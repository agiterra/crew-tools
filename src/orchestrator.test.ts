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
