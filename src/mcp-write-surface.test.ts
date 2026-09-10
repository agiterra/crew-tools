/**
 * AGI-27 items 1-2 regression guard: the MCP server must perform NO crews.db
 * write. Every mutating tool routes through crew-service RPC (crewRpc /
 * crewRpcTo / tryCrewRpc), which re-derives the caller from the signed frame
 * and applies per-agent authorization; reads stay local.
 *
 * This is asserted against the dispatch source because `startServer()` binds a
 * real terminal backend and MCP transport — there is no seam to instantiate it
 * in-process. The complementary runtime proof (a readonly store performs no
 * heal write and does not throw) lives in reality-authz.test.ts.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SRC = readFileSync(join(import.meta.dir, "mcp-server.ts"), "utf8");

/** Every mutating method on CrewStore. */
const STORE_WRITES = [
  "createTab", "setTabTheme", "deleteTab",
  "createPane", "setPaneItermId", "clearPaneItermId", "setPaneTheme", "renamePane",
  "clearTabSession", "deletePane",
  "createAgent", "tombstoneAgent", "setAgentTtl", "setAgentBadge",
  "updateAgentPid", "updateAgentPane", "updateAgentStatus", "touchAgent",
  "deleteAgent", "deleteAgentByScreen", "updateAgentCcSession",
  "createMachine", "deleteMachine", "updateMachineProbe",
];

/** The body of the CallTool dispatch switch. */
function dispatchBody(): string {
  const start = SRC.indexOf("switch (name) {");
  expect(start).toBeGreaterThan(-1);
  const end = SRC.indexOf("throw new Error(`unknown tool:", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("MCP server write surface", () => {
  test("no tool case calls a CrewStore write method", () => {
    const body = dispatchBody();
    const offenders = STORE_WRITES.filter((w) => new RegExp(`\\.${w}\\s*\\(`).test(body));
    expect(offenders).toEqual([]);
  });

  test("the whole server file calls no CrewStore write method", () => {
    const offenders = STORE_WRITES.filter((w) => new RegExp(`\\.${w}\\s*\\(`).test(SRC));
    expect(offenders).toEqual([]);
  });

  test("agent_list routes its lazy-GC heal through crew-service RPC", () => {
    const body = dispatchBody();
    const start = body.indexOf('case "agent_list"');
    expect(start).toBeGreaterThan(-1);
    const caseBody = body.slice(start, body.indexOf("case ", start + 10));
    expect(caseBody).toContain('"crew.agent_heal"');
    expect(caseBody).toMatch(/tryCrewRpc\(|crewRpc\(/);
  });

  test("every mutating tool case reaches crewRpc", () => {
    const body = dispatchBody();
    // Tools that mutate crew state. Reads are excluded by design.
    const MUTATING = [
      "agent_launch", "agent_resume", "agent_register", "agent_badge",
      "agent_interrupt", "agent_close", "agent_stop", "agent_attach",
      "agent_detach", "agent_move", "agent_swap", "agent_send",
      "tab_register", "tab_create", "tab_destroy",
      "pane_register", "pane_create", "pane_send", "pane_badge",
      "pane_notify", "pane_close", "url_open", "theme_update",
      "reconcile", "machine_register", "machine_remove", "machine_probe",
    ];
    const missing: string[] = [];
    for (const tool of MUTATING) {
      const at = body.indexOf(`case "${tool}"`);
      expect(at).toBeGreaterThan(-1);
      const next = body.indexOf('case "', at + 10);
      const caseBody = body.slice(at, next === -1 ? undefined : next);
      if (!/crewRpc(To)?\(|tryCrewRpc\(/.test(caseBody)) missing.push(tool);
    }
    expect(missing).toEqual([]);
  });

  test("self-stamp (cc_session_id / pane / attach) goes through RPC, not the store", () => {
    const stamp = SRC.slice(SRC.indexOf("// Self-stamp:"), SRC.indexOf("Detect the caller's terminal session ID"));
    expect(stamp).toContain('"crew.agent_register"');
    expect(stamp).toContain('"crew.pane_register"');
    expect(stamp).toContain('"crew.agent_attach"');
    const offenders = STORE_WRITES.filter((w) => new RegExp(`\\.${w}\\s*\\(`).test(stamp));
    expect(offenders).toEqual([]);
  });
});
