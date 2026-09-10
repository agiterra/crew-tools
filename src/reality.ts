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

import { realpathSync } from "fs";
import { userInfo } from "os";
import { join } from "path";
import { listSessions, type ScreenSession } from "./screen.js";
import type { CrewStore, Agent } from "./store.js";
import type { TerminalBackend, TerminalSession } from "./terminal.js";

/** Screen sessions crew owns are named `wire-<agentId>`. */
const SCREEN_PREFIX = "wire-";

/** run_as_uid from a spawn manifest JSON, or undefined (absent/unparseable). */
function manifestRunAsUid(spawnManifest: string | null | undefined): string | undefined {
  if (!spawnManifest) return undefined;
  try {
    const uid = (JSON.parse(spawnManifest) as { run_as_uid?: string }).run_as_uid;
    return uid || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether this process's plain `screen -ls` can prove death for a row's
 * run_as_uid. An absent run_as_uid is the legacy same-UID path.
 *
 * AGI-82: the old test compared run_as_uid to `String(process.getuid())` only,
 * so a row stamped with a USERNAME — which is what every agiterra spawn writes
 * ("run_as_uid":"_ephemeral") — could never match, even in a process running as
 * that very user. `!verifiable` fails open, so the branch fired for essentially
 * every row on the box and the reality-join filtered NOTHING: 23/23 rows of the
 * shared store surfaced from agent_list, 14 of them with no screen and no live
 * pid (measured 2026-09-10, /Users/_ephemeral/work/arrufada/evidence).
 *
 * The original caution was right about its cause and wrong about its remedy.
 * `process.env.USER` genuinely can lie under sudo — but `os.userInfo()` does
 * not: it is derived from getuid(), so it names the uid we are ACTUALLY running
 * as. Matching either the numeric uid or that kernel-truth username is sound.
 *
 * The second half of the caution still binds: being the right user is not
 * enough if we are probing the wrong screen namespace. `screen -ls` reads
 * $SCREENDIR (else $HOME/.screen), and a sudo spawn can leave those pointing at
 * another user's home. So we additionally require the namespace we would probe
 * to live under OUR home. Anything we cannot place stays unverifiable and keeps
 * failing open — crew-service's multi-UID lister owns those rows' liveness.
 */
function screenNamespaceVerifiableHere(runAsUid: string | undefined): boolean {
  if (!runAsUid) return true;
  const getuid = process.getuid;
  if (typeof getuid !== "function") return false;
  if (runAsUid === String(getuid.call(process))) return probesOwnScreenNamespace();

  let self: ReturnType<typeof userInfo>;
  try {
    self = userInfo();
  } catch {
    // No passwd entry for this uid — cannot place ourselves; fail open.
    return false;
  }
  if (runAsUid !== self.username) return false;
  return probesOwnScreenNamespace();
}

/**
 * True when the screen socket directory `screen -ls` will consult belongs to
 * the uid we are running as. Guards the sudo case the AGI-27 comment warned
 * about: right user, wrong SCREENDIR ⇒ absence still proves nothing.
 */
function probesOwnScreenNamespace(): boolean {
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    return false;
  }
  if (!home) return false;
  const screenDir = process.env.SCREENDIR ?? join(home, ".screen");
  const owned = join(home, ".screen");
  if (screenDir === owned) return true;
  try {
    return realpathSync(screenDir) === realpathSync(owned);
  } catch {
    return false;
  }
}

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
  /** True only when the screen probe succeeded; false means absence proves nothing. */
  screenProbeOk: boolean;
  /** Live terminal sessions/surfaces, keyed by id. */
  terminals: Map<string, TerminalSession>;
  /** Capture time (ms, from the injected clock). */
  at: number;
}

/** Outcome of a {@link RealityLayer.heal} pass over the agent table. */
/**
 * Scoping for {@link RealityLayer.heal}. Omitted ⇒ heal every row (the
 * crew-service / operator path). Supplied ⇒ only rows the predicate accepts
 * are written; the rest are reported in {@link HealResult.skipped}.
 */
export interface HealOpts {
  canWrite?: (row: Agent) => boolean;
}

export interface HealResult {
  /** Local agent ids confirmed alive (screen present); pid refreshed. */
  alive: string[];
  /** Local agent ids newly observed missing (within grace — not yet deleted). */
  marked: string[];
  /** Local agent ids tombstoned + deleted after a sustained absence. */
  gcd: string[];
  /** Live `wire-` screens with no local agent row (orphans). */
  orphans: ScreenSession[];
  /**
   * Local agent ids the caller was NOT authorized to write (AGI-27). They are
   * still classified and still returned in `live` — the heal simply declines
   * to touch them, so a denial is visible/attributable rather than silent.
   */
  skipped: string[];
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
        const [screenProbe, terminals] = await Promise.all([
          this.screenLister().then(
            (screens) => ({ screens, ok: true }),
            (e) => {
            console.error(`[crew] reality: screen list failed:`, e);
              return { screens: [] as ScreenSession[], ok: false };
            },
          ),
          this.terminalEnumerator().catch((e) => {
            console.error(`[crew] reality: terminal enumerate failed:`, e);
            return [] as TerminalSession[];
          }),
        ]);
        this.cached = {
          screens: new Map(screenProbe.screens.map((s) => [s.name, s])),
          screenProbeOk: screenProbe.ok,
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
      if (!snap.screenProbeOk) {
        // Probe failure is ambiguous evidence, not death. Keep every row
        // readable and do not feed anything into the destructive heal path.
        live.push(row);
        continue;
      }
      if (row.machine_name !== localMachine) {
        // Another machine's reality — not ours to confirm or reap. Pass
        // through (federation verifies it remotely in a later phase). This
        // is the same guard that keeps the reconciler from cascade-deleting
        // peer rows; here it keeps reads from dropping them.
        live.push(row);
        continue;
      }
      // Another UID's reality — same verifiability principle. A screen under
      // e.g. `_ephemeral` (crew-service local-sudo spawn, manifest
      // run_as_uid) is INVISIBLE to this process's same-UID `screen -ls`, so
      // "missing from the snapshot" proves nothing. Reaping here would
      // false-delete live agents from the machine-shared crews.db (the
      // multi-writer skew class). crew-service's multi-UID lister owns their
      // liveness; we pass them through.
      const rowUid = manifestRunAsUid(row.spawn_manifest);
      if (!screenNamespaceVerifiableHere(rowUid)) {
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
    opts?: HealOpts,
  ): Promise<{ live: Agent[]; result: HealResult }> {
    const s = snap ?? (await this.snapshot());
    const rows = store.listAgents();
    const { live, localAlive, localMissing, orphans } = this.classify(rows, localMachine, s);
    const now = this.now();
    const skipped: string[] = [];

    // AGI-27: a heal is a WRITE over arbitrary rows. Two gates decide whether
    // this process may perform it at all:
    //   - a readonly store (every non-crew-service consumer since the interim)
    //     must degrade to a pure read instead of throwing SQLITE_READONLY,
    //   - a per-row `canWrite` predicate scopes the heal to the rows the
    //     calling identity actually owns (self / spawned descendants / ED).
    const canWrite = (row: Agent): boolean => {
      if (store.readonly) return false;
      if (opts?.canWrite && !opts.canWrite(row)) {
        skipped.push(row.id);
        return false;
      }
      return true;
    };

    const alive: string[] = [];
    for (const row of localAlive) {
      this.missingSince.delete(row.screen_name);
      if (!canWrite(row)) continue;
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
      if (!canWrite(row)) continue;
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

    return { live, result: { alive, marked, gcd, orphans, skipped } };
  }
}
