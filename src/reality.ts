/**
 * Reality layer — terminal/screen reality is the source of existence;
 * `crews.db` is annotation only.
 *
 * Generalizes the Wire `peerHasAgent` fix (a694850): a stale DB row must
 * never surface as live. Two reality sources are snapshotted together with
 * a short TTL:
 *   - `screen.listSessions()` — where AGENTS actually live.
 *   - `terminal.enumerateSessions()` — where PANES/TABS actually live.
 *
 * Reads are reality LEFT JOIN db ({@link RealityLayer.liveAgentRows}): a
 * local agent row is surfaced only if its screen session is live right now;
 * remote rows (another machine's reality) pass through unverified. The
 * destructive side — pruning the lingering DB row — is demoted to a lazy,
 * grace-gated healer ({@link RealityLayer.heal}) so the DB is a
 * safe-to-lose cache: a transient `screen -ls` blip hides a row from reads
 * for one snapshot window but only a sustained `graceMs` absence deletes it.
 */

import { listSessions, type ScreenSession } from "./screen.js";
import type { CrewStore, Agent } from "./store.js";
import type { TerminalBackend, TerminalSession } from "./terminal.js";

/** Screen sessions crew owns are named `wire-<agentId>`. */
const SCREEN_PREFIX = "wire-";

/**
 * Snapshot freshness window. Within this, every read shares one
 * `screen -ls` + one terminal enumeration — so a burst of agent_list polls
 * costs one probe, and agents can't flicker in/out between reads in the
 * same window.
 */
const DEFAULT_TTL_MS = 750;

/**
 * How long a local agent's screen must be CONTINUOUSLY absent before the
 * healer tombstones + deletes its DB row. Reads hide it immediately; this
 * grace only governs the irreversible delete, so a brief screen hiccup
 * self-heals instead of orphaning a resumable agent.
 */
const DEFAULT_GRACE_MS = 60_000;

/** A point-in-time view of what actually exists on this machine. */
export interface RealitySnapshot {
  /** Live local screen sessions, keyed by session name. */
  screens: Map<string, ScreenSession>;
  /** Live terminal sessions/surfaces, keyed by id. */
  terminals: Map<string, TerminalSession>;
  /** Capture time (ms, from the injected clock). */
  at: number;
}

/** Outcome of a {@link RealityLayer.heal} pass over the agent table. */
export interface HealResult {
  /** Local agent ids confirmed alive (screen present); pid refreshed. */
  alive: string[];
  /** Local agent ids newly observed missing (within grace — not yet deleted). */
  marked: string[];
  /** Local agent ids tombstoned + deleted after a sustained absence. */
  gcd: string[];
  /** Live `wire-` screens with no local agent row (orphans). */
  orphans: ScreenSession[];
}

/** Per-row classification of the agent table against a snapshot (pure). */
interface AgentClassification {
  /** Rows that are real right now — local-alive ++ remote passthrough. */
  live: Agent[];
  /** Local rows whose screen is present in the snapshot. */
  localAlive: Agent[];
  /** Local rows whose screen is absent from the snapshot. */
  localMissing: Agent[];
  /** Live `wire-` screens with no local agent row. */
  orphans: ScreenSession[];
}

export class RealityLayer {
  private cached: RealitySnapshot | null = null;
  private inflight: Promise<RealitySnapshot> | null = null;

  /**
   * First time each screen name was observed MISSING, keyed by screen name.
   * In-memory by design: a process restart resets the grace, so boot never
   * reaps on its first pass (adopt-don't-reap). Cleared the instant reality
   * confirms the screen again.
   */
  private missingSince = new Map<string, number>();

  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly screenLister: () => Promise<ScreenSession[]>;
  private readonly terminalEnumerator: () => Promise<TerminalSession[]>;

  constructor(
    terminal: TerminalBackend | undefined,
    opts: {
      ttlMs?: number;
      graceMs?: number;
      /** Injectable for tests; defaults to `screen.listSessions`. */
      screenLister?: () => Promise<ScreenSession[]>;
      /** Injectable for tests; defaults to `terminal.enumerateSessions`. */
      terminalEnumerator?: () => Promise<TerminalSession[]>;
      /** Injectable clock for TTL + grace; defaults to `Date.now`. */
      now?: () => number;
    } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    this.now = opts.now ?? (() => Date.now());
    this.screenLister = opts.screenLister ?? listSessions;
    // typeof guard: a backend (or partial test mock) without enumerateSessions
    // degrades to "no terminal reality" rather than throwing. Matches the
    // optional-method tolerance the orchestrator already applies to
    // logWorkspace / splitFromCallerForAgent.
    this.terminalEnumerator =
      opts.terminalEnumerator ??
      (typeof terminal?.enumerateSessions === "function"
        ? () => terminal.enumerateSessions()
        : async () => []);
  }

