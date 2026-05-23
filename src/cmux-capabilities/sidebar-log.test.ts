import { describe, test, expect } from "bun:test";
import { CmuxSidebarLog, type CmuxCli, type WorkspaceResolver } from "./sidebar-log";

function makeMocks(opts: { wsRef?: string | null; cliThrows?: Error } = {}) {
  const calls: string[][] = [];
  const cli: CmuxCli = async (...args) => {
    calls.push(args);
    if (opts.cliThrows) throw opts.cliThrows;
    return "OK";
  };
  const resolveWorkspace: WorkspaceResolver = async () => opts.wsRef ?? null;
  return { cli, resolveWorkspace, calls };
}

describe("CmuxSidebarLog", () => {
  test("append invokes 'cmux log' with default source=crew, no workspace if unresolved", async () => {
    const { cli, resolveWorkspace, calls } = makeMocks({ wsRef: null });
    const impl = new CmuxSidebarLog(cli, resolveWorkspace);
    await impl.append("surface:7", "agent attached");
    expect(calls).toEqual([["log", "--source", "crew", "--", "agent attached"]]);
  });

  test("append includes --workspace when resolver returns a workspace", async () => {
    const { cli, resolveWorkspace, calls } = makeMocks({ wsRef: "workspace:3" });
    const impl = new CmuxSidebarLog(cli, resolveWorkspace);
    await impl.append("surface:7", "hello");
    expect(calls[0]).toContain("--workspace");
    expect(calls[0]).toContain("workspace:3");
  });

  test("append passes --level when provided", async () => {
    const { cli, resolveWorkspace, calls } = makeMocks({ wsRef: "workspace:3" });
    const impl = new CmuxSidebarLog(cli, resolveWorkspace);
    await impl.append("surface:7", "fail", { level: "error" });
    expect(calls[0]).toContain("--level");
    expect(calls[0]).toContain("error");
  });

  test("append swallows CLI errors (decorative)", async () => {
    const { cli, resolveWorkspace } = makeMocks({ cliThrows: new Error("cmux not running") });
    const impl = new CmuxSidebarLog(cli, resolveWorkspace);
    await expect(impl.append("surface:7", "msg")).resolves.toBeUndefined();
  });
});
