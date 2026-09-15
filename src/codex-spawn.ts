/**
 * Codex spawn-home teardown (AGI-74).
 *
 * A codex/bridge spawn provisions a PER-AGENT CODEX_HOME and persists its
 * thread id next to it:
 *
 *   <home>/.wire/codex-spawn/<agentId>/           <- CODEX_HOME (config.toml,
 *                                                   sessions, state_5.sqlite,
 *                                                   AND auth.json -> a SYMLINK
 *                                                   to the owner's live
 *                                                   ~/.codex/auth.json)
 *   <home>/.wire/codex-spawn/<agentId>.thread.json <- STATE_DIR thread pointer
 *
 * Nothing removed it. Every closed/stopped/reaped codex agent left ~48 MB and
 * a live-credential symlink behind, for agents that no longer exist (142 MB
 * under /Users/fondant, 128 MB under /Users/_ephemeral as of 2026-09-10).
 *
 * Where <home> comes from — all three spawn paths key off the RUNNING
 * process's $HOME, so the dir lands in the home of the uid the agent ran as:
 *   - wire-codex/src/index.ts:74-79  `home = process.env.HOME`, then
 *     `CODEX_HOME ?? join(home, ".wire/codex-spawn", agentId)` and
 *     `STATE_DIR ?? join(home, ".wire/codex-spawn")`, thread file
 *     `<STATE_DIR>/<agentId>.thread.json`.
 *   - ~/.wire/codex-launch.sh:118    `SPAWN_HOME="${HOME}/.wire/codex-spawn/${AGENT_ID}"`
 *     (and :123 `ln -sfn "${HOME}/.codex/auth.json" "${SPAWN_HOME}/auth.json"`).
 *   - run_as_uid spawns: screen.ts's `remoteScreen()` launches the session as
 *     `sudo -n -u <uid> env HOME=/Users/<uid> ... screen`, so $HOME inside the
 *     agent IS /Users/<uid>. crew-service agrees independently — its
 *     codex-subagents.ts:70 addresses the same tree as
 *     `/Users/${ownerUid}/.wire/codex-spawn/${agentId}/state_5.sqlite`.
 *
 * SCOPE RULE (deliberate, do not "improve" into a sweep): teardown only ever
 * touches the two paths DERIVED FROM THE ONE agent id being torn down. It
 * never lists, globs, or walks the parent directory, so anything else living
 * there — a persona's own long-lived codex home, a dir with no matching dead
 * agent — is retained by construction. Sweeping the parent is the separate,
 * opt-in job of codex-spawn-prune.sh, which needs the live-agent list that
 * this module deliberately does not have.
 */

import { lstat, rm, readdir, readlink, mkdir, writeFile, open as fsOpen } from "fs/promises";
import { createHash } from "crypto";
import { basename, dirname, isAbsolute, join } from "path";
import * as screen from "./screen.js";

/**
 * Path-safety guard for the id/uid segments that get interpolated into an
 * `rm -rf` target and a shell command. Deliberately its own predicate rather
 * than a reuse of orchestrator's AGENT_ID_RE: this one exists to keep `..`,
 * `/`, and quoting out of a destructive path, and must stay strict even if the
 * id contract is ever loosened. (Importing it would also make a module cycle.)
 */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Same guard for a uid, which on macOS may lead with `_` (`_ephemeral`). */
const SAFE_UID = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** Directory name that must be the parent of anything we delete. */
const SPAWN_PARENT = "codex-spawn";

/**
 * Runtimes whose launcher provisions a per-agent CODEX_HOME. `claude-code`
 * has no such directory, so teardown for it is a silent no-op (never an
 * error). Matches `codex`, `codex-bridge`, `wire-codex`, ...
 */
export function usesCodexSpawnHome(runtime: string): boolean {
  return /(^|[-_])codex([-_]|$)/i.test(runtime);
}

export type CodexSpawnPaths = {
  /** The per-agent CODEX_HOME directory. */
  codexHome: string;
  /** `<STATE_DIR>/<agentId>.thread.json`. */
  threadPath: string;
  /** Home the paths were resolved against. */
  home: string;
};

