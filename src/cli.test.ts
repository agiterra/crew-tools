import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock screen so runCli can construct Orchestrator without real screen ops.
mock.module("./screen", () => ({
  createSession: async (name: string) => ({ name, pid: 12345 }),
  listSessions: async () => [],
  getSessionPid: async () => null,
  isAlive: async () => false,
  isAttached: async () => false,
  detachSession: async () => {},
  sendKeys: async () => {},
  readOutput: async () => "",
  killSession: async () => {},
}));

// Point the DB at a tmp file per test by overriding HOME. runCli's
// Orchestrator uses ~/.wire/crews.db by default; we redirect HOME.
let tmpDir: string;
let origHome: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crew-cli-"));
  origHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

const { runCli } = await import("./cli");

describe("crew CLI", () => {
  test("version prints the package version", async () => {
    const r = await runCli(["version"]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("help on no args", async () => {
    const r = await runCli([]);
    expect(r.exit).toBe(0);
    expect(r.stdout).toMatch(/Usage: crew/);
  });

  test("unknown command exits 1 with usage", async () => {
    const r = await runCli(["bogus"]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/unknown command: bogus/);
  });

  test("launch without --json exits 1", async () => {
    const r = await runCli(["launch"]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/requires --json/);
  });

  test("launch with JSON missing 'env.AGENT_ID' exits 1", async () => {
    const p = join(tmpDir, "launch-bad.json");
    writeFileSync(p, JSON.stringify({ env: { FOO: "bar" } }));
    const r = await runCli(["launch", "--json", p]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/AGENT_ID/);
  });

  test("resume without --json exits 1", async () => {
    const r = await runCli(["resume"]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/requires --json/);
  });

  test("resume with missing file exits 1 (invalid JSON)", async () => {
    const r = await runCli(["resume", "--json", "/tmp/does-not-exist-crew-cli.json"]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/invalid JSON/);
  });

  test("resume with JSON missing 'id' exits 1", async () => {
    const p = join(tmpDir, "opts.json");
    writeFileSync(p, JSON.stringify({ projectDir: "/tmp" }));
    const r = await runCli(["resume", "--json", p]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/must include 'id'/);
  });

  test("stop without id exits 1", async () => {
    const r = await runCli(["stop"]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/requires <id>/);
  });

  test("agent-send without text exits 1", async () => {
    const r = await runCli(["agent-send", "only-id"]);
    expect(r.exit).toBe(1);
    expect(r.stderr).toMatch(/requires <id> <text>/);
  });
});
