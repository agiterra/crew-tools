import { describe, test, expect, mock } from "bun:test";
import { ItermProfiles, type ItermProfilesDeps } from "./profiles";

function makeDeps(overrides: Partial<ItermProfilesDeps> = {}): {
  deps: ItermProfilesDeps;
  calls: {
    writePane: any[];
    writeEmpty: any[];
    escape: Array<{ sessionId: string; escape: string }>;
    splitPane: any[];
    splitSession: any[];
  };
} {
  const calls = {
    writePane: [] as any[],
    writeEmpty: [] as any[],
    escape: [] as Array<{ sessionId: string; escape: string }>,
    splitPane: [] as any[],
    splitSession: [] as any[],
  };
  const deps: ItermProfilesDeps = {
    writePaneProfile: mock((paneName: string, bg: string, opts: any) => {
      calls.writePane.push({ paneName, bg, opts });
      return `Crew ${paneName}`;
    }),
    writeEmptyPaneProfile: mock(() => {
      calls.writeEmpty.push({});
    }),
    writeEscapeToSession: mock(async (sessionId: string, escape: string) => {
      calls.escape.push({ sessionId, escape });
    }),
    splitPaneWithProfile: mock(async (direction: any, profileName: string) => {
      calls.splitPane.push({ direction, profileName });
      return "iterm:new-session";
    }),
    splitSessionWithProfile: mock(async (sessionId: string, direction: any, profileName: string) => {
      calls.splitSession.push({ sessionId, direction, profileName });
      return "iterm:new-session-from";
    }),
    ...overrides,
  };
  return { deps, calls };
}

describe("ItermProfiles", () => {
  test("writePane delegates to writePaneProfile when backgroundImage present", () => {
    const { deps, calls } = makeDeps();
    const impl = new ItermProfiles(deps);
    const name = impl.writePane({ paneName: "oak", backgroundImage: "/img/oak.png", blend: 0.5 });
    expect(name).toBe("Crew oak");
    expect(calls.writePane).toEqual([{ paneName: "oak", bg: "/img/oak.png", opts: { blend: 0.5, mode: undefined, badgeColor: undefined } }]);
  });

  test("writePane falls back to empty when no backgroundImage", () => {
    const { deps, calls } = makeDeps();
    const impl = new ItermProfiles(deps);
    const name = impl.writePane({ paneName: "oak" });
    expect(name).toBe("Crew Empty Pane");
    expect(calls.writeEmpty).toHaveLength(1);
    expect(calls.writePane).toEqual([]);
  });

  test("writeEmpty returns 'Crew Empty Pane'", () => {
    const { deps, calls } = makeDeps();
    const impl = new ItermProfiles(deps);
    expect(impl.writeEmpty()).toBe("Crew Empty Pane");
    expect(calls.writeEmpty).toHaveLength(1);
  });

  test("setProfile writes OSC 1337 SetProfile=", async () => {
    const { deps, calls } = makeDeps();
    const impl = new ItermProfiles(deps);
    await impl.setProfile("iterm:session:abc", "Crew oak");
    expect(calls.escape).toEqual([{ sessionId: "iterm:session:abc", escape: "\x1b]1337;SetProfile=Crew oak\x07" }]);
  });

  test("splitPaneWithProfile delegates to dep", async () => {
    const { deps, calls } = makeDeps();
    const impl = new ItermProfiles(deps);
    const result = await impl.splitPaneWithProfile("horizontal", "Crew oak");
    expect(result).toBe("iterm:new-session");
    expect(calls.splitPane).toEqual([{ direction: "horizontal", profileName: "Crew oak" }]);
  });

  test("splitSessionWithProfile delegates to dep", async () => {
    const { deps, calls } = makeDeps();
    const impl = new ItermProfiles(deps);
    const result = await impl.splitSessionWithProfile("iterm:src", "vertical", "Crew oak");
    expect(result).toBe("iterm:new-session-from");
    expect(calls.splitSession).toEqual([{ sessionId: "iterm:src", direction: "vertical", profileName: "Crew oak" }]);
  });
});
