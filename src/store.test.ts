import { describe, test, expect, beforeEach } from "bun:test";
import { CrewStore } from "./store";
import { chmodSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let store: CrewStore;
let dbPath: string;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "crew-test-"));
  dbPath = join(tmpDir, "test.db");
  store = new CrewStore(dbPath);
});

// --- Tabs ---

describe("tabs", () => {
  test("createTab returns tab with correct fields", () => {
    const tab = store.createTab("eng", "trees");
    expect(tab.name).toBe("eng");
    expect(tab.theme).toBe("trees");
    expect(tab.created_at).toBeGreaterThan(0);
  });

  test("createTab with session ID", () => {
    const tab = store.createTab("eng", "trees", "session-123");
    expect(tab.iterm_session_id).toBe("session-123");
  });

  test("getTab returns null for missing tab", () => {
    expect(store.getTab("nope")).toBeNull();
  });

  test("getTab returns created tab", () => {
    store.createTab("eng", "trees");
    const tab = store.getTab("eng");
    expect(tab).not.toBeNull();
    expect(tab!.name).toBe("eng");
    expect(tab!.theme).toBe("trees");
  });

  test("listTabs returns all tabs in creation order", () => {
    store.createTab("a");
    store.createTab("b");
    store.createTab("c");
    const tabs = store.listTabs();
    expect(tabs.map(t => t.name)).toEqual(["a", "b", "c"]);
  });

  test("setTabTheme updates theme", () => {
    store.createTab("eng", "trees");
    store.setTabTheme("eng", "cities");
    expect(store.getTab("eng")!.theme).toBe("cities");
  });

  test("deleteTab removes tab and its panes", () => {
    store.createTab("eng", "trees");
    store.createPane("oak", "eng", "below");
    store.deleteTab("eng");
    expect(store.getTab("eng")).toBeNull();
    expect(store.getPane("oak")).toBeNull();
  });
});

// --- Panes ---

describe("panes", () => {
  beforeEach(() => {
    store.createTab("eng", "trees");
  });

  test("createPane returns pane with correct fields", () => {
    const pane = store.createPane("oak", "eng", "below", "trees");
    expect(pane.name).toBe("oak");
    expect(pane.tab).toBe("eng");
    expect(pane.position).toBe("below");
    expect(pane.theme).toBe("trees");
    expect(pane.iterm_id).toBeNull();
  });

  test("getPane returns null for missing pane", () => {
    expect(store.getPane("nope")).toBeNull();
  });

  test("setPaneItermId updates terminal session", () => {
    store.createPane("oak", "eng");
    store.setPaneItermId("oak", "sess-456");
    expect(store.getPane("oak")!.iterm_id).toBe("sess-456");
  });

  test("listPanes filters by tab", () => {
    store.createTab("ops", "cities");
    store.createPane("oak", "eng");
    store.createPane("paris", "ops");
    expect(store.listPanes("eng").map(p => p.name)).toEqual(["oak"]);
    expect(store.listPanes("ops").map(p => p.name)).toEqual(["paris"]);
  });

  test("listPanes without filter returns all", () => {
    store.createTab("ops");
    store.createPane("oak", "eng");
    store.createPane("paris", "ops");
    expect(store.listPanes().length).toBe(2);
  });

  test("deletePane detaches agents and removes pane", () => {
    store.createPane("oak", "eng");
    store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant", pane: "oak",
    });
    store.deletePane("oak");
    expect(store.getPane("oak")).toBeNull();
    expect(store.getAgent("fondant")!.pane).toBeNull();
  });

  test("renamePane updates pane row and agent FK", () => {
    store.createPane("oak", "eng");
    store.createAgent({ id: "fondant", display_name: "Fondant", runtime: "claude-code", screen_name: "wire-fondant", pane: "oak" });

    store.renamePane("oak", "maple");

    expect(store.getPane("oak")).toBeNull();
    expect(store.getPane("maple")).not.toBeNull();
    expect(store.getAgent("fondant")!.pane).toBe("maple");
  });

  test("renamePane is a no-op when from === to", () => {
    store.createPane("oak", "eng");
    store.renamePane("oak", "oak");
    expect(store.getPane("oak")).not.toBeNull();
  });

  test("renamePane throws if target name exists", () => {
    store.createPane("oak", "eng");
    store.createPane("maple", "eng");
    expect(() => store.renamePane("oak", "maple")).toThrow();
  });
});

// --- Agents ---

