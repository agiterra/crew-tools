/**
 * Integration test for cmux Notifications.
 *
 * Runs against the live CmuxBackend (which means a real cmux daemon and a
 * real surface). Gated on cmux CLI being on PATH; otherwise skipped. Brian
 * runs this on his cmux-equipped box; CI does not (no daemon).
 *
 * To run: `bun test src/cmux-capabilities/notifications.integration.test.ts`
 * To skip: just don't have cmux on PATH, or set CREW_SKIP_CMUX_INTEGRATION=1.
 */

import { describe, test, expect } from "bun:test";
import { existsSync } from "fs";

// Probe a few well-known cmux CLI locations on macOS. cmux's bundle id varies
// across operator setups (agiterra.app, agiterra-overlay.app, cmux.app); the
// CLI is always at <bundle>/Contents/Resources/bin/cmux. Falls back to PATH.
const CANDIDATE_CMUX_BINS = [
  process.env.CMUX_BUNDLED_CLI_PATH,
  "/Applications/agiterra.app/Contents/Resources/bin/cmux",
  "/Applications/agiterra-overlay.app/Contents/Resources/bin/cmux",
  "/Applications/cmux.app/Contents/Resources/bin/cmux",
].filter((p): p is string => Boolean(p));

const cmuxAvailable =
  CANDIDATE_CMUX_BINS.some((p) => existsSync(p)) &&
  !process.env.CREW_SKIP_CMUX_INTEGRATION;

describe.if(cmuxAvailable)("cmux Notifications — live integration", () => {
  test("notify against the focused surface does not throw", async () => {
    const { CmuxBackend } = await import("../cmux");
    const backend = new CmuxBackend();
    const notif = backend.capability("notifications");
    expect(notif).not.toBeNull();
    const sid = await backend.currentSessionId();
    // Real notification fires; integration test just asserts the call path
    // doesn't throw. Visual confirmation is on the operator.
    await expect(
      notif!.notify(sid, "crew-tools integration", "notification test"),
    ).resolves.toBeUndefined();
  });

  test("flash against the focused surface does not throw", async () => {
    const { CmuxBackend } = await import("../cmux");
    const backend = new CmuxBackend();
    const notif = backend.capability("notifications");
    expect(notif).not.toBeNull();
    const sid = await backend.currentSessionId();
    await expect(notif!.flash(sid)).resolves.toBeUndefined();
  });
});

describe.if(!cmuxAvailable)("cmux Notifications — live integration (SKIPPED)", () => {
  test("cmux CLI not found at expected path; skipping integration suite", () => {
    expect(cmuxAvailable).toBe(false);
  });
});
