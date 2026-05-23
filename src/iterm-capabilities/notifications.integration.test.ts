/**
 * Integration test for iTerm2 Notifications.
 *
 * Runs against the live ItermBackend (which means a real iTerm2 process and
 * a real TTY). Gated on running inside iTerm2 (ITERM_SESSION_ID env);
 * otherwise skipped. Tim runs this on his iTerm-equipped box; CI does not.
 *
 * To run: `bun test src/iterm-capabilities/notifications.integration.test.ts`
 * (must be invoked from within an iTerm2 session)
 * To skip: run from any other terminal, or set CREW_SKIP_ITERM_INTEGRATION=1.
 */

import { describe, test, expect } from "bun:test";

const itermAvailable =
  !!process.env.ITERM_SESSION_ID && !process.env.CREW_SKIP_ITERM_INTEGRATION;

describe.if(itermAvailable)("iTerm2 Notifications — live integration", () => {
  test("notify against the current session does not throw", async () => {
    const { ItermBackend } = await import("../iterm-backend");
    const backend = new ItermBackend();
    const notif = backend.capability("notifications");
    expect(notif).not.toBeNull();
    const sid = await backend.currentSessionId();
    // OSC 9 banner fires; integration test just asserts the call path
    // doesn't throw. Visual confirmation is on the operator.
    await expect(
      notif!.notify(sid, "crew-tools integration", "notification test"),
    ).resolves.toBeUndefined();
  });

  test("flash against the current session does not throw", async () => {
    const { ItermBackend } = await import("../iterm-backend");
    const backend = new ItermBackend();
    const notif = backend.capability("notifications");
    expect(notif).not.toBeNull();
    const sid = await backend.currentSessionId();
    await expect(notif!.flash(sid)).resolves.toBeUndefined();
  });
});

describe.if(!itermAvailable)("iTerm2 Notifications — live integration (SKIPPED)", () => {
  test("ITERM_SESSION_ID not set; skipping integration suite", () => {
    expect(itermAvailable).toBe(false);
  });
});
