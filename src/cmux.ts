/**
 * cmux terminal backend.
 *
 * Controls cmux panes via CLI commands. cmux is a native macOS terminal
 * with a Unix socket API — ideal for agent orchestration.
 *
 * Key differences from iTerm2:
 * - Uses surface refs (e.g. "surface:5") instead of session UUIDs
 * - No dynamic profiles — uses notifications for status
 * - Has built-in browser split support
 * - Uses workspaces instead of tabs
 * - Most commands return "OK surface:N workspace:N" not JSON
 */

import { $ } from "bun";
import type { TerminalBackend, PaneProfile } from "./terminal.js";
import type { CapabilityMap, CapabilityRegistry } from "./capabilities/types.js";
import { CmuxNotifications } from "./cmux-capabilities/notifications.js";

// Capability registration deferred to constructor (needs class-private
// `surfaceArgs` binding). Field declared, populated in constructor.

/**
 * Run a cmux CLI command and return trimmed stdout.
 */
async function cmux(...args: string[]): Promise<string> {
  const result = await $`cmux ${args}`.quiet();
  return result.stdout.toString().trim();
}

/**
 * Run a cmux CLI command with --json flag and parse the result.
 * Not all cmux commands support --json — use cmux() for those.
 */
async function cmuxJson(...args: string[]): Promise<any> {
  const result = await $`cmux ${[...args, "--json"]}`.quiet();
  return JSON.parse(result.stdout.toString().trim());
}

/**
 * Parse "OK surface:N workspace:N" response to extract the surface ref.
 */
function parseSurfaceRef(output: string): string {
  const match = output.match(/surface:\d+/);
  if (!match) throw new Error(`unexpected cmux output: ${output}`);
  return match[0];
}

/**
 * Map cmux blend (0..1, 1=opaque) and mode (0=tile, 1=stretch, 2=scale-to-fill)
 * onto cmux's surface.set_background RPC params (opacity, fit, repeat).
 *
 * The RPC accepts `fit: "cover" | "contain"`, `position`, `opacity`, `repeat`.
 * iTerm's "mode" doesn't map cleanly; we pick the closest sensible default.
 *
 * `surfaceId` must be the surface's UUID. cmux's surface.set_background RPC
 * silently ignores `surface` / `target_id` / short-ref values and falls back
 * to the caller's focused surface — a silent corruption mode. `surface_id`
 * with a UUID is the only reliable target specifier.
 */
function mapProfileToRpcParams(
  surfaceId: string,
  image: string,
  blend: number | undefined,
  mode: number | undefined,
): Record<string, unknown> {
  const opacity = typeof blend === "number" ? Math.max(0, Math.min(1, blend)) : 0.5;
  // 0 = tile → repeat=true, fit=contain
  // 1 = stretch → fit=cover (closest in cmux), no repeat
  // 2 = scale-to-fill → fit=cover, no repeat
  let fit: "cover" | "contain" = "cover";
  let repeat = false;
  if (mode === 0) { fit = "contain"; repeat = true; }
  else if (mode === 1) { fit = "cover"; }
  return { surface_id: surfaceId, image, opacity, fit, position: "center", repeat };
}

export class CmuxBackend implements TerminalBackend {
  readonly name = "cmux" as const;

  /**
   * In-memory profile store. iTerm2 persists profiles to disk; cmux has no
   * dynamic-profile concept, so we stash PaneProfile objects under synthetic
   * names and resolve them when setProfile() / splitWithProfile() fire.
   */
  private profileStore = new Map<string, PaneProfile>();
  private profileSeq = 0;

  private readonly _capabilities: CapabilityRegistry;

  constructor() {
    this._capabilities = {
      notifications: new CmuxNotifications(cmux, (sid) => this.surfaceArgs(sid)),
    };
  }

  capability<K extends keyof CapabilityMap>(name: K): CapabilityMap[K] | null {
    return (this._capabilities[name] as CapabilityMap[K] | undefined) ?? null;
  }

