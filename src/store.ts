/**
 * Pane orchestration state — SQLite persistence.
 *
 * Three tables: tabs (workstream containers), slots (crew viewports),
 * agents (screen sessions with optional slot attachment).
 */

import { Database } from "bun:sqlite";

export type Tab = {
  name: string;
  created_at: number;
};

export type Slot = {
  name: string;
  tab: string;
  position: string;
  iterm_id: string | null;
  created_at: number;
};

export type Agent = {
  id: string;
  display_name: string;
  runtime: string;
  screen_name: string;
  screen_pid: number | null;
  slot: string | null;
  status_name: string | null;
  status_desc: string | null;
  launched_at: number;
  last_seen: number;
};

export class CrewStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tabs (
        name TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slots (
        name TEXT PRIMARY KEY,
        tab TEXT NOT NULL REFERENCES tabs(name),
        position TEXT NOT NULL DEFAULT '',
        iterm_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        runtime TEXT NOT NULL DEFAULT 'claude-code',
        screen_name TEXT NOT NULL,
        screen_pid INTEGER,
        slot TEXT REFERENCES slots(name),
        status_name TEXT,
        status_desc TEXT,
        launched_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
  }

  // --- Tabs ---

  createTab(name: string): Tab {
    const now = Date.now();
    this.db.prepare("INSERT INTO tabs (name, created_at) VALUES (?, ?)").run(name, now);
    return { name, created_at: now };
  }

  getTab(name: string): Tab | null {
    return this.db.prepare("SELECT * FROM tabs WHERE name = ?").get(name) as Tab | null;
  }

  listTabs(): Tab[] {
    return this.db.prepare("SELECT * FROM tabs ORDER BY created_at").all() as Tab[];
  }

  deleteTab(name: string): void {
    this.db.prepare("DELETE FROM slots WHERE tab = ?").run(name);
    this.db.prepare("DELETE FROM tabs WHERE name = ?").run(name);
  }

  // --- Slots ---

  createSlot(name: string, tab: string, position: string = ""): Slot {
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO slots (name, tab, position, created_at) VALUES (?, ?, ?, ?)"
    ).run(name, tab, position, now);
    return { name, tab, position, iterm_id: null, created_at: now };
  }

  getSlot(name: string): Slot | null {
    return this.db.prepare("SELECT * FROM slots WHERE name = ?").get(name) as Slot | null;
  }

  listSlots(tab?: string): Slot[] {
    if (tab) {
      return this.db.prepare("SELECT * FROM slots WHERE tab = ? ORDER BY position").all(tab) as Slot[];
    }
    return this.db.prepare("SELECT * FROM slots ORDER BY tab, position").all() as Slot[];
  }

  setSlotItermId(name: string, itermId: string): void {
    this.db.prepare("UPDATE slots SET iterm_id = ? WHERE name = ?").run(itermId, name);
  }

  deleteSlot(name: string): void {
    // Detach any agent in this slot
    this.db.prepare("UPDATE agents SET slot = NULL WHERE slot = ?").run(name);
    this.db.prepare("DELETE FROM slots WHERE name = ?").run(name);
  }

  // --- Agents ---

  createAgent(agent: {
    id: string;
    display_name: string;
    runtime: string;
    screen_name: string;
    screen_pid?: number;
    slot?: string;
  }): Agent {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO agents (id, display_name, runtime, screen_name, screen_pid, slot, launched_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agent.id, agent.display_name, agent.runtime, agent.screen_name,
      agent.screen_pid ?? null, agent.slot ?? null, now, now,
    );
    return {
      id: agent.id,
      display_name: agent.display_name,
      runtime: agent.runtime,
      screen_name: agent.screen_name,
      screen_pid: agent.screen_pid ?? null,
      slot: agent.slot ?? null,
      status_name: null,
      status_desc: null,
      launched_at: now,
      last_seen: now,
    };
  }

  getAgent(id: string): Agent | null {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent | null;
  }

  listAgents(): Agent[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY launched_at").all() as Agent[];
  }

  updateAgentPid(id: string, pid: number): void {
    this.db.prepare("UPDATE agents SET screen_pid = ?, last_seen = ? WHERE id = ?").run(pid, Date.now(), id);
  }

  updateAgentSlot(id: string, slot: string | null): void {
    this.db.prepare("UPDATE agents SET slot = ?, last_seen = ? WHERE id = ?").run(slot, Date.now(), id);
  }

  updateAgentStatus(id: string, statusName: string, statusDesc: string): void {
    this.db.prepare(
      "UPDATE agents SET status_name = ?, status_desc = ?, last_seen = ? WHERE id = ?"
    ).run(statusName, statusDesc, Date.now(), id);
  }

  touchAgent(id: string): void {
    this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(Date.now(), id);
  }

  deleteAgent(id: string): void {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }
}
