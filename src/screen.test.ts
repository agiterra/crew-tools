import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { parseScreenList, pidLooksAlive } from "./screen";

// Regression tests for 24f3d06: screen_alive reported dead sockets as alive.
// A socket is not a session — the parser used to DISCARD the state field, and
// isAlive trusted socket presence alone.

describe("parseScreenList", () => {
  const output = [
    "There are screens on:",
    "\t53201.fondant\t(Attached)",
    "\t34041.wire-koulouri\t(Detached)",
    "\t51768.corpse\t(Remote or dead)",
    "3 Sockets in /tmp/screens/S-fondant.",
    "",
  ].join("\n");

  test("captures pid, name, and state for every session line", () => {
    const sessions = parseScreenList(output);
    expect(sessions).toEqual([
      { name: "fondant", pid: 53201, state: "Attached" },
      { name: "wire-koulouri", pid: 34041, state: "Detached" },
      { name: "corpse", pid: 51768, state: "Remote or dead" },
    ]);
  });

  test("dead sockets are still LISTED — liveness is the pid probe's job", () => {
    // The state label is not a safe discriminator ("Remote or dead" is
    // ambiguous by its own wording); the fix keys on the pid instead. The
    // parser must not filter — downstream decides.
    const sessions = parseScreenList(output);
    expect(sessions.map((s) => s.name)).toContain("corpse");
  });

  test("ignores non-session lines and handles empty input", () => {
    expect(parseScreenList("")).toEqual([]);
    expect(parseScreenList("No Sockets found in /tmp/screens.\n")).toEqual([]);
  });

  test("tolerates a missing state field (older screen formats)", () => {
    const sessions = parseScreenList("\t123.bare\t\n");
    expect(sessions).toEqual([{ name: "bare", pid: 123, state: undefined }]);
  });
});

describe("pidLooksAlive", () => {
  test("own process is alive", () => {
    expect(pidLooksAlive(process.pid)).toBe(true);
  });

  test("a reaped process is provably dead (ESRCH)", () => {
    // Spawn and fully reap a child; its pid no longer exists.
    const child = spawnSync("true");
    expect(child.pid).toBeGreaterThan(0);
    expect(pidLooksAlive(child.pid!)).toBe(false);
  });

  test("EPERM (exists, other uid) counts as ALIVE — the AGI-69 rule", () => {
    // pid 1 is launchd (root): kill(1, 0) from a non-root test run raises
    // EPERM, which must read as alive. If the suite ever runs as root the
    // probe legitimately succeeds — same verdict either way.
    expect(pidLooksAlive(1)).toBe(true);
  });
});
