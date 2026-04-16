/**
 * Crew orchestration state — SQLite persistence.
 *
 * Three tables: tabs (iTerm2 tabs), panes (iTerm2 panes),
 * agents (screen sessions with optional pane attachment).
 */

import { Database } from "bun:sqlite";

export type Tab = {
  name: string;
  theme: string | null;
  iterm_session_id: string | null;
  created_at: number;
};

export type Pane = {
  name: string;
  tab: string;
  position: string;
  iterm_id: string | null;
  theme: string | null;
  created_at: number;
};

export type Agent = {
  id: string;
  display_name: string;
  runtime: string;
  screen_name: string;
  screen_pid: number | null;
  cc_session_id: string | null;
  pane: string | null;
  status_name: string | null;
  status_desc: string | null;
  badge: string | null;
  launched_at: number;
  last_seen: number;
  ttl_idle_minutes: number | null;
  spawn_manifest: string | null;
};

/**
 * Tombstone left behind when an agent is stopped. Lets agent_resume
 * reconstruct the spawn without the caller re-supplying every arg.
 *
 * `env_json` is the manifest's env map with secrets stripped
 * (AGENT_PRIVATE_KEY in particular) — callers re-provision identity
 * via register_agent and pass the new key as an override on resume.
 */
export type AgentTombstone = {
  id: string;
  screen_name: string;
  display_name: string;
  runtime: string;
  cc_session_id: string | null;
  badge: string | null;
  spawn_manifest: string | null;
  stopped_at: number;
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
        theme TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS panes (
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
        cc_session_id TEXT,
        pane TEXT REFERENCES panes(name),
        status_name TEXT,
        status_desc TEXT,
        badge TEXT,
        launched_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);

    // Add theme column to tabs if missing
    const hasTheme = this.db.prepare(
      "SELECT * FROM pragma_table_info('tabs') WHERE name='theme'"
    ).get();
    if (!hasTheme) {
      this.db.exec("ALTER TABLE tabs ADD COLUMN theme TEXT");
    }

    // Migrate from old "slots"/"slot" schema if present
    const hasSlots = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='slots'"
    ).get();
    if (hasSlots) {
      this.db.exec(`
        INSERT OR IGNORE INTO panes (name, tab, position, iterm_id, created_at)
          SELECT name, tab, position, iterm_id, created_at FROM slots;
        DROP TABLE slots;
      `);
    }
    const hasSlotCol = this.db.prepare(
      "SELECT * FROM pragma_table_info('agents') WHERE name='slot'"
    ).get();
    if (hasSlotCol) {
      this.db.exec(`
        ALTER TABLE agents RENAME COLUMN slot TO pane;
      `);
    }

    // Add cc_session_id column if missing
    const hasCcSession = this.db.prepare(
      "SELECT * FROM pragma_table_info('agents') WHERE name='cc_session_id'"
    ).get();
    if (!hasCcSession) {
      this.db.exec("ALTER TABLE agents ADD COLUMN cc_session_id TEXT");
    }

    // Add theme column to panes if missing
    const hasPaneTheme = this.db.prepare(
      "SELECT * FROM pragma_table_info('panes') WHERE name='theme'"
    ).get();
    if (!hasPaneTheme) {
      this.db.exec("ALTER TABLE panes ADD COLUMN theme TEXT");
    }

    // Add iterm_session_id column to tabs if missing
    const hasTabSession = this.db.prepare(
      "SELECT * FROM pragma_table_info('tabs') WHERE name='iterm_session_id'"
    ).get();
    if (!hasTabSession) {
      this.db.exec("ALTER TABLE tabs ADD COLUMN iterm_session_id TEXT");
    }

    // Add badge column to agents if missing
    const hasBadge = this.db.prepare(
      "SELECT * FROM pragma_table_info('agents') WHERE name='badge'"
    ).get();
    if (!hasBadge) {
      this.db.exec("ALTER TABLE agents ADD COLUMN badge TEXT");
    }

    // Migrate from single-agent-per-id to multi-agent-per-id (for handoff).
    // Change PRIMARY KEY from id to screen_name — screen names are always unique.
    const createSql = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'"
    ).get() as { sql: string } | null;
    if (createSql?.sql?.includes("id TEXT PRIMARY KEY")) {
      this.db.exec(`
        CREATE TABLE agents_new (
          id TEXT NOT NULL,
          display_name TEXT NOT NULL,
          runtime TEXT NOT NULL DEFAULT 'claude-code',
          screen_name TEXT NOT NULL PRIMARY KEY,
          screen_pid INTEGER,
          cc_session_id TEXT,
          pane TEXT REFERENCES panes(name),
          status_name TEXT,
          status_desc TEXT,
          badge TEXT,
          launched_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        );
        INSERT INTO agents_new SELECT id, display_name, runtime, screen_name, screen_pid,
          cc_session_id, pane, status_name, status_desc, badge, launched_at, last_seen FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
        CREATE INDEX IF NOT EXISTS idx_agents_id ON agents(id);
      `);
    }

    // Add ttl_idle_minutes column to agents if missing (v2.1.0 reaper).
    // Runs AFTER the handoff rebuild so the column survives the table swap.
    const hasTtl = this.db.prepare(
      "SELECT * FROM pragma_table_info('agents') WHERE name='ttl_idle_minutes'"
    ).get();
    if (!hasTtl) {
      this.db.exec("ALTER TABLE agents ADD COLUMN ttl_idle_minutes INTEGER");
    }

    // Add spawn_manifest column (v2.3.0 persistent manifest for agent_resume).
    const hasManifest = this.db.prepare(
      "SELECT * FROM pragma_table_info('agents') WHERE name='spawn_manifest'"
    ).get();
    if (!hasManifest) {
      this.db.exec("ALTER TABLE agents ADD COLUMN spawn_manifest TEXT");
    }

    // Tombstone table — one row per stop, keyed by (id, stopped_at) so
    // multiple resume cycles for the same id each leave a record.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tombstones (
        id TEXT NOT NULL,
        screen_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        runtime TEXT NOT NULL,
        cc_session_id TEXT,
        badge TEXT,
        spawn_manifest TEXT,
        stopped_at INTEGER NOT NULL,
        PRIMARY KEY (id, stopped_at)
      );
      CREATE INDEX IF NOT EXISTS idx_tombstones_id ON agent_tombstones(id);
    `);
  }

  // --- Tabs ---

  createTab(name: string, theme?: string, itermSessionId?: string): Tab {
    const now = Date.now();
    this.db.prepare("INSERT INTO tabs (name, theme, iterm_session_id, created_at) VALUES (?, ?, ?, ?)").run(name, theme ?? null, itermSessionId ?? null, now);
    return { name, theme: theme ?? null, iterm_session_id: itermSessionId ?? null, created_at: now };
  }

  setTabTheme(name: string, theme: string): void {
    this.db.prepare("UPDATE tabs SET theme = ? WHERE name = ?").run(theme, name);
  }

  getTab(name: string): Tab | null {
    return this.db.prepare("SELECT * FROM tabs WHERE name = ?").get(name) as Tab | null;
  }

  listTabs(): Tab[] {
    return this.db.prepare("SELECT * FROM tabs ORDER BY created_at").all() as Tab[];
  }

  deleteTab(name: string): void {
    this.db.prepare("DELETE FROM panes WHERE tab = ?").run(name);
    this.db.prepare("DELETE FROM tabs WHERE name = ?").run(name);
  }

  // --- Panes ---

  createPane(name: string, tab: string, position: string = "", theme?: string): Pane {
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO panes (name, tab, position, theme, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(name, tab, position, theme ?? null, now);
    return { name, tab, position, iterm_id: null, theme: theme ?? null, created_at: now };
  }

  getPane(name: string): Pane | null {
    return this.db.prepare("SELECT * FROM panes WHERE name = ?").get(name) as Pane | null;
  }

  listPanes(tab?: string): Pane[] {
    if (tab) {
      return this.db.prepare("SELECT * FROM panes WHERE tab = ? ORDER BY position").all(tab) as Pane[];
    }
    return this.db.prepare("SELECT * FROM panes ORDER BY tab, position").all() as Pane[];
  }

  setPaneItermId(name: string, itermId: string): void {
    this.db.prepare("UPDATE panes SET iterm_id = ? WHERE name = ?").run(itermId, name);
  }

  clearPaneItermId(name: string): void {
    this.db.prepare("UPDATE panes SET iterm_id = NULL WHERE name = ?").run(name);
  }

  setPaneTheme(name: string, theme: string): void {
    this.db.prepare("UPDATE panes SET theme = ? WHERE name = ?").run(theme, name);
  }

  /**
   * Rename a pane and update all FK references (agents.pane).
   * Throws if `to` already exists.
   */
  renamePane(from: string, to: string): void {
    if (from === to) return;
    if (this.getPane(to)) throw new Error(`pane '${to}' already exists`);
    this.db.transaction(() => {
      this.db.prepare("UPDATE panes SET name = ? WHERE name = ?").run(to, from);
      this.db.prepare("UPDATE agents SET pane = ? WHERE pane = ?").run(to, from);
    })();
  }

  clearTabSession(name: string): void {
    this.db.prepare("UPDATE tabs SET iterm_session_id = NULL WHERE name = ?").run(name);
  }

  deletePane(name: string): void {
    // Detach any agent in this pane
    this.db.prepare("UPDATE agents SET pane = NULL WHERE pane = ?").run(name);
    this.db.prepare("DELETE FROM panes WHERE name = ?").run(name);
  }

  // --- Agents ---

  createAgent(agent: {
    id: string;
    display_name: string;
    runtime: string;
    screen_name: string;
    screen_pid?: number;
    cc_session_id?: string;
    pane?: string;
    badge?: string;
    ttl_idle_minutes?: number;
    spawn_manifest?: string;
  }): Agent {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO agents (id, display_name, runtime, screen_name, screen_pid, cc_session_id, pane, badge, launched_at, last_seen, ttl_idle_minutes, spawn_manifest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agent.id, agent.display_name, agent.runtime, agent.screen_name,
      agent.screen_pid ?? null, agent.cc_session_id ?? null,
      agent.pane ?? null, agent.badge ?? null, now, now,
      agent.ttl_idle_minutes ?? null,
      agent.spawn_manifest ?? null,
    );
    return {
      id: agent.id,
      display_name: agent.display_name,
      runtime: agent.runtime,
      screen_name: agent.screen_name,
      screen_pid: agent.screen_pid ?? null,
      cc_session_id: agent.cc_session_id ?? null,
      pane: agent.pane ?? null,
      status_name: null,
      status_desc: null,
      badge: agent.badge ?? null,
      launched_at: now,
      last_seen: now,
      ttl_idle_minutes: agent.ttl_idle_minutes ?? null,
      spawn_manifest: agent.spawn_manifest ?? null,
    };
  }

  /** Copy an agent row into the tombstones table. Call before deleteAgent. */
  tombstoneAgent(agent: Agent): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO agent_tombstones
       (id, screen_name, display_name, runtime, cc_session_id, badge, spawn_manifest, stopped_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      agent.id, agent.screen_name, agent.display_name, agent.runtime,
      agent.cc_session_id, agent.badge, agent.spawn_manifest, Date.now(),
    );
  }

  /** Get the most recent tombstone for an id, or null if none. */
  getLatestTombstone(id: string): AgentTombstone | null {
    return this.db.prepare(
      "SELECT * FROM agent_tombstones WHERE id = ? ORDER BY stopped_at DESC LIMIT 1"
    ).get(id) as AgentTombstone | null;
  }

  /** List tombstones (most recent first). Used for debugging / resume UIs. */
  listTombstones(id?: string, limit = 50): AgentTombstone[] {
    if (id) {
      return this.db.prepare(
        "SELECT * FROM agent_tombstones WHERE id = ? ORDER BY stopped_at DESC LIMIT ?"
      ).all(id, limit) as AgentTombstone[];
    }
    return this.db.prepare(
      "SELECT * FROM agent_tombstones ORDER BY stopped_at DESC LIMIT ?"
    ).all(limit) as AgentTombstone[];
  }

  setAgentTtl(id: string, minutes: number | null): void {
    this.db.prepare("UPDATE agents SET ttl_idle_minutes = ? WHERE id = ?").run(minutes, id);
  }

  /** List agents that have a TTL set — used by the reaper. */
  listAgentsWithTtl(): Agent[] {
    return this.db.prepare(
      "SELECT * FROM agents WHERE ttl_idle_minutes IS NOT NULL"
    ).all() as Agent[];
  }

  setAgentBadge(id: string, badge: string | null): void {
    this.db.prepare("UPDATE agents SET badge = ?, last_seen = ? WHERE id = ?").run(
      badge, Date.now(), id,
    );
  }

  /** Get agent by ID. If multiple exist (handoff in progress), returns the most recent. */
  getAgent(id: string): Agent | null {
    return this.db.prepare(
      "SELECT * FROM agents WHERE id = ? ORDER BY launched_at DESC LIMIT 1"
    ).get(id) as Agent | null;
  }

  /** Get agent by CC session ID — unambiguous, even during handoff. */
  getAgentBySession(ccSessionId: string): Agent | null {
    return this.db.prepare(
      "SELECT * FROM agents WHERE cc_session_id = ?"
    ).get(ccSessionId) as Agent | null;
  }

  /** Get agent by screen name — also unambiguous. */
  getAgentByScreen(screenName: string): Agent | null {
    return this.db.prepare(
      "SELECT * FROM agents WHERE screen_name = ?"
    ).get(screenName) as Agent | null;
  }

  listAgents(): Agent[] {
    return this.db.prepare("SELECT * FROM agents ORDER BY launched_at").all() as Agent[];
  }

  updateAgentPid(id: string, pid: number): void {
    this.db.prepare("UPDATE agents SET screen_pid = ?, last_seen = ? WHERE id = ?").run(pid, Date.now(), id);
  }

  updateAgentPane(id: string, pane: string | null): void {
    this.db.prepare("UPDATE agents SET pane = ?, last_seen = ? WHERE id = ?").run(pane, Date.now(), id);
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

  /** Delete a specific agent instance by screen name. */
  deleteAgentByScreen(screenName: string): void {
    this.db.prepare("DELETE FROM agents WHERE screen_name = ?").run(screenName);
  }

  /** Update CC session ID for an agent (set after launch when session ID becomes known). */
  updateAgentCcSession(screenName: string, ccSessionId: string): void {
    this.db.prepare(
      "UPDATE agents SET cc_session_id = ?, last_seen = ? WHERE screen_name = ?"
    ).run(ccSessionId, Date.now(), screenName);
  }
}
