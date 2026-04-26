/**
 * Crew orchestrator — high-level agent lifecycle management.
 *
 * Composes store, screen, terminal backend, runtimes, and reconciler
 * into the operations that MCP adapters expose as tools.
 */

import { join } from "path";
import { CrewStore, type Agent, type Tab, type Pane, type AgentTombstone, type Machine } from "./store.js";
import * as screen from "./screen.js";
import type { TerminalBackend } from "./terminal.js";
import { getLaunchCommand } from "./runtimes.js";
import { reconcile, formatReport } from "./reconciler.js";
import { pickName, backgroundImagePath, loadTheme, updateTheme, listThemes } from "./themes.js";
import { getClaudeCodeSessionId } from "./claude-session.js";

const DEFAULT_DB = join(process.env.HOME ?? "/tmp", ".wire", "crews.db");
const SCREEN_PREFIX = "wire-";

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Env keys that must never be persisted to the spawn manifest. */
const SECRET_ENV_KEYS = new Set([
  "AGENT_PRIVATE_KEY",
  "WIRE_PRIVATE_KEY",
  "CREW_PRIVATE_KEY",
]);

/** Strip known secret env keys so the manifest can be stored in the DB. */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Shape of the persisted spawn manifest (agents.spawn_manifest JSON). */
export type SpawnManifest = {
  env: Record<string, string>;       // sanitized — no AGENT_PRIVATE_KEY
  runtime: string;
  project_dir: string;
  extra_flags?: string;
  prompt?: string;
  badge?: string;
  display_name: string;
  ttl_idle_minutes?: number;
  /** Only populated for resume-style spawns. */
  channels?: string[];
};

