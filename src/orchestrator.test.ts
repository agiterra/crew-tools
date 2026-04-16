import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { TerminalBackend } from "./terminal";

// Capture the command passed to screen.createSession so we can assert on the
// spawn-time env exports. Mock is installed before Orchestrator is imported.
const createSessionCalls: Array<{ name: string; command: string }> = [];
mock.module("./screen", () => ({
  createSession: async (name: string, command: string) => {
    createSessionCalls.push({ name, command });
    return { name, pid: 12345 };
  },
  listSessions: async () => [],
  getSessionPid: async () => null,
  isAlive: async () => false,
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
