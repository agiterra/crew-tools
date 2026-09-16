import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { readFileSync } from "node:fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TerminalBackend } from "./terminal";

// Capture the command passed to screen.createSession so we can assert on the
// spawn-time env exports. Mock is installed before Orchestrator is imported.
const createSessionCalls: Array<{ name: string; command: string }> = [];
const screenState = {
  isAliveResult: false,
  isAttachedResult: false,
  // Scriptable screen content, KEYED BY SCREEN NAME so tests can't bleed
  // into the background auto-confirm loops of agents launched by other
  // tests (those poll their own wire-<id> screens, which stay blank).
  // Reads pop the named queue, then fall back to the named default.
  // sendKeys appends to the log and fires the optional hook so a test
  // can flip screen content in reaction to a CR.
  screens: {} as Record<string, { queue: string[]; fallback: string }>,
  sendKeysLog: [] as Array<{ name: string; keys: string }>,
  sendKeysHook: null as ((name: string, keys: string) => void) | null,
  // When set, readOutput/readRemoteOutput call this first — lets a test make
  // reads THROW (distinct from reads returning empty; the confirm counts them
  // separately since the 2026-08-04 RCA).
  readOutputHook: undefined as (() => void) | undefined,
  killSessionCalls: [] as string[],
  killSessionSurvivors: 0,
  terminateSessionCalls: [] as Array<{ name: string; timeoutMs: number }>,
  terminateSessionSurvivors: 0,
  // Scriptable ACTING argv for the post-spawn read-back chain. null = the probe
  // saw nothing (the argv-unreadable path).
  argvResult: null as string | null,
  sshRunCalls: [] as Array<{ target: unknown; command: string }>,
  // Cross-uid registration (coupled registration patch): the runAsUid path
  // resolves liveness through getRemoteSessionPid + pidLooksAlive instead of
  // the local isAlive, so both must be scriptable to cover it.
  remoteSessionPidResult: null as number | null,
  /** When set, getRemoteSessionPidChecked reports PROBE FAILURE with this reason. */
  remoteProbeFailure: null as string | null,
  /** When >0, the next N probes fail then recovery is observed. Decremented per probe. */
  remoteProbeFailuresRemaining: 0,
  // null = DELEGATE to the real pidLooksAlive. An unconditional override here would
  // replace it PROCESS-WIDE (mock.module), breaking screen.test.ts's ESRCH test —
  // which is exactly what mock-isolation.test.ts caught. Opt in per test, never by default.
  pidLooksAliveResult: null as boolean | null,
  sshRunResult: "",
};

// Wire broker stub. The inbound read-back's default reader is an HTTP GET
// against a REAL broker on localhost:9800 — a test suite must never touch that,
// so global fetch is replaced here for the whole file. Tests script the roster;
// anything not scripted answers with an empty roster.
const wireState = {
  roster: [] as Array<{ id: string; connection_status?: string }>,
  /** When set, the stubbed fetch throws it (probe-fault path). */
  failWith: null as string | null,
  /** Non-array body to exercise the shape-change guard. */
  bodyOverride: undefined as unknown,
  calls: [] as string[],
};
globalThis.fetch = (async (input: unknown) => {
  wireState.calls.push(String(input));
  if (wireState.failWith) throw new Error(wireState.failWith);
  const body = wireState.bodyOverride !== undefined ? wireState.bodyOverride : wireState.roster;
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}) as unknown as typeof fetch;
import * as __realScreen from "./screen";
// ⛔ Captured EAGERLY, before mock.module runs. A late `__realScreen.pidLooksAlive(pid)`
// inside the mock resolves through the LIVE namespace — which mock.module has by then
// replaced with this very mock — so the wrapper calls itself. Infinite recursion, and it
// presents as the paired run HANGING, not as a failed assertion.
const realPidLooksAlive = __realScreen.pidLooksAlive;
// ⛔ CROSS-FILE MOCK CONTAMINATION (CI, Bun 1.4.2; hypothesis from Brioche's source read,
// reproduced locally). `mock.module` replaces the module PROCESS-WIDE for every later import.
// This mock enumerated the handful of functions this file needs and omitted the rest — so once
// this file had run, `screen.test.ts`'s `import { parseScreenList } from "./screen"` resolved
// against the MOCK and failed with:
//     SyntaxError: Export named 'parseScreenList' not found in module 'screen.ts'
// ORDER-DEPENDENT, and therefore invisible until something changed the order — which adding a
// large test file to this suite did. Measured: cli.test.ts then screen.test.ts -> 10 pass,
// 1 fail, 1 error; screen.test.ts first -> 17 pass, 0 fail.
// ⚠️ I had inferred "pre-existing, not mine" from the production files being untouched. That is
// a NON-SEQUITUR: an unchanged production file does not rule out a SUITE INTEGRATION fault.
// ⇒ SPREAD THE REAL MODULE and override only what this file mocks, so the mock is complete BY
//   CONSTRUCTION and a new export can never be silently dropped again. Same rule as
//   derive-the-list-never-duplicate-it: never hand-maintain a second copy of a surface.
/** The single source of probe-failure truth for every mocked probe path. */
function nextProbe(): { ok: true; pid: number | null } | { ok: false; reason: string } {
  if (screenState.remoteProbeFailuresRemaining > 0) {
    screenState.remoteProbeFailuresRemaining -= 1;
    return { ok: false, reason: "transient: sudo refused" };
  }
  return screenState.remoteProbeFailure
    ? { ok: false, reason: screenState.remoteProbeFailure }
    : { ok: true, pid: screenState.remoteSessionPidResult };
}

mock.module("./screen", () => ({
  ...__realScreen,
  createSession: async (name: string, command: string) => {
    createSessionCalls.push({ name, command });
    return { name, pid: 12345 };
  },
  listSessions: async () => [],
  getSessionPid: async () => null,
  isAlive: async () => screenState.isAliveResult,
  isAttached: async () => screenState.isAttachedResult,
  detachSession: async () => {},
  sendKeys: async (name: string, keys: string) => {
    screenState.sendKeysLog.push({ name, keys });
    screenState.sendKeysHook?.(name, keys);
  },
  readOutput: async (name: string) => {
    screenState.readOutputHook?.();
    const s = screenState.screens[name];
    if (!s) return "";
    return s.queue.length > 0 ? s.queue.shift()! : s.fallback;
  },
  killSession: async (name: string) => {
    screenState.killSessionCalls.push(name);
    return screenState.killSessionSurvivors;
  },
  terminateSessionTree: async (name: string, timeoutMs: number) => {
    screenState.terminateSessionCalls.push({ name, timeoutMs });
    return screenState.terminateSessionSurvivors;
  },
  // Cross-UID/remote screen surface (v2.19.0). Tests drive same-UID agents, so
  // these mirror the local mocks; a test exercising a run_as_uid agent keys the
  // same screenState by screen name.
  LOCAL_SUDO_HOST: "local",
  sendRemoteKeys: async (name: string, keys: string) => {
    screenState.sendKeysLog.push({ name, keys });
    screenState.sendKeysHook?.(name, keys);
  },
  readRemoteOutput: async (name: string) => {
    screenState.readOutputHook?.();
    const s = screenState.screens[name];
    if (!s) return "";
    return s.queue.length > 0 ? s.queue.shift()! : s.fallback;
  },
  isRemoteAlive: async () => screenState.isAliveResult,
  terminateRemoteSessionTree: async (name: string, _target: unknown, timeoutMs: number) => {
    // Mirrors production: the survivor count comes from a probe, so an unobservable
    // namespace must throw rather than report a number.
    const p = nextProbe();
    if (!p.ok) throw new __realScreen.ScreenProbeUnavailable(p.reason);
    screenState.terminateSessionCalls.push({ name, timeoutMs });
    return screenState.terminateSessionSurvivors;
  },
  createRemoteSession: async (name: string, command: string) => {
    createSessionCalls.push({ name, command });
    return { name, pid: 12345 };
  },
  // Imported by credentials.ts (remote credential read) and by the codex-spawn
  // teardown (cross-uid rm). Recorded so a test can assert the exact command,
  // and scriptable so it can replay a remote rm that did / did not succeed.
  sshRun: async (target: unknown, command: string) => {
    screenState.sshRunCalls.push({ target, command });
    return screenState.sshRunResult;
  },
  getRemoteSessionPid: async () => screenState.remoteSessionPidResult,
  // ⛔ ONE probe-failure decision, consumed by EVERY probe path. Two copies is how the
  // transient countdown got decremented by one caller and not another, and a test then
  // passed for the wrong reason.
  getRemoteSessionPidChecked: async () => nextProbe(),
  killRemoteSession: async (name: string, t: unknown) => {
    // Mirrors production: a probe that could not look must not certify zero survivors.
    const p = nextProbe();
    if (!p.ok) throw new __realScreen.ScreenProbeUnavailable(p.reason);
    screenState.killSessionCalls.push(name);
    void t;
    return screenState.killSessionSurvivors;
  },
  isRemoteAliveChecked: async () => {
    const p = nextProbe();
    return p.ok ? { ok: true as const, alive: screenState.isAliveResult } : p;
  },
  pidLooksAlive: (pid: number) => screenState.pidLooksAliveResult ?? realPidLooksAlive(pid),
  pollRemoteSessionPid: async () => null,
  // Post-spawn verify chain (v2.26.0). Tests inject channelProbe/argvReader
  // explicitly; these defaults make un-injected background chains resolve
  // immediately instead of polling their full windows against a dead mock.
  channelPluginAlive: async () => false,
  sessionClaudeArgv: async () => screenState.argvResult,
}));

const { Orchestrator, SOURCE_NEAREST_ENV, WIPE_CLAUDE_SETTINGS_LOCAL, autoConfirmDevChannel, askedFromCommand, verifySpawnArgv, verifyWireInbound } = await import("./orchestrator");

function makeTerminal(): TerminalBackend {
  return {
    name: "test",
    currentSessionId: mock(async () => ""),
    sessionIdForTty: mock(async () => null),
    enumerateSessions: mock(async () => []),
    splitPane: mock(async () => ""),
    splitSession: mock(async () => ""),
    writeToSession: mock(async () => {}),
    closeSession: mock(async () => {}),
    isSessionAlive: mock(async () => true),
    createTab: mock(async () => ""),
    setSessionName: mock(async () => {}),
    setBadge: mock(async () => {}),
    flashSession: mock(async () => {}),
    notifySession: mock(async () => {}),
    renameWorkspace: mock(async () => {}),
    writePaneProfile: mock(() => "Crew Test"),
    deletePaneProfile: mock(() => {}),
    setProfile: mock(async () => {}),
    sendText: mock(async () => {}),
  } as unknown as TerminalBackend;
}

let tmpDir: string;
let dbPath: string;
let orch: InstanceType<typeof Orchestrator>;

/**
 * ⛔ THE ONE reset list. It existed twice: beforeEach reset fifteen fields, a later
 * afterAll reset five, and the two had already diverged by eleven entries. That is the
 * defect this file's own mock.module banner warns about — never hand-maintain a second
 * copy of a surface. Deciding WHICH fields 'can' leak is the judgement that produced a
 * 5-of-16 list, so the list no longer admits that judgement.
 *
 * Called per-test AND at file scope: mock.module replaces ./screen PROCESS-WIDE, so
 * whatever the last test here leaves behind is still in effect for the NEXT FILE.
 */
function resetScreenState(): void {
  // ⓘ isAliveResult was in NEITHER list when this was extracted — beforeEach never
  //   reset it (individual tests used `finally`), and the old afterAll DID. So the two
  //   hand-maintained copies diverged in BOTH directions, which is the argument for
  //   having one. Added here so the list is the full declared surface, 17 of 17.
  screenState.isAliveResult = false;
  screenState.screens = {};
  screenState.sendKeysLog.length = 0;
  screenState.sendKeysHook = null;
  screenState.readOutputHook = undefined;
  screenState.killSessionCalls.length = 0;
  screenState.killSessionSurvivors = 0;
  screenState.terminateSessionCalls.length = 0;
  screenState.terminateSessionSurvivors = 0;
  screenState.argvResult = null;
  screenState.remoteSessionPidResult = null;
  screenState.remoteProbeFailure = null;
  screenState.remoteProbeFailuresRemaining = 0;
  screenState.pidLooksAliveResult = null;
  screenState.isAttachedResult = false;
  screenState.sshRunCalls.length = 0;
  screenState.sshRunResult = "";
}

beforeEach(() => {
  // These exercise spawn MECHANICS (env forwarding, manifest, machine routing)
  // against a mocked screen — bypass the Phase-2 fail-closed credential guard so
  // they don't depend on a live Claude credential in $HOME. The guard has its
  // own coverage in credentials.test.ts.
  process.env.CREW_SKIP_CRED_CHECK = "1";
  tmpDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  dbPath = join(tmpDir, "test.db");
  orch = new Orchestrator(makeTerminal(), dbPath);
  createSessionCalls.length = 0;
  // F6: these are scriptable like every field above, so they reset like every field
  // above. Relying on per-test `finally` worked, but pidLooksAliveResult is uniquely
  // dangerous — mock.module replaces ./screen PROCESS-WIDE, so a leak here breaks
  // screen.test.ts's ESRCH assertion in a DIFFERENT FILE, order-dependently.
  wireState.roster = [];
  wireState.failWith = null;
  wireState.bodyOverride = undefined;
  wireState.calls.length = 0;
  resetScreenState();
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("launchAgent env forwarding", () => {
  test("AGENT_ID and AGENT_NAME flow through env, not separate params", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "test-agent", AGENT_NAME: "Test Agent" },
    });

    expect(createSessionCalls).toHaveLength(1);
    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain("AGENT_ID='test-agent'");
    expect(cmd).toContain("TMPDIR='/tmp/agiterra-lane-test-agent'"); // per-lane TMPDIR at spawn (pasticciotti)
    expect(cmd).toContain("mkdir -p '/tmp/agiterra-lane-test-agent'");
    expect(cmd).toContain("AGENT_NAME='Test Agent'");
    // ENG-3719: shared-DB endpoints inherited from the nearest .env are cleared AFTER it is sourced,
    // so a lane's isolated stack (config/local.json) wins and cannot be silently bypassed.
    expect(cmd).toContain("unset LOCAL_DATABASE_URL DB_CONN_STRING APP_CACHE_URL QUEUE_URL");
    expect(cmd.indexOf("set +a")).toBeLessThan(cmd.indexOf("unset LOCAL_DATABASE_URL"));
  });

  test("throws when env.AGENT_ID is missing", async () => {
    await expect(
      orch.launchAgent({ env: {} }),
    ).rejects.toThrow("env.AGENT_ID is required");
  });

  test("AGENT_NAME defaults to AGENT_ID when omitted", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "solo" } });

    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain("AGENT_ID='solo'");
    // DB record uses AGENT_ID as display name fallback
    const agent = orch.store.getAgent("solo");
    expect(agent?.display_name).toBe("solo");
  });

  test("exports AGENT_PRIVATE_KEY verbatim alongside identity vars", async () => {
    await orch.launchAgent({
      env: {
        AGENT_ID: "waffles",
        AGENT_NAME: "Waffles",
        AGENT_PRIVATE_KEY: "MC4CAQAwBQYDK2VwBCIEtestkey",
      },
      prompt: "verify the deploy",
    });

    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain("AGENT_PRIVATE_KEY='MC4CAQAwBQYDK2VwBCIEtestkey'");
    expect(cmd).toContain("AGENT_ID='waffles'");
  });

  test("exports arbitrary env vars without domain knowledge", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "test-agent", FOO: "bar", BAZ: "qux space" },
    });

    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain("FOO='bar'");
    expect(cmd).toContain("BAZ='qux space'");
  });

  test("shell-escapes env values containing single quotes", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "test-agent", TRICKY: "it's a test" },
    });

    const cmd = createSessionCalls[0]!.command;
    // shellEscape wraps in single quotes and escapes embedded ' as '\''
    expect(cmd).toContain("TRICKY='it'\\''s a test'");
  });

  test("does not synthesize built-in env vars — orchestrator owns identity", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "test-agent" },
    });

    const cmd = createSessionCalls[0]!.command;
    // Crew did NOT inject WIRE_URL or anything else the orchestrator didn't ask for
    expect(cmd).not.toContain("WIRE_URL=");
    expect(cmd).not.toContain("AGENT_PRIVATE_KEY=");
  });

  test("orchestrator can set WIRE_URL via env if needed", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "test-agent", WIRE_URL: "https://wire.example.com" },
    });

    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain("WIRE_URL='https://wire.example.com'");
  });
});

