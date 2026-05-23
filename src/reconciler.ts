/**
 * Reconciler — sync SQLite state with actual terminal + screen reality.
 *
 * Covers four drift surfaces:
 * 1. Agents ↔ screen sessions (dead agents cleaned up, orphan screens flagged)
 * 2. Panes ↔ terminal sessions (pane.iterm_id cleared if session gone)
 * 3. Tabs ↔ terminal sessions + theme sanity (missing themes auto-assigned,
 *    dead iterm_session_id cleared)
 * 4. Live theme application — for panes with iterm_id + a theme, ensure the
 *    pane name comes from the theme's pool (rename if not), then write the
 *    themed profile and apply it to the running session via setProfile.
 */

import { CrewStore, type Agent } from "./store.js";
import { listSessions, type ScreenSession } from "./screen.js";
import { listThemes, loadTheme, pickName, backgroundImagePath } from "./themes.js";
import type { TerminalBackend } from "./terminal.js";

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type ReconcileResult = {
  alive: string[];
  dead: string[];
  orphans: ScreenSession[];
  panesCleared: string[];
  panesDeleted: string[];
  tabsCleared: string[];
  tabsDeleted: string[];
  tabsThemed: Array<{ tab: string; theme: string }>;
  panesThemed: Array<{ pane: string; theme: string }>;
  panesRenamed: Array<{ from: string; to: string; theme: string }>;
  profilesApplied: Array<{ pane: string; profile: string }>;
};

const DEFAULT_TAB_ORPHAN_AGE_MS = 60 * 1000;