  /**
   * Resolve a caller-supplied surface identifier (short ref OR UUID) to the
   * canonical {ref, workspace} recognized by the CURRENT cmux daemon.
   *
   * BOTH input forms go stale across cmux daemon restarts:
   *   - UUIDs from $CMUX_SURFACE_ID are stable per-process but the daemon
   *     mints fresh UUIDs on restart.
   *   - Short refs (`surface:N`) from caches like crew's pane→surface DB
   *     point at a monotonic counter that resets on restart — the same
   *     `surface:20` may now refer to a different pane or be missing
   *     entirely. cmux's per-surface commands (send, new-split,
   *     close-surface, rpc target_id resolution) default `--workspace` to
   *     the CALLER's $CMUX_WORKSPACE_ID, not the surface's actual
   *     workspace; without an explicit `--workspace`, cross-workspace
   *     targets fail with "Surface not found".
   *
   * One tree lookup with `--id-format both` handles both input shapes
   * uniformly: each surface in the tree carries `.id` (UUID) AND `.ref`
   * (short ref), so a single pass matches either field AND captures the
   * containing workspace.
   *
   * Strategy:
   *   1. Lookup in current tree, matching input against surface.id OR
   *      surface.ref → return {ref, ws.ref} if found.
   *   2. Not in tree, but input === $CMUX_SURFACE_ID → fall back to
   *      `cmux identify`.focused. The env var represents the caller's own
   *      surface, so identify always reflects the right ref. (Short-ref
   *      inputs can't take this fallback — env only ever holds UUIDs.)
   *   3. Otherwise → null (surface belongs to a vanished pane or stale
   *      cache entry; caller treats as "placement target gone" and falls
   *      back to headless / re-resolution from a fresh source).
   */
  private async resolveSurface(input: string): Promise<{ ref: string; ws: string | null; id: string | null } | null> {
    try {
      const tree = await cmuxJson("tree", "--id-format", "both");
      for (const win of tree.windows ?? []) {
        for (const ws of win.workspaces ?? []) {
          for (const pane of ws.panes ?? []) {
            for (const surface of pane.surfaces ?? []) {
              if (surface.id === input || surface.ref === input) {
                return { ref: surface.ref, ws: ws.ref ?? null, id: surface.id ?? null };
              }
            }
          }
        }
      }
    } catch {
      // Tree query failed — fall through to env-match fallback.
    }
    if (input === process.env.CMUX_SURFACE_ID) {
      try {
        const info = await cmuxJson("identify");
        const ref = info.focused?.surface_ref ?? info.focused?.surfaceRef;
        const ws = info.focused?.workspace_ref ?? info.focused?.workspaceRef;
        const id = info.focused?.surface_id ?? info.focused?.surfaceId;
        if (typeof ref === "string") {
          return {
            ref,
            ws: typeof ws === "string" ? ws : null,
            id: typeof id === "string" ? id : (input.match(/^[0-9a-f-]{36}$/i) ? input : null),
          };
        }
      } catch {
        // identify failed.
      }
    }
    return null;
  }

  /**
   * Build `["--surface", ref]` plus, if known, `["--workspace", wsRef]`.
   * Centralises the workspace-lookup pattern every per-surface CLI invocation
   * needs. Validates input against current daemon state so commands survive
   * cmux daemon restarts (which invalidate both UUIDs and monotonic short
   * refs). Unresolvable inputs pass through; the downstream cmux call will
   * surface "Surface not found" to the caller's existing try/catch.
   */
  private async surfaceArgs(sessionId: string): Promise<string[]> {
    const resolved = await this.resolveSurface(sessionId);
    if (!resolved) {
      return ["--surface", sessionId];
    }
    return resolved.ws
      ? ["--surface", resolved.ref, "--workspace", resolved.ws]
      : ["--surface", resolved.ref];
  }

  /**
   * Poll until a surface has an allocated PTY (tty field is non-null) or the
   * timeout elapses. cmux lazy-instantiates terminal surfaces, and
   * surface.set_background errors with `surface_unavailable` against a cold
   * surface — the RPC return is silent (caught below) and the bg never
   * renders. Waiting briefly catches the common case where a freshly-split
   * surface materialises within a few hundred ms of the user/UI visiting it.
   *
   * For fully-headless creation (workspace never focused), the surface may
   * stay cold past the timeout. The RPC then errors and we log; the bg will
   * apply on the user's first activation of that pane if upstream code
   * re-fires it (see splitWithProfile / setProfile callers).
   *
   * TODO(cmux): a proper fix is to make v2SurfaceSetBackground in
   * TerminalController+BackgroundImage.swift pre-instantiate the surface
   * rather than erroring on a cold liveSurface. Then this poll is redundant.
   */
  private async waitForPty(sessionId: string, timeoutMs = 1000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const tree = await cmuxJson("tree");
        for (const win of tree.windows ?? []) {
          for (const ws of win.workspaces ?? []) {
            for (const pane of ws.panes ?? []) {
              for (const surface of pane.surfaces ?? []) {
                if (surface.ref === sessionId && surface.tty) return true;
              }
            }
          }
        }
      } catch {
        // tree query failed — keep polling until timeout
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  }