describe("idle TTL + reaper", () => {
  test("ttlIdleMinutes is persisted on the agent row", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "ephemeral" },
      ttlIdleMinutes: 60,
    });
    const agent = orch.store.getAgent("ephemeral");
    expect(agent?.ttl_idle_minutes).toBe(60);
  });

  test("omitting ttlIdleMinutes leaves the column null (unreapable)", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "permanent" } });
    const agent = orch.store.getAgent("permanent");
    expect(agent?.ttl_idle_minutes).toBeNull();
  });

  test("reap() stops agents past their idle threshold", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "stale" },
      ttlIdleMinutes: 30,
    });
    // Backdate last_seen so the agent looks 61 minutes idle.
    orch.store["db"].prepare("UPDATE agents SET last_seen = ? WHERE id = ?")
      .run(Date.now() - 61 * 60_000, "stale");

    const reaped = await orch.reap();
    expect(reaped).toContain("stale");
    expect(orch.store.getAgent("stale")).toBeNull();
  });

  test("reap() leaves fresh agents alone", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "fresh" },
      ttlIdleMinutes: 30,
    });
    const reaped = await orch.reap();
    expect(reaped).not.toContain("fresh");
    expect(orch.store.getAgent("fresh")).not.toBeNull();
  });

  test("reap() ignores agents without a ttl_idle_minutes", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "untracked" } });
    orch.store["db"].prepare("UPDATE agents SET last_seen = ? WHERE id = ?")
      .run(Date.now() - 24 * 60 * 60_000, "untracked");
    const reaped = await orch.reap();
    expect(reaped).not.toContain("untracked");
    expect(orch.store.getAgent("untracked")).not.toBeNull();
  });

  test("agent_send bumps last_seen so TTL timer restarts on activity", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "active" },
      ttlIdleMinutes: 5,
    });
    // Backdate last_seen
    const staleTs = Date.now() - 10 * 60_000;
    orch.store["db"].prepare("UPDATE agents SET last_seen = ? WHERE id = ?")
      .run(staleTs, "active");

    await orch.sendToAgent("active", "ping\n");

    const fresh = orch.store.getAgent("active");
    expect(fresh!.last_seen).toBeGreaterThan(staleTs);
  });
});

describe("machine-aware crew (v2.4.0)", () => {
  test("first-boot auto-registers the local machine", () => {
    const machines = orch.store.listMachines();
    expect(machines).toHaveLength(1);
    expect(machines[0].name).toBe(orch.store.localMachineName());
    expect(machines[0].ssh_host).toBe("localhost");
  });

  test("launchAgent stamps machine_name on the agent row", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "mx" } });
    const agent = orch.store.getAgent("mx");
    expect(agent?.machine_name).toBe(orch.store.localMachineName());
  });

  test("createMachine + listMachines round-trip", () => {
    orch.store.createMachine({
      name: "home-mini",
      hostname: "home-mini",
      ssh_host: "tim@home-mini.local",
    });
    const names = orch.store.listMachines().map((m) => m.name).sort();
    expect(names).toContain("home-mini");
    expect(names).toContain(orch.store.localMachineName());
  });

  test("deleteMachine refuses to remove the local machine", () => {
    expect(() => orch.store.deleteMachine(orch.store.localMachineName())).toThrow(
      /refusing to remove local machine/,
    );
  });

  test("deleteMachine removes non-local rows", () => {
    orch.store.createMachine({
      name: "other",
      hostname: "other",
      ssh_host: "tim@other.local",
    });
    orch.store.deleteMachine("other");
    expect(orch.store.getMachine("other")).toBeNull();
  });

  test("updateMachineProbe refreshes last_seen and crew_version", () => {
    orch.store.createMachine({
      name: "probe-target",
      hostname: "probe-target",
      ssh_host: "tim@probe-target.local",
    });
    orch.store.updateMachineProbe("probe-target", { last_seen: 12345, crew_version: "2.4.0" });
    const m = orch.store.getMachine("probe-target");
    expect(m?.last_seen).toBe(12345);
    expect(m?.crew_version).toBe("2.4.0");
  });
});

describe("spawn manifest + tombstones", () => {
  test("launchAgent persists a manifest stripped of AGENT_PRIVATE_KEY", async () => {
    await orch.launchAgent({
      env: {
        AGENT_ID: "danish",
        AGENT_NAME: "Danish",
        AGENT_PRIVATE_KEY: "secret-key-base64",
        KNOWLEDGE_ENRICH_RULES: '{"ipc":{"from":["brioche"]}}',
      },
      projectDir: "/tmp/danish-wd",
      prompt: "Run the ENG-3021 audit.",
      badge: "ENG-3021 Danish",
      ttlIdleMinutes: 60,
    });

    const row = orch.store.getAgent("danish");
    expect(row?.spawn_manifest).not.toBeNull();
    const manifest = JSON.parse(row!.spawn_manifest!);
    expect(manifest.env.AGENT_ID).toBe("danish");
    expect(manifest.env.AGENT_NAME).toBe("Danish");
    expect(manifest.env.KNOWLEDGE_ENRICH_RULES).toBe('{"ipc":{"from":["brioche"]}}');
    expect(manifest.env.AGENT_PRIVATE_KEY).toBeUndefined();
    expect(manifest.project_dir).toBe("/tmp/danish-wd");
    expect(manifest.prompt).toBe("Run the ENG-3021 audit.");
    expect(manifest.badge).toBe("ENG-3021 Danish");
    expect(manifest.ttl_idle_minutes).toBe(60);
  });

  test("stopAgent writes a tombstone and deletes the live row", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "galette" },
      projectDir: "/tmp/galette",
      badge: "ENG-3020",
    });
    screenState.isAliveResult = true;
    try {
      await orch.stopAgent("galette");
    } finally {
      screenState.isAliveResult = false;
    }

    expect(orch.store.getAgent("galette")).toBeNull();
    const tomb = orch.store.getLatestTombstone("galette");
    expect(tomb).not.toBeNull();
    expect(tomb!.id).toBe("galette");
    expect(tomb!.badge).toBe("ENG-3020");
    expect(tomb!.spawn_manifest).not.toBeNull();
    const manifest = JSON.parse(tomb!.spawn_manifest!);
    expect(manifest.project_dir).toBe("/tmp/galette");
  });

  test("closeAgent terminates codex bridge runtimes with SIGTERM instead of slash-exit", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "bridge" },
      runtime: "codex",
      projectDir: "/tmp/bridge",
    });

    const result = await orch.closeAgent("bridge", undefined, 250);

    expect(result.fallbackUsed).toBe(false);
    expect(screenState.sendKeysLog).toEqual([]);
    expect(screenState.terminateSessionCalls).toEqual([{ name: "wire-bridge", timeoutMs: 250 }]);
    expect(screenState.killSessionCalls).toEqual(["wire-bridge"]);
    expect(orch.store.getAgent("bridge")).toBeNull();
    expect(orch.store.getLatestTombstone("bridge")).not.toBeNull();
  });

  test("closeAgent reports fallback when graceful slash-exit times out", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "slow-close" },
      runtime: "claude-code",
      projectDir: "/tmp/slow-close",
    });
    screenState.isAliveResult = true;
    try {
      const result = await orch.closeAgent("slow-close", undefined, 0);

      expect(result.fallbackUsed).toBe(true);
      expect(screenState.sendKeysLog).toEqual([
        { name: "wire-slow-close", keys: "/exit" },
        { name: "wire-slow-close", keys: "\n" },
      ]);
      expect(screenState.killSessionCalls).toEqual(["wire-slow-close"]);
      expect(orch.store.getAgent("slow-close")).toBeNull();
    } finally {
      screenState.isAliveResult = false;
    }
  });

  test("stopAgent terminates codex bridge runtimes before the final hard reap", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "bridge-stop" },
      runtime: "codex",
      projectDir: "/tmp/bridge-stop",
    });

    await orch.stopAgent("bridge-stop");

    expect(screenState.terminateSessionCalls).toEqual([{ name: "wire-bridge-stop", timeoutMs: 10_000 }]);
    expect(screenState.killSessionCalls).toEqual(["wire-bridge-stop"]);
    expect(orch.store.getAgent("bridge-stop")).toBeNull();
  });

  test("stopAgent keeps the live row when the process group survives hard reap", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "stubborn" },
      runtime: "codex",
      projectDir: "/tmp/stubborn",
    });
    screenState.killSessionSurvivors = 2;
    const orig = console.error;
    console.error = () => {};
    try {
      await expect(orch.stopAgent("stubborn")).rejects.toThrow(/process tree survived kill/);
    } finally {
      console.error = orig;
    }

    expect(orch.store.getAgent("stubborn")).not.toBeNull();
    expect(orch.store.getLatestTombstone("stubborn")).toBeNull();
  });
});

describe("setAgentBadge ambiguous-pane safeguard", () => {
  test("skips render when multiple agents claim the target's pane", async () => {
    // Construct the bad state: two agents both claim pane 'shared'.
    await orch.launchAgent({ env: { AGENT_ID: "a" } });
    await orch.launchAgent({ env: { AGENT_ID: "b" } });
    orch.store["db"].prepare("UPDATE agents SET pane = 'shared' WHERE id IN ('a','b')").run();

    const outcome = await orch.setAgentBadge("a", "should-not-render");

    expect(outcome.rendered).toBe(false);
    expect(outcome.reason).toMatch(/claimed by 2 agents/);
    // DB badge still written — only the pane render is skipped.
    expect(orch.store.getAgent("a")?.badge).toBe("should-not-render");
  });

  test("skips render when the target's screen is detached", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "lonely" } });
    orch.store["db"].prepare("UPDATE agents SET pane = 'rome' WHERE id = 'lonely'").run();
    // Fake a pane row so the iterm_id lookup succeeds.
    orch.store["db"].prepare(
      "INSERT INTO tabs (name, created_at) VALUES ('t', 0)"
    ).run();
    orch.store["db"].prepare(
      "INSERT INTO panes (name, tab, position, iterm_id, created_at) VALUES ('rome','t','below','iterm-rome',0)"
    ).run();

    screenState.isAttachedResult = false; // detached
    try {
      const outcome = await orch.setAgentBadge("lonely", "x");
      expect(outcome.rendered).toBe(false);
      expect(outcome.reason).toMatch(/detached/);
    } finally {
      screenState.isAttachedResult = false;
    }
  });
});

