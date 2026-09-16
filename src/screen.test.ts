import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseScreenList, pidLooksAlive, classifyRemotePidProbe, aliveFromProbe, requireObserved, ScreenProbeUnavailable } from "./screen";

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

// --- N3: the probe-failure discriminator ---
//
// ⛔ WHY THIS EXISTS. `classifyRemotePidProbe` decides whether a `screen -ls` run was
// OBSERVED at all. It previously lived inline with no test: forcing it to `true` —
// deleting the discriminator entirely and restoring the exact defect it exists to fix —
// passed the whole 354-test suite. Its only other appearance is a MOCK in
// orchestrator.test.ts, which reimplements the interface and so tests the caller's
// handling of the contract, never the implementation that produces it.
//
// It is a heuristic over ANOTHER PROGRAM'S output, so the fixtures matter more than the
// assertions. Provenance is marked per case and is NOT uniform:
//
//   [OBSERVED]  captured from a real `screen -ls` on this box, both binaries
//               (Apple 4.00.03 at /usr/bin/screen, Homebrew 5.0.1 which findScreen()
//               prefers). These are bytes, not reconstructions.
//   [SYNTHETIC] hand-constructed. NO real sudo-refusal or unreadable-SCREENDIR output
//               was captured, so these encode an ASSUMPTION about what those failures
//               look like — that they print to stderr and emit no session list. The
//               assumption is the thing under test, and if it is wrong these tests
//               will keep passing while production misclassifies. Stated, not hidden.
describe("classifyRemotePidProbe", () => {
  const probe = (stdout: string, stderr = "", exitCode = 0) =>
    classifyRemotePidProbe({ stdout, stderr, exitCode }, "revprobe", "_ephemeral");

  test("[OBSERVED] an empty namespace is ABSENT, not unobservable — despite exiting 1", () => {
    // The case that makes exit status useless as a discriminator: rc is 1 and the
    // message goes to STDOUT. Treating rc!=0 as probe failure would report every
    // empty namespace as unreadable.
    const r = probe("No Sockets found in /private/tmp/sd.revprobe.\n\n", "", 1);
    expect(r).toEqual({ ok: true, pid: null });
  });

  test("[OBSERVED] a populated listing yields the pid", () => {
    const r = probe("There is a screen on:\n\t76769.revprobe\t(Detached)\n1 Socket in /private/tmp/sd.revprobe.\n\n", "", 0);
    expect(r).toEqual({ ok: true, pid: 76769 });
  });

  test("[OBSERVED] a populated listing NOT naming our session is ABSENT", () => {
    const r = probe("There is a screen on:\n\t76769.someoneelse\t(Detached)\n1 Socket in /private/tmp/sd.revprobe.\n\n", "", 0);
    expect(r).toEqual({ ok: true, pid: null });
  });

  test("[SYNTHETIC] a sudo refusal is UNOBSERVABLE and names the sudo category", () => {
    const r = probe("", "sudo: a password is required\n", 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/sudo refused for uid '_ephemeral'/);
  });

  test("[SYNTHETIC] an unreadable SCREENDIR is UNOBSERVABLE and names that category", () => {
    const r = probe("", "screen: cannot open /Users/_ephemeral/.screen: Permission denied\n", 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/SCREENDIR unreadable for uid '_ephemeral'/);
  });

  test("[SYNTHETIC] silence with no stderr is UNOBSERVABLE, generic category", () => {
    const r = probe("", "", 127);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no parseable screen output, exit 127/);
  });

  test("the reason never echoes an arbitrary stderr line back to the caller", () => {
    // stderr can carry a path or a token; a caller may log the reason verbatim.
    const r = probe("", "sudo: /Users/_ephemeral/.ssh/id_ed25519 rejected\n", 1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).not.toContain("id_ed25519");
      expect(r.reason).not.toContain(".ssh");
    }
  });

  test("CONTROL: the discriminator can REFUSE — forcing it open must change these results", () => {
    // The mutant that survived: `looksLikeScreenOutput = true`. Under it, the three
    // SYNTHETIC cases above all return {ok:true,pid:null} — indistinguishable from a
    // genuinely empty namespace. This asserts the two classes are distinguishable at
    // all, which is the property the suite could not previously see.
    const absent = probe("No Sockets found in /private/tmp/sd.revprobe.\n", "", 1);
    const unobservable = probe("", "sudo: a password is required\n", 1);
    expect(absent.ok).toBe(true);
    expect(unobservable.ok).toBe(false);
  });
});


