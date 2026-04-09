// @bun
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/orchestrator.ts
import { join as join5 } from "path";

// src/store.ts
import { Database } from "bun:sqlite";

class CrewStore {
  db;
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.migrate();
  }
  migrate() {
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
        pane TEXT REFERENCES panes(name),
        status_name TEXT,
        status_desc TEXT,
        launched_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
    const hasTheme = this.db.prepare("SELECT * FROM pragma_table_info('tabs') WHERE name='theme'").get();
    if (!hasTheme) {
      this.db.exec("ALTER TABLE tabs ADD COLUMN theme TEXT");
    }
    const hasSlots = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='slots'").get();
    if (hasSlots) {
      this.db.exec(`
        INSERT OR IGNORE INTO panes (name, tab, position, iterm_id, created_at)
          SELECT name, tab, position, iterm_id, created_at FROM slots;
        DROP TABLE slots;
      `);
    }
    const hasSlotCol = this.db.prepare("SELECT * FROM pragma_table_info('agents') WHERE name='slot'").get();
    if (hasSlotCol) {
      this.db.exec(`
        ALTER TABLE agents RENAME COLUMN slot TO pane;
      `);
    }
    const hasCcSession = this.db.prepare("SELECT * FROM pragma_table_info('agents') WHERE name='cc_session_id'").get();
    if (!hasCcSession) {
      this.db.exec("ALTER TABLE agents ADD COLUMN cc_session_id TEXT");
    }
    const createSql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'").get();
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
          launched_at INTEGER NOT NULL,
          last_seen INTEGER NOT NULL
        );
        INSERT INTO agents_new SELECT id, display_name, runtime, screen_name, screen_pid,
          cc_session_id, pane, status_name, status_desc, launched_at, last_seen FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_new RENAME TO agents;
        CREATE INDEX IF NOT EXISTS idx_agents_id ON agents(id);
      `);
    }
  }
  createTab(name, theme) {
    const now = Date.now();
    this.db.prepare("INSERT INTO tabs (name, theme, created_at) VALUES (?, ?, ?)").run(name, theme ?? null, now);
    return { name, theme: theme ?? null, created_at: now };
  }
  setTabTheme(name, theme) {
    this.db.prepare("UPDATE tabs SET theme = ? WHERE name = ?").run(theme, name);
  }
  getTab(name) {
    return this.db.prepare("SELECT * FROM tabs WHERE name = ?").get(name);
  }
  listTabs() {
    return this.db.prepare("SELECT * FROM tabs ORDER BY created_at").all();
  }
  deleteTab(name) {
    this.db.prepare("DELETE FROM panes WHERE tab = ?").run(name);
    this.db.prepare("DELETE FROM tabs WHERE name = ?").run(name);
  }
  createPane(name, tab, position = "") {
    const now = Date.now();
    this.db.prepare("INSERT INTO panes (name, tab, position, created_at) VALUES (?, ?, ?, ?)").run(name, tab, position, now);
    return { name, tab, position, iterm_id: null, created_at: now };
  }
  getPane(name) {
    return this.db.prepare("SELECT * FROM panes WHERE name = ?").get(name);
  }
  listPanes(tab) {
    if (tab) {
      return this.db.prepare("SELECT * FROM panes WHERE tab = ? ORDER BY position").all(tab);
    }
    return this.db.prepare("SELECT * FROM panes ORDER BY tab, position").all();
  }
  setPaneItermId(name, itermId) {
    this.db.prepare("UPDATE panes SET iterm_id = ? WHERE name = ?").run(itermId, name);
  }
  deletePane(name) {
    this.db.prepare("UPDATE agents SET pane = NULL WHERE pane = ?").run(name);
    this.db.prepare("DELETE FROM panes WHERE name = ?").run(name);
  }
  createAgent(agent) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO agents (id, display_name, runtime, screen_name, screen_pid, cc_session_id, pane, launched_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(agent.id, agent.display_name, agent.runtime, agent.screen_name, agent.screen_pid ?? null, agent.cc_session_id ?? null, agent.pane ?? null, now, now);
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
      launched_at: now,
      last_seen: now
    };
  }
  getAgent(id) {
    return this.db.prepare("SELECT * FROM agents WHERE id = ? ORDER BY launched_at DESC LIMIT 1").get(id);
  }
  getAgentBySession(ccSessionId) {
    return this.db.prepare("SELECT * FROM agents WHERE cc_session_id = ?").get(ccSessionId);
  }
  getAgentByScreen(screenName) {
    return this.db.prepare("SELECT * FROM agents WHERE screen_name = ?").get(screenName);
  }
  listAgents() {
    return this.db.prepare("SELECT * FROM agents ORDER BY launched_at").all();
  }
  updateAgentPid(id, pid) {
    this.db.prepare("UPDATE agents SET screen_pid = ?, last_seen = ? WHERE id = ?").run(pid, Date.now(), id);
  }
  updateAgentPane(id, pane) {
    this.db.prepare("UPDATE agents SET pane = ?, last_seen = ? WHERE id = ?").run(pane, Date.now(), id);
  }
  updateAgentStatus(id, statusName, statusDesc) {
    this.db.prepare("UPDATE agents SET status_name = ?, status_desc = ?, last_seen = ? WHERE id = ?").run(statusName, statusDesc, Date.now(), id);
  }
  touchAgent(id) {
    this.db.prepare("UPDATE agents SET last_seen = ? WHERE id = ?").run(Date.now(), id);
  }
  deleteAgent(id) {
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }
  deleteAgentByScreen(screenName) {
    this.db.prepare("DELETE FROM agents WHERE screen_name = ?").run(screenName);
  }
  updateAgentCcSession(screenName, ccSessionId) {
    this.db.prepare("UPDATE agents SET cc_session_id = ?, last_seen = ? WHERE screen_name = ?").run(ccSessionId, Date.now(), screenName);
  }
}

// src/screen.ts
var exports_screen = {};
__export(exports_screen, {
  sendKeys: () => sendKeys,
  readOutput: () => readOutput,
  listSessions: () => listSessions,
  killSession: () => killSession,
  isAlive: () => isAlive,
  getSessionPid: () => getSessionPid,
  detachSession: () => detachSession,
  createSession: () => createSession
});
var {$ } = globalThis.Bun;
import { join } from "path";
async function findScreen() {
  try {
    const result = await $`command -v screen`.quiet();
    return result.stdout.toString().trim();
  } catch {
    return "screen";
  }
}
async function createSession(name, command) {
  const shell = "/bin/zsh";
  const screenrc = join("/Users/tim", ".wire", "screenrc");
  const scriptFile = `/tmp/crew-launch-${name}-${Date.now()}.sh`;
  await Bun.write(scriptFile, `#!/usr/bin/env -S ${shell} -l\nrm -f '${scriptFile}'\n${command}\n`);
  await $`chmod +x ${scriptFile}`.quiet();
  await $`${SCREEN} -c ${screenrc} -dmS ${name} ${scriptFile}`.quiet();
  const pid = await getSessionPid(name);
  if (pid === null) {
    throw new Error(`screen session '${name}' failed to start`);
  }
  return { name, pid };
}
async function listSessions() {
  try {
    const result = await $`${SCREEN} -ls`.quiet().nothrow();
    const output = result.stdout.toString();
    const sessions = [];
    for (const line of output.split("\n")) {
      const match = line.match(/^\t(\d+)\.(\S+)\t/);
      if (match) {
        sessions.push({ name: match[2], pid: parseInt(match[1]) });
      }
    }
    return sessions;
  } catch {
    return [];
  }
}
async function getSessionPid(name) {
  const sessions = await listSessions();
  const session = sessions.find((s) => s.name === name);
  return session?.pid ?? null;
}
async function isAlive(name) {
  return await getSessionPid(name) !== null;
}
async function detachSession(name) {
  await $`${SCREEN} -S ${name} -X detach`.quiet().nothrow();
}
async function sendKeys(name, text) {
  await $`${SCREEN} -S ${name} -X stuff ${text}`.quiet();
}
async function readOutput(name) {
  const tmpFile = `/tmp/screen-hardcopy-${name}-${Date.now()}`;
  try {
    await $`${SCREEN} -S ${name} -X hardcopy ${tmpFile}`.quiet();
    const content = await Bun.file(tmpFile).text();
    await $`rm -f ${tmpFile}`.quiet();
    return content.trimEnd();
  } catch (e) {
    throw new Error(`failed to read screen output for '${name}': ${e}`);
  }
}
async function killSession(name) {
  const pid = await getSessionPid(name);
  if (pid) {
    await $`pkill -TERM -P ${pid}`.quiet().nothrow();
    await new Promise((r) => setTimeout(r, 500));
    await $`pkill -KILL -P ${pid}`.quiet().nothrow();
  }
  await $`${SCREEN} -S ${name} -X quit`.quiet().nothrow();
}
var SCREEN = await findScreen();