describe("resumeAgent", () => {
  test("builds a claude --resume command with explicit channels list", async () => {
    await orch.resumeAgent({
      id: "danish",
      ccSessionId: "7cc4b34e-225b-42ed-b2e3-bafa696cfc70",
      projectDir: "/tmp/danish-wd",
      channels: ["plugin:wire@agiterra", "plugin:knowledge@agiterra"],
      env: { AGENT_PRIVATE_KEY: "k" },
    });

    expect(createSessionCalls).toHaveLength(1);
    const cmd = createSessionCalls[0]!.command;
    // explicit channels list sidesteps the --resume positional-arg conflict
    expect(cmd).toContain("--dangerously-load-development-channels 'plugin:wire@agiterra,plugin:knowledge@agiterra'");
    expect(cmd).toContain("--resume '7cc4b34e-225b-42ed-b2e3-bafa696cfc70'");
    expect(cmd).toContain("cd '/tmp/danish-wd'");
    expect(cmd).toContain("AGENT_ID='danish'");
    expect(cmd).toContain("AGENT_PRIVATE_KEY='k'");
  });

  test("pre-seeds the DB row from inputs (no self-register required)", async () => {
    await orch.resumeAgent({
      id: "galette",
      ccSessionId: "fake-session-id",
      projectDir: "/tmp/galette-wd",
      displayName: "Galette",
      badge: "ENG-3020 Galette",
    });

    const agent = orch.store.getAgent("galette");
    expect(agent).not.toBeNull();
    expect(agent!.cc_session_id).toBe("fake-session-id");
    expect(agent!.display_name).toBe("Galette");
    expect(agent!.badge).toBe("ENG-3020 Galette");
    expect(agent!.screen_name).toBe("wire-galette");
  });

  test("throws if agent is already alive", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "already-running" } });
    screenState.isAliveResult = true;
    try {
      await expect(
        orch.resumeAgent({
          id: "already-running",
          ccSessionId: "x",
          projectDir: "/tmp",
        }),
      ).rejects.toThrow(/already running/);
    } finally {
      screenState.isAliveResult = false;
    }
  });

  test("rejects env.AGENT_ID mismatch", async () => {
    await expect(
      orch.resumeAgent({
        id: "alpha",
        ccSessionId: "s",
        projectDir: "/tmp",
        env: { AGENT_ID: "beta" },
      }),
    ).rejects.toThrow(/does not match env\.AGENT_ID/);
  });

  test("single-arg resume pulls cc_session_id + project_dir from tombstone", async () => {
    // Launch, stop, then resume with JUST id.
    await orch.launchAgent({
      env: { AGENT_ID: "ghost", AGENT_NAME: "Ghost", KNOWLEDGE_ENRICH_RULES: "{}" },
      projectDir: "/tmp/ghost-wd",
      badge: "Ghost in the shell",
    });
    // Fake the cc_session_id so the tombstone carries a real one.
    orch.store["db"].prepare("UPDATE agents SET cc_session_id = ? WHERE id = ?")
      .run("cc-session-ghost", "ghost");
    screenState.isAliveResult = true;
    try { await orch.stopAgent("ghost"); } finally { screenState.isAliveResult = false; }
    createSessionCalls.length = 0;

    const resumed = await orch.resumeAgent({ id: "ghost" });

    // Spawn command pulls the tombstone's cc_session_id + project_dir
    expect(createSessionCalls).toHaveLength(1);
    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain("cd '/tmp/ghost-wd'");
    expect(cmd).toContain("--resume 'cc-session-ghost'");
    expect(cmd).toContain("AGENT_NAME='Ghost'");
    expect(cmd).toContain("KNOWLEDGE_ENRICH_RULES='{}'");

    // Resumed row inherits identity defaults from the tombstone
    expect(resumed.display_name).toBe("Ghost");
    expect(resumed.badge).toBe("Ghost in the shell");
    expect(resumed.cc_session_id).toBe("cc-session-ghost");
  });

  test("resume env overrides are merged on top of tombstone env", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "merge", FROM_MANIFEST: "original" },
      projectDir: "/tmp/merge",
    });
    orch.store["db"].prepare("UPDATE agents SET cc_session_id = ? WHERE id = ?")
      .run("cc-merge", "merge");
    screenState.isAliveResult = true;
    try { await orch.stopAgent("merge"); } finally { screenState.isAliveResult = false; }
    createSessionCalls.length = 0;

    await orch.resumeAgent({
      id: "merge",
      env: { AGENT_PRIVATE_KEY: "fresh-key", FROM_MANIFEST: "overridden" },
    });

    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain("FROM_MANIFEST='overridden'");
    expect(cmd).toContain("AGENT_PRIVATE_KEY='fresh-key'");
  });

  test("throws when neither tombstone nor cc_session_id is available", async () => {
    await expect(
      orch.resumeAgent({ id: "never-existed" }),
    ).rejects.toThrow(/no tombstone for 'never-existed'/);
  });

  test("launchAgent stamps --session-id <uuid> and records it; resume of that agent passes --resume <same uuid>", async () => {
    // 2026-09-03: every spawned lane row had cc_session_id=NULL, so agent_resume
    // could never carry context. The id is minted at launch, on the command AND the row.
    await orch.launchAgent({ env: { AGENT_ID: "stamped" }, projectDir: "/tmp/stamped" });
    const row = orch.store.getAgent("stamped");
    expect(row!.cc_session_id).toMatch(/^[0-9a-f-]{36}$/);
    const launchCmd = createSessionCalls[0]!.command;
    expect(launchCmd).toContain(` --session-id ${row!.cc_session_id}`);
    screenState.isAliveResult = true;
    try { await orch.stopAgent("stamped"); } finally { screenState.isAliveResult = false; }
    createSessionCalls.length = 0;
    const resumed = await orch.resumeAgent({ id: "stamped" });
    expect(resumed.cc_session_id).toBe(row!.cc_session_id);
    const resumeCmd = createSessionCalls[0]!.command;
    expect(resumeCmd).toContain(`--resume '${row!.cc_session_id}'`);
    expect(resumeCmd).not.toContain("--session-id");
  });

  test("resume rebuilds from the runtime template launch used, not a bare hand-built command", async () => {
    // Brioche 597983: a resumed lane came up without its --mcp-config browser
    // server and without model/effort pins because resume hand-built
    // `claude --dangerously-load-development-channels … --permission-mode …`.
    // The base command (everything after the last `&& `, before the session
    // flag) must be identical between launch and resume, whatever the template.
    await orch.launchAgent({ env: { AGENT_ID: "tmpl" }, projectDir: "/tmp/tmpl" });
    const base = (cmd: string) => cmd.slice(cmd.lastIndexOf("&& ") + 3).replace(/ --(session-id|resume) .*$/, "");
    const launchBase = base(createSessionCalls[0]!.command);
    screenState.isAliveResult = true;
    try { await orch.stopAgent("tmpl"); } finally { screenState.isAliveResult = false; }
    createSessionCalls.length = 0;
    await orch.resumeAgent({ id: "tmpl" });
    expect(base(createSessionCalls[0]!.command)).toBe(launchBase);
  });

  test("resumes from tombstone with null cc_session_id by launching fresh (no --resume flag)", async () => {
    // Agent that /exit'd before CC wrote a session file — tombstone has
    // manifest but no cc_session_id. Brioche's verification case #9.
    await orch.launchAgent({
      env: { AGENT_ID: "never-booted" },
      projectDir: "/tmp/nb",
    });
    // launchAgent now stamps a session id; null it to simulate an agent that
    // never booted CC (the row is what stopAgent copies into the tombstone).
    (orch.store as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("UPDATE agents SET cc_session_id = NULL WHERE id = ?").run("never-booted");
    screenState.isAliveResult = true;
    try { await orch.stopAgent("never-booted"); } finally { screenState.isAliveResult = false; }
    createSessionCalls.length = 0;

    const resumed = await orch.resumeAgent({ id: "never-booted" });
    expect(resumed.id).toBe("never-booted");
    expect(resumed.cc_session_id).toBeNull();
    expect(createSessionCalls).toHaveLength(1);
    const cmd = createSessionCalls[0]!.command;
    expect(cmd).not.toContain("--resume");
    expect(cmd).toContain("cd '/tmp/nb'");
    expect(cmd).toContain("AGENT_ID='never-booted'");
  });
});

describe("registerAgent id-mismatch safety", () => {
  test("uses caller-passed screen context when the service process has no STY", async () => {
    const prevSty = process.env.STY;
    delete process.env.STY;
    screenState.isAliveResult = true;
    try {
      const agent = await orch.registerAgent({
        id: "brioche",
        displayName: "Brioche",
        runtime: "codex",
        callerSessionId: JSON.stringify({
          terminal_session_id: "iterm-session-1",
          screen_name: "wire-brioche",
          screen_pid: 25789,
          sty: "25789.wire-brioche",
        }),
      });

      expect(agent.screen_name).toBe("wire-brioche");
      expect(agent.screen_pid).toBe(25789);
      expect(agent.pane).toBeNull();
    } finally {
      if (prevSty === undefined) delete process.env.STY;
      else process.env.STY = prevSty;
      screenState.isAliveResult = false;
    }
  });

  test("throws when caller id doesn't match the agent owning the screen", async () => {
    // Simulate Brioche running in screen 'wire-brioche' with an existing row
    await orch.launchAgent({ env: { AGENT_ID: "brioche", AGENT_NAME: "Brioche" } });
    const stamped = orch.store.getAgent("brioche")!.cc_session_id;

    const prevSty = process.env.STY;
    process.env.STY = "99999.wire-brioche";
    screenState.isAliveResult = true;
    try {
      await expect(
        orch.registerAgent({ id: "danish", displayName: "Danish" }),
      ).rejects.toThrow(/owned by agent 'brioche' but called with id='danish'/);

      // Brioche's row must be untouched
      const row = orch.store.getAgent("brioche");
      expect(row).not.toBeNull();
      expect(row!.cc_session_id).toBe(stamped);
    } finally {
      if (prevSty === undefined) delete process.env.STY;
      else process.env.STY = prevSty;
      screenState.isAliveResult = false;
    }
  });
});

describe("nearest-ancestor .env sourcing (cc-launch.sh fold)", () => {
  test("claude-code spawns get CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false; caller override wins; codex untouched", async () => {
    // Tim's fleet-wide directive 2026-08-04: suggestion chrome reads as
    // operator input in hardcopies and volunteered policy waivers into lanes.
    await orch.launchAgent({ env: { AGENT_ID: "nosugg" } });
    expect(createSessionCalls.at(-1)!.command).toMatch(/CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION='?false'?/);

    await orch.launchAgent({ env: { AGENT_ID: "yessugg", CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "true" } });
    expect(createSessionCalls.at(-1)!.command).toMatch(/CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION='?true'?/);
    expect(createSessionCalls.at(-1)!.command).not.toMatch(/CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION='?false'?/);

    await orch.launchAgent({ env: { AGENT_ID: "codexy" }, runtime: "codex" });
    expect(createSessionCalls.at(-1)!.command).not.toContain("CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION");
  });


  test("claude-code spawn/resume wipes .claude/settings.local.json; codex does not", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wipe-cc" } });
    const cc = createSessionCalls.at(-1)!.command;
    expect(cc).toContain(WIPE_CLAUDE_SETTINGS_LOCAL);
    expect(cc.indexOf("cd ")).toBeLessThan(cc.indexOf(WIPE_CLAUDE_SETTINGS_LOCAL));

    await orch.launchAgent({ env: { AGENT_ID: "wipe-cx" }, runtime: "codex" });
    expect(createSessionCalls.at(-1)!.command).not.toContain(WIPE_CLAUDE_SETTINGS_LOCAL);

    await orch.resumeAgent({
      id: "wipe-resume",
      ccSessionId: "11111111-2222-3333-4444-555555555555",
      projectDir: "/tmp/wipe-resume-wd",
    });
    expect(createSessionCalls.at(-1)!.command).toContain(WIPE_CLAUDE_SETTINGS_LOCAL);
  });

  test("launch command sources .env after the env exports, before the runtime command", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "envy" } });

    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain(SOURCE_NEAREST_ENV);
    // Anchor on AGENT_ID= (not "export AGENT_ID"): crew injects its own
    // claude-code defaults (CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION) ahead of the
    // caller env, so AGENT_ID is no longer first in the export list.
    const exportsIdx = cmd.indexOf("AGENT_ID=");
    const sourceIdx = cmd.indexOf(SOURCE_NEAREST_ENV);
    expect(exportsIdx).toBeGreaterThan(-1);
    // .env values must win a collision with the forwarded env map —
    // exactly cc-launch.sh's ordering (exports first, then source).
    expect(sourceIdx).toBeGreaterThan(exportsIdx);
    // the runtime command is the tail, after the sourcing
    expect(cmd.length).toBeGreaterThan(sourceIdx + SOURCE_NEAREST_ENV.length);
  });

  test("resume command gets the same sourcing", async () => {
    await orch.resumeAgent({
      id: "envy2",
      ccSessionId: "11111111-2222-3333-4444-555555555555",
      projectDir: "/tmp/envy2-wd",
    });

    const cmd = createSessionCalls[0]!.command;
    expect(cmd).toContain(SOURCE_NEAREST_ENV);
    const sourceIdx = cmd.indexOf(SOURCE_NEAREST_ENV);
    expect(sourceIdx).toBeGreaterThan(cmd.indexOf("export AGENT_ID"));
    expect(cmd.indexOf("--resume", sourceIdx)).toBeGreaterThan(sourceIdx);
  });

  test("the snippet exports vars from the NEAREST ancestor .env in a real shell", () => {
    const root = mkdtempSync(join(tmpdir(), "envfold-"));
    try {
      mkdirSync(join(root, "a", "b"), { recursive: true });
      writeFileSync(join(root, ".env"), "FOLD_PROBE=root-level\n");
      writeFileSync(join(root, "a", ".env"), "FOLD_PROBE=nearest-wins\nFOLD_EXPORTED=yes\n");

      const out = execSync(
        `cd '${join(root, "a", "b")}' && ${SOURCE_NEAREST_ENV} && printf '%s:%s' "$FOLD_PROBE" "$FOLD_EXPORTED"`,
        { shell: "/bin/sh", encoding: "utf8" },
      );
      expect(out).toBe("nearest-wins:yes");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no .env anywhere up the tree is a clean no-op", () => {
    // /private/tmp mkdtemp dirs have no ancestor .env until / — but guard
    // against a stray /tmp/.env on dev machines by probing an unset var.
    const root = mkdtempSync(join(tmpdir(), "envfold-none-"));
    try {
      const out = execSync(
        `cd '${root}' && ${SOURCE_NEAREST_ENV} && printf '%s' "${"$"}{FOLD_PROBE_ABSENT:-unset}"`,
        { shell: "/bin/sh", encoding: "utf8" },
      );
      expect(out).toBe("unset");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("autoConfirmDevChannel — verify-after-confirm", () => {
  const MARKER_SCREEN = "Development channels can run arbitrary code.\n  Enter to confirm · Esc to reject";
  const BOOTED_SCREEN = "❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ? for shortcuts";
  const crs = () => screenState.sendKeysLog.filter((e) => e.name === "dvc" && e.keys === "\r").length;
  const lfs = () => screenState.sendKeysLog.filter((e) => e.name === "dvc" && e.keys === "\n").length;

  test("confirms the prompt and verifies it cleared", async () => {
    screenState.screens["dvc"] = { queue: ["starting claude…", MARKER_SCREEN], fallback: BOOTED_SCREEN };

    const ok = await autoConfirmDevChannel("dvc", "t1", { appearMs: 2_000, clearMs: 1_000 });

    expect(ok).toBe(true);
    expect(crs()).toBe(1);
  });

  test("retries the CR when the prompt does not clear, then succeeds", async () => {
    screenState.screens["dvc"] = { queue: [], fallback: MARKER_SCREEN };
    screenState.sendKeysHook = (name, keys) => {
      // First CR is "lost" (screen keeps showing the prompt); the second lands.
      if (name === "dvc" && keys === "\r" && crs() >= 2) {
        screenState.screens["dvc"]!.fallback = BOOTED_SCREEN;
      }
    };

    const ok = await autoConfirmDevChannel("dvc", "t2", { appearMs: 2_000, clearMs: 400 });

    expect(ok).toBe(true);
    expect(crs()).toBe(2);
  });

  test("normal input UI with no prompt = nothing to confirm, no keys sent", async () => {
    screenState.screens["dvc"] = { queue: [], fallback: BOOTED_SCREEN };

    const ok = await autoConfirmDevChannel("dvc", "t3", { appearMs: 2_000 });

    expect(ok).toBe(true);
    expect(crs()).toBe(0);
  });

  test("nothing renders → false + loud status on the agent row", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "halfboot" } });
    // "dvc" stays blank forever (no screens entry → reads return "").

    const ok = await autoConfirmDevChannel("dvc", "halfboot", {
      store: orch.store,
      agentId: "halfboot",
      appearMs: 400,
      clearMs: 200,
    });

    expect(ok).toBe(false);
    const row = orch.store.getAgent("halfboot");
    expect(row?.status_name).toBe("dev-channel-confirm-failed");
    expect(row?.status_desc).toContain("nothing will confirm it");
  });

  test("TWO sequential dialogs (trust, then dev-channel) both get confirmed", async () => {
    // The 2026-08-04 RCA hazard: dialogs share the marker and appear in
    // sequence; a confirm that returns on first clear leaves dialog #2
    // standing and the channel plugin never loads.
    const TRUST_SCREEN = "Quick safety check: Is this a project you trust?\n  Enter to confirm · Esc to cancel";
    screenState.screens["dvc"] = { queue: [TRUST_SCREEN], fallback: MARKER_SCREEN };
    screenState.sendKeysHook = (name, keys) => {
      if (name === "dvc" && keys === "\r" && crs() >= 2) {
        screenState.screens["dvc"]!.fallback = BOOTED_SCREEN;
      }
    };

    const ok = await autoConfirmDevChannel("dvc", "twodialogs", { appearMs: 3_000, clearMs: 800 });

    expect(ok).toBe(true);
    expect(crs()).toBe(2); // one Enter per dialog
  });

  test("booted WITH channel banner → boot-gate-ok status (outcome recorded, not just ceremony)", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "bannered" } });
    const BOOTED_WITH_CHANNEL = "▎ Channels (experimental) messages from plugin:wire@agiterra inject directly\n❯ \n  ⏵⏵ bypass permissions on";
    screenState.screens["dvc"] = { queue: [MARKER_SCREEN], fallback: BOOTED_WITH_CHANNEL };

    const ok = await autoConfirmDevChannel("dvc", "bannered", {
      store: orch.store, agentId: "bannered", appearMs: 2_000, clearMs: 800,
    });

    expect(ok).toBe(true);
    const row = orch.store.getAgent("bannered");
    expect(row?.status_name).toBe("boot-gate-ok");
    expect(row?.status_desc).toContain("channel banner observed");
  });

  test("banner on an EARLY frame only (scrolled off by footer time) → boot-gate-ok", async () => {
    // The 2026-08-04 false-negative shape: a lane boots with its brief
    // auto-submitted, output streams immediately, and the transient splash
    // banner is gone from the frame where the footer first appears. Both
    // post-redeploy lanes (pastizz, cavallucci) were marked wire-channel-absent
    // this way while their channel plugin was provably live.
    await orch.launchAgent({ env: { AGENT_ID: "earlybanner" } });
    const DIALOG_WITH_BANNER =
      "▎ Channels (experimental) messages from plugin:wire@agiterra inject directly\n" + MARKER_SCREEN;
    screenState.screens["dvc"] = { queue: [DIALOG_WITH_BANNER], fallback: BOOTED_SCREEN };

    const ok = await autoConfirmDevChannel("dvc", "earlybanner", {
      store: orch.store, agentId: "earlybanner", appearMs: 2_000, clearMs: 800,
      channelProbe: async () => { throw new Error("probe must not run when the banner was seen"); },
    });

    expect(ok).toBe(true);
    const row = orch.store.getAgent("earlybanner");
    expect(row?.status_name).toBe("boot-gate-ok");
    expect(row?.status_desc).toContain("channel banner observed");
  });

  test("no banner on any frame but channel plugin process LIVE → boot-gate-ok via process witness", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "witnessed" } });
    screenState.screens["dvc"] = { queue: [], fallback: BOOTED_SCREEN };

    const ok = await autoConfirmDevChannel("dvc", "witnessed", {
      store: orch.store, agentId: "witnessed", appearMs: 2_000,
      channelProbe: async () => true, channelProbeMs: 1_000,
    });

    expect(ok).toBe(true);
    const row = orch.store.getAgent("witnessed");
    expect(row?.status_name).toBe("boot-gate-ok");
    expect(row?.status_desc).toContain("process witness");
  });

  test("booted WITHOUT channel banner AND no plugin process → wire-channel-absent (the wire-blind half-boot, loud)", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "blindboot" } });
    screenState.screens["dvc"] = { queue: [], fallback: BOOTED_SCREEN };

    const ok = await autoConfirmDevChannel("dvc", "blindboot", {
      store: orch.store, agentId: "blindboot", appearMs: 2_000,
      channelProbe: async () => false, channelProbeMs: 0,
    });

    expect(ok).toBe(true); // session IS up — but the status says what's missing
    const row = orch.store.getAgent("blindboot");
    expect(row?.status_name).toBe("wire-channel-absent");
    expect(row?.status_desc).toContain("wire-blind");
    expect(row?.status_desc).toContain("no wire channel plugin process");
  });

  test("probe that THROWS is counted, not treated as a verdict → wire-channel-absent with probe count", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "probefail" } });
    screenState.screens["dvc"] = { queue: [], fallback: BOOTED_SCREEN };

    const ok = await autoConfirmDevChannel("dvc", "probefail", {
      store: orch.store, agentId: "probefail", appearMs: 2_000,
      channelProbe: async () => { throw new Error("ps unavailable"); }, channelProbeMs: 0,
    });

    expect(ok).toBe(true);
    const row = orch.store.getAgent("probefail");
    expect(row?.status_name).toBe("wire-channel-absent");
    expect(row?.status_desc).toMatch(/[1-9]\d* probe\(s\) threw/);
  });

  test("read failures are counted distinctly in the failure detail (no swallowed-error ambiguity)", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "readfail" } });
    screenState.readOutputHook = () => { throw new Error("boom"); };

    const ok = await autoConfirmDevChannel("dvc", "readfail", {
      store: orch.store, agentId: "readfail", appearMs: 500, clearMs: 200,
    });

    expect(ok).toBe(false);
    const row = orch.store.getAgent("readfail");
    expect(row?.status_desc).toMatch(/\d+ threw/);
    screenState.readOutputHook = undefined;
  });

  test("prompt stuck through all retries → false + status records the stuck prompt", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "stuckboot" } });
    screenState.screens["dvc"] = { queue: [], fallback: MARKER_SCREEN };

    const ok = await autoConfirmDevChannel("dvc", "stuckboot", {
      store: orch.store,
      agentId: "stuckboot",
      appearMs: 2_000,
      clearMs: 300,
    });

    expect(ok).toBe(false);
    // 3 submit attempts, byte-alternated CR/LF/CR → 2 CRs.
    expect(crs()).toBe(2);
    expect(lfs()).toBe(1);
    const row = orch.store.getAgent("stuckboot");
    expect(row?.status_name).toBe("dev-channel-confirm-failed");
    expect(row?.status_desc).toContain("did not clear after 3 submit attempts");
  });
});

