import { describe, test, expect } from "bun:test";
import { CmuxWorkspaceSplit, type CmuxCli, type SurfaceResolver } from "./workspace-split";

function makeMocks(opts: {
  resolved?: { ref: string; ws: string | null; id: string | null } | null;
  cliResult?: string;
  cliThrows?: Error;
} = {}) {
  const calls: string[][] = [];
  const cli: CmuxCli = async (...args) => {
    calls.push(args);
    if (opts.cliThrows) throw opts.cliThrows;
    return opts.cliResult ?? "OK surface:42 workspace:3";
  };
  const resolveSurface: SurfaceResolver = async () => opts.resolved ?? null;
  return { cli, resolveSurface, calls };
}

describe("CmuxWorkspaceSplit", () => {
  test("splitFromCaller invokes new-split with resolved surface + workspace", async () => {
    const { cli, resolveSurface, calls } = makeMocks({
      resolved: { ref: "surface:7", ws: "workspace:3", id: null },
    });
    const impl = new CmuxWorkspaceSplit(cli, resolveSurface);
    const result = await impl.splitFromCaller("surface:7", "right");
    expect(calls).toEqual([["new-split", "right", "--surface", "surface:7", "--workspace", "workspace:3"]]);
    expect(result).toBe("surface:42");
  });

  test("splitFromCaller returns null when caller surface unresolved", async () => {
    const { cli, resolveSurface, calls } = makeMocks({ resolved: null });
    const impl = new CmuxWorkspaceSplit(cli, resolveSurface);
    const result = await impl.splitFromCaller("surface:bogus", "right");
    expect(result).toBeNull();
    expect(calls).toEqual([]);
  });

  test("splitFromCaller returns null when CLI throws", async () => {
    const { cli, resolveSurface } = makeMocks({
      resolved: { ref: "surface:7", ws: "workspace:3", id: null },
      cliThrows: new Error("cmux down"),
    });
    const impl = new CmuxWorkspaceSplit(cli, resolveSurface);
    const result = await impl.splitFromCaller("surface:7", "down");
    expect(result).toBeNull();
  });

  test("splitFromCaller passes direction 'down' through correctly", async () => {
    const { cli, resolveSurface, calls } = makeMocks({
      resolved: { ref: "surface:7", ws: null, id: null },
    });
    const impl = new CmuxWorkspaceSplit(cli, resolveSurface);
    await impl.splitFromCaller("surface:7", "down");
    expect(calls[0]).toEqual(["new-split", "down", "--surface", "surface:7"]);
  });
});