export async function reconcile(
  store: CrewStore,
  terminal?: TerminalBackend,
  options?: { tabOrphanAgeMs?: number },
): Promise<ReconcileResult> {
  const tabOrphanAgeMs = options?.tabOrphanAgeMs ?? DEFAULT_TAB_ORPHAN_AGE_MS;
  const agents = store.listAgents();
  const sessions = await listSessions();
  const sessionByName = new Map(sessions.map((s) => [s.name, s]));
  const localMachine = store.localMachineName();

  const alive: string[] = [];
  const dead: string[] = [];
  const knownScreenNames = new Set<string>();

  for (const agent of agents) {
    // Cross-machine safety: the local reconciler is NOT authoritative for
    // agents on peer machines. Their screen sessions live on the remote
    // host; `screen -ls` here will always return nothing for them. Without
    // this skip, the first time a peer is registered and fleet_list
    // populates the DB with remote rows, the next boot would cascade-
    // delete every remote agent — classic latent fatal bug.
    if (agent.machine_name !== localMachine) continue;

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

  const orphans = sessions.filter(
    (s) => s.name.startsWith("wire-") && !knownScreenNames.has(s.name),
  );

  // --- Pane session check ---
  // Pane lifecycle follows iTerm: if we confirm the pane's iTerm session is
  // gone, delete the DB row (deletePane detaches any agent claiming it).
  // Panes with null iterm_id are left alone — they're transient, waiting for
  // self-stamp at MCP startup to bind them to a real iTerm session.
  const panesCleared: string[] = [];
  const panesDeleted: string[] = [];
  if (terminal) {
    for (const pane of store.listPanes()) {
      if (!pane.iterm_id) continue;
      const isAlive = await terminal.isSessionAlive(pane.iterm_id).catch(() => false);
      if (!isAlive) {
        store.deletePane(pane.name);
        panesDeleted.push(pane.name);
      }
    }
  }

  // --- Tab session check ---
  // Clear iterm_session_id for tabs whose iTerm session is gone.
  const tabsCleared: string[] = [];
  if (terminal) {
    for (const tab of store.listTabs()) {
      if (!tab.iterm_session_id) continue;
      const isAlive = await terminal.isSessionAlive(tab.iterm_session_id).catch(() => false);
      if (!isAlive) {
        store.clearTabSession(tab.name);
        tabsCleared.push(tab.name);
      }
    }
  }

  // --- Tab orphan prune ---
  // Delete unbound tabs that have no panes and are older than the safety
  // threshold. Age gate avoids racing a just-created tab that hasn't had
  // its iterm_session_id stamped yet.
  const tabsDeleted: string[] = [];
  const nowMs = Date.now();
  for (const tab of store.listTabs()) {
    if (tab.iterm_session_id) continue;
    if (store.listPanes(tab.name).length > 0) continue;
    if (nowMs - tab.created_at < tabOrphanAgeMs) continue;
    store.deleteTab(tab.name);
    tabsDeleted.push(tab.name);
  }

  // --- Tab theme auto-assign ---
  const tabsThemed: Array<{ tab: string; theme: string }> = [];
  const availableThemes = listThemes();
  for (const tab of store.listTabs()) {
    if (tab.theme || availableThemes.length === 0) continue;
    const usedThemes = new Set(
      store.listTabs().map((t) => t.theme).filter(Boolean) as string[],
    );
    const picked = availableThemes.find((t) => !usedThemes.has(t)) ?? availableThemes[0];
    store.setTabTheme(tab.name, picked);
    tabsThemed.push({ tab: tab.name, theme: picked });
  }

  // --- Pane theme heal (inherit from tab) ---
  const panesThemed: Array<{ pane: string; theme: string }> = [];
  for (const pane of store.listPanes()) {
    if (pane.theme) continue;
    const tab = store.getTab(pane.tab);
    if (tab?.theme) {
      store.setPaneTheme(pane.name, tab.theme);
      panesThemed.push({ pane: pane.name, theme: tab.theme });
    }
  }

  // --- Live theme application: rename to pool name if needed, write+apply profile ---
  const panesRenamed: Array<{ from: string; to: string; theme: string }> = [];
  const profilesApplied: Array<{ pane: string; profile: string }> = [];
  if (terminal) {
    // Re-fetch panes after rename to get current name
    let panesSnapshot = store.listPanes();
    for (let i = 0; i < panesSnapshot.length; i++) {
      const original = panesSnapshot[i];
      if (!original.iterm_id || !original.theme) continue;

      let workingName = original.name;
      const themeConfig = loadTheme(original.theme);
      const pool = themeConfig?.pool ?? [];

      // If pane's current name isn't in the theme's pool, swap to an unused pool name.
      if (pool.length > 0 && !pool.includes(workingName)) {
        const usedNames = store.listPanes().map((p) => p.name);
        const newName = pickName(original.theme, usedNames);
        if (newName) {
          try {
            store.renamePane(workingName, newName);
            await terminal.setSessionName(original.iterm_id, titleCase(newName));
            panesRenamed.push({ from: workingName, to: newName, theme: original.theme });
            workingName = newName;
            // Refresh local snapshot index
            panesSnapshot = store.listPanes();
          } catch (e) {
            console.error(`[crew] reconcile: failed to rename pane '${workingName}' → '${newName}':`, e);
            continue;
          }
        }
      }

      // Build the themed profile and apply it to the live session.
      const bgPath = backgroundImagePath(original.theme, workingName, themeConfig);
      const badgeColor = themeConfig?.badgeColors?.[workingName] ?? themeConfig?.defaultBadgeColor;
      try {
        const profileName = terminal.writePaneProfile({
          paneName: workingName,
          backgroundImage: bgPath ?? undefined,
          blend: themeConfig?.background.blend,
          mode: themeConfig?.background.mode,
          badgeColor,
        });
        await terminal.setProfile(original.iterm_id, profileName);
        // SetProfile switches profile attributes but leaves the session title untouched.
        // Always set the session name so live iTerm UI matches the DB pane name.
        await terminal.setSessionName(original.iterm_id, titleCase(workingName));
        // setProfile clears the session's badge (the dynamic profile has no
        // badge text set). If an agent is attached to this pane, re-apply its
        // badge so the operator's view survives boot-time reconcile. Without
        // this, any agent_badge call made in the window between mcp.connect
        // and reconcile completing gets silently blown away — exactly what
        // Brioche observed in v2.3.2 post-restart.
        const occupant = store.listAgents().find((a) => a.pane === workingName);
        if (occupant?.badge) {
          try { await terminal.setBadge(original.iterm_id, occupant.badge); } catch {}
        }
        profilesApplied.push({ pane: workingName, profile: profileName });
      } catch (e) {
        console.error(`[crew] reconcile: failed to apply profile for pane '${workingName}':`, e);
      }
    }
  }

  return {
    alive, dead, orphans,
    panesCleared, panesDeleted, tabsCleared, tabsDeleted,
    tabsThemed, panesThemed,
    panesRenamed, profilesApplied,
  };
}

export function formatReport(result: ReconcileResult, agents: Agent[]): string {
  const lines: string[] = [];
  const attached = agents.filter((a) => a.pane);
  const detached = agents.filter((a) => !a.pane);

  lines.push(`${agents.length} agent(s): ${attached.length} attached, ${detached.length} detached`);

  if (result.dead.length > 0) {
    lines.push(`${result.dead.length} dead agent(s) cleaned up: ${result.dead.join(", ")}`);
  }
  if (result.orphans.length > 0) {
    lines.push(`${result.orphans.length} orphan screen session(s): ${result.orphans.map((o) => o.name).join(", ")}`);
  }
  if (result.panesCleared.length > 0) {
    lines.push(`${result.panesCleared.length} pane(s) with dead terminal session: ${result.panesCleared.join(", ")}`);
  }
  if (result.panesDeleted.length > 0) {
    lines.push(`${result.panesDeleted.length} orphan pane(s) pruned: ${result.panesDeleted.join(", ")}`);
  }
  if (result.tabsCleared.length > 0) {
    lines.push(`${result.tabsCleared.length} tab(s) with dead terminal session: ${result.tabsCleared.join(", ")}`);
  }
  if (result.tabsDeleted.length > 0) {
    lines.push(`${result.tabsDeleted.length} orphan tab(s) pruned: ${result.tabsDeleted.join(", ")}`);
  }
  if (result.tabsThemed.length > 0) {
    lines.push(`${result.tabsThemed.length} tab(s) auto-themed: ${result.tabsThemed.map((t) => `${t.tab}→${t.theme}`).join(", ")}`);
  }
  if (result.panesThemed.length > 0) {
    lines.push(`${result.panesThemed.length} pane(s) theme inherited from tab: ${result.panesThemed.map((p) => `${p.pane}→${p.theme}`).join(", ")}`);
  }
  if (result.panesRenamed.length > 0) {
    lines.push(`${result.panesRenamed.length} pane(s) renamed to themed pool: ${result.panesRenamed.map((p) => `${p.from}→${p.to} (${p.theme})`).join(", ")}`);
  }
  if (result.profilesApplied.length > 0) {
    lines.push(`${result.profilesApplied.length} pane profile(s) applied: ${result.profilesApplied.map((p) => `${p.pane}=${p.profile}`).join(", ")}`);
  }

  for (const agent of agents) {
    const status = agent.status_name ? ` [${agent.status_name}]` : "";
    const location = agent.pane ? `pane:${agent.pane}` : "detached";
    lines.push(`  ${agent.id} (${agent.display_name}) — ${location}${status}`);
  }

  return lines.join("\n");
}