describe("sendToAgent — two-phase submit-verify + alternate-byte (v2.20.0)", () => {
  async function spawnActive(id: string) {
    await orch.launchAgent({ env: { AGENT_ID: id } });
    // launchAgent's background autoConfirm polls wire-<id>; give the send test
    // its own deterministic screen content.
    return `wire-${id}`;
  }
  const bytesTo = (name: string) =>
    screenState.sendKeysLog.filter((e) => e.name === name).map((e) => e.keys);

  test("body that appears then clears on submit → landed:true; body + one terminator sent", async () => {
    const scr = await spawnActive("s-ok");
    // After the body is typed the draft shows it; the FIRST terminator clears it.
    screenState.screens[scr] = { queue: [], fallback: "❯ hello world draft" };
    screenState.sendKeysHook = (name, keys) => {
      if (name === scr && (keys === "\r" || keys === "\n")) {
        screenState.screens[scr]!.fallback = "❯ "; // draft submitted, input empty
      }
    };
    const r = await orch.sendToAgent("s-ok", "hello world\n");
    expect(r.landed).toBe(true);
    const keys = bytesTo(scr);
    expect(keys[0]).toBe("hello world"); // body first
    expect(keys.filter((k) => k === "\r" || k === "\n").length).toBe(1); // one terminator
  });

  test("submit lost → alternates CR/LF/CR, reports landed:false after 3", async () => {
    const scr = await spawnActive("s-stuck");
    // Draft never clears — every terminator is 'swallowed'.
    screenState.screens[scr] = { queue: [], fallback: "❯ stuck draft here" };
    const r = await orch.sendToAgent("s-stuck", "stuck draft here\n");
    expect(r.landed).toBe(false);
    const terms = bytesTo(scr).filter((k) => k === "\r" || k === "\n");
    expect(terms).toEqual(["\r", "\n", "\r"]); // alternated
  }, 15_000); // fully-stuck path exhausts 3× the ~2.5s submit-verify poll by design

  test("no trailing terminator → preserves type-and-verify (landed reflects appearance)", async () => {
    const scr = await spawnActive("s-notrail");
    screenState.screens[scr] = { queue: [], fallback: "❯ just typing this" };
    const r = await orch.sendToAgent("s-notrail", "just typing this");
    expect(r.landed).toBe(true);
    const keys = bytesTo(scr);
    expect(keys.every((k) => k !== "\r" && k !== "\n")).toBe(true); // no submit sent
  });
});

describe("askedFromCommand — the ask derives from the command, not a duplicated constant", () => {
  const RUNTIME_CMD =
    "claude --dangerously-load-development-channels plugin:wire@agiterra --permission-mode bypassPermissions --model ${CLAUDE_MODEL:-claude-opus-4-8} --effort ${CLAUDE_EFFORT:-high}";

  test("env pin resolves exactly as the shell will", () => {
    const asked = askedFromCommand(RUNTIME_CMD, { CLAUDE_MODEL: "claude-fable-5[1m]", CLAUDE_EFFORT: "medium" });
    expect(asked.model).toBe("claude-fable-5[1m]");
    expect(asked.effort).toBe("medium");
    expect(asked.channels).toBe(true);
  });

  test("no env pin falls to the template default", () => {
    const asked = askedFromCommand(RUNTIME_CMD, {});
    expect(asked.model).toBe("claude-opus-4-8");
    expect(asked.effort).toBe("high");
  });

  test("empty-string env falls to the default (matching ${VAR:-} shell semantics)", () => {
    const asked = askedFromCommand(RUNTIME_CMD, { CLAUDE_MODEL: "" });
    expect(asked.model).toBe("claude-opus-4-8");
  });

  test("extraFlags repeating a flag win (last occurrence, the CLI's rule)", () => {
    const asked = askedFromCommand(`${RUNTIME_CMD} --model claude-sonnet-5`, { CLAUDE_MODEL: "claude-opus-5" });
    expect(asked.model).toBe("claude-sonnet-5");
  });

  test("a command that never asks asserts nothing", () => {
    const asked = askedFromCommand("claude --permission-mode bypassPermissions", {});
    expect(asked.model).toBeUndefined();
    expect(asked.effort).toBeUndefined();
    expect(asked.channels).toBe(false);
  });

  test("shellEscaped literal is compared unquoted (what execve sees)", () => {
    const asked = askedFromCommand("claude --model 'claude-fable-5[1m]'", {});
    expect(asked.model).toBe("claude-fable-5[1m]");
  });
});

describe("verifySpawnArgv — asked-vs-got against the ACTING argv", () => {
  const ARGV_FULL =
    "claude --dangerously-load-development-channels plugin:wire@agiterra --permission-mode bypassPermissions --model claude-opus-5 --effort medium You are a lane";

  test("match over boot-gate-ok appends 'argv verified' to the healthy status", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "avok" } });
    orch.store.updateAgentStatus("avok", "boot-gate-ok", "dialogs confirmed: 1");

    await verifySpawnArgv("dvc", "avok", { model: "claude-opus-5", effort: "medium", channels: true }, {
      store: orch.store, agentId: "avok", argvReader: async () => ARGV_FULL,
    });

    const row = orch.store.getAgent("avok");
    expect(row?.status_name).toBe("boot-gate-ok");
    expect(row?.status_desc).toContain("argv verified: model=claude-opus-5 effort=medium channels=present");
  });

  test("model mismatch → argv-mismatch, loud, asked and got both named", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "avmm" } });
    orch.store.updateAgentStatus("avmm", "boot-gate-ok", "dialogs confirmed: 1");

    await verifySpawnArgv("dvc", "avmm", { model: "claude-fable-5[1m]", channels: true }, {
      store: orch.store, agentId: "avmm", argvReader: async () => ARGV_FULL,
    });

    const row = orch.store.getAgent("avmm");
    expect(row?.status_name).toBe("argv-mismatch");
    expect(row?.status_desc).toContain("asked 'claude-fable-5[1m]'");
    expect(row?.status_desc).toContain("got 'claude-opus-5'");
  });

  test("channels asked but flag absent → argv-mismatch naming the wire-void precondition", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "avch" } });

    await verifySpawnArgv("dvc", "avch", { channels: true }, {
      store: orch.store, agentId: "avch",
      argvReader: async () => "claude --permission-mode bypassPermissions --model claude-opus-5",
    });

    const row = orch.store.getAgent("avch");
    expect(row?.status_name).toBe("argv-mismatch");
    expect(row?.status_desc).toContain("wire-void precondition");
  });

  test("unreadable argv over boot-gate-ok → argv-unreadable (a probe fact, not a mismatch claim)", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "avun" } });
    orch.store.updateAgentStatus("avun", "boot-gate-ok", "dialogs confirmed: 1");

    await verifySpawnArgv("dvc", "avun", { model: "claude-opus-5" }, {
      store: orch.store, agentId: "avun", argvReader: async () => null, appearMs: 100,
    });

    const row = orch.store.getAgent("avun");
    expect(row?.status_name).toBe("argv-unreadable");
    expect(row?.status_desc).toContain("NOT verified");
  });

  test("unreadable argv NEVER overwrites a standing alarm", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "avalarm" } });
    orch.store.updateAgentStatus("avalarm", "wire-channel-absent", "no banner, no process");

    await verifySpawnArgv("dvc", "avalarm", { model: "claude-opus-5" }, {
      store: orch.store, agentId: "avalarm", argvReader: async () => null, appearMs: 100,
    });

    const row = orch.store.getAgent("avalarm");
    expect(row?.status_name).toBe("wire-channel-absent");
    expect(row?.status_desc).toBe("no banner, no process");
  });

  test("a MATCH never upgrades a standing alarm either (summaries only upgrade status — refuse)", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "avkeep" } });
    orch.store.updateAgentStatus("avkeep", "wire-channel-absent", "no banner, no process");

    await verifySpawnArgv("dvc", "avkeep", { model: "claude-opus-5", channels: true }, {
      store: orch.store, agentId: "avkeep", argvReader: async () => ARGV_FULL,
    });

    const row = orch.store.getAgent("avkeep");
    expect(row?.status_name).toBe("wire-channel-absent");
    expect(row?.status_desc).toBe("no banner, no process");
  });

  test("a field the spawn never asked for is not asserted", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "avnone" } });
    orch.store.updateAgentStatus("avnone", "boot-gate-ok", "dialogs confirmed: 0");

    await verifySpawnArgv("dvc", "avnone", { channels: true }, {
      store: orch.store, agentId: "avnone",
      argvReader: async () => "claude --dangerously-load-development-channels plugin:wire@agiterra --resume abc",
    });

    const row = orch.store.getAgent("avnone");
    expect(row?.status_name).toBe("boot-gate-ok");
    expect(row?.status_desc).toContain("model=(not asked)");
  });
});

