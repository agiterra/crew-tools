import { describe, test, expect, beforeEach, mock } from "bun:test";
import { CrewStore } from "./store";
import { reconcile } from "./reconciler";
import type { TerminalBackend } from "./terminal";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let store: CrewStore;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "reconciler-test-"));
  store = new CrewStore(join(tmp, "test.db"));
});

type TerminalCalls = {
  setSessionName: Array<{ sessionId: string; name: string }>;
  writePaneProfile: Array<{ paneName: string; backgroundImage?: string }>;
  setProfile: Array<{ sessionId: string; profileName: string }>;
};

function makeTerminal(aliveSessionIds: string[]): TerminalBackend & { calls: TerminalCalls } {
  const alive = new Set(aliveSessionIds);
  const calls: TerminalCalls = {
    setSessionName: [],
    writePaneProfile: [],
    setProfile: [],
  };
  const t: TerminalBackend & { calls: TerminalCalls } = {
    name: "test",
    calls,
    currentSessionId: mock(async () => ""),
    sessionIdForTty: mock(async () => null),
    splitPane: mock(async () => ""),
    splitSession: mock(async () => ""),
    writeToSession: mock(async () => {}),
    closeSession: mock(async () => {}),
    isSessionAlive: mock(async (id: string) => alive.has(id)),
    createTab: mock(async () => ""),
    setSessionName: mock(async (sessionId: string, name: string) => {
      calls.setSessionName.push({ sessionId, name });
    }),
    setBadge: mock(async () => {}),
    flashSession: mock(async () => {}),
    notifySession: mock(async () => {}),
    renameWorkspace: mock(async () => {}),
    writePaneProfile: mock((profile: { paneName: string; backgroundImage?: string }) => {
      calls.writePaneProfile.push({ paneName: profile.paneName, backgroundImage: profile.backgroundImage });
      return `Crew ${profile.paneName}`;
    }),
    writeEmptyPaneProfile: mock(() => "Crew Empty Pane"),
    setProfile: mock(async (sessionId: string, profileName: string) => {
      calls.setProfile.push({ sessionId, profileName });
    }),
    splitPaneWithProfile: mock(async () => ""),
    splitSessionWithProfile: mock(async () => ""),
    splitWebBrowser: mock(async () => ""),
    splitSessionWebBrowser: mock(async () => ""),
  } as unknown as TerminalBackend & { calls: TerminalCalls };
  return t;
}

describe("reconcile cross-machine safety", () => {
  test("skips agents on peer machines (does NOT cascade-delete remote rows)", async () => {
    // Local row: screen looks dead, reconciler prunes it.
    store.createAgent({
      id: "local-dead",
      display_name: "LocalDead",
      runtime: "claude-code",
      screen_name: "wire-local-dead",
    });
    // Remote row: pretend the agent lives on home-mini. createAgent stamps
    // the local hostname, so we UPDATE to simulate a fleet_list insertion.
    store.createMachine({ name: "home-mini", hostname: "home-mini", ssh_host: "tim@home-mini" });
    store.createAgent({
      id: "remote-alive",
      display_name: "RemoteAlive",
      runtime: "claude-code",
      screen_name: "wire-remote-alive",
    });
    store["db"].prepare("UPDATE agents SET machine_name = ? WHERE id = ?").run("home-mini", "remote-alive");

    const result = await reconcile(store);

    // Local dead agent got pruned.
    expect(result.dead).toContain("local-dead");
    expect(store.getAgent("local-dead")).toBeNull();
    // Remote agent is untouched — NOT in alive (we don't claim it is) and NOT in dead.
    expect(result.alive).not.toContain("remote-alive");
    expect(result.dead).not.toContain("remote-alive");
    expect(store.getAgent("remote-alive")).not.toBeNull();
  });
});

