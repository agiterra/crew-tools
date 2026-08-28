import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { execSync } from "child_process";
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
mock.module("./screen", () => ({
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
  killRemoteSession: async (name: string) => {
    screenState.killSessionCalls.push(name);
    return screenState.killSessionSurvivors;
  },
  terminateRemoteSessionTree: async (name: string, _target: unknown, timeoutMs: number) => {
    screenState.terminateSessionCalls.push({ name, timeoutMs });
    return screenState.terminateSessionSurvivors;
  },
  createRemoteSession: async (name: string, command: string) => {
    createSessionCalls.push({ name, command });
    return { name, pid: 12345 };
  },
  // Imported by credentials.ts (remote credential read). Unused in these tests
  // (CREW_SKIP_CRED_CHECK short-circuits) but the mock must satisfy the import.
  sshRun: async () => "",
  getRemoteSessionPid: async () => null,
  pollRemoteSessionPid: async () => null,
  // Post-spawn verify chain (v2.26.0). Tests inject channelProbe/argvReader
  // explicitly; these defaults make un-injected background chains resolve
  // immediately instead of polling their full windows against a dead mock.
  channelPluginAlive: async () => false,
  sessionClaudeArgv: async () => screenState.argvResult,
}));

const { Orchestrator, SOURCE_NEAREST_ENV, autoConfirmDevChannel, askedFromCommand, verifySpawnArgv, verifyWireInbound } = await import("./orchestrator");

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
  screenState.screens = {};
  screenState.sendKeysLog.length = 0;
  screenState.sendKeysHook = null;
  screenState.readOutputHook = undefined;
  screenState.killSessionCalls.length = 0;
  screenState.killSessionSurvivors = 0;
  screenState.terminateSessionCalls.length = 0;
  screenState.terminateSessionSurvivors = 0;
  screenState.argvResult = null;
  wireState.roster = [];
  wireState.failWith = null;
  wireState.bodyOverride = undefined;
  wireState.calls.length = 0;
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
    expect(cmd).toContain("AGENT_NAME='Test Agent'");
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

  test("resumes from tombstone with null cc_session_id by launching fresh (no --resume flag)", async () => {
    // Agent that /exit'd before CC wrote a session file — tombstone has
    // manifest but no cc_session_id. Brioche's verification case #9.
    await orch.launchAgent({
      env: { AGENT_ID: "never-booted" },
      projectDir: "/tmp/nb",
    });
    // Leave cc_session_id as NULL — simulate an agent that never booted CC.
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
      expect(row!.cc_session_id).toBeNull();
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
