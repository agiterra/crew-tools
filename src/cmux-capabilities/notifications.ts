/**
 * cmux Notifications capability — wraps cmux's native `notify` and
 * `trigger-flash` CLI commands.
 *
 * Constructor-injected with the cmux CLI invoker and surface-args resolver
 * from the backend so the capability is unit-testable in isolation: mock the
 * `cli` function, run notify(), assert the args.
 */

import type { NotificationsCapability } from "../capabilities/notifications.js";

export type CmuxCli = (...args: string[]) => Promise<string>;
export type SurfaceArgsResolver = (sessionId: string) => Promise<string[]>;

export class CmuxNotifications implements NotificationsCapability {
  constructor(
    private readonly cli: CmuxCli,
    private readonly surfaceArgs: SurfaceArgsResolver,
  ) {}

  async notify(sessionId: string, title: string, body?: string): Promise<void> {
    try {
      const surfaceArgs = await this.surfaceArgs(sessionId);
      const args = ["notify", "--title", title, ...surfaceArgs];
      if (body) args.push("--body", body);
      await this.cli(...args);
    } catch {
      // Non-fatal — notifications are decorative.
    }
  }

  async flash(sessionId: string): Promise<void> {
    try {
      const args = await this.surfaceArgs(sessionId);
      await this.cli("trigger-flash", ...args);
    } catch {
      // Non-fatal — flash is decorative.
    }
  }
}