describe("reconcile theme healing", () => {
  test("assigns theme to untheme tab", async () => {
    store.createTab("brioche");
    const result = await reconcile(store);
    expect(result.tabsThemed.length).toBe(1);
    expect(result.tabsThemed[0].tab).toBe("brioche");
    expect(result.tabsThemed[0].theme).toBeDefined();
    expect(store.getTab("brioche")!.theme).toBe(result.tabsThemed[0].theme);
  });

  test("skips tabs that already have a theme", async () => {
    store.createTab("eng", "trees");
    const result = await reconcile(store);
    expect(result.tabsThemed.length).toBe(0);
    expect(store.getTab("eng")!.theme).toBe("trees");
  });

  test("picks unused theme when others are taken", async () => {
    store.createTab("a", "trees");
    store.createTab("b"); // no theme
    const result = await reconcile(store);
    expect(result.tabsThemed.length).toBe(1);
    expect(result.tabsThemed[0].theme).not.toBe("trees");
  });

  test("pane inherits theme from tab", async () => {
    store.createTab("eng", "trees");
    store.createPane("oak", "eng"); // no theme
    const result = await reconcile(store);
    expect(result.panesThemed.length).toBe(1);
    expect(result.panesThemed[0]).toEqual({ pane: "oak", theme: "trees" });
    expect(store.getPane("oak")!.theme).toBe("trees");
  });
});

describe("reconcile terminal session checks", () => {
  test("deletes pane with dead session and no agent ref", async () => {
    store.createTab("eng", "trees");
    store.createPane("oak", "eng");
    store.setPaneItermId("oak", "session-dead");
    const terminal = makeTerminal([]);
    const result = await reconcile(store, terminal);
    expect(result.panesDeleted).toEqual(["oak"]);
    expect(result.panesCleared).toEqual([]);
    expect(store.getPane("oak")).toBeNull();
  });

  test("leaves null-iterm_id pane alone (transient, waiting for self-stamp)", async () => {
    store.createTab("eng", "trees");
    store.createPane("oak", "eng"); // never bound
    const terminal = makeTerminal([]);
    const result = await reconcile(store, terminal);
    expect(result.panesDeleted).toEqual([]);
    expect(store.getPane("oak")).not.toBeNull();
  });

  test("keeps alive pane iterm_id", async () => {
    store.createTab("eng", "trees");
    store.createPane("oak", "eng");
    store.setPaneItermId("oak", "session-live");
    const terminal = makeTerminal(["session-live"]);
    const result = await reconcile(store, terminal);
    expect(result.panesCleared).toEqual([]);
    expect(store.getPane("oak")!.iterm_id).toBe("session-live");
  });

  test("clears dead tab session", async () => {
    store.createTab("eng", "trees", "session-dead");
    const terminal = makeTerminal([]);
    const result = await reconcile(store, terminal);
    expect(result.tabsCleared).toEqual(["eng"]);
    expect(store.getTab("eng")!.iterm_session_id).toBeNull();
  });

  test("renames non-pool pane to a themed name and applies profile", async () => {
    // brioche tab is themed cities; the test-east pane name is NOT in the cities pool.
    store.createTab("brioche", "cities");
    store.createPane("test-east", "brioche", "", "cities");
    store.setPaneItermId("test-east", "session-brioche");
    const terminal = makeTerminal(["session-brioche"]);
    const result = await reconcile(store, terminal);

    expect(result.panesRenamed.length).toBe(1);
    expect(result.panesRenamed[0].from).toBe("test-east");
    expect(result.panesRenamed[0].theme).toBe("cities");
    const newName = result.panesRenamed[0].to;

    // Pane was renamed in DB
    expect(store.getPane("test-east")).toBeNull();
    expect(store.getPane(newName)).not.toBeNull();

    // setSessionName was called on the live session with title-cased new name
    expect(terminal.calls.setSessionName.some((c) => c.sessionId === "session-brioche")).toBe(true);

    // Profile was written and applied
    expect(result.profilesApplied.length).toBe(1);
    expect(terminal.calls.setProfile.some((c) => c.sessionId === "session-brioche")).toBe(true);
  });

  test("skips rename when pane name is already in the theme's pool", async () => {
    // 'paris' IS in the cities pool, so no rename should happen.
    store.createTab("fabrica", "cities");
    store.createPane("paris", "fabrica", "", "cities");
    store.setPaneItermId("paris", "session-paris");
    const terminal = makeTerminal(["session-paris"]);
    const result = await reconcile(store, terminal);

    expect(result.panesRenamed).toEqual([]);
    // But profile should still be applied (the heal applies even without rename)
    expect(result.profilesApplied.length).toBe(1);
    expect(result.profilesApplied[0].pane).toBe("paris");
    // And the session title must be refreshed so iTerm shows the pane name,
    // even though the pane wasn't renamed.
    expect(
      terminal.calls.setSessionName.some(
        (c) => c.sessionId === "session-paris" && c.name === "Paris",
      ),
    ).toBe(true);
  });

  test("skips heal when pane has no iterm_id", async () => {
    store.createTab("brioche", "cities");
    store.createPane("test-east", "brioche", "", "cities");
    // no setPaneItermId — pane is not bound to a session
    const terminal = makeTerminal([]);
    const result = await reconcile(store, terminal);

    expect(result.panesRenamed).toEqual([]);
    expect(result.profilesApplied).toEqual([]);
    // Null iterm_id is transient (waiting for self-stamp) — pane is preserved.
    expect(result.panesDeleted).toEqual([]);
    expect(store.getPane("test-east")).not.toBeNull();
  });

  test("skips terminal checks when backend omitted", async () => {
    store.createTab("eng", "trees");
    store.createPane("oak", "eng");
    store.setPaneItermId("oak", "session-anything");
    const result = await reconcile(store); // no terminal
    expect(result.panesCleared).toEqual([]);
    expect(result.tabsCleared).toEqual([]);
    expect(store.getPane("oak")!.iterm_id).toBe("session-anything");
  });
});