describe("verifyWireInbound — the BROKER's view of the inbound connection", () => {
  const FAST = { windowMs: 200, pollMs: 50 };

  test("connected over boot-gate-ok appends 'wire inbound verified' to the healthy status", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wiok" } });
    orch.store.updateAgentStatus("wiok", "boot-gate-ok", "dialogs confirmed: 1");

    await verifyWireInbound("dvc", "wiok", {
      store: orch.store, agentId: "wiok", ...FAST,
      agentsReader: async () => [{ id: "wiok", connection_status: "connected" }],
    });

    const row = orch.store.getAgent("wiok");
    expect(row?.status_name).toBe("boot-gate-ok");
    expect(row?.status_desc).toContain("wire inbound verified");
    expect(row?.status_desc).toContain("connection_status=connected");
  });

  test("absent from the roster → wire-inbound-absent, LOUD, naming the cwd and the remediation", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wiabs" } });
    orch.store.updateAgentStatus("wiabs", "boot-gate-ok", "dialogs confirmed: 1");

    await verifyWireInbound("wire-wiabs", "wiabs", {
      store: orch.store, agentId: "wiabs", ...FAST,
      projectDir: "/opt/fabrica/fabrica-v3/fabrica-v3-api",
      agentsReader: async () => [{ id: "someone-else", connection_status: "connected" }],
    });

    const row = orch.store.getAgent("wiabs");
    expect(row?.status_name).toBe("wire-inbound-absent");
    expect(row?.status_desc).toContain("WIRE INBOUND BLIND");
    expect(row?.status_desc).toContain("'wiabs'");
    expect(row?.status_desc).toContain("cwd at spawn: /opt/fabrica/fabrica-v3/fabrica-v3-api");
    expect(row?.status_desc).toContain("project trust");
    expect(row?.status_desc).toContain("/opt/fabrica/fabrica-v3");
  });

  test("present but NOT connected → wire-inbound-disconnected, naming the status it actually saw", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "widis" } });
    orch.store.updateAgentStatus("widis", "boot-gate-ok", "dialogs confirmed: 1");

    await verifyWireInbound("wire-widis", "widis", {
      store: orch.store, agentId: "widis", ...FAST,
      projectDir: "/",
      agentsReader: async () => [{ id: "widis", connection_status: "disconnected" }],
    });

    const row = orch.store.getAgent("widis");
    expect(row?.status_name).toBe("wire-inbound-disconnected");
    expect(row?.status_desc).toContain("WIRE INBOUND DOWN");
    expect(row?.status_desc).toContain("connection_status='disconnected'");
    expect(row?.status_desc).toContain("cwd at spawn: /");
  });

  test("a transient absent-then-connected does NOT alarm — the window is the settle", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wisettle" } });
    orch.store.updateAgentStatus("wisettle", "boot-gate-ok", "dialogs confirmed: 1");

    let n = 0;
    await verifyWireInbound("dvc", "wisettle", {
      store: orch.store, agentId: "wisettle", windowMs: 5_000, pollMs: 10,
      agentsReader: async () => (++n < 3 ? [] : [{ id: "wisettle", connection_status: "connected" }]),
    });

    const row = orch.store.getAgent("wisettle");
    expect(row?.status_name).toBe("boot-gate-ok");
    expect(row?.status_desc).toContain("wire inbound verified");
    expect(n).toBe(3);
  });

  test("roster unreadable over boot-gate-ok → wire-inbound-unreadable (a probe fact, not an agent verdict)", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wiunr" } });
    orch.store.updateAgentStatus("wiunr", "boot-gate-ok", "dialogs confirmed: 1");

    await verifyWireInbound("dvc", "wiunr", {
      store: orch.store, agentId: "wiunr", ...FAST,
      agentsReader: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9800"); },
    });

    const row = orch.store.getAgent("wiunr");
    expect(row?.status_name).toBe("wire-inbound-unreadable");
    expect(row?.status_desc).toContain("NOT verified");
    expect(row?.status_desc).toContain("ECONNREFUSED");
    // The crucial distinction: an unreachable BROKER must never be reported as
    // a wire-blind AGENT.
    expect(row?.status_desc).not.toContain("WIRE INBOUND BLIND");
  });

  test("a non-array roster body is a probe fault, never a false 'absent'", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wishape" } });
    orch.store.updateAgentStatus("wishape", "boot-gate-ok", "dialogs confirmed: 1");

    await verifyWireInbound("dvc", "wishape", {
      store: orch.store, agentId: "wishape", ...FAST,
      agentsReader: async () => ({ agents: [] }),
    });

    const row = orch.store.getAgent("wishape");
    expect(row?.status_name).toBe("wire-inbound-unreadable");
    expect(row?.status_desc).toContain("expected a JSON array of agents, got object");
  });

  test("unreadable NEVER overwrites a standing alarm", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wialarm" } });
    orch.store.updateAgentStatus("wialarm", "wire-channel-absent", "no banner, no process");

    await verifyWireInbound("dvc", "wialarm", {
      store: orch.store, agentId: "wialarm", ...FAST,
      agentsReader: async () => { throw new Error("boom"); },
    });

    const row = orch.store.getAgent("wialarm");
    expect(row?.status_name).toBe("wire-channel-absent");
    expect(row?.status_desc).toBe("no banner, no process");
  });

  test("a CONNECTED read never upgrades a standing alarm either", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "wikeep" } });
    orch.store.updateAgentStatus("wikeep", "argv-mismatch", "model: asked X, got Y");

    await verifyWireInbound("dvc", "wikeep", {
      store: orch.store, agentId: "wikeep", ...FAST,
      agentsReader: async () => [{ id: "wikeep", connection_status: "connected" }],
    });

    const row = orch.store.getAgent("wikeep");
    expect(row?.status_name).toBe("argv-mismatch");
    expect(row?.status_desc).toBe("model: asked X, got Y");
  });

  test("no store/agentId → no consumer, the roster is never read at all", async () => {
    let called = 0;
    await verifyWireInbound("dvc", "nobody", {
      ...FAST,
      agentsReader: async () => { called++; return []; },
    });
    expect(called).toBe(0);
  });

  // The case that motivated the gate: croquant ran 3h14m wire-blind after being
  // spawned into an UNTRUSTED cwd. Driven through launchAgent — the caller —
  // so this proves the chain is WIRED, not just that the function works.
  test("ACCEPTANCE: an untrusted-cwd spawn trips the gate end-to-end via launchAgent", async () => {
    process.env.CREW_WIRE_READBACK_WINDOW_MS = "150";
    try {
      // Boot gate passes: footer + channel banner both on the frame. The flag is
      // present and CC says "Channels (experimental)" — exactly the healthy-
      // looking half-boot an untrusted cwd produces.
      screenState.screens["wire-croquant"] = {
        queue: [],
        fallback: "Channels (experimental)\n? for shortcuts",
      };
      screenState.argvResult =
        "claude --dangerously-load-development-channels plugin:wire@agiterra --permission-mode bypassPermissions --model claude-opus-4-8 --effort high";
      // The broker never sees it: no MCP server started, so nothing registered.
      wireState.roster = [{ id: "brioche", connection_status: "connected" }];

      await orch.launchAgent({
        env: { AGENT_ID: "croquant" },
        projectDir: "/opt/fabrica/fabrica-v3/fabrica-v3-api",
      });

      // The chain is fire-and-forget; wait for its verdict to land.
      const deadline = Date.now() + 15_000;
      let row = orch.store.getAgent("croquant");
      while (Date.now() < deadline && row?.status_name !== "wire-inbound-absent") {
        await new Promise((r) => setTimeout(r, 50));
        row = orch.store.getAgent("croquant");
      }

      expect(row?.status_name).toBe("wire-inbound-absent");
      expect(row?.status_desc).toContain("WIRE INBOUND BLIND on wire-croquant");
      expect(row?.status_desc).toContain("cwd at spawn: /opt/fabrica/fabrica-v3/fabrica-v3-api");
      expect(row?.status_desc).toContain("respawn into the trusted root /opt/fabrica/fabrica-v3");
      // And it went to the real endpoint, not a stub left in the chain.
      expect(wireState.calls.some((u) => u.endsWith("/agents"))).toBe(true);
    } finally {
      delete process.env.CREW_WIRE_READBACK_WINDOW_MS;
    }
  }, 30_000);
});

describe("launchAgent id contract", () => {
  test("underscore-suffixed and hyphenated ids are accepted; dots, uppercase, leading '-' and >64 chars are refused at spawn", async () => {
    const { AGENT_ID_RE } = await import("./orchestrator");
    for (const ok of ["crumiri_", "bocconotti-2", "a", "kx-1a2b3c4d", "wire-grok", "0lane"]) expect(AGENT_ID_RE.test(ok)).toBe(true);
    for (const bad of ["Bad.Name", "Crumiri", "-lead", "_lead", "", "x".repeat(65), "sp ace", "über"]) expect(AGENT_ID_RE.test(bad)).toBe(false);
    await expect(orch.launchAgent({ env: { AGENT_ID: "Bad.Name" } })).rejects.toThrow(/not a valid agent id/);
  });
});


describe("codex-spawn teardown (AGI-74)", () => {
  /**
   * A codex spawn's CODEX_HOME is `$HOME/.wire/codex-spawn/<id>/` with its
   * thread pointer beside it (wire-codex index.ts:74-79, codex-launch.sh:118).
   * Build that shape under a temp HOME and assert close/stop remove exactly
   * the torn-down agent's pair.
   */
  let fakeHome: string;
  let spawnRoot: string;
  let realHome: string | undefined;

  function seedSpawn(id: string): { dir: string; thread: string } {
    const dir = join(spawnRoot, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.toml"), `# ${id}\n`);
    mkdirSync(join(dir, "sessions"), { recursive: true });
    writeFileSync(join(dir, "sessions", "rollout.jsonl"), "{}\n");
    const thread = join(spawnRoot, `${id}.thread.json`);
    writeFileSync(thread, JSON.stringify({ threadId: "t-" + id }) + "\n");
    return { dir, thread };
  }

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "codex-home-"));
    spawnRoot = join(fakeHome, ".wire", "codex-spawn");
    mkdirSync(spawnRoot, { recursive: true });
    realHome = process.env.HOME;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    try { chmodSync(spawnRoot, 0o700); } catch {}
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });

  test("closeAgent removes only THIS agent scaffolding, retaining conversation state", async () => {
    const target = seedSpawn("galette");
    const sibling = seedSpawn("parrozzo");
    const persona = seedSpawn("fondant");

    await orch.launchAgent({ env: { AGENT_ID: "galette" }, runtime: "codex", projectDir: "/tmp/galette" });

    process.env.HOME = fakeHome;
    await orch.closeAgent("galette", undefined, 250);

    // PRESERVING TEARDOWN (2026-09-15): scaffolding goes, conversation state stays.
    // These rows asserted whole-home removal, which destroyed an unpushed clone and
    // 19.5 MB of thread history. The SCOPING intent below is unchanged.
    expect(existsSync(join(target.dir, "config.toml"))).toBe(false);
    expect(existsSync(join(target.dir, "sessions", "rollout.jsonl"))).toBe(true);
    expect(existsSync(target.thread)).toBe(true);
    // Scoped: a live sibling and the persona's own home are untouched.
    expect(existsSync(sibling.dir)).toBe(true);
    expect(existsSync(sibling.thread)).toBe(true);
    expect(existsSync(persona.dir)).toBe(true);
    expect(orch.store.getAgent("galette")).toBeNull();
  });

  test("stopAgent (and the idle reaper) removes scaffolding only, retaining conversation state", async () => {
    const target = seedSpawn("bavarois");
    const sibling = seedSpawn("kouign");

    await orch.launchAgent({ env: { AGENT_ID: "bavarois" }, runtime: "codex", projectDir: "/tmp/bavarois" });

    process.env.HOME = fakeHome;
    await orch.stopAgent("bavarois");

    expect(existsSync(join(target.dir, "config.toml"))).toBe(false);
    expect(existsSync(join(target.dir, "sessions", "rollout.jsonl"))).toBe(true);
    expect(existsSync(target.thread)).toBe(true);
    expect(existsSync(sibling.dir)).toBe(true);
  });

  test("claude-code runtime is a no-op, not an error", async () => {
    // Same-named dir planted deliberately: a claude agent never owns one, so
    // teardown must not touch it even when the names line up.
    const planted = seedSpawn("cc-agent");

    await orch.launchAgent({ env: { AGENT_ID: "cc-agent" }, runtime: "claude-code", projectDir: "/tmp/cc" });

    process.env.HOME = fakeHome;
    await orch.closeAgent("cc-agent", undefined, 0);

    expect(existsSync(planted.dir)).toBe(true);
    expect(existsSync(planted.thread)).toBe(true);
    expect(orch.store.getAgent("cc-agent")).toBeNull();
  });

  test("missing codex home is a no-op and the close still succeeds", async () => {
    await orch.launchAgent({ env: { AGENT_ID: "never-ran" }, runtime: "codex", projectDir: "/tmp/never" });

    process.env.HOME = fakeHome;
    await orch.closeAgent("never-ran", undefined, 250);

    expect(existsSync(join(spawnRoot, "never-ran"))).toBe(false);
    expect(orch.store.getAgent("never-ran")).toBeNull();
  });

  test("an unwritable spawn root fails CLOSED: nothing removed, said loudly, close unblocked", async () => {
    const stuck = seedSpawn("stuck");
    await orch.launchAgent({ env: { AGENT_ID: "stuck" }, runtime: "codex", projectDir: "/tmp/stuck" });

    // Read+execute only on the parent: unlink inside it fails with EACCES.
    chmodSync(spawnRoot, 0o500);
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    process.env.HOME = fakeHome;
    try {
      await orch.closeAgent("stuck", undefined, 250);
    } finally {
      console.error = orig;
      chmodSync(spawnRoot, 0o700);
    }

    // FAIL CLOSED: the INTENT receipt cannot be written into a 0500 spawn root, so
    // NOTHING is removed and it is said out loud. Stronger than the old contract,
    // which logged a failure only after deleting whatever it could.
    expect(existsSync(stuck.dir)).toBe(true);
    expect(existsSync(join(stuck.dir, "config.toml"))).toBe(true);
    const failure = logs.find((l) => l.includes("INTENT receipt undurable"));
    expect(failure).toBeDefined();
    expect(failure).toContain("NOTHING REMOVED");
    // The agent is still fully torn down — a leaked dir never keeps a row alive.
    expect(orch.store.getAgent("stuck")).toBeNull();
    expect(orch.store.getLatestTombstone("stuck")).not.toBeNull();
  });

  test("a run_as_uid agent is torn down in THAT uid's home, under sudo -u", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "ephem" },
      runtime: "codex",
      projectDir: "/tmp/ephem",
      runAsUid: "_ephemeral",
    });
    screenState.sshRunResult =
      "DISPOSE /Users/_ephemeral/.wire/codex-spawn/ephem/config.toml\n" +
      "RETAIN /Users/_ephemeral/.wire/codex-spawn/ephem/sessions\n" +
      "REMOVED /Users/_ephemeral/.wire/codex-spawn/ephem/config.toml\n" +
      "CREW_TEARDOWN_DONE\n";

    await orch.closeAgent("ephem", undefined, 250);

    const teardown = screenState.sshRunCalls.map((c) => c.command).find((c) => c.includes("codex-spawn"));
    expect(teardown).toBeDefined();
    expect(teardown).toContain("sudo -n -u _ephemeral");
    expect(teardown).toContain("CODEX_HOME='/Users/_ephemeral/.wire/codex-spawn/ephem'");
    // NO-GLOB-TO-RM, the intent of the old not.toContain("*"): the script globs to
    // ENUMERATE, but every removal takes ONE explicit path.
    // ⛔ NOT "stronger" — that claim was wrong and the review (T4) was right to call it.
    // This is a SHAPE assertion and it is blind to the only thing that matters: what "$p"
    // is BOUND TO. `rm -rf -- "$p"` is equally true when $p is the whole home. The gap is
    // closed at RUNTIME, not here — codex-spawn-preserve.test.ts, "T4: an explicit
    // whole-home target on the disposal list is REFUSED by the guard". Keep both: this row
    // catches a glob reappearing in the text, that row catches a bad binding.
    for (const line of teardown!.split("\n").filter((l) => l.includes("rm -rf"))) {
      expect(line).toContain('rm -rf -- "$p"');
    }
    expect(orch.store.getAgent("ephem")).toBeNull();
  });

  test("a remote rm that leaves the home behind is reported, close still completes", async () => {
    await orch.launchAgent({
      env: { AGENT_ID: "ephem2" },
      runtime: "codex",
      projectDir: "/tmp/ephem2",
      runAsUid: "_ephemeral",
    });
    screenState.sshRunResult =
      "PRE /Users/_ephemeral/.wire/codex-spawn/ephem2\n" +
      "REMAIN /Users/_ephemeral/.wire/codex-spawn/ephem2\n" +
      "CREW_TEARDOWN_DONE\n";
    const logs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
      await orch.closeAgent("ephem2", undefined, 250);
    } finally {
      console.error = orig;
    }

    const failure = logs.find((l) => l.includes("codex-spawn teardown FAILED"));
    expect(failure).toContain("/Users/_ephemeral/.wire/codex-spawn/ephem2");
    expect(orch.store.getAgent("ephem2")).toBeNull();
  });
});

