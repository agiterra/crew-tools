/**
 * cmux SidebarLog capability — wraps `cmux log`, which writes workspace-
 * level sidebar entries that the operator sees without opening any specific
 * pane. Constructor-injected with the cmux CLI and a workspace-ref resolver
 * so it's unit-testable in isolation.
 */

import type {
  SidebarLogCapability,
  SidebarLogLevel,
} from "../capabilities/sidebar-log.js";

export type CmuxCli = (...args: string[]) => Promise<string>;
export type WorkspaceResolver = (sessionId: string) => Promise<string | null>;

export class CmuxSidebarLog implements SidebarLogCapability {
  constructor(
    private readonly cli: CmuxCli,
    private readonly resolveWorkspace: WorkspaceResolver,
  ) {}

  async append(
    sessionId: string,
    message: string,
    opts?: { level?: SidebarLogLevel; source?: string },
  ): Promise<void> {
    try {
      const wsRef = await this.resolveWorkspace(sessionId);
      const wsFlag = wsRef ? ["--workspace", wsRef] : [];
      const levelFlag = opts?.level ? ["--level", opts.level] : [];
      const sourceFlag = ["--source", opts?.source ?? "crew"];
      // cmux log puts the message after `--`, supporting messages that start with `-`.
      await this.cli("log", ...wsFlag, ...levelFlag, ...sourceFlag, "--", message);
    } catch {
      // Non-fatal — sidebar log is decorative.
    }
  }
}