// src/iterm.ts
var exports_iterm = {};
__export(exports_iterm, {
  writeToSession: () => writeToSession,
  writePaneProfile: () => writePaneProfile,
  writeEmptyPaneProfile: () => writeEmptyPaneProfile,
  splitWebBrowser: () => splitWebBrowser,
  splitSessionWithProfile: () => splitSessionWithProfile,
  splitSessionWebBrowser: () => splitSessionWebBrowser,
  splitSession: () => splitSession,
  splitPaneWithProfile: () => splitPaneWithProfile,
  splitPane: () => splitPane,
  setTabName: () => setTabName,
  setSessionName: () => setSessionName,
  setBadge: () => setBadge,
  sessionIdForTty: () => sessionIdForTty,
  isSessionAlive: () => isSessionAlive,
  currentSessionId: () => currentSessionId,
  createItermTab: () => createItermTab,
  closeSession: () => closeSession
});
var {$: $2 } = globalThis.Bun;
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join as join2 } from "path";
async function osascript(script) {
  const result = await $2`osascript -e ${script}`.quiet();
  return result.stdout.toString().trim();
}
async function currentSessionId() {
  return osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        return id
      end tell
    end tell
  `);
}
async function sessionIdForTty(ttyName) {
  const devTty = ttyName.startsWith("/dev/") ? ttyName : `/dev/${ttyName}`;
  try {
    const result = await osascript(`
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${devTty}" then
                return id of s
              end if
            end repeat
          end repeat
        end repeat
        return "NOT_FOUND"
      end tell
    `);
    return result === "NOT_FOUND" ? null : result;
  } catch (e) {
    console.error(`[crew] sessionIdForTty failed for ${devTty}:`, e);
    return null;
  }
}
async function splitPane(direction) {
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        set newSession to split ${verb} with default profile
        tell newSession
          return id
        end tell
      end tell
    end tell
  `);
}
async function splitSession(sessionId, direction) {
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s
                set newSession to split ${verb} with default profile
              end tell
              return id of newSession
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `);
}
async function writeToSession(sessionId, text) {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s to write text "${escaped}"
              return
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `);
}
async function closeSession(sessionId) {
  const result = await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              close s
              return "closed"
            end if
          end repeat
        end repeat
      end repeat
      return "not_found"
    end tell
  `);
  if (result === "not_found") {
    throw new Error(`iTerm2 session not found: ${sessionId} \u2014 pane may have been closed manually or session ID is stale`);
  }
}
async function createItermTab() {
  return osascript(`
    tell application "iTerm2"
      tell current window
        set newTab to (create tab with default profile)
        tell current session of newTab
          return id
        end tell
      end tell
    end tell
  `);
}
async function isSessionAlive(sessionId) {
  try {
    const result = await osascript(`
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if id of s is "${sessionId}" then
                return "alive"
              end if
            end repeat
          end repeat
        end repeat
        return "dead"
      end tell
    `);
    return result === "alive";
  } catch {
    return false;
  }
}
async function setSessionName(sessionId, name) {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s to set name to "${escaped}"
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `);
}
async function setTabName(sessionId, name) {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell t to set name to "${escaped}"
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `);
}
async function setBadge(sessionId, text) {
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s
                set variable named "user.crew_badge" to "${escaped}"
                set badge to "\\(user.crew_badge)"
              end tell
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `);
}
function writePaneProfile(paneName, backgroundImage, opts) {
  const profileName = `Crew ${paneName}`;
  const guid = `crew-pane-${paneName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  const profileFile = join2(DYNAMIC_PROFILES_DIR, `crew-pane-${paneName}.json`);
  mkdirSync(DYNAMIC_PROFILES_DIR, { recursive: true });
  try {
    unlinkSync(profileFile);
  } catch {
  }
  const profile = {
    Profiles: [
      {
        Name: profileName,
        Guid: guid,
        "Custom Command": "Yes",
        Command: `zsh -c 'printf "\\n  \\033[2m\u2610 Available \u2014 no agent attached\\033[0m\\n\\n" && exec zsh -l'`,
        "Silence Bell": true,
        "Background Image Location": backgroundImage,
        Blend: opts?.blend ?? 0.5,
        "Background Image Mode": opts?.mode ?? 2
      }
    ]
  };
  writeFileSync(profileFile, JSON.stringify(profile, null, 2));
  return profileName;
}
function writeEmptyPaneProfile() {
  mkdirSync(DYNAMIC_PROFILES_DIR, { recursive: true });
  const profile = {
    Name: EMPTY_PANE_PROFILE_NAME,
    Guid: "crew-empty-pane-001",
    "Custom Command": "Yes",
    Command: `zsh -c 'printf "\\n  \\033[2m\u2610 Available \u2014 no agent attached\\033[0m\\n\\n" && exec zsh -l'`,
    "Silence Bell": true
  };
  writeFileSync(EMPTY_PANE_PROFILE_FILE, JSON.stringify({ Profiles: [profile] }, null, 2));
}
async function splitPaneWithProfile(direction, profileName) {
  const escaped = profileName.replace(/"/g, '\\"');
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        set newSession to split ${verb} with profile "${escaped}"
        tell newSession
          return id
        end tell
      end tell
    end tell
  `);
}
async function splitSessionWithProfile(sessionId, direction, profileName) {
  const escaped = profileName.replace(/"/g, '\\"');
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s
                set newSession to split ${verb} with profile "${escaped}"
              end tell
              return id of newSession
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `);
}
function writeBrowserProfile(url) {
  mkdirSync(DYNAMIC_PROFILES_DIR, { recursive: true });
  try {
    unlinkSync(BROWSER_PROFILE_FILE);
  } catch {
  }
  const profile = {
    Profiles: [
      {
        Name: BROWSER_PROFILE_NAME,
        Guid: "crew-web-browser-001",
        "Custom Command": "Browser",
        "Initial URL": url
      }
    ]
  };
  writeFileSync(BROWSER_PROFILE_FILE, JSON.stringify(profile, null, 2));
}
async function splitWebBrowser(url, direction = "horizontal") {
  writeBrowserProfile(url);
  await new Promise((r) => setTimeout(r, 500));
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        set newSession to split ${verb} with profile "${BROWSER_PROFILE_NAME}"
        tell newSession
          return id
        end tell
      end tell
    end tell
  `);
}
async function splitSessionWebBrowser(sessionId, url, direction = "horizontal") {
  writeBrowserProfile(url);
  await new Promise((r) => setTimeout(r, 500));
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s
                set newSession to split ${verb} with profile "${BROWSER_PROFILE_NAME}"
              end tell
              return id of newSession
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `);
}
var DYNAMIC_PROFILES_DIR = join2("/Users/tim", "Library/Application Support/iTerm2/DynamicProfiles");
var BROWSER_PROFILE_FILE = join2(DYNAMIC_PROFILES_DIR, "crew-web-browser.json");
var BROWSER_PROFILE_NAME = "Pane Web Browser";
var EMPTY_PANE_PROFILE_FILE = join2(DYNAMIC_PROFILES_DIR, "crew-empty-pane.json");
var EMPTY_PANE_PROFILE_NAME = "Crew Empty Pane";

// src/runtimes.ts
import { existsSync, readFileSync } from "fs";
import { join as join3 } from "path";
function loadRuntimes() {
  if (_cache)
    return _cache;
  const runtimes = { ...DEFAULTS };
  if (existsSync(CONFIG_PATH)) {
    try {
      const userConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      for (const [name, config] of Object.entries(userConfig)) {
        if (typeof config === "string") {
          runtimes[name] = { command: config };
        } else if (typeof config === "object" && config !== null) {
          runtimes[name] = config;
        }
      }
    } catch {
    }
  }
  _cache = runtimes;
  return runtimes;
}
function expandCommand(template, vars) {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }
  return result;
}
function getLaunchCommand(runtime, vars) {
  const runtimes = loadRuntimes();
  const config = runtimes[runtime];
  if (!config) {
    throw new Error(`unknown runtime '${runtime}'. Available: ${Object.keys(runtimes).join(", ")}`);
  }
  return expandCommand(config.command, vars);
}
var DEFAULTS = {
  "claude-code": {
    command: "claude --dangerously-load-development-channels plugin:wire@agiterra --permission-mode bypassPermissions",
    description: "Claude Code with Wire channel (SSE push). MCP plugins (wire-ipc, personai, crew) load from installed_plugins.json per project scope."
  },
  codex: {
    command: "codex",
    description: "OpenAI Codex CLI"
  }
};
var CONFIG_PATH = join3("/Users/tim", ".wire", "runtimes.json");
var _cache = null;

// src/reconciler.ts
async function reconcile(store) {
  const agents = store.listAgents();
  const sessions = await listSessions();
  const sessionByName = new Map(sessions.map((s) => [s.name, s]));
  const alive = [];
  const dead = [];
  const knownScreenNames = new Set;
  for (const agent of agents) {
    knownScreenNames.add(agent.screen_name);
    const session = sessionByName.get(agent.screen_name);
    if (session) {
      store.updateAgentPid(agent.id, session.pid);
      store.touchAgent(agent.id);
      alive.push(agent.id);
    } else {
      store.deleteAgent(agent.id);
      dead.push(agent.id);
    }
  }
  const orphans = sessions.filter((s) => s.name.startsWith("wire-") && !knownScreenNames.has(s.name));
  return { alive, dead, orphans };
}
function formatReport(result, agents) {
  const lines = [];
  const attached = agents.filter((a) => a.pane);
  const detached = agents.filter((a) => !a.pane);
  lines.push(`${agents.length} agent(s): ${attached.length} attached, ${detached.length} detached`);
  if (result.dead.length > 0) {
    lines.push(`${result.dead.length} dead agent(s) cleaned up: ${result.dead.join(", ")}`);
  }
  if (result.orphans.length > 0) {
    lines.push(`${result.orphans.length} orphan screen session(s): ${result.orphans.map((o) => o.name).join(", ")}`);
  }
  for (const agent of agents) {
    const status = agent.status_name ? ` [${agent.status_name}]` : "";
    const location = agent.pane ? `pane:${agent.pane}` : "detached";
    lines.push(`  ${agent.id} (${agent.display_name}) \u2014 ${location}${status}`);
  }
  return lines.join("\n");
}

// src/themes.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "fs";
import { join as join4 } from "path";
function resolveThemeDir(theme) {
  const crewDir = join4(CREW_THEMES_DIR, theme);
  if (existsSync2(crewDir))
    return crewDir;
  const wireDir = join4(WIRE_THEMES_DIR, theme);
  if (existsSync2(wireDir))
    return wireDir;
  return null;
}
function loadTheme(theme) {
  for (const base of [CREW_THEMES_DIR, WIRE_THEMES_DIR]) {
    const jsonPath = join4(base, theme, "theme.json");
    if (existsSync2(jsonPath)) {
      try {
        const raw = JSON.parse(readFileSync2(jsonPath, "utf-8"));
        return validateTheme(raw, theme);
      } catch (e) {
        console.error(`[crew] failed to parse ${jsonPath}:`, e);
        return null;
      }
    }
  }
  return synthesizeLegacyTheme(theme);
}
function validateTheme(raw, fallbackName) {
  const name = raw.name ?? fallbackName;
  const pool = Array.isArray(raw.pool) ? raw.pool : POOLS[name] ?? [];
  const bg = raw.background ?? {};
  return {
    name,
    description: raw.description,
    author: raw.author,
    version: raw.version,
    pool,
    background: {
      blend: typeof bg.blend === "number" ? bg.blend : 0.5,
      mode: typeof bg.mode === "number" ? bg.mode : 2,
      images: typeof bg.images === "object" && bg.images !== null ? bg.images : {}
    }
  };
}
function synthesizeLegacyTheme(theme) {
  const dir = resolveThemeDir(theme);
  const pool = POOLS[theme];
  if (!dir && !pool)
    return null;
  const images = {};
  if (dir) {
    try {
      const files = readdirSync(dir);
      for (const file of files) {
        const match = file.match(/^(.+)\.(jpg|jpeg|png|webp)$/i);
        if (match) {
          images[match[1].toLowerCase()] = file;
        }
      }
    } catch {
    }
  }
  return {
    name: theme,
    pool: pool ?? [],
    background: {
      blend: 0.5,
      mode: 2,
      images
    }
  };
}
function listThemes() {
  const names = new Set(Object.keys(POOLS));
  for (const base of [CREW_THEMES_DIR, WIRE_THEMES_DIR]) {
    if (!existsSync2(base))
      continue;
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory())
          names.add(entry.name);
      }
    } catch {
    }
  }
  return [...names].sort();
}
function pickName(theme, usedNames) {
  const config = loadTheme(theme);
  const pool = config?.pool ?? POOLS[theme];
  if (!pool)
    return null;
  const used = new Set(usedNames);
  const available = pool.filter((n) => !used.has(n));
  if (available.length === 0)
    return null;
  return available[0];
}
function isValidTheme(theme) {
  return theme in POOLS || resolveThemeDir(theme) !== null;
}
function backgroundImagePath(theme, name, config) {
  const dir = resolveThemeDir(theme);
  if (!dir)
    return null;
  const cfg = config ?? loadTheme(theme);
  if (cfg?.background.images) {
    const filename = cfg.background.images[name] ?? cfg.background.images["default"];
    if (filename) {
      const path = join4(dir, filename);
      if (existsSync2(path))
        return path;
    }
  }
  for (const ext of ["jpg", "jpeg", "png", "webp"]) {
    const path = join4(dir, `${name}.${ext}`);
    if (existsSync2(path))
      return path;
  }
  return null;
}
var CREW_THEMES_DIR = join4("/Users/tim", ".crew", "themes");
var WIRE_THEMES_DIR = join4("/Users/tim", ".wire", "themes");
var POOLS = {
  trees: [
    "walnut",
    "oak",
    "cherry",
    "maple",
    "ash",
    "birch",
    "elm",
    "alder",
    "beech",
    "hickory",
    "cedar",
    "pine",
    "spruce",
    "fir",
    "hemlock",
    "teak",
    "mahogany",
    "ebony",
    "rosewood",
    "bamboo"
  ],
  rivers: [
    "thames",
    "seine",
    "danube",
    "rhine",
    "tigris",
    "nile",
    "ganges",
    "volga",
    "amazon",
    "missouri",
    "yukon",
    "loire",
    "elbe",
    "don",
    "ohio",
    "platte",
    "snake",
    "rouge",
    "pearl",
    "verde"
  ],
  stones: [
    "granite",
    "marble",
    "slate",
    "basalt",
    "quartz",
    "obsidian",
    "flint",
    "jasper",
    "onyx",
    "agate",
    "pumice",
    "shale",
    "gneiss",
    "chalk",
    "dolomite",
    "travertine",
    "sandstone",
    "limestone",
    "soapstone",
    "feldspar"
  ],
  peaks: [
    "rainier",
    "denali",
    "shasta",
    "hood",
    "baker",
    "whitney",
    "elbert",
    "olympus",
    "logan",
    "robson",
    "fuji",
    "blanc",
    "elbrus",
    "rosa",
    "matterhorn",
    "cook",
    "vinson",
    "kailash",
    "ararat",
    "sinai"
  ],
  spices: [
    "saffron",
    "cardamom",
    "cumin",
    "cinnamon",
    "clove",
    "nutmeg",
    "ginger",
    "turmeric",
    "paprika",
    "sumac",
    "anise",
    "fennel",
    "coriander",
    "thyme",
    "oregano",
    "basil",
    "sage",
    "tarragon",
    "dill",
    "caraway"
  ],
  cities: [
    "rome",
    "paris",
    "vienna",
    "prague",
    "lisbon",
    "florence",
    "barcelona",
    "bruges",
    "edinburgh",
    "zurich",
    "boston",
    "savannah",
    "havana",
    "montreal",
    "lima",
    "cairo",
    "marrakech",
    "istanbul",
    "beirut",
    "nairobi"
  ]
};
var THEME_NAMES = Object.keys(POOLS);

// src/orchestrator.ts
function titleCase(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
var DEFAULT_DB = join5("/Users/tim", ".wire", "crews.db");
var SCREEN_PREFIX = "wire-";

class Orchestrator {
  store;
  constructor(dbPath = DEFAULT_DB) {
    this.store = new CrewStore(dbPath);
  }
  async launchAgent(opts) {
    const runtime = opts.runtime ?? "claude-code";
    let screenName = `${SCREEN_PREFIX}${opts.id}`;
    const existing = this.store.getAgent(opts.id);
    if (existing) {
      const alive = await isAlive(existing.screen_name);
      if (alive) {
        screenName = `${SCREEN_PREFIX}${opts.id}-${Date.now()}`;
      } else {
        this.store.deleteAgentByScreen(existing.screen_name);
      }
    }
    const wireUrl = "https://the-wire.ngrok.io";
    const projectDir = opts.projectDir ?? process.cwd();
    const vars = {
      AGENT_ID: opts.id,
      AGENT_NAME: opts.displayName,
      WIRE_URL: wireUrl,
      PROJECT_DIR: projectDir
    };
    let command = getLaunchCommand(runtime, vars);
    if (opts.prompt) {
      command += ` ${shellEscape(opts.prompt)}`;
    }
    if (opts.extraFlags) {
      command += ` ${opts.extraFlags}`;
    }
    const keyExport = opts.privateKeyB64 ? ` CREW_PRIVATE_KEY=${shellEscape(opts.privateKeyB64)}` : "";
    const envExports = `export CREW_AGENT_ID=${shellEscape(opts.id)} CREW_AGENT_NAME=${shellEscape(opts.displayName)} WIRE_URL=${shellEscape(wireUrl)}${keyExport}`;
    const fullCommand = `cd ${shellEscape(projectDir)} && ${envExports} && ${command}`;
    const session = await createSession(screenName, fullCommand);
    setTimeout(async () => {
      try {
        await sendKeys(screenName, "\n");
      } catch (e) {
        console.error(`[crew] failed to auto-confirm dev-channel prompt for ${opts.id}:`, e);
      }
    }, 3000);
    return this.store.createAgent({
      id: opts.id,
      display_name: opts.displayName,
      runtime,
      screen_name: screenName,
      screen_pid: session.pid
    });
  }
  async registerAgent(opts) {
    const runtime = opts.runtime ?? "claude-code";
    const ccSessionId = opts.ccSessionId ?? "";
    const sty = "88083.fondant";
    if (!sty)
      throw new Error("not running in a screen session (STY not set)");
    const [pidStr, ...nameParts] = sty.split(".");
    const screenName = nameParts.join(".");
    const screenPid = parseInt(pidStr, 10);
    if (!screenName || isNaN(screenPid)) {
      throw new Error(`cannot parse STY: ${sty}`);
    }
    const alive = await isAlive(screenName);
    if (!alive)
      throw new Error(`screen session '${screenName}' is not running`);
    const callerPane = opts.callerItermId ? this.store.listPanes().find((p) => p.iterm_id === opts.callerItermId)?.name ?? null : null;
    const existingByScreen = this.store.getAgentByScreen(screenName);
    if (existingByScreen) {
      this.store.updateAgentPid(existingByScreen.id, screenPid);
      if (ccSessionId)
        this.store.updateAgentCcSession(screenName, ccSessionId);
      if (!existingByScreen.pane && callerPane) {
        this.store.updateAgentPane(existingByScreen.id, callerPane);
      }
      return this.store.getAgentByScreen(screenName);
    }
    return this.store.createAgent({
      id: opts.id,
      display_name: opts.displayName,
      runtime,
      screen_name: screenName,
      screen_pid: screenPid,
      cc_session_id: ccSessionId ?? undefined,
      pane: callerPane ?? undefined
    });
  }
  async stopAgent(id, ccSessionId) {
    let agent;
    if (ccSessionId) {
      agent = this.store.getAgentBySession(ccSessionId);
      if (!agent)
        throw new Error(`no agent with cc_session_id '${ccSessionId}'`);
    } else {
      agent = this.store.getAgent(id);
      if (!agent)
        throw new Error(`agent '${id}' not found`);
    }
    await killSession(agent.screen_name);
    this.store.deleteAgentByScreen(agent.screen_name);
  }
  async attachAgent(agentId, paneName) {
    const agent = this.store.getAgent(agentId);
    if (!agent)
      throw new Error(`agent '${agentId}' not found`);
    const pane = this.store.getPane(paneName);
    if (!pane)
      throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id)
      throw new Error(`pane '${paneName}' has no iTerm2 session`);
    const occupants = this.store.listAgents().filter((a) => a.pane === paneName);
    for (const occ of occupants) {
      await detachSession(occ.screen_name);
      this.store.updateAgentPane(occ.id, null);
    }
    await detachSession(agent.screen_name);
    await writeToSession(pane.iterm_id, `screen -x ${agent.screen_name}`);
    this.store.updateAgentPane(agentId, paneName);
  }
  async detachAgent(agentId) {
    const agent = this.store.getAgent(agentId);
    if (!agent)
      throw new Error(`agent '${agentId}' not found`);
    await detachSession(agent.screen_name);
    this.store.updateAgentPane(agentId, null);
  }
  async moveAgent(agentId, toPane) {
    await this.detachAgent(agentId);
    await this.attachAgent(agentId, toPane);
  }
  async swapAgents(agentIdA, agentIdB) {
    const a = this.store.getAgent(agentIdA);
    const b = this.store.getAgent(agentIdB);
    if (!a)
      throw new Error(`agent '${agentIdA}' not found`);
    if (!b)
      throw new Error(`agent '${agentIdB}' not found`);
    if (a.pane)
      await this.detachAgent(agentIdA);
    if (b.pane)
      await this.detachAgent(agentIdB);
    const paneA = a.pane;
    const paneB = b.pane;
    if (paneB)
      await this.attachAgent(agentIdA, paneB);
    if (paneA)
      await this.attachAgent(agentIdB, paneA);
  }
  async sendToAgent(agentId, text, ccSessionId) {
    const agent = this.resolveAgent(agentId, ccSessionId);
    await sendKeys(agent.screen_name, text);
  }
  async readAgent(agentId, ccSessionId) {
    const agent = this.resolveAgent(agentId, ccSessionId);
    return readOutput(agent.screen_name);
  }
  resolveAgent(agentId, ccSessionId) {
    if (ccSessionId) {
      const agent2 = this.store.getAgentBySession(ccSessionId);
      if (!agent2)
        throw new Error(`no agent with cc_session_id '${ccSessionId}'`);
      return agent2;
    }
    const agent = this.store.getAgent(agentId);
    if (!agent)
      throw new Error(`agent '${agentId}' not found`);
    return agent;
  }
  setAgentStatus(agentId, statusName, statusDesc) {
    const agent = this.store.getAgent(agentId);
    if (!agent)
      throw new Error(`agent '${agentId}' not found`);
    this.store.updateAgentStatus(agentId, statusName, statusDesc);
  }
  listAgents() {
    return this.store.listAgents();
  }
  async sendToPane(paneName, text) {
    const pane = this.store.getPane(paneName);
    if (!pane)
      throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id)
      throw new Error(`pane '${paneName}' has no iTerm2 session`);
    await writeToSession(pane.iterm_id, text);
  }
  async setBadge(paneName, text) {
    const pane = this.store.getPane(paneName);
    if (!pane)
      throw new Error(`pane '${paneName}' not found`);
    if (!pane.iterm_id)
      throw new Error(`pane '${paneName}' has no iTerm2 session`);
    await setBadge(pane.iterm_id, text);
  }
  async interruptAgent(agentId, background = false, ccSessionId) {
    const agent = this.resolveAgent(agentId, ccSessionId);
    if (background) {
      await sendKeys(agent.screen_name, "\x02\x02");
    } else {
      await sendKeys(agent.screen_name, "\x1B");
    }
    await new Promise((r) => setTimeout(r, 500));
    const output = await readOutput(agent.screen_name);
    return { method: background ? "background" : "escape", output };
  }
  createTab(name, theme) {
    return this.store.createTab(name, theme);
  }
  setTabTheme(name, theme) {
    if (!this.store.getTab(name))
      throw new Error(`tab '${name}' not found`);
    this.store.setTabTheme(name, theme);
  }
  listTabs() {
    return this.store.listTabs();
  }
  deleteTab(name) {
    this.store.deleteTab(name);
  }
  async registerPane(tab, name, itermSessionId) {
    if (!this.store.getTab(tab))
      throw new Error(`tab '${tab}' not found`);
    const alive = await isSessionAlive(itermSessionId);
    if (!alive)
      throw new Error(`iTerm2 session ${itermSessionId} not found \u2014 ITERM_SESSION_ID may be stale`);
    const paneName = name ?? this.nextPaneName(tab);
    if (!paneName)
      throw new Error(`no name provided and tab '${tab}' has no theme (or pool exhausted)`);
    const existing = this.store.getPane(paneName);
    if (existing) {
      this.store.setPaneItermId(paneName, itermSessionId);
      await setSessionName(itermSessionId, titleCase(paneName));
      return { ...existing, iterm_id: itermSessionId };
    }
    const pane = this.store.createPane(paneName, tab, "registered");
    this.store.setPaneItermId(paneName, itermSessionId);
    await setSessionName(itermSessionId, titleCase(paneName));
    return { ...pane, iterm_id: itermSessionId };
  }
  resolveSession(relativeTo) {
    const pane = this.store.getPane(relativeTo);
    if (pane?.iterm_id)
      return pane.iterm_id;
    return relativeTo;
  }
  async createPane(tab, name, position = "below", relativeTo) {
    if (!this.store.getTab(tab))
      throw new Error(`tab '${tab}' not found`);
    const paneName = name ?? this.nextPaneName(tab);
    if (!paneName)
      throw new Error(`no name provided and tab '${tab}' has no theme (or pool exhausted)`);
    const direction = position === "left" || position === "right" ? "vertical" : "horizontal";
    const tabRow = this.store.getTab(tab);
    const theme = tabRow?.theme ? loadTheme(tabRow.theme) : null;
    const bgPath = tabRow?.theme ? backgroundImagePath(tabRow.theme, paneName, theme) : null;
    const profileName = bgPath ? writePaneProfile(paneName, bgPath, {
      blend: theme?.background.blend,
      mode: theme?.background.mode
    }) : (writeEmptyPaneProfile(), "Crew Empty Pane");
    await new Promise((r) => setTimeout(r, 300));
    let itermId;
    if (relativeTo) {
      const resolvedId = this.resolveSession(relativeTo);
      const alive = await isSessionAlive(resolvedId);
      if (!alive) {
        throw new Error(`cannot split relative to '${relativeTo}': iTerm2 session ${resolvedId} is dead or stale. ` + `Re-register the pane or omit relative_to to split the caller's pane.`);
      }
      itermId = await splitSessionWithProfile(resolvedId, direction, profileName);
    } else {
      itermId = await splitPaneWithProfile(direction, profileName);
    }
    const pane = this.store.createPane(paneName, tab, position);
    this.store.setPaneItermId(paneName, itermId);
    await setSessionName(itermId, titleCase(paneName));
    return { ...pane, iterm_id: itermId };
  }
  nextPaneName(tab) {
    const tabRow = this.store.getTab(tab);
    if (!tabRow?.theme)
      return null;
    const usedNames = this.store.listPanes(tab).map((p) => p.name);
    return pickName(tabRow.theme, usedNames);
  }
  listPanes(tab) {
    return this.store.listPanes(tab);
  }
  async closePane(name, callerItermId) {
    const pane = this.store.getPane(name);
    if (!pane)
      throw new Error(`pane '${name}' not found`);
    if (callerItermId && pane.iterm_id === callerItermId) {
      throw new Error(`refusing to close pane '${name}' \u2014 it is YOUR pane. ` + `Closing it would kill your process. Use agent_detach to leave a pane without closing it.`);
    }
    const occupants = this.store.listAgents().filter((a) => a.pane === name);
    for (const occ of occupants) {
      this.store.updateAgentPane(occ.id, null);
    }
    if (pane.iterm_id) {
      await closeSession(pane.iterm_id);
    }
    this.store.deletePane(name);
  }
  async openUrl(opts) {
    if (!this.store.getTab(opts.tab))
      throw new Error(`tab '${opts.tab}' not found`);
    const paneName = opts.pane ?? `url-${Date.now()}`;
    const position = opts.position ?? "below";
    const direction = position === "left" || position === "right" ? "vertical" : "horizontal";
    const itermId = opts.relativeTo ? await splitSessionWebBrowser(this.resolveSession(opts.relativeTo), opts.url, direction) : await splitWebBrowser(opts.url, direction);
    const pane = this.store.createPane(paneName, opts.tab, position);
    this.store.setPaneItermId(paneName, itermId);
    return { pane: { ...pane, iterm_id: itermId }, url: opts.url };
  }
  async reconcile() {
    const result = await reconcile(this.store);
    const agents = this.store.listAgents();
    return formatReport(result, agents);
  }
}
export {
  exports_screen as screen,
  resolveThemeDir,
  reconcile,
  pickName,
  loadTheme,
  loadRuntimes,
  listThemes,
  exports_iterm as iterm,
  isValidTheme,
  getLaunchCommand,
  formatReport,
  expandCommand,
  backgroundImagePath,
  THEME_NAMES,
  Orchestrator,
  CrewStore
};