describe("registerAgent cross-uid path (coupled registration patch)", () => {
  // A central service does not share the registering persona's screen namespace,
  // so registerAgent resolves liveness through the REMOTE pid probe when the
  // caller supplies runAsUid. This path was hot-patched into the deployed tree
  // and existed in no commit; these are the only tests it has ever had.
  const caller = JSON.stringify({
    terminal_session_id: "iterm-session-9",
    screen_name: "wire-fondant",
    screen_pid: 31337,
    sty: "31337.wire-fondant",
  });

  test("rejects a runAsUid that is not a valid unix username, and writes no row", async () => {
    await expect(
      orch.registerAgent({
        id: "fondant", displayName: "Fondant", runAsUid: "bad uid; rm -rf /", callerSessionId: caller,
      }),
    ).rejects.toThrow(/invalid owning UID/);
    expect(orch.store.getAgent("fondant")).toBeNull();
  });

  test("uses the REMOTE pid probe, not the local isAlive, when runAsUid is given", async () => {
    // The local probe is made to say ALIVE. If the cross-uid path were not taken
    // this would register successfully — so the throw is what proves the branch.
    screenState.isAliveResult = true;
    screenState.remoteSessionPidResult = null;
    try {
      await expect(
        orch.registerAgent({
          id: "fondant", displayName: "Fondant", runAsUid: "fondant", callerSessionId: caller,
        }),
      ).rejects.toThrow(/is not running with pid 31337 as fondant/);
    } finally {
      screenState.isAliveResult = false;
      screenState.remoteSessionPidResult = null;
    }
  });

  test("registers and records run_as_uid in the manifest when the remote pid matches", async () => {
    // The manifest write is the COUPLING: this orchestrator path calls the
    // store's updateAgentManifest/createAgent. If the store half is reverted
    // while this half survives, the call is to a method that no longer exists.
    screenState.isAliveResult = false;
    screenState.remoteSessionPidResult = 31337;
    screenState.pidLooksAliveResult = true;
    // F3: isAttachedResult is false by default, which makes `attached` false with or
    // without the `!registerTarget &&` guard — so the pane assertion below proved
    // nothing until this line existed.
    screenState.isAttachedResult = true;
    try {
      const agent = await orch.registerAgent({
        id: "fondant", displayName: "Fondant", runAsUid: "fondant", callerSessionId: caller,
      });
      expect(agent.screen_name).toBe("wire-fondant");
      expect(agent.screen_pid).toBe(31337);
      expect(JSON.parse(orch.store.getAgent("fondant")!.spawn_manifest!).run_as_uid).toBe("fondant");
      // A cross-uid registration must not claim an attached pane — and with
      // isAttachedResult TRUE above, this now discriminates (mutant A kills it).
      expect(agent.pane).toBeNull();
    } finally {
      screenState.remoteSessionPidResult = null;
      screenState.pidLooksAliveResult = null;
    }
  });

  test("without runAsUid the local isAlive path still governs (no regression)", async () => {
    screenState.isAliveResult = true;
    screenState.remoteSessionPidResult = null; // remote probe would refuse if consulted
    try {
      const agent = await orch.registerAgent({
        id: "fondant", displayName: "Fondant", callerSessionId: caller,
      });
      expect(agent.screen_pid).toBe(31337);
      expect(orch.store.getAgent("fondant")!.spawn_manifest).toBeNull();
    } finally {
      screenState.isAliveResult = false;
    }
  });
});

