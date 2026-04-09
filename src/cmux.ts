/**
 * cmux terminal backend.
 *
 * Controls cmux panes via CLI commands. cmux is a native macOS terminal
 * with a Unix socket API — ideal for agent orchestration.
 *
 * Key differences from iTerm2:
 * - Uses surface IDs (numeric) instead of session UUIDs
 * - No dynamic profiles — theming done via sidebar metadata
 * - Has built-in browser split support
 * - Uses workspaces instead of tabs
 */

import { $ } from "bun";
import type { TerminalBackend, PaneProfile } from "./terminal.js";

/**
 * Run a cmux CLI command with --json flag and parse the result.
 */
async function cmuxJson(...args: string[]): Promise<any> {
  const result = await $`cmux ${[...args, "--json"]}`.quiet();
  return JSON.parse(result.stdout.toString().trim());
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
    return String(info.surfaceId ?? info.surface_id ?? info.id);
  }

  async sessionIdForTty(ttyName: string): Promise<string | null> {
    try {
      const surfaces = await cmuxJson("surface", "list");
      const list = Array.isArray(surfaces) ? surfaces : surfaces.surfaces ?? [];
      const devTty = ttyName.startsWith("/dev/") ? ttyName : `/dev/${ttyName}`;
      const match = list.find(
        (s: any) => s.tty === devTty || s.tty === ttyName,
      );
      return match ? String(match.id ?? match.surfaceId ?? match.surface_id) : null;
    } catch (e) {
      console.error(`[crew] cmux sessionIdForTty failed for ${ttyName}:`, e);
      return null;
    }
  }

  async splitPane(direction: "horizontal" | "vertical"): Promise<string> {
    // cmux: horizontal (below) = "down", vertical (right) = "right"
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const result = await cmuxJson("split", cmuxDir);
    return String(result.surfaceId ?? result.surface_id ?? result.id);
  }

  async splitSession(
    sessionId: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const result = await cmuxJson("split", cmuxDir, "--surface", sessionId);
    return String(result.surfaceId ?? result.surface_id ?? result.id);
  }

  async writeToSession(sessionId: string, text: string): Promise<void> {
    await $`cmux send --surface ${sessionId} ${text}`.quiet();
  }

  async closeSession(sessionId: string): Promise<void> {
    // cmux may use surface close or a similar command
    // Try the most likely API shape
    try {
      await $`cmux surface close ${sessionId}`.quiet();
    } catch {
      // Fall back to sending exit command if close isn't supported
      await this.writeToSession(sessionId, "exit\n");
    }
  }

  async isSessionAlive(sessionId: string): Promise<boolean> {
    try {
      const surfaces = await cmuxJson("surface", "list");
      const list = Array.isArray(surfaces) ? surfaces : surfaces.surfaces ?? [];
      return list.some(
        (s: any) =>
          String(s.id ?? s.surfaceId ?? s.surface_id) === String(sessionId),
      );
    } catch {
      return false;
    }
  }

  async createTab(): Promise<string> {
    const result = await cmuxJson("workspace", "new");
    // Return the surface ID of the new workspace's initial surface
    return String(
      result.surfaceId ??
        result.surface_id ??
        result.id ??
        result.workspaceId ??
        result.workspace_id,
    );
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    try {
      await $`cmux status set --surface ${sessionId} name ${name}`.quiet();
    } catch {
      // Sidebar metadata may not be available for all surfaces — non-fatal
    }
  }

  async setTabName(_sessionId: string, _name: string): Promise<void> {
    // cmux workspace naming is handled at workspace level
    // This is a best-effort operation
    try {
      if (process.env.CMUX_WORKSPACE_ID) {
        await $`cmux workspace rename ${process.env.CMUX_WORKSPACE_ID} ${_name}`.quiet();
      }
    } catch {
      // No-op if not supported
    }
  }

  async setBadge(sessionId: string, text: string): Promise<void> {
    try {
      await $`cmux status set --surface ${sessionId} badge ${text}`.quiet();
    } catch {
      // Fall back to notification if status pills aren't supported
      try {
        await $`cmux notify ${text}`.quiet();
      } catch {
        // Non-fatal
      }
    }
  }

  writePaneProfile(_profile: PaneProfile): string {
    // cmux doesn't use dynamic profiles — return a dummy name.
    // The split commands work without profiles.
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
    // cmux ignores profiles — just do a normal split
    return this.splitSession(sessionId, direction);
  }

  async splitWebBrowser(
    _url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    // cmux's split browser command opens its embedded browser.
    // URL routing is handled by cmux's HTTP host allowlist in settings.
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const result = await cmuxJson("split", "browser", cmuxDir);
    return String(result.surfaceId ?? result.surface_id ?? result.id);
  }

  async splitSessionWebBrowser(
    sessionId: string,
    _url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    const cmuxDir = direction === "horizontal" ? "down" : "right";
    const result = await cmuxJson(
      "split",
      "browser",
      cmuxDir,
      "--surface",
      sessionId,
    );
    return String(result.surfaceId ?? result.surface_id ?? result.id);
  }
}
