/**
 * Crew orchestrator — high-level agent lifecycle management.
 *
 * Composes store, screen, runtimes, and reconciler into the operations
 * that MCP adapters expose as tools.
 */

import { join } from "path";
import { CrewStore, type Agent, type Tab, type Pane } from "./store.js";
import * as screen from "./screen.js";
import * as iterm from "./iterm.js";
import { getLaunchCommand } from "./runtimes.js";
import { reconcile, formatReport } from "./reconciler.js";
import { pickName, backgroundImagePath, loadTheme } from "./themes.js";

const DEFAULT_DB = join(process.env.HOME ?? "/tmp", ".wire", "crews.db");
const SCREEN_PREFIX = "wire-";

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Escape a string for use in a shell command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export class Orchestrator {
  readonly store: CrewStore;

  constructor(dbPath: string = DEFAULT_DB) {
    this.store = new CrewStore(dbPath);
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
    privateKeyB64?: string;
    /** Initial prompt — passed as positional arg to claude. */
    prompt?: string;
  }): Promise<Agent> {
    const runtime = opts.runtime ?? "claude-code";
    let screenName = `${SCREEN_PREFIX}${opts.id}`;

    // Check for existing agent with the same ID
    const existing = this.store.getAgent(opts.id);
    if (existing) {
      const alive = await screen.isAlive(existing.screen_name);
      if (alive) {
        // During handoff, the old agent is still running.
        // Use a suffixed screen name to avoid collision.
        screenName = `${SCREEN_PREFIX}${opts.id}-${Date.now()}`;
      } else {
        // Dead agent — clean up stale record
        this.store.deleteAgentByScreen(existing.screen_name);
      }
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
    if (opts.prompt) {
      command += ` ${shellEscape(opts.prompt)}`;
    }
    if (opts.extraFlags) {
      command += ` ${opts.extraFlags}`;
    }

    // Set crew-specific identity + key vars
    const keyExport = opts.privateKeyB64 ? ` CREW_PRIVATE_KEY=${shellEscape(opts.privateKeyB64)}` : "";
    const envExports = `export CREW_AGENT_ID=${shellEscape(opts.id)} CREW_AGENT_NAME=${shellEscape(opts.displayName)} WIRE_URL=${shellEscape(wireUrl)}${keyExport}`;
    const fullCommand = `cd ${shellEscape(projectDir)} && ${envExports} && ${command}`;

    // Create screen session
    const session = await screen.createSession(screenName, fullCommand);

    // Auto-confirm the dev channels prompt (sends Enter after a delay)
    setTimeout(async () => {
      try {
        await screen.sendKeys(screenName, "\n");
      } catch (e) {
        console.error(`[crew] failed to auto-confirm dev-channel prompt for ${opts.id}:`, e);
      }
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
   * Register an already-running agent (self-registration).
   * The agent detects its own screen session from STY env var.
   * If callerItermId is provided, auto-links to the pane owning that session.
   */
  async registerAgent(opts: {
    id: string;
    displayName: string;
    runtime?: string;
    callerItermId?: string;
    ccSessionId?: string;
  }): Promise<Agent> {
    const runtime = opts.runtime ?? "claude-code";
    const ccSessionId = opts.ccSessionId ?? process.env.CLAUDE_CODE_SESSION_ID;

    // Detect screen session from STY (format: "pid.name")
    const sty = process.env.STY;
    if (!sty) throw new Error("not running in a screen session (STY not set)");
    const [pidStr, ...nameParts] = sty.split(".");
    const screenName = nameParts.join(".");
    const screenPid = parseInt(pidStr, 10);
    if (!screenName || isNaN(screenPid)) {
      throw new Error(`cannot parse STY: ${sty}`);
    }

    // Verify screen session is alive
    const alive = await screen.isAlive(screenName);
    if (!alive) throw new Error(`screen session '${screenName}' is not running`);

    // Find the pane this agent is sitting in (by iTerm session ID)
    const callerPane = opts.callerItermId
      ? this.store.listPanes().find((p) => p.iterm_id === opts.callerItermId)?.name ?? null
      : null;

    // Check if this exact screen session is already registered
    const existingByScreen = this.store.getAgentByScreen(screenName);
    if (existingByScreen) {
      this.store.updateAgentPid(existingByScreen.id, screenPid);
      if (ccSessionId) this.store.updateAgentCcSession(screenName, ccSessionId);
      if (!existingByScreen.pane && callerPane) {
        this.store.updateAgentPane(existingByScreen.id, callerPane);
      }
      return this.store.getAgentByScreen(screenName)!;
    }

    return this.store.createAgent({
      id: opts.id,
      display_name: opts.displayName,
      runtime,
      screen_name: screenName,
      screen_pid: screenPid,
      cc_session_id: ccSessionId ?? undefined,
      pane: callerPane ?? undefined,
    });
  }

  /**
   * Stop an agent — kills the screen session.
   * Accepts optional ccSessionId to target a specific instance during handoff.
   */
  async stopAgent(id: string, ccSessionId?: string): Promise<void> {
    let agent: Agent | null;
    if (ccSessionId) {
      agent = this.store.getAgentBySession(ccSessionId);
      if (!agent) throw new Error(`no agent with cc_session_id '${ccSessionId}'`);
    } else {
      agent = this.store.getAgent(id);
      if (!agent) throw new Error(`agent '${id}' not found`);
    }

    await screen.killSession(agent.screen_name);
    this.store.deleteAgentByScreen(agent.screen_name);
  }

  /**
   * Attach an agent to a pane (make it visible).
   * Detaches the screen session first (remotely), then reattaches it
   * in the target pane's iTerm2 session.
   */
  async attachAgent(agentId: string, paneName: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);
    const pane = this.store.getPane(paneName);
    if (!pane) throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id) throw new Error(`pane '${paneName}' has no iTerm2 session`);

    // Detach any agent currently in this pane (remotely via screen -d)
    const occupants = this.store.listAgents().filter((a) => a.pane === paneName);
    for (const occ of occupants) {
      await screen.detachSession(occ.screen_name);
      this.store.updateAgentPane(occ.id, null);
    }

    // Detach the agent's screen from wherever it currently is
    await screen.detachSession(agent.screen_name);

    // Attach screen session to the iTerm2 pane.
    // Use -x (multi-display) to handle edge cases where -r fails.
    // Use full path to screen binary to avoid PATH issues in non-login shells.
    await iterm.writeToSession(pane.iterm_id, `screen -x ${agent.screen_name}`);
    this.store.updateAgentPane(agentId, paneName);
  }

  /**
   * Detach an agent from its pane (agent keeps running in background).
   * Detaches screen remotely, leaving an empty shell in the pane.
   */
  async detachAgent(agentId: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);

    await screen.detachSession(agent.screen_name);
    this.store.updateAgentPane(agentId, null);
  }

  /**
   * Move an agent to a different pane.
   */
  async moveAgent(agentId: string, toPane: string): Promise<void> {
    await this.detachAgent(agentId);
    await this.attachAgent(agentId, toPane);
  }

  /**
   * Swap two agents' panes.
   */
  async swapAgents(agentIdA: string, agentIdB: string): Promise<void> {
    const a = this.store.getAgent(agentIdA);
    const b = this.store.getAgent(agentIdB);
    if (!a) throw new Error(`agent '${agentIdA}' not found`);
    if (!b) throw new Error(`agent '${agentIdB}' not found`);

    // Detach both from their current panes
    if (a.pane) await this.detachAgent(agentIdA);
    if (b.pane) await this.detachAgent(agentIdB);

    // Re-attach in swapped positions
    const paneA = a.pane;
    const paneB = b.pane;
    if (paneB) await this.attachAgent(agentIdA, paneB);
    if (paneA) await this.attachAgent(agentIdB, paneA);
  }

  /**
   * Send keystrokes to an agent's screen session.
   * Accepts optional ccSessionId to target a specific instance during handoff.
   */
  async sendToAgent(agentId: string, text: string, ccSessionId?: string): Promise<void> {
    const agent = this.resolveAgent(agentId, ccSessionId);
    await screen.sendKeys(agent.screen_name, text);
  }

  /**
   * Read an agent's current screen output.
   * Accepts optional ccSessionId to target a specific instance during handoff.
   */
  async readAgent(agentId: string, ccSessionId?: string): Promise<string> {
    const agent = this.resolveAgent(agentId, ccSessionId);
    return screen.readOutput(agent.screen_name);
  }

  /**
   * Resolve an agent by ID or CC session ID.
   * Used internally by send/read/stop for session-level addressing.
   */
  private resolveAgent(agentId: string, ccSessionId?: string): Agent {
    if (ccSessionId) {
      const agent = this.store.getAgentBySession(ccSessionId);
      if (!agent) throw new Error(`no agent with cc_session_id '${ccSessionId}'`);
      return agent;
    }
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);
    return agent;
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

  // --- Pane I/O ---

  /**
   * Send keystrokes to a pane's iTerm2 session.
   * Works whether or not an agent is attached.
   */
  async sendToPane(paneName: string, text: string): Promise<void> {
    const pane = this.store.getPane(paneName);
    if (!pane) throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id) throw new Error(`pane '${paneName}' has no iTerm2 session`);
    await iterm.writeToSession(pane.iterm_id, text);
  }

  // --- Badges ---

  /**
   * Set the iTerm2 badge on a pane.
   */
  async setBadge(paneName: string, text: string): Promise<void> {
    const pane = this.store.getPane(paneName);
    if (!pane) throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id) throw new Error(`pane '${paneName}' has no iTerm2 session`);
    await iterm.setBadge(pane.iterm_id, text);
  }

  // --- Interrupt ---

  /**
   * Interrupt an agent.
   * Default: Escape (cancel current tool call).
   * Background: Ctrl-B Ctrl-B (background current task, preserves work).
   * Returns screen output so the caller can assess the result.
   */
  async interruptAgent(agentId: string, background = false, ccSessionId?: string): Promise<{ method: string; output: string }> {
    const agent = this.resolveAgent(agentId, ccSessionId);

    if (background) {
      await screen.sendKeys(agent.screen_name, "\x02\x02"); // Ctrl-B Ctrl-B
    } else {
      await screen.sendKeys(agent.screen_name, "\x1b"); // Escape
    }

    await new Promise((r) => setTimeout(r, 500));
    const output = await screen.readOutput(agent.screen_name);
    return { method: background ? "background" : "escape", output };
  }

  // --- Tabs ---

  createTab(name: string, theme?: string): Tab {
    return this.store.createTab(name, theme);
  }

  setTabTheme(name: string, theme: string): void {
    if (!this.store.getTab(name)) throw new Error(`tab '${name}' not found`);
    this.store.setTabTheme(name, theme);
  }

  listTabs(): Tab[] {
    return this.store.listTabs();
  }

  deleteTab(name: string): void {
    this.store.deleteTab(name);
  }

  // --- Panes ---

  /**
   * Register an existing iTerm2 session as a named pane.
   * Use this so agents can register their own pane and split relative to it.
   */
  async registerPane(tab: string, name: string | undefined, itermSessionId: string): Promise<Pane> {
    if (!this.store.getTab(tab)) throw new Error(`tab '${tab}' not found`);

    const alive = await iterm.isSessionAlive(itermSessionId);
    if (!alive) throw new Error(`iTerm2 session ${itermSessionId} not found — ITERM_SESSION_ID may be stale`);

    // Auto-name from theme if no name given
    const paneName = name ?? this.nextPaneName(tab);
    if (!paneName) throw new Error(`no name provided and tab '${tab}' has no theme (or pool exhausted)`);

    const existing = this.store.getPane(paneName);
    if (existing) {
      // Update the iterm_id if pane already exists
      this.store.setPaneItermId(paneName, itermSessionId);
      await iterm.setSessionName(itermSessionId, titleCase(paneName));
      return { ...existing, iterm_id: itermSessionId };
    }

    const pane = this.store.createPane(paneName, tab, "registered");
    this.store.setPaneItermId(paneName, itermSessionId);
    await iterm.setSessionName(itermSessionId, titleCase(paneName));
    return { ...pane, iterm_id: itermSessionId };
  }

  /**
   * Resolve a relativeTo value to an iTerm2 session UUID.
   * Accepts a pane name (looked up in DB) or a raw UUID.
   */
  private resolveSession(relativeTo: string): string {
    // Check if it's a known pane name
    const pane = this.store.getPane(relativeTo);
    if (pane?.iterm_id) return pane.iterm_id;
    // Otherwise treat as raw iTerm2 session UUID
    return relativeTo;
  }

  /**
   * Create a pane by splitting an existing iTerm2 pane.
   * Direction is inferred from position: "below"/"above" = horizontal,
   * "left"/"right" = vertical. Default: horizontal (below).
   * relativeTo: pane name or iTerm2 session UUID to split from.
   */
  async createPane(tab: string, name: string | undefined, position: string = "below", relativeTo?: string): Promise<Pane> {
    if (!this.store.getTab(tab)) throw new Error(`tab '${tab}' not found`);

    // Auto-name from theme if no name given
    const paneName = name ?? this.nextPaneName(tab);
    if (!paneName) throw new Error(`no name provided and tab '${tab}' has no theme (or pool exhausted)`);

    const direction = (position === "left" || position === "right")
      ? "vertical"
      : "horizontal";

    // Resolve background image and choose the right profile
    const tabRow = this.store.getTab(tab);
    const theme = tabRow?.theme ? loadTheme(tabRow.theme) : null;
    const bgPath = tabRow?.theme ? backgroundImagePath(tabRow.theme, paneName, theme) : null;
    const profileName = bgPath
      ? iterm.writePaneProfile(paneName, bgPath, {
          blend: theme?.background.blend,
          mode: theme?.background.mode,
        })
      : (iterm.writeEmptyPaneProfile(), "Crew Empty Pane");

    // Brief delay for iTerm2 to pick up the dynamic profile
    await new Promise((r) => setTimeout(r, 300));

    // Split relative to a named pane, raw UUID, or fall back to current.
    let itermId: string;
    if (relativeTo) {
      const resolvedId = this.resolveSession(relativeTo);
      const alive = await iterm.isSessionAlive(resolvedId);
      if (!alive) {
        throw new Error(
          `cannot split relative to '${relativeTo}': iTerm2 session ${resolvedId} is dead or stale. ` +
          `Re-register the pane or omit relative_to to split the caller's pane.`
        );
      }
      itermId = await iterm.splitSessionWithProfile(resolvedId, direction, profileName);
    } else {
      itermId = await iterm.splitPaneWithProfile(direction, profileName);
    }

    const pane = this.store.createPane(paneName, tab, position);
    this.store.setPaneItermId(paneName, itermId);
    await iterm.setSessionName(itermId, titleCase(paneName));
    return { ...pane, iterm_id: itermId };
  }

  /**
   * Pick the next themed pane name for a tab.
   * Returns null if the tab has no theme or the pool is exhausted.
   */
  nextPaneName(tab: string): string | null {
    const tabRow = this.store.getTab(tab);
    if (!tabRow?.theme) return null;
    const usedNames = this.store.listPanes(tab).map((p) => p.name);
    return pickName(tabRow.theme, usedNames);
  }

  listPanes(tab?: string): Pane[] {
    return this.store.listPanes(tab);
  }

  /**
   * Close a pane — closes the iTerm2 session and removes from DB.
   * Detaches any agent in the pane first (agent keeps running in its screen session).
   * Throws if the pane is not found or can't be closed.
   */
  async closePane(name: string, callerItermId?: string): Promise<void> {
    const pane = this.store.getPane(name);
    if (!pane) throw new Error(`pane '${name}' not found`);

    // Self-protection: prevent an agent from destroying the pane it's sitting in
    if (callerItermId && pane.iterm_id === callerItermId) {
      throw new Error(
        `refusing to close pane '${name}' — it is YOUR pane. ` +
        `Closing it would kill your process. Use agent_detach to leave a pane without closing it.`
      );
    }

    // Detach any agent currently in this pane
    const occupants = this.store.listAgents().filter((a) => a.pane === name);
    for (const occ of occupants) {
      this.store.updateAgentPane(occ.id, null);
    }

    if (pane.iterm_id) {
      await iterm.closeSession(pane.iterm_id);
    }
    this.store.deletePane(name);
  }

  // --- URLs ---

  /**
   * Open a URL in an iTerm2 web browser pane.
   * Creates a pane with a native iTerm2 browser session.
   */
  async openUrl(opts: {
    tab: string;
    pane?: string;
    url: string;
    position?: string;
    relativeTo?: string;
  }): Promise<{ pane: Pane; url: string }> {
    if (!this.store.getTab(opts.tab)) throw new Error(`tab '${opts.tab}' not found`);

    const paneName = opts.pane ?? `url-${Date.now()}`;
    const position = opts.position ?? "below";
    const direction = (position === "left" || position === "right")
      ? "vertical"
      : "horizontal";

    const itermId = opts.relativeTo
      ? await iterm.splitSessionWebBrowser(this.resolveSession(opts.relativeTo), opts.url, direction)
      : await iterm.splitWebBrowser(opts.url, direction);

    const pane = this.store.createPane(paneName, opts.tab, position);
    this.store.setPaneItermId(paneName, itermId);

    return { pane: { ...pane, iterm_id: itermId }, url: opts.url };
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