describe("registerAgent re-registration branch (existingByScreen)", () => {
  // ⛔ THE COVERAGE GAP THIS CLOSES. The first three cross-uid tests all go through
  // createAgent, because beforeEach builds a fresh DB so getAgentByScreen is always
  // null. Every changed line on the re-registration path therefore had NO test, and
  // four single-line mutants survived the full suite. These enter the branch.
  const caller = JSON.stringify({
    terminal_session_id: "iterm-session-9",
    screen_name: "wire-fondant",
    screen_pid: 31337,
    sty: "31337.wire-fondant",
  });
  const FULL_MANIFEST = {
    env: { AGENT_PARENT: "brioche" },
    runtime: "claude-code",
    project_dir: "/opt/work",
    display_name: "Fondant",
    ttl_idle_minutes: 90,
    channels: ["dev"],
    aux_surface: "pane-7",
  };

  function seedRow(opts: { manifest?: string; runtime?: string; cc?: string } = {}) {
    return orch.store.createAgent({
      id: "fondant",
      display_name: "Fondant",
      runtime: opts.runtime ?? "claude-code",
      screen_name: "wire-fondant",
      screen_pid: 1,
      cc_session_id: opts.cc ?? "sess-old",
      spawn_manifest: opts.manifest,
    });
  }
  function crossUidAlive() {
    screenState.remoteSessionPidResult = 31337;
    screenState.pidLooksAliveResult = true;
  }
  const register = (extra: Record<string, unknown> = {}) =>
    orch.registerAgent({ id: "fondant", displayName: "Fondant", callerSessionId: caller, ...extra });

  // --- MUTANT D: the manifest merge must not become a clobber ---
  test("preserves every existing manifest field and adds run_as_uid", async () => {
    seedRow({ manifest: JSON.stringify(FULL_MANIFEST) });
    crossUidAlive();
    await register({ runAsUid: "fondant" });
    const stored = JSON.parse(orch.store.getAgent("fondant")!.spawn_manifest!);
    // Each asserted by name: a clobber that kept only run_as_uid passes any
    // assertion that merely checks run_as_uid is present.
    expect(stored.env).toEqual({ AGENT_PARENT: "brioche" });
    expect(stored.project_dir).toBe("/opt/work");
    expect(stored.ttl_idle_minutes).toBe(90);
    expect(stored.channels).toEqual(["dev"]);
    expect(stored.aux_surface).toBe("pane-7");
    expect(stored.display_name).toBe("Fondant");
    expect(stored.run_as_uid).toBe("fondant");
  });

  // --- MUTANT C: the runtime update must actually land ---
  test("updateAgentRuntime lands on the existing row", async () => {
    seedRow({ runtime: "claude-code" });
    crossUidAlive();
    await register({ runAsUid: "fondant", runtime: "codex" });
    expect(orch.store.getAgent("fondant")!.runtime).toBe("codex");
  });

  // --- MUTANT B: the cc-session guard, both directions ---
  test("a supplied cc_session_id IS written when the row stays claude-code", async () => {
    seedRow({ runtime: "claude-code", cc: "sess-old" });
    crossUidAlive();
    await register({ runAsUid: "fondant", runtime: "claude-code", ccSessionId: "sess-new" });
    expect(orch.store.getAgent("fondant")!.cc_session_id).toBe("sess-new");
  });

  test("a supplied cc_session_id is DISCARDED when the passed runtime is not claude-code", async () => {
    seedRow({ runtime: "claude-code", cc: "sess-old" });
    crossUidAlive();
    await register({ runAsUid: "fondant", runtime: "codex", ccSessionId: "sess-new" });
    // updateAgentRuntime's CASE WHEN nulls it on the move away from claude-code;
    // the point is that "sess-new" was NOT written.
    expect(orch.store.getAgent("fondant")!.cc_session_id).not.toBe("sess-new");
  });

  // --- F8: the omitted-runtime case, called out explicitly ---
  test("F8: with NO runtime passed, the row's own runtime governs and the id is dropped", async () => {
    seedRow({ runtime: "codex", cc: "sess-old" });
    crossUidAlive();
    await register({ runAsUid: "fondant", ccSessionId: "sess-new" });
    const row = orch.store.getAgent("fondant")!;
    expect(row.runtime).toBe("codex");          // inherited, not overwritten
    expect(row.cc_session_id).toBe("sess-old"); // the supplied id never landed
  });

  // --- F1: refuse, and leave the row byte-for-byte unchanged ---
  for (const [label, bad, kind] of [
    ["unparseable", "{not json", /unparseable spawn_manifest/],
    ["non-object (array)", "[1,2]", /non-object spawn_manifest \(parsed as array\)/],
    ["non-object (string)", "\"just a string\"", /non-object spawn_manifest \(parsed as string\)/],
    ["non-object (null)", "null", /non-object spawn_manifest \(parsed as null\)/],
  ] as const) {
    test(`F1: a ${label} manifest is REFUSED and the row is unchanged`, async () => {
      seedRow({ manifest: bad, runtime: "claude-code", cc: "sess-old" });
      const before = orch.store.getAgent("fondant")!;
      crossUidAlive();
      await expect(register({ runAsUid: "fondant", runtime: "codex", ccSessionId: "sess-new" }))
        .rejects.toThrow(kind);
      // ⇒ UNCHANGED-ROW EVIDENCE. The old code committed pid and runtime before the
      // parse threw, leaving a torn write. Every column must be as it was.
      const after = orch.store.getAgent("fondant")!;
      expect(after.spawn_manifest).toBe(before.spawn_manifest);
      expect(after.screen_pid).toBe(before.screen_pid);
      expect(after.runtime).toBe(before.runtime);
      expect(after.cc_session_id).toBe(before.cc_session_id);
    });
  }

  test("F1: the refusal never puts the manifest, env or session id in its message", async () => {
    seedRow({ manifest: '{"env":{"SECRET_TOKEN":"swordfish"},', cc: "sess-old" });
    crossUidAlive();
    let msg = "";
    try { await register({ runAsUid: "fondant", ccSessionId: "sess-new" }); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toMatch(/unparseable spawn_manifest/);
    expect(msg).not.toContain("swordfish");
    expect(msg).not.toContain("SECRET_TOKEN");
    expect(msg).not.toContain("sess-new");
    expect(msg).toContain("fondant"); // the agent id IS a safe identifier
  });

  // --- MUTANT A / F3: the pane guard, with isAttached actually true ---
  test("F3: a cross-uid registration claims no pane even when one IS attached and resolvable", async () => {
    // ⛔ TWO preconditions, and the assertion is vacuous without BOTH:
    //   1. isAttachedResult must be true, or `attached` is false regardless of the guard;
    //   2. a pane whose iterm_id matches the caller must EXIST, or callerPane resolves
    //      to null anyway and removing the guard changes nothing.
    // My first attempt set only (1) and mutant A still survived.
    orch.store.createTab("eng");
    orch.store.createPane("eng-nw", "eng");
    orch.store.setPaneItermId("eng-nw", "iterm-session-9");
    seedRow();
    crossUidAlive();
    screenState.isAttachedResult = true;
    const agent = await register({ runAsUid: "fondant" });
    expect(agent.pane).toBeNull();
    expect(orch.store.getAgent("fondant")!.pane).toBeNull();
  });

  test("F3 control: the SAME setup WITHOUT runAsUid does claim the pane", async () => {
    // Proves the preconditions above are real — if this did not link, the test
    // above would pass for the wrong reason.
    orch.store.createTab("eng");
    orch.store.createPane("eng-nw", "eng");
    orch.store.setPaneItermId("eng-nw", "iterm-session-9");
    seedRow();
    screenState.isAliveResult = true;
    screenState.isAttachedResult = true;
    const agent = await register({});
    expect(agent.pane).toBe("eng-nw");
  });

  // --- F4: a failed probe must not be reported as the session's absence ---
  test("F4: an unobservable screen namespace reports UNKNOWN, not 'not running'", async () => {
    seedRow();
    screenState.remoteProbeFailure = "sudo refused for uid 'fondant'";
    let msg = "";
    try { await register({ runAsUid: "fondant" }); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toMatch(/could not observe screen namespace/);
    expect(msg).toMatch(/UNKNOWN, not disproved/);
    expect(msg).not.toMatch(/is not running with pid/);
  });

  test("F4: a genuinely absent session still reports 'not running'", async () => {
    seedRow();
    screenState.remoteSessionPidResult = null; // probe worked; no such session
    await expect(register({ runAsUid: "fondant" }))
      .rejects.toThrow(/is not running with pid 31337 as fondant/);
  });

  // --- F7: one validator, and it is length-bounded ---
  test("F7: a uid containing '.' is accepted (SAFE_UID admits it; the old local regex did not)", async () => {
    seedRow();
    screenState.remoteSessionPidResult = 31337;
    screenState.pidLooksAliveResult = true;
    await expect(register({ runAsUid: "svc.worker" })).resolves.toBeDefined();
  });

  test("F7: an over-length uid is rejected", async () => {
    seedRow();
    crossUidAlive();
    await expect(register({ runAsUid: "a".repeat(65) })).rejects.toThrow(/invalid owning UID/);
  });

  test("F7: a uid starting with '-' is rejected (sudo option injection)", async () => {
    seedRow();
    crossUidAlive();
    await expect(register({ runAsUid: "-u" })).rejects.toThrow(/invalid owning UID/);
  });
});

describe("F5 · registration → consumer data flow (run_as_uid in the manifest)", () => {
  // ⛔ WHY THIS EXISTS. The reconciliation touches NO PR 91 source, and verifying that
  // proves nothing: registerAgent writes `run_as_uid` into agents.spawn_manifest, and
  // PR 91's teardown READS that column to choose which uid's home it operates on. The
  // coupling is a DATABASE COLUMN, so a source diff cannot see it.
  //
  //   registerAgent   →  writes run_as_uid into spawn_manifest
  //   targetFor       →  reads it → screen.RemoteTarget
  //   stopAgent       →  const target = this.targetFor(agent)      (PR 91's function)
  //   removeCodexSpawnHome → runAsUid: target?.runAsUid ?? manifest?.run_as_uid
  //                          env:      manifest?.env
  //
  // ⓘ NOTHING DESTRUCTIVE RUNS HERE. The cross-uid path goes through the mocked
  // `sshRun`, so the teardown command is CONSTRUCTED AND RECORDED, never executed.
  // These assert on the command string, which is the decision under test.
  const caller = JSON.stringify({
    terminal_session_id: "iterm-session-9",
    screen_name: "wire-fondant",
    screen_pid: 31337,
    sty: "31337.wire-fondant",
  });

  test("a registration-written run_as_uid redirects the codex teardown to that uid's home", async () => {
    orch.store.createAgent({
      id: "fondant",
      display_name: "Fondant",
      runtime: "codex",
      screen_name: "wire-fondant",
      screen_pid: 1,
      spawn_manifest: JSON.stringify({
        env: { AGENT_PARENT: "brioche" },
        runtime: "codex",
        project_dir: "/opt/work",
        display_name: "Fondant",
      }),
    });
    screenState.remoteSessionPidResult = 31337;
    screenState.pidLooksAliveResult = true;
    await orch.registerAgent({ id: "fondant", displayName: "Fondant", callerSessionId: caller, runAsUid: "_ephemeral" });

    // The manifest now carries the uid, and env survived the merge.
    const m = JSON.parse(orch.store.getAgent("fondant")!.spawn_manifest!);
    expect(m.run_as_uid).toBe("_ephemeral");
    expect(m.env).toEqual({ AGENT_PARENT: "brioche" });

    screenState.sshRunCalls.length = 0;
    await orch.stopAgent("fondant");

    // ⇒ The teardown addressed the OTHER uid's home because registration said so.
    const teardown = screenState.sshRunCalls.map((c) => c.command).join("\n");
    expect(teardown).toContain("/Users/_ephemeral/.wire/codex-spawn/fondant");
    expect(teardown).not.toContain("/Users/fondant/.wire/codex-spawn/fondant");
    expect(screenState.sshRunCalls.some((c) => (c.target as { runAsUid?: string })?.runAsUid === "_ephemeral")).toBe(true);
  });

  test("registration preserves env.AGENT_PARENT — an AUTHORIZATION input, not just metadata", async () => {
    // ⛔ WHY THIS IS SINGLED OUT FROM THE GENERAL env ASSERTION. crew-service's
    // authz.ts resolves an agent's SPAWNER from `spawn_manifest.env.AGENT_PARENT`
    // (authz.ts:88-93) and uses it for `canManageDescendant` and the restart guard
    // (authz.ts:254). So this key is not metadata — it decides WHO MAY ACT ON THE ROW.
    //
    // A clobbering merge would therefore not merely make an agent unresumable: it
    // would silently change authorization outcomes, in a repo whose own fixtures
    // never exercise a registration-rewritten manifest (authz.test.ts references
    // spawn_manifest but never run_as_uid).
    orch.store.createAgent({
      id: "fondant",
      display_name: "Fondant",
      runtime: "claude-code",
      screen_name: "wire-fondant",
      screen_pid: 1,
      spawn_manifest: JSON.stringify({ env: { AGENT_PARENT: "brioche", OTHER: "x" }, runtime: "claude-code", project_dir: "/opt/x", display_name: "F" }),
    });
    screenState.remoteSessionPidResult = 31337;
    screenState.pidLooksAliveResult = true;
    await orch.registerAgent({ id: "fondant", displayName: "Fondant", callerSessionId: caller, runAsUid: "_ephemeral" });

    const m = JSON.parse(orch.store.getAgent("fondant")!.spawn_manifest!);
    expect(m.env.AGENT_PARENT).toBe("brioche");
    expect(m.env.OTHER).toBe("x");
    expect(m.run_as_uid).toBe("_ephemeral");
  });

  test("with NO run_as_uid the same stop stays local — the uid is the only difference", async () => {
    // The control. Without it, the assertion above could pass for an unrelated reason.
    orch.store.createAgent({
      id: "fondant",
      display_name: "Fondant",
      runtime: "codex",
      screen_name: "wire-fondant",
      screen_pid: 1,
      spawn_manifest: JSON.stringify({ env: {}, runtime: "codex", project_dir: "/opt/work", display_name: "Fondant" }),
    });
    screenState.sshRunCalls.length = 0;
    await orch.stopAgent("fondant");
    expect(screenState.sshRunCalls.filter((c) => (c.target as { runAsUid?: string })?.runAsUid).length).toBe(0);
  });
});

describe("N4 · an unobservable probe must not authorise a delete or a spawn", () => {
  // ⛔ THE FAILURE THIS PREVENTS. A cross-uid liveness probe can fail — sudo refused,
  // SCREENDIR unreadable — and the old boolean reported that as `false`, i.e. "not
  // running". Both call sites below then DELETED the row. In resumeAgent's case it
  // went further and resumed a SECOND INSTANCE against a live screen.
  //
  // Losing an agent row is not recoverable by any other path: registerAgent is
  // self-registration, so no other process can put it back.
  //
  // ⓘ Nothing destructive runs here. Screen operations are mocked throughout, so a
  // "spawn" would be a recorded createSession call, and we assert there is none.
  function seedCrossUid(id = "ephemeral-lane") {
    return orch.store.createAgent({
      id,
      display_name: "Ephemeral",
      runtime: "claude-code",
      screen_name: `wire-${id}`,
      screen_pid: 4242,
      cc_session_id: "sess-keep",
      spawn_manifest: JSON.stringify({ run_as_uid: "_ephemeral", env: { A: "1" }, project_dir: "/opt/x", display_name: "E", runtime: "claude-code" }),
    });
  }

  test("launchAgent ABORTS and preserves the row when liveness is UNKNOWN", async () => {
    const before = seedCrossUid();
    screenState.remoteProbeFailure = "sudo refused for uid '_ephemeral'";
    createSessionCalls.length = 0;

    await expect(orch.launchAgent({ env: { AGENT_ID: "ephemeral-lane", AGENT_NAME: "Ephemeral" } }))
      .rejects.toThrow(/UNKNOWN, not disproved/);

    const after = orch.store.getAgent("ephemeral-lane");
    expect(after).not.toBeNull();
    expect(after!.screen_name).toBe(before.screen_name);
    expect(after!.cc_session_id).toBe("sess-keep");
    expect(after!.spawn_manifest).toBe(before.spawn_manifest);
    // ⇒ AND NOTHING WAS STARTED.
    expect(createSessionCalls.length).toBe(0);
  });

  test("resumeAgent ABORTS and preserves the row when liveness is UNKNOWN", async () => {
    const before = seedCrossUid();
    screenState.remoteProbeFailure = "SCREENDIR unreadable for uid '_ephemeral'";
    createSessionCalls.length = 0;

    await expect(orch.resumeAgent({ id: "ephemeral-lane", projectDir: "/opt/x" }))
      .rejects.toThrow(/UNKNOWN, not disproved/);

    const after = orch.store.getAgent("ephemeral-lane");
    expect(after).not.toBeNull();
    expect(after!.spawn_manifest).toBe(before.spawn_manifest);
    expect(createSessionCalls.length).toBe(0);
  });

  test("CONTROL: with an OBSERVABLE dead probe, launchAgent still prunes and spawns", async () => {
    // Without this the two tests above would pass against a launchAgent that had
    // simply stopped working. The uid path is identical; only observability differs.
    seedCrossUid();
    screenState.remoteProbeFailure = null;
    screenState.isAliveResult = false; // observed, and genuinely not running
    createSessionCalls.length = 0;

    await orch.launchAgent({ env: { AGENT_ID: "ephemeral-lane", AGENT_NAME: "Ephemeral" } });
    expect(createSessionCalls.length).toBeGreaterThan(0);
  });

  test("closeAgent does NOT certify a clean exit from an unobservable probe", async () => {
    // ⛔ The third deletion-adjacent consumer. Here UNKNOWN must NOT abort — we are
    // mid-teardown and abandoning it is worse — but it must not suppress the fallback
    // either. `fallbackUsed:false` would mean "it exited cleanly on its own", which a
    // probe that could not look has no standing to claim.
    orch.store.createAgent({
      id: "ephemeral-lane",
      display_name: "Ephemeral",
      runtime: "claude-code",
      screen_name: "wire-ephemeral-lane",
      screen_pid: 4242,
      spawn_manifest: JSON.stringify({ run_as_uid: "_ephemeral", env: {}, project_dir: "/opt/x", display_name: "E", runtime: "claude-code" }),
    });
    // ⚠️ REVISED. This test first used a PERSISTENT failure and asserted on
    // fallbackUsed — and it passed only because the mock's killRemoteSession did not
    // throw, i.e. the mock did not implement the production contract. With a faithful
    // mock, a persistent UNKNOWN aborts the close entirely (see N4b). The grace
    // decision is a TRANSIENT-failure question, so script exactly one failing probe:
    // timeoutMs 0 skips the poll loop, leaving the single post-loop probe.
    screenState.remoteProbeFailuresRemaining = 1;
    const r = await orch.closeAgent("ephemeral-lane", undefined, 0);
    expect(r.fallbackUsed).toBe(true);
  });

  test("CONTROL: an OBSERVED clean exit does report fallbackUsed:false", async () => {
    // Proves the assertion above discriminates rather than always reading true.
    orch.store.createAgent({
      id: "local-lane",
      display_name: "Local",
      runtime: "claude-code",
      screen_name: "wire-local-lane",
      screen_pid: 4242,
      spawn_manifest: JSON.stringify({ env: {}, project_dir: "/opt/x", display_name: "L", runtime: "claude-code" }),
    });
    screenState.remoteProbeFailure = null;
    screenState.remoteProbeFailuresRemaining = 0;
    screenState.isAliveResult = false; // observed, and genuinely gone
    const r = await orch.closeAgent("local-lane", undefined, 0);
    expect(r.fallbackUsed).toBe(false);
  });

  test("CONTROL: an OBSERVABLE live probe blocks a double resume with the running error", async () => {
    seedCrossUid();
    screenState.remoteProbeFailure = null;
    screenState.isAliveResult = true;
    await expect(orch.resumeAgent({ id: "ephemeral-lane", projectDir: "/opt/x" }))
      .rejects.toThrow(/is already running/);
    expect(orch.store.getAgent("ephemeral-lane")).not.toBeNull();
  });
});

describe("N5 · the uid acceptance contract, stated rather than implied", () => {
  // SAFE_UID replaced a local regex and the swap is NOT a pure tightening. These pin
  // the contract in both directions so a future edit cannot widen or narrow it silently.
  // ⓘ The policy is NOT changed here to make a review note go away — it is recorded.
  const caller = JSON.stringify({ terminal_session_id: "iterm-session-9", screen_name: "wire-fondant", screen_pid: 31337, sty: "31337.wire-fondant" });
  const reg = (runAsUid: unknown) =>
    orch.registerAgent({ id: "fondant", displayName: "Fondant", callerSessionId: caller, runAsUid } as never);

  function seed() {
    orch.store.createAgent({ id: "fondant", display_name: "Fondant", runtime: "claude-code", screen_name: "wire-fondant", screen_pid: 1 });
    screenState.remoteSessionPidResult = 31337;
    screenState.pidLooksAliveResult = true;
  }

  test("an EMPTY uid is now REJECTED, where it used to fall through to the local path", () => {
    // Deliberate behaviour change from the `!== undefined` guard: explicit over
    // implicit. `runAsUid: ""` asked for a cross-uid registration and must not be
    // silently downgraded to a same-uid one.
    seed();
    return expect(reg("")).rejects.toThrow(/invalid owning UID/);
  });

  test("ACCEPTED: dotted and numeric-leading uids (SAFE_UID admits both)", async () => {
    seed();
    await expect(reg("svc.worker")).resolves.toBeDefined();
    orch.store.deleteAgentByScreen("wire-fondant");
    seed();
    // Numeric-leading is accepted and is NOT a root path: `sudo -u` resolves a bare
    // `0` as a USER NAME; a numeric uid requires a `#` prefix. It yields a nonsense
    // HOME rather than a dangerous one. Recorded so the widening is deliberate.
    await expect(reg("0")).resolves.toBeDefined();
  });

  test("REJECTED: over-length, leading dash, slash, and shell metacharacters", async () => {
    for (const bad of ["a".repeat(65), "-u", "a/b", "a;b", "a b", "a$b", "a`b", "a|b"]) {
      seed();
      await expect(reg(bad)).rejects.toThrow(/invalid owning UID/);
      orch.store.deleteAgentByScreen("wire-fondant");
    }
  });

  test("undefined still means same-uid, and is not rejected", async () => {
    seed();
    screenState.isAliveResult = true;
    await expect(reg(undefined)).resolves.toBeDefined();
  });
});

// ⛔ FILE-SCOPED RESET — beforeEach is NOT sufficient for these two.
//
// `mock.module("./screen", …)` replaces the module PROCESS-WIDE, so `screenState`
// outlives this file. beforeEach clears the fields before each test HERE, but whatever
// the LAST test leaves behind is still in effect when the NEXT FILE runs — and
// screen.test.ts imports the mocked module and asserts on the REAL pidLooksAlive.
//
// Measured, not theorised: with `pidLooksAliveResult` left `true` by the final test in
// this file, `pidLooksAlive > a reaped process is provably dead (ESRCH)` fails in
// screen.test.ts, and mock-isolation.test.ts catches it as an ORDER failure. The
// reviewer called this leak "latent, not live"; adding tests that set the field made it
// live. The scope of the reset has to match the scope of the leak.
afterAll(() => {
  // Same list as beforeEach, BY CONSTRUCTION — see resetScreenState().
  resetScreenState();
});

describe("N5 · registration → agents.runtime → the teardown decisions", () => {
  // ⛔ THE SECOND DATA COUPLING, AND THE MORE REACHABLE ONE. registerAgent writes
  // `agents.runtime`, and three teardown decisions read that column:
  //   runtimeUsesSlashExit  — closeAgent: /exit keystrokes vs not
  //   runtimeUsesSlashExit  — stopAgent:  SIGTERM-then-escalate vs not
  //   usesCodexSpawnHome    — whether the codex-home RECURSIVE DELETE happens at all,
  //                           or returns skipped:"not-a-codex-runtime"
  //
  // ⚠️ Unlike run_as_uid — which crew-service resolves from observed screen state and
  // never accepts from a caller — `runtime` IS declared on the MCP schema and forwarded
  // by the dispatch. So this input is CALLER-SUPPLIED, which makes the reach that
  // follows it more consequential, not less.
  //
  // The behaviour is correct and predates this batch; what was missing is any test that
  // the column's REACH works. Every existing teardown test seeds runtime through
  // createAgent, never through registerAgent.
  //
  // ⓘ NOTHING DESTRUCTIVE RUNS. These use the cross-uid path, so the delete is
  // constructed and recorded through the mocked sshRun, never executed.
  const caller = JSON.stringify({
    terminal_session_id: "iterm-session-9",
    screen_name: "wire-fondant",
    screen_pid: 31337,
    sty: "31337.wire-fondant",
  });
  function seed(runtime: string) {
    orch.store.createAgent({
      id: "fondant",
      display_name: "Fondant",
      runtime,
      screen_name: "wire-fondant",
      screen_pid: 1,
      spawn_manifest: JSON.stringify({ run_as_uid: "_ephemeral", env: {}, project_dir: "/opt/x", display_name: "F", runtime }),
    });
    screenState.remoteSessionPidResult = 31337;
    screenState.pidLooksAliveResult = true;
  }
  const register = (extra: Record<string, unknown>) =>
    orch.registerAgent({ id: "fondant", displayName: "Fondant", callerSessionId: caller, runAsUid: "_ephemeral", ...extra });

  test("claude-code → codex: registration ENABLES the codex-home teardown", async () => {
    seed("claude-code");
    await register({ runtime: "codex" });
    expect(orch.store.getAgent("fondant")!.runtime).toBe("codex");

    screenState.sshRunCalls.length = 0;
    const r = await orch.stopAgent("fondant");
    // ⇒ No longer skipped: the registration decided the delete may proceed.
    expect(r.teardown?.skipped).not.toBe("not-a-codex-runtime");
    expect(screenState.sshRunCalls.map((c) => c.command).join("\n")).toContain("/Users/_ephemeral/.wire/codex-spawn/fondant");
  });

  test("codex → claude-code: registration DISABLES it, and the delete is not constructed", async () => {
    seed("codex");
    await register({ runtime: "claude-code" });
    expect(orch.store.getAgent("fondant")!.runtime).toBe("claude-code");

    screenState.sshRunCalls.length = 0;
    const r = await orch.stopAgent("fondant");
    expect(r.teardown?.skipped).toBe("not-a-codex-runtime");
    expect(screenState.sshRunCalls.map((c) => c.command).join("\n")).not.toContain("codex-spawn/fondant");
  });

  test("runtime OMITTED: the row's own runtime is preserved and still governs the teardown", async () => {
    // The third direction, and the one a two-case test would miss: registering without
    // a runtime must not reset the column, or a re-registration would silently disable
    // a codex agent's cleanup.
    seed("codex");
    await register({});
    expect(orch.store.getAgent("fondant")!.runtime).toBe("codex");

    screenState.sshRunCalls.length = 0;
    const r = await orch.stopAgent("fondant");
    expect(r.teardown?.skipped).not.toBe("not-a-codex-runtime");
  });

  test("registration also flips the SHUTDOWN MODE that runtime selects", async () => {
    // runtimeUsesSlashExit: claude-code gets /exit keystrokes; codex does not.
    // Asserted through the recorded keystroke log rather than an internal.
    seed("codex");
    await register({ runtime: "claude-code" });
    screenState.sendKeysLog.length = 0;
    await orch.closeAgent("fondant", undefined, 250);
    expect(screenState.sendKeysLog.some((k) => k.keys.includes("/exit"))).toBe(true);
  });

  test("CONTROL: with the row left on codex, close does NOT send /exit", async () => {
    seed("codex");
    await register({});
    screenState.sendKeysLog.length = 0;
    await orch.closeAgent("fondant", undefined, 250);
    expect(screenState.sendKeysLog.some((k) => k.keys.includes("/exit"))).toBe(false);
  });
});

describe("N4b · persistent UNKNOWN through terminate → hard-kill", () => {
  // ⚠️ MY EARLIER CLAIM "never an abort" WAS TOO BROAD, and the ED was right to
  // challenge it. terminateAgentTree converts UNKNOWN into an escalation (survivors=1),
  // but the escalation's next step is killAgentSession → killRemoteSession, which
  // THROWS on UNKNOWN. So a PERSISTENTLY unobservable namespace does abort the stop.
  //
  // That is the correct outcome — but only if it aborts BEFORE anything destructive or
  // irreversible. These pin exactly that: the row survives, no tombstone, and no
  // teardown command is ever constructed.
  const manifest = JSON.stringify({ run_as_uid: "_ephemeral", env: { A: "1" }, project_dir: "/opt/x", display_name: "F", runtime: "codex" });
  function seedCodexCrossUid() {
    orch.store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "codex",
      screen_name: "wire-fondant", screen_pid: 1, spawn_manifest: manifest,
    });
  }

  test("stopAgent THROWS and the row, its manifest and its tombstone state are all retained", async () => {
    seedCodexCrossUid();
    screenState.remoteProbeFailure = "sudo refused for uid '_ephemeral'";
    screenState.sshRunCalls.length = 0;

    await expect(orch.stopAgent("fondant")).rejects.toThrow(/screen probe unavailable/);

    const row = orch.store.getAgent("fondant");
    expect(row).not.toBeNull();
    expect(row!.spawn_manifest).toBe(manifest);
    // ⇒ AND NOTHING DESTRUCTIVE WAS EVEN CONSTRUCTED: no codex-home delete command.
    expect(screenState.sshRunCalls.map((c) => c.command).join("\n")).not.toContain("codex-spawn/fondant");
  });

  test("closeAgent THROWS and retains the row the same way", async () => {
    seedCodexCrossUid();
    screenState.remoteProbeFailure = "SCREENDIR unreadable for uid '_ephemeral'";
    screenState.sshRunCalls.length = 0;

    await expect(orch.closeAgent("fondant", undefined, 250)).rejects.toThrow(/screen probe unavailable/);

    expect(orch.store.getAgent("fondant")).not.toBeNull();
    expect(screenState.sshRunCalls.map((c) => c.command).join("\n")).not.toContain("codex-spawn/fondant");
  });

  test("UNKNOWN → later OBSERVED recovers within the existing policy, with no extra kill", async () => {
    // A transient refusal must not permanently wedge a stop, and must not cause the
    // recovery path to do anything the normal path would not. Two probes fail, then
    // observation resumes.
    // ⚠️ RECOVERY IS A LATER CALL, NOT A RETRY. My first version of this test assumed
    // stopAgent would retry past a transient failure. It does not — there is no retry
    // loop around killAgentSession, so the first call aborts. That is the correct
    // design (a failed observation should not be papered over by looping), and the
    // honest scenario is: one call fails closed, a later call succeeds.
    seedCodexCrossUid();
    // ⓘ TWO failures, and the count is the finding: a codex stop probes TWICE —
    // terminateAgentTree first (whose catch ABSORBS the throw and returns 1), then
    // killAgentSession. With only one scripted failure the stop SUCCEEDS, because the
    // terminate catch swallows it. That is the P1 mechanism observed from the outside,
    // and it is why the catch's return value is only ever load-bearing for a transient.
    screenState.remoteProbeFailuresRemaining = 2;
    screenState.killSessionCalls.length = 0;
    screenState.killSessionSurvivors = 0;

    // Call 1 — persistent-enough UNKNOWN: aborts, row retained, nothing destroyed.
    await expect(orch.stopAgent("fondant")).rejects.toThrow(/screen probe unavailable/);
    expect(orch.store.getAgent("fondant")).not.toBeNull();
    expect(screenState.killSessionCalls.length).toBe(0);

    // Call 2 — the probe now observes. Proceeds through the ORDINARY path.
    screenState.remoteSessionPidResult = null;
    const r = await orch.stopAgent("fondant");
    expect(orch.store.getAgent("fondant")).toBeNull();
    expect(r.teardown?.skipped).not.toBe("not-a-codex-runtime");
    // ⇒ WITHIN EXISTING POLICY: exactly one kill, of the one session. The failed call
    //   left no queued or duplicated work behind.
    expect(screenState.killSessionCalls.filter((n) => n === "wire-fondant").length).toBe(1);
  });
});