  /**
   * Return a snapshot of reality, refreshing only when the cached one is
   * older than the TTL. Concurrent callers during a cold refresh share one
   * in-flight probe (no `screen -ls` / osascript storm at boot). Both
   * sources are total — a failure reduces to an empty map for that source,
   * never a throw, so a degraded probe can't cascade into reaping.
   */
  async snapshot(force = false): Promise<RealitySnapshot> {
    const now = this.now();
    if (!force && this.cached && now - this.cached.at < this.ttlMs) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const [screens, terminals] = await Promise.all([
          this.screenLister().catch((e) => {
            console.error(`[crew] reality: screen list failed:`, e);
            return [] as ScreenSession[];
          }),
          this.terminalEnumerator().catch((e) => {
            console.error(`[crew] reality: terminal enumerate failed:`, e);
            return [] as TerminalSession[];
          }),
        ]);
        this.cached = {
          screens: new Map(screens.map((s) => [s.name, s])),
          terminals: new Map(terminals.map((t) => [t.id, t])),
          at: this.now(),
        };
        return this.cached;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Drop the cached snapshot so the next {@link snapshot} call re-probes. */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Classify agent rows against a snapshot. Pure — no DB writes, no grace
   * bookkeeping. Local rows are split by whether their screen is live;
   * remote rows (machine_name != localMachine) can't be verified here, so
   * they pass straight through to `live`.
   */
  private classify(
    rows: Agent[],
    localMachine: string,
    snap: RealitySnapshot,
  ): AgentClassification {
    const live: Agent[] = [];
    const localAlive: Agent[] = [];
    const localMissing: Agent[] = [];
    const knownLocalScreens = new Set<string>();

    for (const row of rows) {
      if (row.machine_name !== localMachine) {
        // Another machine's reality — not ours to confirm or reap. Pass
        // through (federation verifies it remotely in a later phase). This
        // is the same guard that keeps the reconciler from cascade-deleting
        // peer rows; here it keeps reads from dropping them.
        live.push(row);
        continue;
      }
      knownLocalScreens.add(row.screen_name);
      if (snap.screens.has(row.screen_name)) {
        localAlive.push(row);
        live.push(row);
      } else {
        localMissing.push(row);
      }
    }

    const orphans = [...snap.screens.values()].filter(
      (s) => s.name.startsWith(SCREEN_PREFIX) && !knownLocalScreens.has(s.name),
    );

    return { live, localAlive, localMissing, orphans };
  }

  /**
   * Reads = reality LEFT JOIN db. Returns the agent rows that are real
   * right now: every local row with a live screen, plus every remote row
   * (unverified). Stale local rows — including ones inside the delete grace
   * — are omitted. Pure: callers that also want pruning call {@link heal}.
   */
  async liveAgentRows(
    rows: Agent[],
    localMachine: string,
    snap?: RealitySnapshot,
  ): Promise<Agent[]> {
    const s = snap ?? (await this.snapshot());
    return this.classify(rows, localMachine, s).live;
  }

  /**
   * Metadata-healer: reconcile the agent table toward reality.
   *  - Confirmed-alive local rows: refresh `screen_pid`, bump `last_seen`,
   *    clear any missing-mark.
   *  - Absent local rows: mark on first sight; once continuously absent for
   *    `graceMs`, tombstone (so agent_resume still works) then delete.
   *  - Remote rows: untouched.
   *
   * Returns both the surviving live rows (so a read can avoid re-listing)
   * and a {@link HealResult} for reporting. Safe to call on every read —
   * the snapshot is cached and, in steady state (nothing dead), it performs
   * only a handful of idempotent `last_seen` bumps.
   */
  async heal(
    store: CrewStore,
    localMachine: string,
    snap?: RealitySnapshot,
  ): Promise<{ live: Agent[]; result: HealResult }> {
    const s = snap ?? (await this.snapshot());
    const rows = store.listAgents();
    const { live, localAlive, localMissing, orphans } = this.classify(rows, localMachine, s);
    const now = this.now();

    const alive: string[] = [];
    for (const row of localAlive) {
      this.missingSince.delete(row.screen_name);
      const session = s.screens.get(row.screen_name);
      if (session && session.pid !== row.screen_pid) {
        store.updateAgentPid(row.id, session.pid);
      } else {
        store.touchAgent(row.id);
      }
      alive.push(row.id);
    }

    const marked: string[] = [];
    const gcd: string[] = [];
    for (const row of localMissing) {
      const first = this.missingSince.get(row.screen_name);
      if (first === undefined) {
        this.missingSince.set(row.screen_name, now);
        marked.push(row.id);
      } else if (now - first >= this.graceMs) {
        // Sustained absence — prune the lingering cache row. Tombstone first
        // so a crashed agent can still be agent_resume'd (today's reconciler
        // deleted without a tombstone, losing the manifest).
        store.tombstoneAgent(row);
        store.deleteAgentByScreen(row.screen_name);
        this.missingSince.delete(row.screen_name);
        gcd.push(row.id);
      }
      // else: still within grace — leave the row, keep the mark.
    }

    return { live, result: { alive, marked, gcd, orphans } };
  }
}
