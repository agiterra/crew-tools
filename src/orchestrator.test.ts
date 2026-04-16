import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TerminalBackend } from "./terminal";

// Capture the command passed to screen.createSession so we can assert on the
// spawn-time env exports. Mock is installed before Orchestrator is imported.
const createSessionCalls: Array<{ name: string; command: string }> = [];
const screenState = { isAliveResult: false, isAttachedResult: false };
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
  sendKeys: async () => {},
  readOutput: async () => "",
  killSession: async () => {},
}));

const { Orchestrator } = await import("./orchestrator");

function makeTerminal(): TerminalBackend {
  return {
    name: "test",
    currentSessionId: mock(async () => ""),
    sessionIdForTty: mock(async () => null),
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
  tmpDir = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  dbPath = join(tmpDir, "test.db");
  orch = new Orchestrator(makeTerminal(), dbPath);
  createSessionCalls.length = 0;
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
    ).rejects.toThrow(/no cc_session_id supplied and no tombstone/);
  });
});

describe("registerAgent id-mismatch safety", () => {
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