/**
 * Resolve the two paths a teardown may remove, or null when there is nothing
 * to remove (non-codex runtime) or the inputs fail a safety guard.
 *
 * `env` is the spawn manifest's env: an explicit CODEX_HOME / STATE_DIR in it
 * wins, exactly as it does in wire-codex (index.ts:74-79). A caller-supplied
 * CODEX_HOME still has to look like a spawn home (`.../codex-spawn/<agentId>`)
 * or it is refused — we will not `rm -rf` an arbitrary manifest string.
 */
export function resolveCodexSpawnPaths(args: {
  agentId: string;
  runtime: string;
  /** Manifest run_as_uid (or the resolved remote target's uid). */
  runAsUid?: string;
  env?: Record<string, string>;
  /** This process's home; defaults to $HOME. Only used for same-uid agents. */
  selfHome?: string;
}): CodexSpawnPaths | null {
  if (!usesCodexSpawnHome(args.runtime)) return null;
  if (!SAFE_SEGMENT.test(args.agentId)) return null;
  if (args.runAsUid !== undefined && !SAFE_UID.test(args.runAsUid)) return null;

  const home = args.runAsUid
    ? `/Users/${args.runAsUid}`
    : args.selfHome ?? process.env.HOME ?? "/tmp";
  const spawnRoot = join(home, ".wire", SPAWN_PARENT);
  const codexHome = args.env?.CODEX_HOME || join(spawnRoot, args.agentId);
  const stateDir = args.env?.STATE_DIR || spawnRoot;
  const threadPath = join(stateDir, `${args.agentId}.thread.json`);

  // Both targets must be an absolute path named for THIS agent, directly
  // inside a `codex-spawn` directory. Anything else is a manifest we do not
  // trust with a recursive delete.
  if (!isAbsolute(codexHome) || basename(codexHome) !== args.agentId) return null;
  if (basename(dirname(codexHome)) !== SPAWN_PARENT) return null;
  if (!isAbsolute(threadPath) || basename(dirname(threadPath)) !== SPAWN_PARENT) return null;

  return { codexHome, threadPath, home };
}


// ---------------------------------------------------------------------------
// PRESERVING TEARDOWN (spec docs/stop-preservation-spec-20260915.md rev4)
//
// Routine parking removes RUNTIME SCAFFOLDING ONLY. Everything else — user work,
// conversation state, SQLite databases with their -wal/-shm, and any entry this
// code does not positively recognise — is RETAINED IN PLACE.
//
// The whole-home `rm -rf` this replaces destroyed an unpushed clone and 19.5 MB
// of thread history on 2026-09-15 while its caller's stop request carried the
// words "Preserve clone/session" in a field nothing executed.
// ---------------------------------------------------------------------------

/** Exact basenames that gen-codex-home.sh regenerates on every spawn. */
export const DISPOSABLE_BASENAMES = new Set([
  "config.toml", "models_cache.json", "installation_id",
  ".personality_migration", ".sandbox_migration",
]);
/** The only directories classification is allowed to descend into. */
export const LOCK_DIRS = ["app-server-control", "mcp-oauth-locks", "thread-writer-locks"];

export type SpawnEntry = {
  path: string;
  /** "disposable" only by structural identity or an exact .lock in a lock dir. */
  disposition: "disposable" | "retained";
  reason: string;
  kind: "symlink" | "socket" | "file" | "dir" | "other";
  size: number;
  mode: number;
};

/**
 * Decide each entry AT THE SPAWN-HOME ROOT and inside the three named lock
 * directories. Never follows a symlink. Never descends anywhere else, so nested
 * Git content is not inspected and cannot be mutated.
 */