// --- N4 decision helpers: UNKNOWN must never read as absence ---
describe("aliveFromProbe — the fail-closed liveness mapping", () => {
  test("an UNOBSERVABLE probe reports ALIVE, never dead", () => {
    // ⛔ The whole point. Returning false here is the defect that let a caller
    // prune a live agent row on a sudo refusal.
    expect(aliveFromProbe({ ok: false, reason: "sudo refused for uid 'x'" }, "wire-x")).toBe(true);
  });
  test("an observed absence reports NOT alive", () => {
    expect(aliveFromProbe({ ok: true, pid: null }, "wire-x")).toBe(false);
  });
  test("an observed session reports alive", () => {
    expect(aliveFromProbe({ ok: true, pid: 4242 }, "wire-x")).toBe(true);
  });
});

describe("requireObserved — a number cannot express 'I could not look'", () => {
  test("an UNOBSERVABLE probe THROWS rather than returning a countable zero", () => {
    // Returning 0/null here would certify "zero survivors", "nothing to terminate",
    // or "not there yet" from a probe that never saw the namespace.
    expect(() => requireObserved({ ok: false, reason: "SCREENDIR unreadable for uid 'x'" }))
      .toThrow(ScreenProbeUnavailable);
    try {
      requireObserved({ ok: false, reason: "SCREENDIR unreadable for uid 'x'" });
    } catch (e) {
      expect((e as ScreenProbeUnavailable).reason).toBe("SCREENDIR unreadable for uid 'x'");
    }
  });
  test("an observed absence passes through as null — absence is a legitimate answer", () => {
    expect(requireObserved({ ok: true, pid: null })).toBeNull();
  });
  test("an observed pid passes through", () => {
    expect(requireObserved({ ok: true, pid: 76769 })).toBe(76769);
  });
});

test("N4 wiring: all three numeric-return consumers route through requireObserved", () => {
  // Structural, same limit as the N3 wiring check: these shell out and cannot be
  // exercised without a live screen, which is not authorized. What is checkable is
  // that none of them still consumes the raw probe.
  //
  // ⚠️ Slice to the NEXT top-level declaration, not a fixed character count. My first
  // version used a 300-char window and failed because a comment I had just written
  // pushed the call past it — a test that reports on comment length rather than on
  // the property it names.
  const src = readFileSync(new URL("./screen.ts", import.meta.url), "utf8");
  const bodyOf = (decl: string): string => {
    const i = src.indexOf(decl);
    expect({ decl, found: i >= 0 }).toEqual({ decl, found: true });
    const rest = src.slice(i + decl.length);
    const end = rest.search(/\n(export|\/\*\*)/);
    return rest.slice(0, end === -1 ? rest.length : end);
  };
  for (const fn of ["killRemoteSession", "terminateRemoteSessionTree", "pollRemoteSessionPid"]) {
    expect({ fn, routed: bodyOf(`export async function ${fn}`).includes("requireObserved") })
      .toEqual({ fn, routed: true });
  }
  expect({ fn: "isRemoteAlive", routed: bodyOf("export async function isRemoteAlive(").includes("aliveFromProbe") })
    .toEqual({ fn: "isRemoteAlive", routed: true });
  // And the N3 wrapper, checked the same way.
  const checked = bodyOf("export async function getRemoteSessionPidChecked");
  expect(checked).toContain("classifyRemotePidProbe");
  expect(checked).toContain("sshRunStatus");
});