describe("agents", () => {
  beforeEach(() => {
    store.createTab("eng", "trees");
    store.createPane("oak", "eng");
  });

  test("createAgent returns agent with correct fields", () => {
    const agent = store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant", screen_pid: 1234,
      cc_session_id: "cc-uuid", pane: "oak", badge: "Fondant — Toolsmith",
    });
    expect(agent.id).toBe("fondant");
    expect(agent.display_name).toBe("Fondant");
    expect(agent.screen_name).toBe("wire-fondant");
    expect(agent.screen_pid).toBe(1234);
    expect(agent.cc_session_id).toBe("cc-uuid");
    expect(agent.pane).toBe("oak");
    expect(agent.badge).toBe("Fondant — Toolsmith");
    expect(agent.launched_at).toBeGreaterThan(0);
  });

  test("getAgent returns most recent by launched_at", async () => {
    store.createAgent({
      id: "brioche", display_name: "Brioche", runtime: "claude-code",
      screen_name: "wire-brioche-old",
    });
    // Ensure different timestamp
    await new Promise(r => setTimeout(r, 2));
    store.createAgent({
      id: "brioche", display_name: "Brioche", runtime: "claude-code",
      screen_name: "wire-brioche-new",
    });
    const agent = store.getAgent("brioche");
    expect(agent!.screen_name).toBe("wire-brioche-new");
  });

  test("getAgentBySession returns by cc_session_id", () => {
    store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant", cc_session_id: "cc-123",
    });
    const agent = store.getAgentBySession("cc-123");
    expect(agent).not.toBeNull();
    expect(agent!.id).toBe("fondant");
  });

  test("getAgentByScreen returns by screen_name", () => {
    store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant",
    });
    expect(store.getAgentByScreen("wire-fondant")).not.toBeNull();
    expect(store.getAgentByScreen("wire-nope")).toBeNull();
  });

  test("updateAgentPane changes pane", () => {
    store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant", pane: "oak",
    });
    store.updateAgentPane("fondant", null);
    expect(store.getAgent("fondant")!.pane).toBeNull();
  });

  test("updateAgentCcSession sets cc_session_id by screen_name", () => {
    store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant",
    });
    store.updateAgentCcSession("wire-fondant", "cc-new-uuid");
    expect(store.getAgentByScreen("wire-fondant")!.cc_session_id).toBe("cc-new-uuid");
  });

  test("setAgentBadge updates badge", () => {
    store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant",
    });
    store.setAgentBadge("fondant", "Fondant — Toolsmith\nCrew #21");
    expect(store.getAgent("fondant")!.badge).toBe("Fondant — Toolsmith\nCrew #21");
  });

  test("deleteAgent removes by id", () => {
    store.createAgent({
      id: "fondant", display_name: "Fondant", runtime: "claude-code",
      screen_name: "wire-fondant",
    });
    store.deleteAgent("fondant");
    expect(store.getAgent("fondant")).toBeNull();
  });

  test("deleteAgentByScreen removes specific instance", () => {
    store.createAgent({
      id: "brioche", display_name: "Brioche", runtime: "claude-code",
      screen_name: "wire-brioche-old",
    });
    store.createAgent({
      id: "brioche", display_name: "Brioche", runtime: "claude-code",
      screen_name: "wire-brioche-new",
    });
    store.deleteAgentByScreen("wire-brioche-old");
    expect(store.getAgentByScreen("wire-brioche-old")).toBeNull();
    expect(store.getAgentByScreen("wire-brioche-new")).not.toBeNull();
  });

  test("listAgents returns all in launch order", () => {
    store.createAgent({
      id: "a", display_name: "A", runtime: "claude-code", screen_name: "wire-a",
    });
    store.createAgent({
      id: "b", display_name: "B", runtime: "claude-code", screen_name: "wire-b",
    });
    const agents = store.listAgents();
    expect(agents.map(a => a.id)).toEqual(["a", "b"]);
  });
});

// --- Migration ---

describe("migration", () => {
  test("opening same DB twice doesn't error (idempotent migrations)", () => {
    const store2 = new CrewStore(dbPath);
    store2.createTab("test");
    expect(store2.getTab("test")).not.toBeNull();
  });

  test("CREW_SVC_DEST opens existing DB readonly for consumers", () => {
    store.createTab("test");
    const prevDest = process.env.CREW_SVC_DEST;
    process.env.CREW_SVC_DEST = "crew-svc@patisserie";

    try {
      const reader = new CrewStore(dbPath);
      expect(reader.readonly).toBe(true);
      expect(reader.getTab("test")?.name).toBe("test");
      expect(() => reader.createTab("write")).toThrow();
    } finally {
      if (prevDest === undefined) delete process.env.CREW_SVC_DEST;
      else process.env.CREW_SVC_DEST = prevDest;
    }
  });

  test("CREW_RPC_DEST also opens readonly (a consumer configured the old way is still a consumer)", () => {
    store.createTab("test");
    const prev = process.env.CREW_RPC_DEST;
    process.env.CREW_RPC_DEST = "crew-svc@patisserie";

    try {
      const reader = new CrewStore(dbPath);
      expect(reader.readonly).toBe(true);
      expect(reader.getTab("test")?.name).toBe("test");
    } finally {
      if (prev === undefined) delete process.env.CREW_RPC_DEST;
      else process.env.CREW_RPC_DEST = prev;
    }
  });

  // AGI-27: the permission probe is what makes tightening crews.db safe. A
  // consumer nobody remembered to configure must degrade to readonly rather
  // than throw out of the constructor on PRAGMA/migrate.
  test("an existing db this uid cannot write opens readonly with no env config", () => {
    store.createTab("test");
    chmodSync(dbPath, 0o444);

    try {
      const reader = new CrewStore(dbPath);
      expect(reader.readonly).toBe(true);
      expect(reader.getTab("test")?.name).toBe("test");
      expect(() => reader.createTab("write")).toThrow();
    } finally {
      chmodSync(dbPath, 0o644);
    }
  });

  test("a MISSING db is still created read-write (absence is not unwritable)", () => {
    const fresh = join(tmpDir, "fresh.db");
    const created = new CrewStore(fresh);
    expect(created.readonly).toBe(false);
    expect(created.createTab("bootstrap").name).toBe("bootstrap");
  });

  test("explicit opts.readonly wins over the probe", () => {
    store.createTab("test");
    chmodSync(dbPath, 0o444);
    try {
      // Forcing readonly:false on an unwritable file must NOT be silently
      // upgraded to readonly — the service wants to fail on the write, not
      // quietly degrade into a reader.
      const forced = new CrewStore(dbPath, { readonly: false });
      expect(forced.readonly).toBe(false);
      // NOTE: construction itself does NOT throw. On an already-migrated db the
      // WAL pragma and the IF-NOT-EXISTS migrate steps perform no writes, so
      // SQLite never takes a write lock. The failure surfaces on a real write.
      expect(() => forced.createTab("write")).toThrow();
    } finally {
      chmodSync(dbPath, 0o644);
    }
  });
});