describe("P1 · terminateAgentTree's UNKNOWN escalation value", () => {
  // ⛔ THE VALUE THE COMMENT TURNS ON, AND IT WAS UNTESTED. terminateAgentTree catches
  // ScreenProbeUnavailable and returns 1 — "unknown survivors", which must never be 0,
  // because 0 is the value that CERTIFIES A CLEAN TERM. Flipping it to 0 left the suite
  // at 379/0: the repository could not tell "we could not count" from "we counted none".
  //
  // ⚠️ AND THE COMMENT OVERSTATED THE MECHANISM, which is corrected in source. For a
  // PERSISTENT failure the escalation this value triggers dies one line later in
  // killRemoteSession, so the 1 never matters. It matters only for a TRANSIENT failure
  // that clears between the two probes — which is exactly what this test scripts.
  function seedCodexCrossUid() {
    orch.store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "codex",
      screen_name: "wire-fondant", screen_pid: 1,
      spawn_manifest: JSON.stringify({ run_as_uid: "_ephemeral", env: {}, project_dir: "/opt/x", display_name: "F", runtime: "codex" }),
    });
  }

  test("a TRANSIENT probe failure during terminate reports a survivor, not a clean term", async () => {
    seedCodexCrossUid();
    // Exactly one failure: consumed by terminateRemoteSessionTree. The hard reap that
    // follows observes normally, so the run completes and the return value is visible.
    screenState.remoteProbeFailuresRemaining = 1;
    screenState.remoteSessionPidResult = null;
    screenState.killSessionSurvivors = 0;

    const r = await orch.closeAgent("fondant", undefined, 250);
    // ⇒ fallbackUsed is `survivorsAfterTerm > 0`. With the catch returning 1 this is
    //   true; with the mutant returning 0 it is false and a clean term is certified.
    expect(r.fallbackUsed).toBe(true);
  });

  test("CONTROL: an OBSERVED zero-survivor terminate does report a clean term", async () => {
    // Without this the assertion above passes for a closeAgent that always escalates.
    seedCodexCrossUid();
    screenState.remoteProbeFailuresRemaining = 0;
    screenState.terminateSessionSurvivors = 0;
    screenState.remoteSessionPidResult = null;
    screenState.killSessionSurvivors = 0;

    const r = await orch.closeAgent("fondant", undefined, 250);
    expect(r.fallbackUsed).toBe(false);
  });
});

describe("P2 · the grace loop stops on an unobservable probe", () => {
  test("a permanently failed probe is polled ONCE, not for the whole window", async () => {
    // ⛔ "A probe that cannot look does not become true by repetition" was already
    // written in pollRemoteSessionPid and not carried here: the loop spent the full
    // window issuing ~40 sudo probes and ~40 identical log lines before throwing in
    // killAgentSession anyway. Timing is not asserted — the OBSERVABLE is that the
    // close still fails closed, and it now does so promptly.
    orch.store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant", screen_pid: 1,
      spawn_manifest: JSON.stringify({ run_as_uid: "_ephemeral", env: {}, project_dir: "/opt/x", display_name: "F", runtime: "claude-code" }),
    });
    screenState.remoteProbeFailure = "sudo refused for uid '_ephemeral'";
    const started = Date.now();
    await expect(orch.closeAgent("fondant", undefined, 10_000)).rejects.toThrow(/screen probe unavailable/);
    // A 10s window that returns in well under it is the behavioural signature of the
    // early break. Generous bound so this cannot flake on a loaded machine.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

test("R4 GUARD: resetScreenState covers EVERY declared screenState field", () => {
  // ⛔ WHY A TEST AND NOT A CAREFUL LIST. The reset list has now drifted from the
  // declared surface three separate times: afterAll once held 5 of 16; extracting the
  // single list revealed `isAliveResult` was in NEITHER copy; and the re-review found
  // afterAll had "gained a field it does not reset". Each time the fix was to look
  // harder, and each time it drifted again on the next edit.
  //
  // A list that must match another list is not a discipline problem, it is a missing
  // assertion. This reads both from the source and fails the moment they diverge, so
  // adding a field to screenState without resetting it cannot ship.
  const src = readFileSync(new URL("./orchestrator.test.ts", import.meta.url), "utf8");

  const declStart = src.indexOf("const screenState = {");
  expect(declStart).toBeGreaterThan(-1);
  const decl = src.slice(declStart, src.indexOf("\n};", declStart));
  const declared = [...decl.matchAll(/^  ([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]);

  const fnStart = src.indexOf("function resetScreenState(): void {");
  expect(fnStart).toBeGreaterThan(-1);
  const fn = src.slice(fnStart, src.indexOf("\n}", fnStart));
  const reset = new Set([...fn.matchAll(/screenState\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]));

  expect(declared.length).toBeGreaterThan(10); // the parse found a real declaration
  const missing = declared.filter((f) => !reset.has(f));
  expect({ missing, declared: declared.length, reset: reset.size })
    .toEqual({ missing: [], declared: declared.length, reset: declared.length });
});