export async function classifySpawnHome(codexHome: string, home: string): Promise<SpawnEntry[]> {
  const out: SpawnEntry[] = [];
  let names: string[];
  try { names = await readdir(codexHome); } catch { return out; }
  const authTarget = join(home, ".codex", "auth.json");

  for (const name of names.sort()) {
    const path = join(codexHome, name);
    let st;
    try { st = await lstat(path); } catch { continue; }
    const kind: SpawnEntry["kind"] =
      st.isSymbolicLink() ? "symlink" : st.isSocket() ? "socket"
      : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
    const base = { path, kind, size: st.size, mode: st.mode & 0o7777 };

    if (kind === "symlink") {
      let target = "";
      try { target = await readlink(path); } catch { /* dangling: still a link */ }
      if (name === "auth.json" && target === authTarget) {
        out.push({ ...base, disposition: "disposable", reason: "credential symlink (unlink only, never dereferenced)" });
      } else {
        out.push({ ...base, disposition: "retained", reason: "unrecognised symlink" });
      }
      continue;
    }
    if (kind === "socket") {
      out.push({ ...base, disposition: "disposable", reason: "socket" });
      continue;
    }
    if (kind === "file" && DISPOSABLE_BASENAMES.has(name)) {
      out.push({ ...base, disposition: "disposable", reason: "regenerated by gen-codex-home" });
      continue;
    }
    if (kind === "dir" && LOCK_DIRS.includes(name)) {
      let inner: string[] = [];
      try { inner = await readdir(path); } catch { /* unreadable: retain */ }
      let allLocks = inner.length > 0;
      for (const ln of inner.sort()) {
        const lp = join(path, ln);
        let lst;
        try { lst = await lstat(lp); } catch { allLocks = false; continue; }
        if (lst.isFile() && ln.endsWith(".lock")) {
          out.push({ path: lp, kind: "file", size: lst.size, mode: lst.mode & 0o7777,
                     disposition: "disposable", reason: ".lock in a named lock directory" });
        } else {
          allLocks = false;
          out.push({ path: lp, kind: lst.isDirectory() ? "dir" : "other", size: lst.size,
                     mode: lst.mode & 0o7777, disposition: "retained", reason: "not a .lock file" });
        }
      }
      // The directory itself goes only if every entry in it was disposable.
      out.push({ ...base, disposition: allLocks ? "disposable" : "retained",
                 reason: allLocks ? "lock directory, empty after its locks" : "lock directory holding retained content" });
      continue;
    }
    // ⛔ EVERYTHING ELSE IS RETAINED, at any depth, including cache/ and tmp/
    // in their entirety. Unrecognised names from a future Codex release fail SAFE.
    out.push({ ...base, disposition: "retained", reason: "not positively identified as disposable" });
  }
  return out;
}

export type StopReceipt = {
  agent: string; caller?: string; state: "in-progress" | "complete" | "finalize-failed";
  at: string; codexHome: string;
  disposable: string[]; retained: string[];
  removed?: string[]; failed?: Array<{ path: string; error: string }>;
  /** sha256 over ROOT-LEVEL METADATA ONLY — never a recursive content hash. */
  manifest_sha256?: string;
  manifest_scope: "root-metadata";
};

export function manifestDigest(entries: SpawnEntry[]): string {
  const h = createHash("sha256");
  for (const e of entries.filter((x) => x.disposition === "retained").sort((a, b) => a.path < b.path ? -1 : 1)) {
    h.update(`${e.path}\0${e.kind}\0${e.size}\0${e.mode}\n`);
  }
  return h.digest("hex");
}

/**
 * Write a receipt and FSYNC IT. Durability is the whole point: the INTENT record
 * is a precondition for removal, so "written" must mean "survives a kill".
 */
