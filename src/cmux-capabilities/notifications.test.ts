import { describe, test, expect } from "bun:test";
import { CmuxNotifications, type CmuxCli, type SurfaceArgsResolver } from "./notifications";
import { runNotificationsContract } from "../capabilities/notifications.contract";

function makeMocks(opts: { cliResult?: string; cliThrows?: Error } = {}) {
  const calls: string[][] = [];
  const cli: CmuxCli = async (...args) => {
    calls.push(args);
    if (opts.cliThrows) throw opts.cliThrows;
    return opts.cliResult ?? "OK";
  };
  const surfaceArgs: SurfaceArgsResolver = async (sid) => ["--surface", sid];
  return { cli, surfaceArgs, calls };
}

describe("CmuxNotifications transport", () => {
  test("notify invokes cmux 'notify' with --title and surface args", async () => {
    const { cli, surfaceArgs, calls } = makeMocks();
    const impl = new CmuxNotifications(cli, surfaceArgs);
    await impl.notify("surface:7", "hello");
    expect(calls).toEqual([["notify", "--title", "hello", "--surface", "surface:7"]]);
  });

  test("notify appends --body when present", async () => {
    const { cli, surfaceArgs, calls } = makeMocks();
    const impl = new CmuxNotifications(cli, surfaceArgs);
    await impl.notify("surface:7", "hello", "world");
    expect(calls[0]).toContain("--body");
    expect(calls[0]).toContain("world");
  });

  test("flash invokes cmux 'trigger-flash' with surface args", async () => {
    const { cli, surfaceArgs, calls } = makeMocks();
    const impl = new CmuxNotifications(cli, surfaceArgs);
    await impl.flash("surface:7");
    expect(calls).toEqual([["trigger-flash", "--surface", "surface:7"]]);
  });

  test("notify swallows CLI errors (decorative)", async () => {
    const { cli, surfaceArgs } = makeMocks({ cliThrows: new Error("cmux not running") });
    const impl = new CmuxNotifications(cli, surfaceArgs);
    await expect(impl.notify("surface:7", "hello")).resolves.toBeUndefined();
  });

  test("flash swallows CLI errors (decorative)", async () => {
    const { cli, surfaceArgs } = makeMocks({ cliThrows: new Error("cmux not running") });
    const impl = new CmuxNotifications(cli, surfaceArgs);
    await expect(impl.flash("surface:7")).resolves.toBeUndefined();
  });
});

runNotificationsContract(
  "cmux",
  () => {
    const { cli, surfaceArgs } = makeMocks();
    return new CmuxNotifications(cli, surfaceArgs);
  },
  { exampleSessionId: "surface:1" },
);
