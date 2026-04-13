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

export class CmuxBackend implements TerminalBackend {
  readonly name = "cmux" as const;

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

  async createTab(_profileName?: string): Promise<string> {
    // profileName is iTerm2-only (dynamic profiles) — cmux ignores it.
    const output = await cmux("new-workspace");
    // Output: "OK workspace:N"
    // We need the surface ref of the new workspace's initial surface.
    // List panes in the new workspace to get it.
    const wsMatch = output.match(/workspace:\d+/);
    if (!wsMatch) throw new Error(`unexpected cmux new-workspace output: ${output}`);
    const wsRef = wsMatch[0];

    // Get the tree to find the surface in this workspace
    const tree = await cmuxJson("tree");
    for (const win of tree.windows ?? []) {
      for (const ws of win.workspaces ?? []) {
        if (ws.ref === wsRef) {
          const firstSurface = ws.panes?.[0]?.surfaces?.[0];
          if (firstSurface) return firstSurface.ref;
        }
      }
    }
    // Fall back to workspace ref if we can't find the surface
    return wsRef;
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    try {
      await cmux("rename-tab", "--surface", sessionId, name);
    } catch {
      // Non-fatal — tab renaming may not always work
    }
  }

  async setTabName(_sessionId: string, name: string): Promise<void> {
    try {
      if (process.env.CMUX_WORKSPACE_ID) {
        await cmux("rename-workspace", "--workspace", process.env.CMUX_WORKSPACE_ID, name);
      }
    } catch {
      // No-op if not supported
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

  writePaneProfile(_profile: PaneProfile): string {
    // cmux doesn't use dynamic profiles — return a dummy name.
    return "cmux-default";
  }

  writeEmptyPaneProfile(): string {
    return "cmux-default";
  }

  async splitPaneWithProfile(
    direction: "horizontal" | "vertical",
    _profileName: string,
  ): Promise<string> {
    // cmux ignores profiles — just do a normal split
    return this.splitPane(direction);
  }

  async splitSessionWithProfile(
    sessionId: string,
    direction: "horizontal" | "vertical",
    _profileName: string,
  ): Promise<string> {
    return this.splitSession(sessionId, direction);
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
}