  /**
   * Apply a stored profile's background to a surface via cmux's RPC.
   * Best-effort — failures (cmux down, surface gone, malformed image path)
   * are logged but never thrown. Matches the rest of this class's policy.
   *
   * Polls briefly for PTY allocation before firing the RPC. See waitForPty
   * for why.
   */
  private async applyProfileToSurface(sessionId: string, profileName: string): Promise<void> {
    const profile = this.profileStore.get(profileName);
    if (!profile || !profile.backgroundImage) return;
    await this.waitForPty(sessionId);
    const resolved = await this.resolveSurface(sessionId);
    if (!resolved?.id) {
      console.error(`[crew] cmux set-background skipped: cannot resolve UUID for ${sessionId}`);
      return;
    }
    const params = mapProfileToRpcParams(
      resolved.id,
      profile.backgroundImage,
      profile.blend,
      profile.mode,
    );
    try {
      await cmux("rpc", "surface.set_background", JSON.stringify(params));
    } catch (e) {
      console.error(`[crew] cmux set-background failed for ${sessionId} (${resolved.id}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async currentSessionId(): Promise<string> {
    // Prefer env var (set automatically by cmux for child processes)
    if (process.env.CMUX_SURFACE_ID) {
      return process.env.CMUX_SURFACE_ID;
    }
    // Fall back to identify command
    const info = await cmuxJson("identify");
    return info.focused?.surface_ref ?? info.focused?.surfaceRef;
  }

  async currentTabId(): Promise<string | null> {
    // cmux 'identify' returns focused.workspace_ref — the workspace the
    // operator is currently viewing. Crew tabs map 1:1 to cmux workspaces
    // and store the workspace ref in tabs.iterm_session_id (legacy column
    // name; semantics are backend-agnostic).
    try {
      const info = await cmuxJson("identify");
      const ws = info.focused?.workspace_ref ?? info.focused?.workspaceRef;
      return typeof ws === "string" ? ws : null;
    } catch {
      return null;
    }
  }

  async sessionIdForTty(ttyName: string): Promise<string | null> {
    try {
      // Use tree --json to find all surfaces and match by TTY
      const tree = await cmuxJson("tree");
      const ttyShort = ttyName.replace(/^\/dev\//, "");
      for (const win of tree.windows ?? []) {
        for (const ws of win.workspaces ?? []) {
          for (const pane of ws.panes ?? []) {
            for (const surface of pane.surfaces ?? []) {
              if (surface.tty === ttyShort || surface.tty === ttyName) {
                return surface.ref;
              }
            }
          }
        }
      }
      return null;
    } catch (e) {
      console.error(`[crew] cmux sessionIdForTty failed for ${ttyName}:`, e);
      return null;
    }
  }

  async splitPane(direction: "horizontal" | "vertical"): Promise<string> {
    // cmux: horizontal (below) = "down", vertical (right) = "right"
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const output = await cmux("new-split", cmuxDir);
    return parseSurfaceRef(output);
  }

  async splitSession(
    sessionId: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const args = await this.surfaceArgs(sessionId);
    const output = await cmux("new-split", cmuxDir, ...args);
    return parseSurfaceRef(output);
  }

  async writeToSession(sessionId: string, text: string): Promise<void> {
    const args = await this.surfaceArgs(sessionId);
    await cmux("send", ...args, text);
  }

  /**
   * Attach a screen session and commit with a deterministic enter key.
   *
   * `cmux send <text>` sends the literal string with no auto-newline (unlike
   * iTerm2's AppleScript `write text`). Composing send + send-key separates
   * "type the command" from "press enter", so the attach always commits even
   * if `screenName` ever picked up an unexpected trailing character.
   *
   * This eliminates the bridge.spawn-drops-\r class of bug, where a freshly
   * split pane sat at an unsubmitted `screen -x wire-<id>` prompt.
   *
   * Also writes a surface.resume binding so cmux can re-run the attach
   * after a daemon restart without crew involvement. The binding is
   * decorative for cmux versions that don't support resume; failures
   * here are non-fatal.
   */
  async attachScreen(
    sessionId: string,
    screenName: string,
    mode: "r" | "x" = "r",
  ): Promise<void> {
    const args = await this.surfaceArgs(sessionId);
    await cmux("send", ...args, `screen -${mode} ${screenName}`);
    await cmux("send-key", ...args, "enter");
    try {
      await cmux(
        "surface", "resume", "set",
        ...args,
        "--kind", "agent",
        "--name", screenName,
        "--shell", `screen -${mode} ${screenName}`,
      );
    } catch (err) {
      // Non-fatal — older cmux builds lack surface.resume; not load-bearing.
      console.warn(`[cmux] surface.resume.set failed for ${screenName}:`, err);
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      const args = await this.surfaceArgs(sessionId);
      await cmux("close-surface", ...args);
    } catch {
      // If close-surface fails, try sending exit
      try {
        await this.writeToSession(sessionId, "exit\n");
      } catch {
        // Best effort
      }
    }
  }

  async isSessionAlive(sessionId: string): Promise<boolean> {
    // Reuse resolveSurface so UUID and short-ref inputs are both validated
    // against the current cmux tree (with env-match fallback for the
    // caller's own surface). Predates the v2 split — was checking only
    // surface.ref, missing UUID inputs that callerSession() returns from
    // CMUX_SURFACE_ID.
    return (await this.resolveSurface(sessionId)) !== null;
  }

  async createTab(profileName?: string): Promise<string> {
    // --focus true is required: cmux 0.64+ lazy-instantiates terminals,
    // so the workspace's initial surface has no backing PTY until focused.
    // Without this, attaching screen to the surface fails with
    // "Surface is not a terminal" / "Terminal surface not found".
    const output = await cmux("new-workspace", "--focus", "true");
    // Output: "OK workspace:N"
    // We need the surface ref of the new workspace's initial surface.
    // List panes in the new workspace to get it.
    const wsMatch = output.match(/workspace:\d+/);
    if (!wsMatch) throw new Error(`unexpected cmux new-workspace output: ${output}`);
    const wsRef = wsMatch[0];

    // Get the tree to find the surface in this workspace
    const tree = await cmuxJson("tree");
    let surfaceRef: string | null = null;
    for (const win of tree.windows ?? []) {
      for (const ws of win.workspaces ?? []) {
        if (ws.ref === wsRef) {
          const firstSurface = ws.panes?.[0]?.surfaces?.[0];
          if (firstSurface) surfaceRef = firstSurface.ref;
        }
      }
    }
    const result = surfaceRef ?? wsRef;
    if (profileName && surfaceRef) {
      await this.applyProfileToSurface(surfaceRef, profileName);
    }
    return result;
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    try {
      const args = await this.surfaceArgs(sessionId);
      await cmux("rename-tab", ...args, name);
    } catch {
      // Non-fatal — tab renaming may not always work
    }
  }

  /**
   * Append a workspace-level log entry to cmux's sidebar log. Useful for
   * surfacing agent lifecycle (attached, closed, stopped) where the operator
   * can scan recent activity without opening any specific pane.
   *
   * iTerm2 backend leaves this undefined; orchestrator skips the call there.
   */
  async logWorkspace(
    sessionId: string,
    message: string,
    opts?: { level?: "info" | "progress" | "success" | "warning" | "error"; source?: string },
  ): Promise<void> {
    try {
      const wsRef = (await this.resolveSurface(sessionId))?.ws ?? null;
      const wsFlag = wsRef ? ["--workspace", wsRef] : [];
      const levelFlag = opts?.level ? ["--level", opts.level] : [];
      const sourceFlag = ["--source", opts?.source ?? "crew"];
      // cmux log puts the message after `--`, supporting messages that start with `-`.
      await cmux("log", ...wsFlag, ...levelFlag, ...sourceFlag, "--", message);
    } catch {
      // Non-fatal — sidebar log is decorative.
    }
  }

  async setBadge(sessionId: string, text: string): Promise<void> {
    // cmux exposes per-workspace sidebar status pills (set-status / clear-status).
    // These are the closest analogue to iTerm2's per-session badge: they
    // persist, they're visible at a glance, and they're tagged by a key so
    // multiple agents can coexist. We key by sessionId so each pane gets its
    // own pill in its workspace's sidebar. Empty text clears the pill.
    try {
      const wsRef = (await this.resolveSurface(sessionId))?.ws ?? null;
      const wsFlag = wsRef ? ["--workspace", wsRef] : [];
      const key = `crew.${sessionId}`;
      if (text === "") {
        await cmux("clear-status", key, ...wsFlag);
      } else {
        await cmux("set-status", key, text, ...wsFlag);
      }
    } catch {
      // Non-fatal — sidebar metadata is decorative, not load-bearing.
    }
  }

  /**
   * @deprecated Phase 1 shim. Use `capability("notifications")?.flash(sessionId)`.
   * Removed in v3.0.0.
   */
  async flashSession(sessionId: string): Promise<void> {
    await this.capability("notifications")?.flash(sessionId);
  }

  /**
   * @deprecated Phase 1 shim. Use `capability("notifications")?.notify(...)`.
   * Removed in v3.0.0.
   */
  async notifySession(sessionId: string, title: string, body?: string): Promise<void> {
    await this.capability("notifications")?.notify(sessionId, title, body);
  }

  async renameWorkspace(sessionId: string, name: string): Promise<void> {
    try {
      // Find which workspace this surface belongs to
      const tree = await cmuxJson("tree");
      for (const win of tree.windows ?? []) {
        for (const ws of win.workspaces ?? []) {
          for (const pane of ws.panes ?? []) {
            for (const surface of pane.surfaces ?? []) {
              if (surface.ref === sessionId) {
                await cmux("rename-workspace", "--workspace", ws.ref, name);
                return;
              }
            }
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  writePaneProfile(profile: PaneProfile): string {
    // cmux has no on-disk dynamic-profile concept — stash in memory and
    // apply when the new surface exists (in setProfile / splitWithProfile).
    const name = `cmux-profile-${this.profileSeq++}-${profile.paneName}`;
    this.profileStore.set(name, profile);
    return name;
  }

  writeEmptyPaneProfile(): string {
    // Empty profile means "no background" — represented as a name with no
    // entry in the store, so applyProfileToSurface no-ops on lookup.
    return "cmux-empty";
  }

  async setProfile(sessionId: string, profileName: string): Promise<void> {
    await this.applyProfileToSurface(sessionId, profileName);
  }

  async splitPaneWithProfile(
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    const sessionId = await this.splitPane(direction);
    await this.applyProfileToSurface(sessionId, profileName);
    return sessionId;
  }

  async splitSessionWithProfile(
    sessionId: string,
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    const newSessionId = await this.splitSession(sessionId, direction);
    await this.applyProfileToSurface(newSessionId, profileName);
    return newSessionId;
  }

  async splitWebBrowser(
    url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const output = await cmux("new-pane", "--type", "browser", "--direction", cmuxDir, "--url", url);
    // Try to extract surface ref; new-pane may return differently
    const match = output.match(/surface:\d+/);
    if (match) return match[0];
    // Fall back to browser open
    const output2 = await cmux("browser", "open-split", url);
    const match2 = output2.match(/surface:\d+/);
    if (match2) return match2[0];
    throw new Error(`cmux browser split failed: ${output}`);
  }

  async splitSessionWebBrowser(
    _sessionId: string,
    url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const output = await cmux("new-pane", "--type", "browser", "--direction", cmuxDir, "--url", url);
    const match = output.match(/surface:\d+/);
    if (match) return match[0];
    throw new Error(`cmux browser split failed: ${output}`);
  }

  /**
   * Split the caller's surface in the caller's workspace and return the
   * new surface ref. Used by orchestrator.launchAgent when the caller
   * wants the new agent to appear right next to them.
   *
   * Returns the new surface ref on success, null on failure (caller
   * surface invalid, cmux split refused, etc.). The orchestrator treats
   * a null return as "best-effort failed — keep the agent headless."
   */
  async splitFromCallerForAgent(
    callerSurfaceId: string,
    direction: "right" | "down",
  ): Promise<string | null> {
    // Strict resolve: placement next to caller only makes sense if caller's
    // surface actually exists. Unlike per-surface ops on possibly-stale refs
    // (which surfaceArgs lets through so cmux can return "Surface not found"),
    // cmux new-split silently ignores an unknown --surface and creates an
    // orphan surface in the focused workspace. Fail fast instead.
    const resolved = await this.resolveSurface(callerSurfaceId);
    if (!resolved) return null;
    try {
      const cmuxDir = direction === "right" ? "right" : "down";
      const args = resolved.ws
        ? ["--surface", resolved.ref, "--workspace", resolved.ws]
        : ["--surface", resolved.ref];
      const output = await cmux("new-split", cmuxDir, ...args);
      const match = output.match(/surface:\d+/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }
}
