/**
 * Notifications contract — shared assertions every backend's Notifications
 * implementation must pass. Backend-specific test files (cmux/iterm) call
 * `runNotificationsContract(impl)` from their suites; the impl can be the
 * real backend's capability or a mocked one wired against the same
 * interface.
 *
 * The contract checks SEMANTIC obligations, not transport details:
 *  - notify() resolves without throwing when given valid inputs
 *  - flash() resolves without throwing when given valid inputs
 *  - notify() tolerates an absent `body`
 *  - both methods accept the same `sessionId` shape the rest of the
 *    backend accepts (we don't make assumptions about format)
 *
 * Transport assertions (correct OSC bytes for iTerm, correct CLI args for
 * cmux) live in each backend's own unit tests, not here.
 */

import { describe, test, expect } from "bun:test";
import type { NotificationsCapability } from "./notifications.js";

export function runNotificationsContract(
  label: string,
  factory: () => NotificationsCapability,
  opts: { exampleSessionId: string },
): void {
  describe(`NotificationsCapability contract — ${label}`, () => {
    test("notify resolves with title only", async () => {
      const impl = factory();
      await expect(impl.notify(opts.exampleSessionId, "test title")).resolves.toBeUndefined();
    });

    test("notify resolves with title and body", async () => {
      const impl = factory();
      await expect(
        impl.notify(opts.exampleSessionId, "test title", "test body"),
      ).resolves.toBeUndefined();
    });

    test("flash resolves", async () => {
      const impl = factory();
      await expect(impl.flash(opts.exampleSessionId)).resolves.toBeUndefined();
    });

    test("notify with empty body still resolves", async () => {
      const impl = factory();
      await expect(impl.notify(opts.exampleSessionId, "title", "")).resolves.toBeUndefined();
    });
  });
}
