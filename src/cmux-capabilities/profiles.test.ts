import { describe, test, expect } from "bun:test";
import { CmuxProfiles, type CmuxProfilesDeps } from "./profiles";

function makeDeps(): {
  deps: CmuxProfilesDeps;
  calls: { splitPane: any[]; splitSession: any[]; apply: any[] };
} {
  const calls = { splitPane: [] as any[], splitSession: [] as any[], apply: [] as any[] };
  const deps: CmuxProfilesDeps = {
    splitPane: async (d) => {
      calls.splitPane.push(d);
      return "surface:new";
    },
    splitSession: async (sid, d) => {
      calls.splitSession.push({ sid, d });
      return "surface:new-from";
    },
    applyToSurface: async (sid, profile) => {
      calls.apply.push({ sid, profile });
    },
  };
  return { deps, calls };
}

describe("CmuxProfiles", () => {
  test("writePane stores profile under a synthetic name", () => {
    const { deps } = makeDeps();
    const impl = new CmuxProfiles(deps);
    const name1 = impl.writePane({ paneName: "oak", backgroundImage: "/img/oak.png" });
    const name2 = impl.writePane({ paneName: "elm", backgroundImage: "/img/elm.png" });
    expect(name1).toMatch(/^cmux-profile-0-oak$/);
    expect(name2).toMatch(/^cmux-profile-1-elm$/);
  });

  test("writeEmpty returns 'cmux-empty' (no store entry)", () => {
    const { deps } = makeDeps();
    const impl = new CmuxProfiles(deps);
    expect(impl.writeEmpty()).toBe("cmux-empty");
  });

  test("setProfile applies the stored spec via applyToSurface", async () => {
    const { deps, calls } = makeDeps();
    const impl = new CmuxProfiles(deps);
    const name = impl.writePane({ paneName: "oak", backgroundImage: "/img/oak.png", blend: 0.5 });
    await impl.setProfile("surface:7", name);
    expect(calls.apply).toEqual([
      { sid: "surface:7", profile: { paneName: "oak", backgroundImage: "/img/oak.png", blend: 0.5 } },
    ]);
  });

  test("setProfile no-ops when profile name not in store", async () => {
    const { deps, calls } = makeDeps();
    const impl = new CmuxProfiles(deps);
    await impl.setProfile("surface:7", "cmux-empty");
    expect(calls.apply).toEqual([]);
  });

  test("splitPaneWithProfile splits then applies", async () => {
    const { deps, calls } = makeDeps();
    const impl = new CmuxProfiles(deps);
    const name = impl.writePane({ paneName: "oak", backgroundImage: "/img/oak.png" });
    const result = await impl.splitPaneWithProfile("horizontal", name);
    expect(result).toBe("surface:new");
    expect(calls.splitPane).toEqual(["horizontal"]);
    expect(calls.apply[0].sid).toBe("surface:new");
  });

  test("splitSessionWithProfile splits then applies", async () => {
    const { deps, calls } = makeDeps();
    const impl = new CmuxProfiles(deps);
    const name = impl.writePane({ paneName: "oak", backgroundImage: "/img/oak.png" });
    const result = await impl.splitSessionWithProfile("surface:src", "vertical", name);
    expect(result).toBe("surface:new-from");
    expect(calls.splitSession).toEqual([{ sid: "surface:src", d: "vertical" }]);
    expect(calls.apply[0].sid).toBe("surface:new-from");
  });
});
