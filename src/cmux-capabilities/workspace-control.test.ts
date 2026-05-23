import { describe, test, expect } from "bun:test";
import { CmuxWorkspaceControl, type CmuxCli, type CmuxJsonCli } from "./workspace-control";

function makeMocks(opts: { tree?: any; cliThrows?: Error } = {}) {
  const calls: string[][] = [];
  const cli: CmuxCli = async (...args) => {
    calls.push(args);
    if (opts.cliThrows) throw opts.cliThrows;
    return "OK";
  };
  const jsonCli: CmuxJsonCli = async () => opts.tree ?? { windows: [] };
  return { cli, jsonCli, calls };
}

describe("CmuxWorkspaceControl", () => {
  test("rename resolves the workspace from the tree and invokes rename-workspace", async () => {
    const tree = {
      windows: [
        {
          workspaces: [
            { ref: "workspace:3", panes: [{ surfaces: [{ ref: "surface:7" }] }] },
            { ref: "workspace:4", panes: [{ surfaces: [{ ref: "surface:9" }] }] },
          ],
        },
      ],
    };
    const { cli, jsonCli, calls } = makeMocks({ tree });
    const impl = new CmuxWorkspaceControl(cli, jsonCli);
    await impl.rename("surface:9", "engineering");
    expect(calls).toEqual([["rename-workspace", "--workspace", "workspace:4", "engineering"]]);
  });

  test("rename no-ops silently when the surface isn't in the tree", async () => {
    const { cli, jsonCli, calls } = makeMocks({ tree: { windows: [] } });
    const impl = new CmuxWorkspaceControl(cli, jsonCli);
    await impl.rename("surface:missing", "foo");
    expect(calls).toEqual([]);
  });

  test("rename swallows CLI errors (decorative)", async () => {
    const tree = {
      windows: [
        { workspaces: [{ ref: "workspace:3", panes: [{ surfaces: [{ ref: "surface:7" }] }] }] },
      ],
    };
    const { cli, jsonCli } = makeMocks({ tree, cliThrows: new Error("cmux gone") });
    const impl = new CmuxWorkspaceControl(cli, jsonCli);
    await expect(impl.rename("surface:7", "x")).resolves.toBeUndefined();
  });
});