export async function writeReceipt(stateDir: string, agentId: string, stamp: string, r: StopReceipt): Promise<string> {
  const dir = join(stateDir, ".stopped");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${agentId}.${stamp}.json`);
  const fh = await fsOpen(path, "w");
  try {
    await fh.writeFile(JSON.stringify(r, null, 1));
    await fh.sync();
  } finally {
    await fh.close();
  }
  return path;
}


/**
 * The remote (cross-uid) executor cannot import this module, so the rules are
 * COMPILED FROM THE SAME CONSTANTS into a /bin/sh program. One source of truth;
 * an equivalence test runs this generated script against the same fixture as the
 * TypeScript classifier and asserts identical outcomes.
 */
export function buildRemoteTeardownScript(): string {
  const bases = [...DISPOSABLE_BASENAMES].map((b) => `'${b}'`).join(" ");
  const locks = LOCK_DIRS.map((d) => `'${d}'`).join(" ");
  return [
    'set -u',
    'H="$CODEX_HOME"; A="$AUTH_TARGET"; R="$RECEIPT"',
    `BASES="${bases.replace(/'/g, "")}"; LOCKS="${locks.replace(/'/g, "")}"`,
    'DISP=""; RET=""',
    'for p in "$H"/* "$H"/.*; do',
    '  n=$(basename "$p"); [ "$n" = "." ] || [ "$n" = ".." ] && continue',
    '  [ -e "$p" ] || [ -L "$p" ] || continue',
    '  d=0',
    '  if [ -L "$p" ]; then',
    '    t=$(readlink "$p"); [ "$n" = "auth.json" ] && [ "$t" = "$A" ] && d=1',
    '  elif [ -S "$p" ]; then d=1',
    '  elif [ -f "$p" ]; then for b in $BASES; do [ "$n" = "$b" ] && d=1; done',
    '  elif [ -d "$p" ]; then',
    '    for l in $LOCKS; do',
    '      [ "$n" = "$l" ] || continue',
    '      all=1; any=0',
    '      for q in "$p"/* "$p"/.*; do',
    '        m=$(basename "$q"); [ "$m" = "." ] || [ "$m" = ".." ] && continue',
    '        [ -e "$q" ] || continue; any=1',
    '        case "$m" in *.lock) [ -f "$q" ] && DISP="$DISP\n$q" || all=0;; *) all=0; RET="$RET\n$q";; esac',
    '      done',
    '      [ "$any" = 1 ] && [ "$all" = 1 ] && d=1',
    '    done',
    '  fi',
    '  [ "$d" = 1 ] && DISP="$DISP\n$p" || RET="$RET\n$p"',
    'done',
    // INTENT first, fsync'd, and NO removal if it cannot be written.
    'mkdir -p "$(dirname "$R")" || { echo "CREW_INTENT_FAILED"; exit 9; }',
    '{ echo "{\"state\":\"in-progress\",\"disposable\":[" ; echo "$DISP" | sed "/^$/d;s/.*/\"&\",/" ; echo "\"\"]}" ; } > "$R" || { echo "CREW_INTENT_FAILED"; exit 9; }',
    'sync',
    '[ -s "$R" ] || { echo "CREW_INTENT_FAILED"; exit 9; }',
    'echo "$DISP" | sed "/^$/d" | while IFS= read -r p; do echo "DISPOSE $p"; done',
    'echo "$RET" | sed "/^$/d" | while IFS= read -r p; do echo "RETAIN $p"; done',
    'echo "$DISP" | sed "/^$/d" | sort -r | while IFS= read -r p; do rm -rf -- "$p" 2>/dev/null; [ -e "$p" ] || [ -L "$p" ] && echo "REMAIN $p" || echo "REMOVED $p"; done',
    'echo CREW_TEARDOWN_DONE',
  ].join("\n");
}

export type CodexSpawnTeardownResult = {
  /** Paths that existed and are now gone. */
  removed: string[];
  /** Paths that were already absent (normal — a resumed/never-started agent). */
  absent: string[];
  /** Paths still present after the attempt, with the reason. */
  failed: Array<{ path: string; error: string }>;
  /** Set when nothing was attempted (non-codex runtime / guard tripped). */
  skipped?: string;
};

export type CodexSpawnTeardownDeps = {
  /** Cross-uid / cross-machine executor. Defaults to screen.sshRun. */
  sshRun?: (t: screen.RemoteTarget, command: string) => Promise<string>;
  /** Log sink. Defaults to console.error (crew's log channel). */
  log?: (msg: string) => void;
};

/**
 * Remove ONE agent's codex spawn home + thread file. Never throws, never
 * blocks the caller's teardown: every failure is logged loudly WITH THE PATH
 * so an operator can finish the job by hand, and returned for the caller.
 */
export async function removeCodexSpawnHome(
  args: {
    agentId: string;
    runtime: string;
    runAsUid?: string;
    env?: Record<string, string>;
    selfHome?: string;
    /** Present when the agent's screen lives under another uid/host. */
    target?: screen.RemoteTarget;
  },
  deps: CodexSpawnTeardownDeps = {},
): Promise<CodexSpawnTeardownResult> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const paths = resolveCodexSpawnPaths(args);
  if (!paths) {
    if (usesCodexSpawnHome(args.runtime) && SAFE_SEGMENT.test(args.agentId)) {
      // A codex agent we refused to resolve is worth a loud line: it means a
      // manifest CODEX_HOME/run_as_uid we would not delete blind.
      log(
        `[crew] codex-spawn teardown SKIPPED for '${args.agentId}': unsafe or ` +
          `unrecognised CODEX_HOME in manifest (env.CODEX_HOME=${args.env?.CODEX_HOME ?? "unset"}, ` +
          `run_as_uid=${args.runAsUid ?? "unset"}) — remove it by hand if it exists.`,
      );
      return { removed: [], absent: [], failed: [], skipped: "unsafe-path" };
    }
    return { removed: [], absent: [], failed: [], skipped: "not-a-codex-runtime" };
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z");
  const stateDir = args.env?.STATE_DIR || dirname(paths.codexHome);
  const result: CodexSpawnTeardownResult = { removed: [], absent: [], failed: [] };

  if (args.target) {
    await teardownRemote(args.target, paths, stateDir, args.agentId, stamp, result, deps);
  } else {
    await teardownLocal(paths, stateDir, args.agentId, stamp, result, deps);
  }

  for (const f of result.failed) {
    log(
      `[crew] codex-spawn teardown FAILED for '${args.agentId}': ${f.path} still present — ${f.error}. ` +
        `Remove it by hand if it is scaffolding; retained content is left in place by design.`,
    );
  }
  return result;
}

async function teardownLocal(
  paths: CodexSpawnPaths, stateDir: string, agentId: string, stamp: string,
  result: CodexSpawnTeardownResult, deps: CodexSpawnTeardownDeps,
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.error(m));
  const entries = await classifySpawnHome(paths.codexHome, paths.home);
  const disposable = entries.filter((e) => e.disposition === "disposable");
  const retained = entries.filter((e) => e.disposition === "retained");

  // ⛔ INTENT IS A PRECONDITION. If it cannot be made durable, NOTHING is removed —
  // enforceable precisely because nothing has been destroyed yet.
  const receipt: StopReceipt = {
    agent: agentId, state: "in-progress", at: new Date().toISOString(),
    codexHome: paths.codexHome, manifest_scope: "root-metadata",
    disposable: disposable.map((e) => e.path), retained: retained.map((e) => e.path),
  };
  try {
    await writeReceipt(stateDir, agentId, stamp, receipt);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log(`[crew] codex-spawn: INTENT receipt undurable for '${agentId}' (${error}) — NOTHING REMOVED.`);
    result.skipped = "intent-undurable";
    return;
  }

  // Deepest-first so a lock directory is empty before it is considered.
  for (const e of [...disposable].sort((a, b) => b.path.length - a.path.length)) {
    try {
      await rm(e.path, { recursive: true, force: true });
    } catch (err) {
      result.failed.push({ path: e.path, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (await exists(e.path)) result.failed.push({ path: e.path, error: "still present after rm" });
    else result.removed.push(e.path);
  }

  const final: StopReceipt = {
    ...receipt, state: "complete", removed: result.removed, failed: result.failed,
    manifest_sha256: manifestDigest(entries),
  };
  try {
    await writeReceipt(stateDir, agentId, stamp, final);
  } catch (e) {
    log(`[crew] codex-spawn: FINALIZE receipt failed for '${agentId}' — removal ALREADY RAN; ` +
        `removed=${result.removed.length} retained=${retained.length}. Not reported as success.`);
    result.failed.push({ path: `${stateDir}/.stopped/${agentId}.${stamp}.json`, error: "finalize-failed" });
  }
  log(`[crew] codex-spawn: retained ${retained.length} entr(ies) incl. conversation state; ` +
      `removed ${result.removed.length} scaffolding entr(ies) for agent '${agentId}'`);
}

async function teardownRemote(
  target: screen.RemoteTarget, paths: CodexSpawnPaths, stateDir: string, agentId: string,
  stamp: string, result: CodexSpawnTeardownResult, deps: CodexSpawnTeardownDeps,
): Promise<void> {
  const run = deps.sshRun ?? screen.sshRun;
  const script = buildRemoteTeardownScript();
  const receipt = join(stateDir, ".stopped", `${agentId}.${stamp}.json`);
  const command =
    `sudo -n -u ${target.runAsUid} env CODEX_HOME='${paths.codexHome}' ` +
    `AUTH_TARGET='${join(paths.home, ".codex", "auth.json")}' RECEIPT='${receipt}' ` +
    `/bin/sh -c '${script.replace(/'/g, "'\\''")}'`;
  let out: string;
  try {
    out = await run(target, command);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    result.failed.push({ path: paths.codexHome, error });
    return;
  }
  if (out.includes("CREW_INTENT_FAILED")) {
    result.skipped = "intent-undurable";
    return;
  }
  if (!out.includes("CREW_TEARDOWN_DONE")) {
    result.failed.push({ path: paths.codexHome, error: `remote teardown did not complete: ${out.trim() || "(no output)"}` });
    return;
  }
  const pick = (tag: string) =>
    out.split("\n").filter((l) => l.startsWith(tag + " ")).map((l) => l.slice(tag.length + 1).trim());
  result.removed.push(...pick("REMOVED"));
  for (const p of pick("REMAIN")) result.failed.push({ path: p, error: "still present after remote rm" });
}