/** Escape a string for use in a shell command. */
function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export class Orchestrator {
  readonly store: CrewStore;
  readonly terminal: TerminalBackend;

  constructor(terminal: TerminalBackend, dbPath: string = DEFAULT_DB) {
    this.terminal = terminal;
    this.store = new CrewStore(dbPath);
  }

  // --- Agent lifecycle ---

  /**
   * Launch an agent in a screen session.
   * The agent runs in background — no pane attachment required.
   */
  async launchAgent(opts: {
    /**
     * Env vars exported into the spawned agent's process. Crew has no domain
     * knowledge of what these mean — it just forwards them.
     *
     * MUST include AGENT_ID. Crew uses it as the agent's primary identifier
     * (screen session name, DB record key, dedupe lookups). All other vars
     * are opaque to crew. AGENT_NAME defaults to AGENT_ID if omitted.
     *
     * For Wire-using agents the orchestrator generates a keypair, pre-registers
     * the public key on Wire (sponsoring-agent register flow), and includes
     * the base64 PKCS8 private key as AGENT_PRIVATE_KEY here.
     */
    env: Record<string, string>;
    runtime?: string;
    projectDir?: string;
    extraFlags?: string;
    /** Initial prompt — passed as positional arg to the runtime command. */
    prompt?: string;
    /** Optional badge text displayed in the pane's top-right when attached. */
    badge?: string;
    /**
     * Idle TTL in minutes. If set, the orchestrator's reaper (see
     * {@link startReaper}) stops this agent once `now - last_seen`
     * exceeds the threshold. `last_seen` is bumped on every send / attach /
     * status update, so the timer restarts on real activity.
     */
    ttlIdleMinutes?: number;
  }): Promise<Agent> {
    const id = opts.env.AGENT_ID;
    if (!id) throw new Error("env.AGENT_ID is required");
    const displayName = opts.env.AGENT_NAME ?? id;

    const runtime = opts.runtime ?? "claude-code";
    let screenName = `${SCREEN_PREFIX}${id}`;

    // Check for existing agent with the same ID
    const existing = this.store.getAgent(id);
    if (existing) {
      const alive = await screen.isAlive(existing.screen_name);
      if (alive) {
        // During handoff, the old agent is still running.
        // Use a suffixed screen name to avoid collision.
        screenName = `${SCREEN_PREFIX}${id}-${Date.now()}`;
      } else {
        // Dead agent — clean up stale record
        this.store.deleteAgentByScreen(existing.screen_name);
      }
    }

    // Build launch command. Template variables expand from env + PROJECT_DIR.
    const projectDir = opts.projectDir ?? process.cwd();
    const templateVars = { ...opts.env, PROJECT_DIR: projectDir };
    let command = getLaunchCommand(runtime, templateVars);
    if (opts.prompt) {
      command += ` ${shellEscape(opts.prompt)}`;
    }
    if (opts.extraFlags) {
      command += ` ${opts.extraFlags}`;
    }

    // Forward env into the launched process. Verbatim — no synthesis, no
    // built-ins. The orchestrator owns identity and config semantics.
    const envExports = `export ${Object.entries(opts.env)
      .map(([k, v]) => `${k}=${shellEscape(v)}`)
      .join(" ")}`;
    const fullCommand = `cd ${shellEscape(projectDir)} && ${envExports} && ${command}`;

    // Create screen session
    const session = await screen.createSession(screenName, fullCommand);

    // Auto-confirm the dev channels prompt (sends Enter after a delay)
    setTimeout(async () => {
      try {
        await screen.sendKeys(screenName, "\n");
      } catch (e) {
        console.error(`[crew] failed to auto-confirm dev-channel prompt for ${id}:`, e);
      }
    }, 3000);

    // Persist a sanitized manifest alongside the agent row so agent_resume
    // can reconstruct the spawn later. AGENT_PRIVATE_KEY is stripped — the
    // caller re-provisions identity via register_agent on resume.
    const manifest: SpawnManifest = {
      env: sanitizeEnv(opts.env),
      runtime,
      project_dir: projectDir,
      extra_flags: opts.extraFlags,
      prompt: opts.prompt,
      badge: opts.badge,
      display_name: displayName,
      ttl_idle_minutes: opts.ttlIdleMinutes,
    };

    // Record in DB
    return this.store.createAgent({
      id,
      display_name: displayName,
      runtime,
      screen_name: screenName,
      screen_pid: session.pid,
      badge: opts.badge,
      ttl_idle_minutes: opts.ttlIdleMinutes,
      spawn_manifest: JSON.stringify(manifest),
    });
  }

  /**
   * Resume a stopped agent whose Claude Code session JSONL still exists.
   *
   * Mirrors {@link launchAgent} but passes `--resume <ccSessionId>` to the
   * runtime so the agent picks up its conversation history, and pre-seeds
   * the DB row with everything the caller tells us (id, cc_session_id,
   * optional pane) rather than relying on the resumed agent to
   * self-register from inside.
   *
   * Why this exists: premature agent_stop is irreversible today — the DB
   * row is gone and recreating it by hand is ~10 non-obvious steps
   * (see crew-tools#40). This collapses recovery into one call for the
   * common case where the JSONL is still on disk.
   *
   * Channels handling: Claude Code's argparser treats positionals after
   * --dangerously-load-development-channels as part of the channel list,
   * which collides with --resume. We always pass an explicit channels
   * list to sidestep that. The default list is the runtime default's
   * channel; override via opts.channels for fuller plugin loads.
   */
  async resumeAgent(opts: {
    /** Agent ID to resume. Must not already be alive. */
    id: string;
    /**
     * Claude Code session ID (the JSONL filename stem). Falls back to the
     * tombstone's cc_session_id if a tombstone exists for `id`.
     */
    ccSessionId?: string;
    /** Working directory. Falls back to the tombstone manifest's project_dir. */
    projectDir?: string;
    /**
     * Env overrides. Merged on top of the tombstone manifest's env (overrides
     * win). AGENT_PRIVATE_KEY is stripped from the manifest for security, so
     * callers who want Wire identity should re-provision via register_agent
     * and pass the new key here.
     */
    env?: Record<string, string>;
    /**
     * Dev-channel plugin list. Falls back to tombstone manifest's channels,
     * then to ["plugin:wire@agiterra"]. Explicit list sidesteps the
     * --resume / --dangerously-load-development-channels argparser conflict.
     */
    channels?: string[];
    /** Runtime name. Default: tombstone's runtime or "claude-code". */
    runtime?: string;
    /** Display name. Falls back to tombstone manifest's display_name. */
    displayName?: string;
    /** Additional CLI flags appended after --resume. */
    extraFlags?: string;
    /** Optional pane to attach to once the resumed screen is up. */
    attachToPane?: string;
    /** Badge text. Falls back to tombstone's badge. */
    badge?: string;
  }): Promise<Agent> {
    // Refuse to double-resume
    const existing = this.store.getAgent(opts.id);
    if (existing) {
      const alive = await screen.isAlive(existing.screen_name);
      if (alive) {
        throw new Error(
          `resumeAgent: agent '${opts.id}' is already running (screen '${existing.screen_name}'). ` +
          `Stop it first with agent_stop or use agent_attach to view it.`,
        );
      }
      // Dead row left behind — prune it so createAgent doesn't collide.
      this.store.deleteAgentByScreen(existing.screen_name);
    }

    // Pull defaults from the most recent tombstone, if one exists.
    const tomb = this.store.getLatestTombstone(opts.id);
    let manifest: SpawnManifest | null = null;
    if (tomb?.spawn_manifest) {
      try {
        manifest = JSON.parse(tomb.spawn_manifest) as SpawnManifest;
      } catch (e) {
        console.error(`[crew] resumeAgent: failed to parse tombstone manifest for '${opts.id}':`, e);
      }
    }

    const ccSessionId = opts.ccSessionId ?? tomb?.cc_session_id ?? null;
    // cc_session_id is optional on resume: when the original agent never
    // booted a CC session (agent_stop'd before CC wrote a session JSONL, or
    // a prompt like "/exit" caused CC to bail), the tombstone exists with
    // cc_session_id=null. In that case we can still use the manifest to
    // re-launch fresh (no --resume flag). If there's NO tombstone and NO
    // manifest AND no opts.projectDir, we have nothing to work with.
    if (!ccSessionId && !tomb && !opts.projectDir) {
      throw new Error(
        `resumeAgent: no tombstone for '${opts.id}' and no explicit inputs. ` +
        `Launch the agent once via agent_launch so a manifest is recorded, ` +
        `or pass cc_session_id + project_dir explicitly.`,
      );
    }

    const projectDir = opts.projectDir ?? manifest?.project_dir;
    if (!projectDir) {
      throw new Error(
        `resumeAgent: tombstone for '${opts.id}' has no project_dir in its manifest. ` +
        `Pass project_dir explicitly.`,
      );
    }

    const runtime = opts.runtime ?? tomb?.runtime ?? manifest?.runtime ?? "claude-code";
    if (runtime !== "claude-code") {
      throw new Error(`resumeAgent only supports claude-code today (got '${runtime}')`);
    }

    // Merge env: manifest (sanitized, no private key) < opts.env < { AGENT_ID }
    const mergedEnv: Record<string, string> = {
      ...(manifest?.env ?? {}),
      ...(opts.env ?? {}),
      AGENT_ID: opts.id,
    };
    if (opts.env?.AGENT_ID && opts.env.AGENT_ID !== opts.id) {
      throw new Error(`resumeAgent: opts.id ('${opts.id}') does not match env.AGENT_ID ('${opts.env.AGENT_ID}')`);
    }
    const displayName = opts.displayName ?? mergedEnv.AGENT_NAME ?? manifest?.display_name ?? tomb?.display_name ?? opts.id;
    const badge = opts.badge ?? manifest?.badge ?? tomb?.badge ?? undefined;
    const extraFlags = opts.extraFlags ?? manifest?.extra_flags;
    const channels = (opts.channels ?? manifest?.channels ?? ["plugin:wire@agiterra"]).join(",");
    const screenName = `${SCREEN_PREFIX}${opts.id}`;

    // Build: claude --dangerously-load-development-channels <channels> \
    //        --permission-mode bypassPermissions [--resume <cc_session_id>] [extra]
    // Explicit channels list sidesteps the --resume positional-arg conflict.
    // --resume is only added when we have a cc_session_id to resume; if the
    // original agent never booted a CC session (cc_session_id=null in the
    // tombstone) we launch fresh from the manifest instead.
    let command =
      `claude --dangerously-load-development-channels ${shellEscape(channels)} ` +
      `--permission-mode bypassPermissions`;
    if (ccSessionId) command += ` --resume ${shellEscape(ccSessionId)}`;
    if (extraFlags) command += ` ${extraFlags}`;

    const envExports = `export ${Object.entries(mergedEnv)
      .map(([k, v]) => `${k}=${shellEscape(v)}`)
      .join(" ")}`;
    const fullCommand = `cd ${shellEscape(projectDir)} && ${envExports} && ${command}`;

    const session = await screen.createSession(screenName, fullCommand);

    // Auto-confirm dev-channel prompt (same cadence as launchAgent).
    setTimeout(async () => {
      try {
        await screen.sendKeys(screenName, "\n");
      } catch (e) {
        console.error(`[crew] failed to auto-confirm dev-channel prompt for resumed '${opts.id}':`, e);
      }
    }, 3000);

    // Write a fresh manifest for the resumed agent so it can be resumed
    // again later. Channels flow into the manifest only here (launchAgent
    // doesn't record them because the runtime command template carries
    // the default). Env is re-sanitized.
    const resumedManifest: SpawnManifest = {
      env: sanitizeEnv(mergedEnv),
      runtime,
      project_dir: projectDir,
      extra_flags: extraFlags,
      badge,
      display_name: displayName,
      ttl_idle_minutes: manifest?.ttl_idle_minutes,
      channels: opts.channels ?? manifest?.channels,
    };

    const created = this.store.createAgent({
      id: opts.id,
      display_name: displayName,
      runtime,
      screen_name: screenName,
      screen_pid: session.pid,
      cc_session_id: ccSessionId ?? undefined,
      pane: undefined,
      badge,
      ttl_idle_minutes: manifest?.ttl_idle_minutes,
      spawn_manifest: JSON.stringify(resumedManifest),
    });

    // If the caller wants the resumed agent visible, attach now. attachAgent
    // will re-render the badge on the pane per the badge-slot convention.
    if (opts.attachToPane) {
      await this.attachAgent(opts.id, opts.attachToPane);
      return this.store.getAgent(opts.id) ?? created;
    }

    return created;
  }

  /**
   * Register an already-running agent (self-registration).
   * The agent detects its own screen session from STY env var.
   * If callerSessionId is provided, auto-links to the pane owning that session.
   */
  async registerAgent(opts: {
    id: string;
    displayName: string;
    runtime?: string;
    callerSessionId?: string;
    ccSessionId?: string;
  }): Promise<Agent> {
    const runtime = opts.runtime ?? "claude-code";
    const ccSessionId = opts.ccSessionId ?? getClaudeCodeSessionId() ?? undefined;

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

    // Find the pane this agent is sitting in (by terminal session ID).
    // If the session isn't registered as a pane, auto-register it.
    //
    // IMPORTANT: only auto-link when the screen is actually attached to a
    // terminal right now. A detached screen has no iTerm pane of its own —
    // callerSessionId may still be set (inherited from the shell that ran
    // `screen -dmS`), but that shell's pane is not where this agent lives.
    // Example breakage: Brioche (in lisbon) runs `screen -dmS wire-danish`;
    // Danish's inherited ITERM_SESSION_ID points at lisbon; if we auto-link,
    // Danish ends up with pane='lisbon' (Brioche's pane). Skip auto-link
    // for detached screens — the caller can agent_attach explicitly later.
    let callerPane: string | null = null;
    const attached = await screen.isAttached(screenName);
    if (opts.callerSessionId && attached) {
      callerPane = this.store.listPanes().find((p) => p.iterm_id === opts.callerSessionId)?.name ?? null;
      if (!callerPane) {
        callerPane = await this.autoRegisterPane(opts.callerSessionId);
      }
    }

    // Check if this exact screen session is already registered
    const existingByScreen = this.store.getAgentByScreen(screenName);
    if (existingByScreen) {
      // Safety: refuse if the caller is trying to register under an id that
      // doesn't match the agent that OWNS this screen session. Without this,
      // Brioche calling registerAgent({id:'danish'}) from her own screen
      // would overwrite her own DB row's cc_session_id with Danish's id —
      // silently corrupting her identity record. STY is the ground truth
      // for "who is running in this process"; opts.id must agree with it.
      if (existingByScreen.id !== opts.id) {
        throw new Error(
          `registerAgent: screen '${screenName}' is owned by agent ` +
          `'${existingByScreen.id}' but called with id='${opts.id}'. ` +
          `STY identifies the running process — you can only register ` +
          `yourself. If you want to register a DIFFERENT agent (e.g. one ` +
          `you spawned), call agent_register from inside that agent's ` +
          `own screen session, not yours.`,
        );
      }
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

    // Clear the pane's badge before killing — otherwise the dead agent's
    // badge text lingers on the now-empty pane until something else clobbers
    // it. Matches the agent_badge/attach/detach convention of "the agent
    // owns the pane's badge slot while it's attached."
    if (agent.pane) {
      const pane = this.store.getPane(agent.pane);
      if (pane?.iterm_id) {
        try { await this.terminal.setBadge(pane.iterm_id, ""); } catch {}
      }
    }

    await screen.killSession(agent.screen_name);
    // Leave a tombstone so agent_resume can reconstruct the spawn later.
    this.store.tombstoneAgent(agent);
    this.store.deleteAgentByScreen(agent.screen_name);
  }

  /**
   * Attach an agent to a pane (make it visible).
   * If the pane doesn't match the tab's theme, auto-swaps to a themed pane.
   * Detaches the screen session first (remotely), then reattaches it
   * in the target pane's terminal session.
   */
  async attachAgent(agentId: string, paneName: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);

    // Auto-swap to a themed pane if needed
    const resolvedPane = await this.ensureThemedPane(paneName);

    const pane = this.store.getPane(resolvedPane);
    if (!pane) throw new Error(`pane '${resolvedPane}' not found`);
    if (!pane.iterm_id) throw new Error(`pane '${resolvedPane}' has no terminal session`);

    // Detach any agent currently in this pane (remotely via screen -d)
    const occupants = this.store.listAgents().filter((a) => a.pane === resolvedPane);
    for (const occ of occupants) {
      await screen.detachSession(occ.screen_name);
      this.store.updateAgentPane(occ.id, null);
    }

    // Detach the agent's screen from wherever it currently is
    await screen.detachSession(agent.screen_name);

    // Attach screen session to the terminal pane.
    // Use -x (multi-display) to handle edge cases where -r fails.
    await this.terminal.writeToSession(pane.iterm_id, `screen -x ${agent.screen_name}`);
    this.store.updateAgentPane(agentId, resolvedPane);

    // Flash the tab and notify — agent is now visible.
    // On cmux these are native; on iTerm2 flash is a no-op and notify
    // falls back to setBadge, so the agent badge below must run AFTER
    // to reclaim the badge slot.
    try {
      await this.terminal.flashSession(pane.iterm_id);
      await this.terminal.notifySession(pane.iterm_id, `${agent.display_name} attached`, `→ pane ${resolvedPane}`);
    } catch (e) {
      console.error(`[crew] attach flash/notify failed for '${agentId}' on '${resolvedPane}':`, e);
    }

    // Apply the agent's badge to the pane (color from pane's profile, text from agent).
    // Runs AFTER notifySession so it wins on iTerm2 (where notify falls back to setBadge).
    if (agent.badge) {
      try {
        await this.terminal.setBadge(pane.iterm_id, agent.badge);
      } catch (e) {
        console.error(`[crew] failed to set badge for '${agentId}' on '${resolvedPane}':`, e);
      }
    }
  }

  /**
   * Ensure a pane matches its tab's theme. If the pane was created without
   * the tab's current theme (e.g., default profile, wrong theme), create a
   * new themed pane in the same position, and close the old one.
   * Returns the pane name to use (original if already themed, new if swapped).
   */
  async ensureThemedPane(paneName: string): Promise<string> {
    const pane = this.store.getPane(paneName);
    if (!pane) return paneName; // Let the caller handle missing pane

    const tab = this.store.getTab(pane.tab);
    if (!tab?.theme) return paneName; // No theme on tab — nothing to do

    // Already matches the tab's theme
    if (pane.theme === tab.theme) return paneName;

    // Pane doesn't match — swap it
    const newPane = await this.createPane(pane.tab, undefined, pane.position, paneName);
    await this.closePane(paneName);
    return newPane.name;
  }

  /**
   * Detach an agent from its pane (agent keeps running in background).
   * Detaches screen remotely, leaving an empty shell in the pane.
   */
  async detachAgent(agentId: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);

    // Clear the badge from the pane before detaching
    if (agent.pane) {
      const pane = this.store.getPane(agent.pane);
      if (pane?.iterm_id) {
        try { await this.terminal.setBadge(pane.iterm_id, ""); } catch {}
      }
    }

    await screen.detachSession(agent.screen_name);
    this.store.updateAgentPane(agentId, null);
  }

  /**
   * Update an agent's badge text. Persists in the DB and applies to the
   * pane immediately if the agent is currently attached.
   *
   * Returns a summary of what happened: the DB badge is always written;
   * the pane render is skipped when the pane's occupancy is ambiguous
   * (more than one agent row claims it). Ambiguous panes happen when an
   * operator reattaches a screen via raw `screen -x` or iTerm controls
   * instead of `agent_attach`, leaving the DB lying about which pane
   * shows which agent. Rendering the badge in that state would push the
   * escape sequence to whichever iTerm session the pane is wired to,
   * clobbering whatever agent is ACTUALLY displayed there — classically
   * the caller's own badge.
   */
  async setAgentBadge(agentId: string, badge: string): Promise<{
    rendered: boolean;
    pane: string | null;
    reason?: string;
  }> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error(`agent '${agentId}' not found`);
    this.store.setAgentBadge(agentId, badge);

    if (!agent.pane) {
      return { rendered: false, pane: null, reason: "agent is headless (no pane)" };
    }

    // Invariant: each pane hosts at most one agent. Check BEFORE iterm_id
    // resolution — a drifted DB is a more informative signal than "no iterm
    // session." If multiple rows claim this pane we cannot safely render:
    // the iterm_id may be wired to a different agent, and rendering would
    // clobber whoever is actually displayed (classically the caller's own
    // badge, when an operator calls agent_badge for another agent that
    // nominally shares the caller's pane).
    const claimants = this.store.listAgents().filter((a) => a.pane === agent.pane);
    if (claimants.length > 1) {
      const reason =
        `pane '${agent.pane}' is claimed by ${claimants.length} agents (${claimants.map((c) => c.id).join(", ")}). ` +
        `DB is stale — probably an operator reattached a screen outside of agent_attach. ` +
        `Resolve by calling agent_attach / agent_detach on the affected agents, or run reconcile.`;
      console.error(`[crew] setAgentBadge skipped render: ${reason}`);
      return { rendered: false, pane: agent.pane, reason };
    }

    const pane = this.store.getPane(agent.pane);
    if (!pane?.iterm_id) {
      return { rendered: false, pane: agent.pane, reason: "pane has no iterm session" };
    }

    // Defence in depth: if the target's screen session isn't attached to any
    // terminal right now, the DB pane is stale (headless agents can't render).
    const attached = await screen.isAttached(agent.screen_name);
    if (!attached) {
      return {
        rendered: false,
        pane: agent.pane,
        reason: `target screen '${agent.screen_name}' is detached — rendering would go to a stale iterm session`,
      };
    }

    await this.terminal.setBadge(pane.iterm_id, badge);
    return { rendered: true, pane: agent.pane };
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
    this.store.touchAgent(agent.id);
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
   * Send keystrokes to a pane's terminal session.
   * Works whether or not an agent is attached.
   */
  async sendToPane(paneName: string, text: string): Promise<void> {
    const pane = this.store.getPane(paneName);
    if (!pane) throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id) throw new Error(`pane '${paneName}' has no terminal session`);
    await this.terminal.writeToSession(pane.iterm_id, text);
  }

  // --- Badges ---

  /**
   * Set the badge/status on a pane.
   */
  async setBadge(paneName: string, text: string): Promise<void> {
    const pane = this.store.getPane(paneName);
    if (!pane) throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id) throw new Error(`pane '${paneName}' has no terminal session`);
    await this.terminal.setBadge(pane.iterm_id, text);
  }

  // --- Notifications ---

  /**
   * Flash a pane's tab and send a notification.
   * On cmux: triggers the notification ring + desktop notification.
   * On iTerm2: sets the badge text (best effort).
   */
  async notifyPane(paneName: string, title: string, body?: string): Promise<void> {
    const pane = this.store.getPane(paneName);
    if (!pane) throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id) throw new Error(`pane '${paneName}' has no terminal session`);
    await this.terminal.flashSession(pane.iterm_id);
    await this.terminal.notifySession(pane.iterm_id, title, body);
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

  async createTab(name: string, theme?: string): Promise<Tab & { pane?: Pane }> {
    // Resolve theme: explicit → first unused → first available
    let resolvedTheme = theme;
    if (!resolvedTheme) {
      const available = listThemes();
      const usedThemes = new Set(this.store.listTabs().map((t) => t.theme).filter(Boolean));
      resolvedTheme = available.find((t) => !usedThemes.has(t)) ?? available[0];
    }

    // Pick a pane name from the theme pool and write the profile so the
    // auto-created tab session shows the themed background from the start.
    // On cmux, writePaneProfile is a no-op and createTab ignores profileName.
    let profileName: string | undefined;
    let paneName: string | undefined;
    if (resolvedTheme) {
      const themeConfig = loadTheme(resolvedTheme);
      const usedNames = this.store.listPanes().map((p) => p.name);
      const picked = pickName(resolvedTheme, usedNames);
      if (picked && themeConfig) {
        paneName = picked;
        const bgPath = backgroundImagePath(resolvedTheme, picked, themeConfig);
        if (bgPath) {
          profileName = this.terminal.writePaneProfile({
            paneName: picked,
            backgroundImage: bgPath,
            blend: themeConfig.background.blend,
            mode: themeConfig.background.mode,
            badgeColor: themeConfig.badgeColors?.[picked] ?? themeConfig.defaultBadgeColor,
          });
          // Brief delay for iTerm2 to pick up the dynamic profile
          if (this.terminal.name === "iterm") {
            await new Promise((r) => setTimeout(r, 300));
          }
        }
      }
    }

    const sessionId = await this.terminal.createTab(profileName);
    const tab = this.store.createTab(name, resolvedTheme, sessionId);

    // Register the auto-created pane if we named it from the theme
    let pane: Pane | undefined;
    if (paneName) {
      pane = this.store.createPane(paneName, name, "below", resolvedTheme);
      this.store.setPaneItermId(paneName, sessionId);
      await this.terminal.setSessionName(sessionId, titleCase(paneName));
    }

    // Name the workspace/tab (cmux: renames workspace; iTerm2: no-op)
    await this.terminal.renameWorkspace(sessionId, name);

    return { ...tab, pane };
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
   * Register an existing terminal session as a named pane.
   * Use this so agents can register their own pane and split relative to it.
   */
  async registerPane(tab: string, name: string | undefined, sessionId: string): Promise<Pane> {
    if (!this.store.getTab(tab)) throw new Error(`tab '${tab}' not found`);

    const alive = await this.terminal.isSessionAlive(sessionId);
    if (!alive) throw new Error(`terminal session ${sessionId} not found — session ID may be stale`);

    // Auto-name from theme if no name given
    const paneName = name ?? this.nextPaneName(tab);
    if (!paneName) {
      const tabRow = this.store.getTab(tab);
      if (!tabRow?.theme) {
        throw new Error(`tab '${tab}' has no theme — specify a pane name or set a theme first`);
      }
      const usedCount = this.store.listPanes(tab).length;
      throw new Error(
        `all names in theme '${tabRow.theme}' are in use on tab '${tab}' (${usedCount} panes) — specify a name explicitly`
      );
    }

    const existing = this.store.getPane(paneName);
    if (existing) {
      // Update the iterm_id if pane already exists
      this.store.setPaneItermId(paneName, sessionId);
      await this.terminal.setSessionName(sessionId, titleCase(paneName));
      return { ...existing, iterm_id: sessionId };
    }

    const tabRow = this.store.getTab(tab);
    const pane = this.store.createPane(paneName, tab, "registered", tabRow?.theme ?? undefined);
    this.store.setPaneItermId(paneName, sessionId);
    await this.terminal.setSessionName(sessionId, titleCase(paneName));
    return { ...pane, iterm_id: sessionId };
  }

  /**
   * Resolve a relativeTo value to a terminal session ID.
   * Accepts a pane name (looked up in DB) or a raw session ID.
   */
  private resolveSession(relativeTo: string): string {
    // Check if it's a known pane name
    const pane = this.store.getPane(relativeTo);
    if (pane?.iterm_id) return pane.iterm_id;
    // Otherwise treat as raw session ID
    return relativeTo;
  }

  /**
   * Create a pane by splitting an existing terminal pane.
   * Direction is inferred from position: "below"/"above" = horizontal,
   * "left"/"right" = vertical. Default: horizontal (below).
   * relativeTo: pane name or session ID to split from.
   */
  async createPane(tab: string, name: string | undefined, position: string = "below", relativeTo?: string): Promise<Pane> {
    if (!this.store.getTab(tab)) throw new Error(`tab '${tab}' not found`);

    // Auto-name from theme if no name given
    const paneName = name ?? this.nextPaneName(tab);
    if (!paneName) {
      const tabRow = this.store.getTab(tab);
      if (!tabRow?.theme) {
        throw new Error(`tab '${tab}' has no theme — specify a pane name or set a theme first`);
      }
      const usedCount = this.store.listPanes(tab).length;
      throw new Error(
        `all names in theme '${tabRow.theme}' are in use on tab '${tab}' (${usedCount} panes) — specify a name explicitly`
      );
    }

    const direction = (position === "left" || position === "right")
      ? "vertical"
      : "horizontal";

    // Resolve background image and choose the right profile
    const tabRow = this.store.getTab(tab);
    const theme = tabRow?.theme ? loadTheme(tabRow.theme) : null;
    const bgPath = tabRow?.theme ? backgroundImagePath(tabRow.theme, paneName, theme) : null;
    const profileName = bgPath
      ? this.terminal.writePaneProfile({
          paneName,
          backgroundImage: bgPath,
          blend: theme?.background.blend,
          mode: theme?.background.mode,
          badgeColor: theme?.badgeColors?.[paneName] ?? theme?.defaultBadgeColor,
        })
      : this.terminal.writeEmptyPaneProfile();

    // Brief delay for iTerm2 to pick up the dynamic profile (cmux doesn't need this but it's harmless)
    if (this.terminal.name === "iterm") {
      await new Promise((r) => setTimeout(r, 300));
    }

    // Split relative to: explicit pane/session → tab's session → any pane in the tab.
    // Never fall back to the caller's pane — that's always wrong for cross-tab creates.
    let sessionId: string;
    let splitTarget = relativeTo ?? tabRow?.iterm_session_id;

    // If the tab has no session ID, find any existing pane in the tab to split from
    if (!splitTarget) {
      const tabPanes = this.store.listPanes(tab);
      const paneWithSession = tabPanes.find((p) => p.iterm_id);
      if (paneWithSession) {
        splitTarget = paneWithSession.iterm_id!;
      }
    }

    if (!splitTarget) {
      throw new Error(
        `tab '${tab}' has no terminal session and no panes with sessions. ` +
        `The tab may need to be re-created, or specify relative_to with a pane name.`
      );
    }

    const resolvedId = relativeTo ? this.resolveSession(relativeTo) : splitTarget;
    const alive = await this.terminal.isSessionAlive(resolvedId);
    if (!alive) {
      throw new Error(
        `cannot split relative to '${relativeTo ?? tab}': terminal session ${resolvedId} is dead or stale. ` +
        `Re-register the pane or tab, or specify a different relative_to.`
      );
    }
    sessionId = await this.terminal.splitSessionWithProfile(resolvedId, direction, profileName);

    const pane = this.store.createPane(paneName, tab, position, tabRow?.theme ?? undefined);
    this.store.setPaneItermId(paneName, sessionId);
    await this.terminal.setSessionName(sessionId, titleCase(paneName));
    return { ...pane, iterm_id: sessionId };
  }

  /**
   * Pick the next themed pane name for a tab.
   * Returns null if the tab has no theme or the pool is exhausted.
   */
  nextPaneName(tab: string): string | null {
    const tabRow = this.store.getTab(tab);
    if (!tabRow?.theme) return null;
    // Names are globally unique (panes.name PK), so check across ALL panes,
    // not just this tab. Filtering per-tab caused pickName to return a name
    // that already existed in another tab → INSERT hit UNIQUE constraint.
    const usedNames = this.store.listPanes().map((p) => p.name);
    return pickName(tabRow.theme, usedNames);
  }

  listPanes(tab?: string): Pane[] {
    return this.store.listPanes(tab);
  }

  /**
   * Auto-register an unregistered terminal session as a pane.
   * Finds the tab by matching sessionId against known tab/pane sessions,
   * picks a theme name, writes the dynamic profile, and registers in the DB.
   * Returns the new pane name, or null if the session can't be associated with a tab.
   */
  async autoRegisterPane(sessionId: string): Promise<string | null> {
    // Already registered?
    const existing = this.store.listPanes().find((p) => p.iterm_id === sessionId);
    if (existing) return existing.name;

    // Find which tab this session belongs to by checking tab sessions and sibling panes
    const tabs = this.store.listTabs();
    let targetTab: Tab | null = null;

    for (const tab of tabs) {
      // Direct tab session match
      if (tab.iterm_session_id === sessionId) {
        targetTab = tab;
        break;
      }
      // Check if the session is a sibling of any pane in this tab
      // (on iTerm2, sessions in the same tab share a tab container)
      const tabPanes = this.store.listPanes(tab.name);
      if (tabPanes.some((p) => p.iterm_id === sessionId)) {
        targetTab = tab;
        break;
      }
    }

    if (!targetTab) return null;

    // Pick a name from the theme pool
    const paneName = this.nextPaneName(targetTab.name);
    if (!paneName) return null; // pool exhausted, can't auto-name

    // Write themed profile
    const theme = targetTab.theme ? loadTheme(targetTab.theme) : null;
    const bgPath = targetTab.theme ? backgroundImagePath(targetTab.theme, paneName, theme) : null;
    if (bgPath) {
      this.terminal.writePaneProfile({
        paneName,
        backgroundImage: bgPath,
        blend: theme?.background.blend,
        mode: theme?.background.mode,
        badgeColor: theme?.badgeColors?.[paneName] ?? theme?.defaultBadgeColor,
      });
    }

    // Register in DB
    this.store.createPane(paneName, targetTab.name, "below", targetTab.theme ?? undefined);
    this.store.setPaneItermId(paneName, sessionId);
    await this.terminal.setSessionName(sessionId, titleCase(paneName));
    console.error(`[crew] auto-registered pane '${paneName}' in tab '${targetTab.name}' (session ${sessionId})`);
    return paneName;
  }

  /**
   * Close a pane — closes the terminal session and removes from DB.
   * Detaches any agent in the pane first (agent keeps running in its screen session).
   * Throws if the pane is not found or can't be closed.
   */
  async closePane(name: string, callerSessionId?: string): Promise<void> {
    const pane = this.store.getPane(name);
    if (!pane) throw new Error(`pane '${name}' not found`);

    // Self-protection: prevent an agent from destroying the pane it's sitting in
    if (callerSessionId && pane.iterm_id === callerSessionId) {
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
      await this.terminal.closeSession(pane.iterm_id);
    }
    this.store.deletePane(name);
  }

  // --- URLs ---

  /**
   * Open a URL in a web browser pane.
   * Creates a pane with a browser session (iTerm2 native browser or cmux embedded browser).
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

    const sessionId = opts.relativeTo
      ? await this.terminal.splitSessionWebBrowser(this.resolveSession(opts.relativeTo), opts.url, direction)
      : await this.terminal.splitWebBrowser(opts.url, direction);

    const pane = this.store.createPane(paneName, opts.tab, position);
    this.store.setPaneItermId(paneName, sessionId);

    return { pane: { ...pane, iterm_id: sessionId }, url: opts.url };
  }

  // --- Theme updates ---

  /**
   * Update a theme's settings (blend, mode, images) and rebuild all live
   * panes using that theme. For each affected pane:
   *   1. Create new themed pane (relative to old — preserves position)
   *   2. Move any attached agent to the new pane
   *   3. Close the old pane
   */
  async updateThemeAndRebuild(
    themeName: string,
    updates: { blend?: number; mode?: number; images?: Record<string, string> },
  ): Promise<{ updated: string[]; errors: string[] }> {
    // Update theme.json on disk
    const config = updateTheme(themeName, updates);
    if (!config) throw new Error(`theme '${themeName}' not found`);

    // Find all live panes using this theme
    const allPanes = this.store.listPanes();
    const affected = allPanes.filter((p) => p.theme === themeName);

    const updated: string[] = [];
    const errors: string[] = [];

    for (const oldPane of affected) {
      try {
        // Find agent in old pane (if any)
        const occupant = this.store.listAgents().find((a) => a.pane === oldPane.name);

        // Detach agent from old pane
        if (occupant) {
          await screen.detachSession(occupant.screen_name);
          this.store.updateAgentPane(occupant.id, null);
        }

        // Create new pane relative to old (preserves position)
        const newPane = await this.createPane(
          oldPane.tab,
          undefined,
          oldPane.position,
          oldPane.name,
        );

        // Close old pane (must happen after create so position is preserved)
        await this.closePane(oldPane.name);

        // Reattach agent to new pane
        if (occupant) {
          await this.attachAgent(occupant.id, newPane.name);
        }

        updated.push(`${oldPane.name} → ${newPane.name}`);
      } catch (e: any) {
        errors.push(`${oldPane.name}: ${e.message}`);
      }
    }

    return { updated, errors };
  }

  // --- Machines (cross-machine orchestration registry) ---

  /**
   * Register a machine in the local crew DB so crew-fleet can fan-out
   * queries + handoffs to it. Probes SSH reachability; refuses to
   * register unreachable hosts unless `skipProbe` is set.
   */
  async registerMachine(opts: {
    name: string;
    sshHost: string;
    sshPort?: number;
    notes?: string;
    skipProbe?: boolean;
    /**
     * If true, after registering the destination locally, SSH to it and
     * register the LOCAL machine in its DB too. Best-effort — SSH failure
     * during reciprocal step is logged but does not undo the local
     * registration.
     *
     * The local machine's reachable address from the destination's POV
     * is `${USER}@${hostname}.local` by default; override via
     * `localAddress`.
     */
    reciprocal?: boolean;
    /** Override the local machine's reachable SSH address for the reciprocal call. */
    localAddress?: string;
  }): Promise<Machine & { reciprocal?: { ok: boolean; remote_record?: unknown; error?: string } }> {
    const existing = this.store.getMachine(opts.name);
    if (existing) {
      throw new Error(
        `registerMachine: '${opts.name}' is already registered (ssh_host='${existing.ssh_host}'). ` +
        `Call machine_remove first if you want to re-register.`,
      );
    }
    let probedHostname = opts.name;
    let crewVersion: string | undefined;
    if (!opts.skipProbe) {
      const probe = await this.probeMachineSsh(opts.sshHost, opts.sshPort);
      if (!probe.reachable) {
        throw new Error(
          `registerMachine: SSH probe to '${opts.sshHost}' failed: ${probe.error ?? "unreachable"}. ` +
          `Pass skipProbe: true to register anyway.`,
        );
      }
      probedHostname = probe.hostname ?? opts.name;
      crewVersion = probe.crewVersion;
    }
    const row = this.store.createMachine({
      name: opts.name,
      hostname: probedHostname,
      ssh_host: opts.sshHost,
      ssh_port: opts.sshPort,
      notes: opts.notes,
    });
    if (crewVersion) {
      this.store.updateMachineProbe(opts.name, { last_seen: Date.now(), crew_version: crewVersion });
    }
    const finalRow = this.store.getMachine(opts.name) ?? row;

    // Reciprocal step: SSH the destination and run `crew machine-register`
    // with our identity, so the destination's crew DB knows about us.
    // Best-effort — failure here is logged but doesn't undo the local row.
    if (opts.reciprocal) {
      const localAddress = opts.localAddress ?? `${process.env.USER ?? "tim"}@${this.store.localMachineName()}.local`;
      const reciprocal = await this.reciprocalRegister(
        opts.sshHost,
        opts.sshPort,
        { name: this.store.localMachineName(), ssh_host: localAddress },
      );
      return { ...finalRow, reciprocal };
    }

    return finalRow;
  }

  /**
   * SSH the destination and run `crew machine-register --json -` with
   * our identity as the body. Used by reciprocal pairing. Returns a
   * structured outcome — never throws.
   */
  private async reciprocalRegister(
    sshHost: string,
    sshPort: number | undefined,
    selfRow: { name: string; ssh_host: string; ssh_port?: number; notes?: string },
  ): Promise<{ ok: boolean; remote_record?: unknown; error?: string }> {
    try {
      const portArg = sshPort ? ["-p", String(sshPort)] : [];
      // Send the JSON via stdin so it doesn't show in the SSH audit log.
      const proc = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ...portArg, sshHost, "crew machine-register --json -"],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      const stdin = (proc as unknown as { stdin: { write: (s: string) => void; end: () => void } }).stdin;
      stdin.write(JSON.stringify(selfRow));
      stdin.end();
      const exitCode = await proc.exited;
      const stdout = (await new Response(proc.stdout).text()).trim();
      const stderr = (await new Response(proc.stderr).text()).trim();
      if (exitCode !== 0) {
        return { ok: false, error: stderr || `exit ${exitCode}` };
      }
      let remote_record: unknown = stdout;
      try { remote_record = JSON.parse(stdout); } catch { /* keep as raw */ }
      return { ok: true, remote_record };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg };
    }
  }

  listMachines(): Machine[] {
    return this.store.listMachines();
  }

  removeMachine(name: string): void {
    this.store.deleteMachine(name);
  }

  /**
   * Re-probe a registered machine. Updates `last_seen` and `crew_version`
   * in the DB. Returns the probe result.
   */
  async probeMachine(name: string): Promise<{ reachable: boolean; hostname?: string; crewVersion?: string; error?: string }> {
    const m = this.store.getMachine(name);
    if (!m) throw new Error(`probeMachine: '${name}' not registered`);
    const probe = await this.probeMachineSsh(m.ssh_host, m.ssh_port ?? undefined);
    if (probe.reachable) {
      this.store.updateMachineProbe(name, {
        last_seen: Date.now(),
        crew_version: probe.crewVersion,
      });
    }
    return probe;
  }

  /**
   * Low-level SSH probe: `ssh <host> 'hostname && bun ... --version'`.
   * Returns reachable + remote hostname + crew version (if detectable).
   * All failures reduce to `{ reachable: false, error }` so callers get a
   * uniform shape. Timeout is 5 seconds.
   */
  private async probeMachineSsh(
    sshHost: string,
    sshPort?: number,
  ): Promise<{ reachable: boolean; hostname?: string; crewVersion?: string; error?: string }> {
    try {
      const portArg = sshPort ? ["-p", String(sshPort)] : [];
      const proc = Bun.spawn(
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", ...portArg, sshHost, "hostname && (cat ~/.claude/plugins/cache/agiterra/crew/*/package.json 2>/dev/null | grep '\"version\"' | head -1 || true)"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        return { reachable: false, error: err.trim() || `exit ${exitCode}` };
      }
      const out = (await new Response(proc.stdout).text()).trim().split("\n");
      const remoteHost = out[0]?.toLowerCase() ?? undefined;
      const versionLine = out.find((l) => l.includes('"version"'));
      const versionMatch = versionLine?.match(/"version":\s*"([^"]+)"/);
      return {
        reachable: true,
        hostname: remoteHost,
        crewVersion: versionMatch?.[1],
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { reachable: false, error: msg };
    }
  }

  // --- Reconciler ---

  /**
   * Reconcile DB state with running screen sessions.
   * Run on boot and periodically.
   */
  async reconcile(): Promise<string> {
    const result = await reconcile(this.store, this.terminal);
    const agents = this.store.listAgents();
    return formatReport(result, agents);
  }

  // --- Reaper (idle TTL enforcement) ---

  private reaperInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * Scan agents with `ttl_idle_minutes` set and stop any whose
   * `last_seen` is older than the threshold. Returns the IDs reaped.
   */
  async reap(): Promise<string[]> {
    const now = Date.now();
    const candidates = this.store.listAgentsWithTtl();
    const reaped: string[] = [];
    for (const agent of candidates) {
      const ttlMs = (agent.ttl_idle_minutes ?? 0) * 60_000;
      if (ttlMs <= 0) continue;
      const idleMs = now - agent.last_seen;
      if (idleMs <= ttlMs) continue;
      try {
        await this.stopAgent(agent.id, agent.cc_session_id ?? undefined);
        reaped.push(agent.id);
        console.error(
          `[crew] reaper stopped '${agent.id}' (idle ${Math.round(idleMs / 60_000)}min > ttl ${agent.ttl_idle_minutes}min)`,
        );
      } catch (e) {
        console.error(`[crew] reaper failed to stop '${agent.id}':`, e);
      }
    }
    return reaped;
  }

  /** Start the reaper interval. Call once from a long-lived process. */
  startReaper(intervalMs = 60_000): void {
    if (this.reaperInterval) return;
    this.reaperInterval = setInterval(() => {
      this.reap().catch((e) => console.error(`[crew] reaper tick failed:`, e));
    }, intervalMs);
  }

  stopReaper(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = null;
    }
  }
}