describe("reconcile tab orphan prune", () => {
  test("deletes unbound tab with no panes once past age threshold", async () => {
    store.createTab("eng", "trees"); // never bound, no panes
    const result = await reconcile(store, undefined, { tabOrphanAgeMs: 0 });
    expect(result.tabsDeleted).toEqual(["eng"]);
    expect(store.getTab("eng")).toBeNull();
  });

  test("keeps unbound tab that still has panes", async () => {
    store.createTab("brioche", "cities");
    store.createPane("paris", "brioche");
    const result = await reconcile(store, undefined, { tabOrphanAgeMs: 0 });
    expect(result.tabsDeleted).toEqual([]);
    expect(store.getTab("brioche")).not.toBeNull();
    expect(store.getPane("paris")).not.toBeNull();
  });

  test("keeps bound tab even with no panes", async () => {
    store.createTab("eng", "trees", "session-live");
    const terminal = makeTerminal(["session-live"]);
    const result = await reconcile(store, terminal, { tabOrphanAgeMs: 0 });
    expect(result.tabsDeleted).toEqual([]);
    expect(store.getTab("eng")).not.toBeNull();
  });

  test("respects age threshold — fresh unbound empty tab is kept", async () => {
    store.createTab("eng", "trees");
    // Default threshold is 60s — a just-created tab must not be pruned.
    const result = await reconcile(store);
    expect(result.tabsDeleted).toEqual([]);
    expect(store.getTab("eng")).not.toBeNull();
  });

  test("prunes tab whose session was just cleared by the same reconcile pass", async () => {
    store.createTab("eng", "trees", "session-dead");
    const terminal = makeTerminal([]); // session is dead
    const result = await reconcile(store, terminal, { tabOrphanAgeMs: 0 });
    expect(result.tabsCleared).toEqual(["eng"]);
    expect(result.tabsDeleted).toEqual(["eng"]);
    expect(store.getTab("eng")).toBeNull();
  });

  test("cascade: deleting tab removes its panes too", async () => {
    store.createTab("orphan-tab", "trees");
    store.createPane("ghost", "orphan-tab");
    // First check: tab is not pruned because it has a pane
    let result = await reconcile(store, undefined, { tabOrphanAgeMs: 0 });
    expect(result.tabsDeleted).toEqual([]);
    // Now delete the pane manually and reconcile again — tab should prune and cascade is a no-op
    store.deletePane("ghost");
    result = await reconcile(store, undefined, { tabOrphanAgeMs: 0 });
    expect(result.tabsDeleted).toEqual(["orphan-tab"]);
    expect(store.getTab("orphan-tab")).toBeNull();
  });
});
