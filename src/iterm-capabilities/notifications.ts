/**
 * iTerm2 Notifications capability — wraps the OSC sequences iTerm2 honors
 * for native macOS notification banner (OSC 9) and dock-bounce attention
 * request (OSC 1337 RequestAttention).
 *
 * Constructor-injected with a session-escape writer so the capability is
 * unit-testable in isolation: mock `writeEscape`, run notify(), assert the
 * OSC bytes that were written.
 */

import type { NotificationsCapability } from "../capabilities/notifications.js";

export type EscapeWriter = (sessionId: string, escape: string) => Promise<void>;

export class ItermNotifications implements NotificationsCapability {
  constructor(private readonly writeEscape: EscapeWriter) {}

  async notify(sessionId: string, title: string, body?: string): Promise<void> {
    // OSC 9 displays a macOS notification banner. iTerm2 reads through to
    // NSUserNotificationCenter when a profile permits it.
    const msg = body ? `${title}: ${body}` : title;
    await this.writeEscape(sessionId, `\x1b]9;${msg}\x07`);
  }

  async flash(sessionId: string): Promise<void> {
    // OSC 1337 RequestAttention=fireworks bounces the iTerm2 dock icon.
    await this.writeEscape(sessionId, "\x1b]1337;RequestAttention=fireworks\x07");
  }
}
