/**
 * Pane orchestrator — high-level agent lifecycle management.
 *
 * Composes store, screen, runtimes, and reconciler into the operations
 * that MCP adapters expose as tools.
 */

import { join } from "path";
import { PaneStore, type Agent, type Tab, type Slot } from "./store.js";
import * as screen from "./screen.js";
import * as iterm from "./iterm.js";
import { getLaunchCommand } from "./runtimes.js";
import { reconcile, formatReport } from "./reconciler.js";

const DEFAULT_DB = join(process.env.HOME ?? "/tmp", ".wire", "panes.db");
const SCREEN_PREFIX = "wire-";

/** Escape a string for use in a shell command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export class Orchestrator {
  readonly store: PaneStore;

  constructor(dbPath: string = DEFAULT_DB) {
    this.store = new PaneStore(dbPath);
  }

  // --- Agent lifecycle ---

  /**
   * Launch an agent in a screen session.
   * The agent runs in background — no pane attachment required.
   */
  async launchAgent(opts: {
    id: string;
    displayName: string;
    runtime?: string;
    projectDir?: string;
    extraFlags?: string;
  }): Promise<Agent> {
    const runtime = opts.runtime ?? "claude-code";
    const screenName = `${SCREEN_PREFIX}${opts.id}`;

    // Check for existing agent
    const existing = this.store.getAgent(opts.id);
    if (existing) {
      const alive = await screen.isAlive(existing.screen_name);
      if (alive) {
        throw new Error(`agent '${opts.id}' is already running`);
      }
      // Dead agent — clean up stale record
      this.store.deleteAgent(opts.id);
    }

    // Build launch command with agent identity injected as env vars
    const wireUrl = process.env.WIRE_URL ?? "http://localhost:9800";
    const projectDir = opts.projectDir ?? process.cwd();
    const vars = {
      AGENT_ID: opts.id,
      AGENT_NAME: opts.displayName,
      WIRE_URL: wireUrl,
      PROJECT_DIR: projectDir,
    };
    let command = getLaunchCommand(runtime, vars);
    if (opts.extraFlags) {
      command += ` ${opts.extraFlags}`;
    }

    // Set pane-specific identity vars that take priority over .env's WIRE_AGENT_ID
    const envExports = `export PANE_AGENT_ID=${shellEscape(opts.id)} PANE_AGENT_NAME=${shellEscape(opts.displayName)} WIRE_URL=${shellEscape(wireUrl)}`;
    const fullCommand = `cd ${shellEscape(projectDir)} && ${envExports} && ${command}`;

    // Create screen session
    const session = await screen.createSession(screenName, fullCommand);

    // Auto-confirm the dev channels prompt (sends Enter after a delay)
    setTimeout(async () => {
      try { await screen.sendKeys(screenName, "\n"); } catch {}
    }, 3000);

    // Record in DB
    return this.store.createAgent({
      id: opts.id,
      display_name: opts.displayName,
      runtime,
      screen_name: screenName,
      screen_pid: session.pid,
    });
  }

  /**
   * Stop an agent — sends exit to screen session.
   */
  async stopAgent(id: string): Promise<void> {
    const agent = this.store.getAgent(id);
    if (!agent) throw new Error(`agent '${id}' not found`);

    await screen.killSession(agent.screen_name);
    this.store.deleteAgent(id);
  }

  /**
   * Attach an agent to a slot (make it visible in a pane).
   * Runs `screen -r <name>` in the slot's iTerm2 session.
   */
  async attachAgent(agentId: string, slotName: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);
    const slot = this.store.getSlot(slotName);
    if (!slot) throw new Error(`slot '${slotName}' not found`);
    if (!slot.iterm_id) throw new Error(`slot '${slotName}' has no iTerm2 session`);

    // Detach any agent currently in this slot
    const occupants = this.store.listAgents().filter((a) => a.slot === slotName);
    for (const occ of occupants) {
      // Detach screen in the iTerm session before reassigning
      if (slot.iterm_id) {
        await iterm.writeToSession(slot.iterm_id, "/opt/homebrew/bin/screen -d").catch(() => {});
      }
      this.store.updateAgentSlot(occ.id, null);
    }

    // Attach screen session to the iTerm2 pane
    await iterm.writeToSession(slot.iterm_id, `/opt/homebrew/bin/screen -r ${agent.screen_name}`);
    this.store.updateAgentSlot(agentId, slotName);
  }

  /**
   * Detach an agent from its slot (agent keeps running in background).
   * Sends ctrl-a,d to detach screen, leaving an empty shell in the pane.
   */
  async detachAgent(agentId: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);

    if (agent.slot) {
      const slot = this.store.getSlot(agent.slot);
      if (slot?.iterm_id) {
        // Detach screen (ctrl-a, d)
        await iterm.writeToSession(slot.iterm_id, String.fromCharCode(1) + "d").catch(() => {});
      }
    }

    this.store.updateAgentSlot(agentId, null);
  }

  /**
   * Move an agent to a different slot.
   */
  async moveAgent(agentId: string, toSlot: string): Promise<void> {
    await this.detachAgent(agentId);
    await this.attachAgent(agentId, toSlot);
  }

  /**
   * Swap two agents' slots.
   */
  async swapAgents(agentIdA: string, agentIdB: string): Promise<void> {
    const a = this.store.getAgent(agentIdA);
    const b = this.store.getAgent(agentIdB);
    if (!a) throw new Error(`agent '${agentIdA}' not found`);
    if (!b) throw new Error(`agent '${agentIdB}' not found`);

    // Detach both from their current slots
    if (a.slot) await this.detachAgent(agentIdA);
    if (b.slot) await this.detachAgent(agentIdB);

    // Re-attach in swapped positions
    const slotA = a.slot;
    const slotB = b.slot;
    if (slotB) await this.attachAgent(agentIdA, slotB);
    if (slotA) await this.attachAgent(agentIdB, slotA);
  }

  /**
   * Send keystrokes to an agent's screen session.
   */
  async sendToAgent(agentId: string, text: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);
    await screen.sendKeys(agent.screen_name, text);
  }

  /**
   * Read an agent's current screen output.
   */
  async readAgent(agentId: string): Promise<string> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);
    return screen.readOutput(agent.screen_name);
  }

  /**
   * Update an agent's status.
   */
  setAgentStatus(agentId: string, statusName: string, statusDesc: string): void {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);
    this.store.updateAgentStatus(agentId, statusName, statusDesc);
  }

  /**
   * List all agents with their current state.
   */
  listAgents(): Agent[] {
    return this.store.listAgents();
  }

  // --- Badges ---

  /**
   * Set the iTerm2 badge on a slot's pane.
   */
  async setBadge(slotName: string, text: string): Promise<void> {
    const slot = this.store.getSlot(slotName);
    if (!slot) throw new Error(`slot '${slotName}' not found`);
    if (!slot.iterm_id) throw new Error(`slot '${slotName}' has no iTerm2 session`);
    await iterm.setBadge(slot.iterm_id, text);
  }

  // --- Interrupt ---

  /**
   * Interrupt an agent — sends Escape and monitors screen until agent is idle.
   * Returns the number of Escapes sent and the final screen state.
   */
  async interruptAgent(agentId: string, maxAttempts = 8): Promise<{ escapes: number; idle: boolean; output: string }> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);

    for (let i = 0; i < maxAttempts; i++) {
      await screen.sendKeys(agent.screen_name, "\x1b");
      await new Promise((r) => setTimeout(r, 500));

      const output = await screen.readOutput(agent.screen_name);
      // Claude Code shows ">" prompt when idle
      if (output.includes("\n> ") || output.trimEnd().endsWith(">")) {
        return { escapes: i + 1, idle: true, output };
      }
    }

    const output = await screen.readOutput(agent.screen_name);
    return { escapes: maxAttempts, idle: false, output };
  }

  // --- Tabs ---

  createTab(name: string): Tab {
    return this.store.createTab(name);
  }

  listTabs(): Tab[] {
    return this.store.listTabs();
  }

  deleteTab(name: string): void {
    this.store.deleteTab(name);
  }

  // --- Slots ---

  /**
   * Register an existing iTerm2 session as a named slot.
   * Use this so agents can register their own pane and split relative to it.
   */
  registerSlot(tab: string, name: string, itermSessionId: string): Slot {
    if (!this.store.getTab(tab)) throw new Error(`tab '${tab}' not found`);

    const existing = this.store.getSlot(name);
    if (existing) {
      // Update the iterm_id if slot already exists
      this.store.setSlotItermId(name, itermSessionId);
      return { ...existing, iterm_id: itermSessionId };
    }

    const slot = this.store.createSlot(name, tab, "registered");
    this.store.setSlotItermId(name, itermSessionId);
    return { ...slot, iterm_id: itermSessionId };
  }

  /**
   * Resolve a relativeTo value to an iTerm2 session UUID.
   * Accepts a slot name (looked up in DB) or a raw UUID.
   */
  private resolveSession(relativeTo: string): string {
    // Check if it's a known slot name
    const slot = this.store.getSlot(relativeTo);
    if (slot?.iterm_id) return slot.iterm_id;
    // Otherwise treat as raw iTerm2 session UUID
    return relativeTo;
  }

  /**
   * Create a slot by splitting an iTerm2 pane.
   * Direction is inferred from position: "below"/"above" = horizontal,
   * "left"/"right" = vertical. Default: horizontal (below).
   * relativeTo: slot name or iTerm2 session UUID to split from.
   */
  async createSlot(tab: string, name: string, position: string = "below", relativeTo?: string): Promise<Slot> {
    if (!this.store.getTab(tab)) throw new Error(`tab '${tab}' not found`);

    const direction = (position === "left" || position === "right")
      ? "vertical"
      : "horizontal";

    // Split relative to a named slot, raw UUID, or fall back to current
    const itermId = relativeTo
      ? await iterm.splitSession(this.resolveSession(relativeTo), direction)
      : await iterm.splitPane(direction);

    const slot = this.store.createSlot(name, tab, position);
    this.store.setSlotItermId(name, itermId);
    return { ...slot, iterm_id: itermId };
  }

  listSlots(tab?: string): Slot[] {
    return this.store.listSlots(tab);
  }

  /**
   * Destroy a slot — closes the iTerm2 session and removes from DB.
   */
  async deleteSlot(name: string): Promise<void> {
    const slot = this.store.getSlot(name);
    if (slot?.iterm_id) {
      await iterm.closeSession(slot.iterm_id);
    }
    this.store.deleteSlot(name);
  }

  // --- URLs ---

  /**
   * Open a URL in an iTerm2 web browser pane.
   * Creates a slot with a native iTerm2 browser session.
   */
  async openUrl(opts: {
    tab: string;
    slot?: string;
    url: string;
    position?: string;
    relativeTo?: string;
  }): Promise<{ slot: Slot; url: string }> {
    if (!this.store.getTab(opts.tab)) throw new Error(`tab '${opts.tab}' not found`);

    const slotName = opts.slot ?? `url-${Date.now()}`;
    const position = opts.position ?? "below";
    const direction = (position === "left" || position === "right")
      ? "vertical"
      : "horizontal";

    const itermId = opts.relativeTo
      ? await iterm.splitSessionWebBrowser(this.resolveSession(opts.relativeTo), opts.url, direction)
      : await iterm.splitWebBrowser(opts.url, direction);

    const slot = this.store.createSlot(slotName, opts.tab, position);
    this.store.setSlotItermId(slotName, itermId);

    return { slot: { ...slot, iterm_id: itermId }, url: opts.url };
  }

  // --- Reconciler ---

  /**
   * Reconcile DB state with running screen sessions.
   * Run on boot and periodically.
   */
  async reconcile(): Promise<string> {
    const result = await reconcile(this.store);
    const agents = this.store.listAgents();
    return formatReport(result, agents);
  }
}
