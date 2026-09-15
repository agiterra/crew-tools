import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Mock screen so runCli can construct Orchestrator without real screen ops.
import * as __realScreen from "./screen";
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
mock.module("./screen", () => ({
  ...__realScreen,
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