async function removeLocal(targets: string[], result: CodexSpawnTeardownResult): Promise<void> {
  for (const path of targets) {
    const existed = await exists(path);
    try {
      await rm(path, { recursive: true, force: true });
    } catch (e) {
      result.failed.push({ path, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (await exists(path)) {
      result.failed.push({ path, error: "still present after rm" });
    } else if (existed) {
      result.removed.push(path);
    } else {
      result.absent.push(path);
    }
  }
}

/**
 * Cross-uid / cross-machine removal. Runs the whole rm-and-verify under
 * `sudo -n -u <uid>` — the same grant the spawn itself rides (screen.ts's
 * remoteScreen) — because the service user typically cannot even stat inside
 * /Users/<uid>, and a permission-denied `[ -e ]` would otherwise read as
 * "successfully gone".
 */
async function removeRemote(
  target: screen.RemoteTarget,
  targets: string[],
  result: CodexSpawnTeardownResult,
  deps: CodexSpawnTeardownDeps,
): Promise<void> {
  const run = deps.sshRun ?? screen.sshRun;
  const [codexHome, threadPath] = targets as [string, string];
  const script =
    'for p in "$P1" "$P2"; do [ -e "$p" ] && echo "PRE $p"; done; ' +
    'rm -rf -- "$P1" "$P2"; ' +
    'for p in "$P1" "$P2"; do [ -e "$p" ] && echo "REMAIN $p"; done; ' +
    "echo CREW_TEARDOWN_DONE";
  const command =
    `sudo -n -u ${target.runAsUid} env P1='${codexHome}' P2='${threadPath}' ` +
    `/bin/sh -c '${script}'`;

  let out: string;
  try {
    out = await run(target, command);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    for (const path of targets) result.failed.push({ path, error });
    return;
  }
  if (!out.includes("CREW_TEARDOWN_DONE")) {
    for (const path of targets) {
      result.failed.push({ path, error: `remote teardown did not complete: ${out.trim() || "(no output)"}` });
    }
    return;
  }
  const pre = new Set(
    out.split("\n").filter((l) => l.startsWith("PRE ")).map((l) => l.slice(4).trim()),
  );
  const remain = new Set(
    out.split("\n").filter((l) => l.startsWith("REMAIN ")).map((l) => l.slice(7).trim()),
  );
  for (const path of targets) {
    if (remain.has(path)) result.failed.push({ path, error: "still present after remote rm" });
    else if (pre.has(path)) result.removed.push(path);
    else result.absent.push(path);
  }
}

/** lstat, not stat: a dangling auth.json symlink still exists for removal. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
