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
 */
function mapProfileToRpcParams(
  surface: string,
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
  return { surface, image, opacity, fit, position: "center", repeat };
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

  /**
   * Apply a stored profile's background to a surface via cmux's RPC.
   * Best-effort — failures (cmux down, surface gone, malformed image path)
   * are logged but never thrown. Matches the rest of this class's policy.
   */
  private async applyProfileToSurface(sessionId: string, profileName: string): Promise<void> {
    const profile = this.profileStore.get(profileName);
    if (!profile || !profile.backgroundImage) return;
    const params = mapProfileToRpcParams(
      sessionId,
      profile.backgroundImage,
      profile.blend,
      profile.mode,
    );
    try {
      await cmux("rpc", "surface.set_background", JSON.stringify(params));
    } catch (e) {
      console.error(`[crew] cmux set-background failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}`);
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
    const output = await cmux("new-split", cmuxDir, "--surface", sessionId);
    return parseSurfaceRef(output);
  }

  async writeToSession(sessionId: string, text: string): Promise<void> {
    await cmux("send", "--surface", sessionId, text);
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await cmux("close-surface", "--surface", sessionId);
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
    try {
      const tree = await cmuxJson("tree");
      for (const win of tree.windows ?? []) {
        for (const ws of win.workspaces ?? []) {
          for (const pane of ws.panes ?? []) {
            for (const surface of pane.surfaces ?? []) {
              if (surface.ref === sessionId) return true;
            }
          }
        }
      }
      return false;
    } catch {
      return false;
    }
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
      await cmux("rename-tab", "--surface", sessionId, name);
    } catch {
      // Non-fatal — tab renaming may not always work
    }
  }

  async setBadge(sessionId: string, text: string): Promise<void> {
    try {
      await cmux("notify", "--title", text, "--surface", sessionId);
    } catch {
      // Non-fatal
    }
  }

  async flashSession(sessionId: string): Promise<void> {
    try {
      await cmux("trigger-flash", "--surface", sessionId);
    } catch {
      // Non-fatal
    }
  }

  async notifySession(sessionId: string, title: string, body?: string): Promise<void> {
    try {
      const args = ["notify", "--title", title, "--surface", sessionId];
      if (body) args.push("--body", body);
      await cmux(...args);
    } catch {
      // Non-fatal
    }
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
    try {
      const cmuxDir = direction === "right" ? "right" : "down";
      const output = await cmux("new-split", cmuxDir, "--surface", callerSurfaceId);
      const match = output.match(/surface:\d+/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }
}
