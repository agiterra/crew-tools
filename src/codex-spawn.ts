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

import { lstat, rm, readdir, readlink, mkdir, rename, open as fsOpen } from "fs/promises";
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
 * Any character that could break out of single-quoted shell interpolation, plus control chars.
 *
 * ⚠️ N11 DISPOSITION (re-review): this is applied in resolveCodexSpawnPaths, so it refuses a
 * path for the LOCAL teardown too, where no shell is involved and the characters are harmless.
 * The reviewer is right that the hazard lives at the shell boundary and the check is therefore
 * broader than the risk. KEPT AS IS, deliberately:
 *   · the two paths must agree on what they will act on — a path the remote side refuses and
 *     the local side accepts is a divergence between implementations, which is finding C1's
 *     whole shape, and I am not introducing one to narrow a guard;
 *   · the failure is LOUD and fail-safe: resolveCodexSpawnPaths returns null, the caller logs
 *     "unsafe or unrecognised CODEX_HOME … remove it by hand if it exists" and sets
 *     skipped:"unsafe-path". Nothing is removed and nothing is claimed.
 * The cost is real and stated rather than hidden: a lane whose HOME legitimately contains one
 * of these characters is never torn down automatically and accumulates. If that ever occurs in
 * practice, the fix is to scope the check to the shell interpolation site AND prove both
 * implementations still agree — not to relax it here.
 */
const SHELL_UNSAFE = /['"`$\\;&|<>(){}\n\r\t*?!#~\[\]]|[\x00-\x1f]/;

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
  // ⛔ S1 (PR 91 review). These paths are interpolated into a `sudo -n -u <uid> env VAR='<path>'`
  // command line on the remote path. The guards below check SHAPE; they say nothing about
  // CONTENT, so a single quote in a manifest CODEX_HOME escapes the assignment and executes
  // arbitrary commands as the ssh user. Reject anything that could leave the quotes.
  if (SHELL_UNSAFE.test(codexHome) || SHELL_UNSAFE.test(stateDir) || SHELL_UNSAFE.test(threadPath)) return null;
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

/** Thrown when the spawn home exists but cannot be read — never confused with "already gone". */
/**
 * ⛔ N31/N32 (delta review at 6bb1c60). `skipped` carried FREE TEXT — it was built as
 * `home-unreadable:entry:<filename>:<code>`, and a filename is attacker-shaped data:
 *   a `:` in a name   -> positional parsing breaks (6 fields, [1]==="entry"); `:` is legal
 *                        in a POSIX filename on macOS, so this is reachable, not theoretical
 *   a NEWLINE in a name -> `skipped` spans lines and breaks ANY line-oriented log or event
 *                        record. Reproduced.
 *   the String(e) fallback could inject arbitrary text the same way.
 * And N32: the same condition produced DIFFERENT strings on the two paths — local
 * `home-unreadable:entry:config.toml:EACCES` vs remote `home-unreadable:EACCES`, because the
 * remote has no per-entry classifier and can never emit an `entry:*` code. The field I added
 * to make conditions DISTINGUISHABLE reported two values for one condition, defeating its own
 * purpose (N29).
 * ⇒ `code` is now a CLOSED VOCABULARY. The offending entry name is still reported — in the LOG
 *   line, which is free text by nature and read by humans — never in a parsed string.
 */
export const UNREADABLE_CODES = ["EACCES", "ENOTDIR", "ESYMLINK", "ELOOP", "EPERM", "EIO", "UNKNOWN"] as const;
export type UnreadableCode = (typeof UNREADABLE_CODES)[number];

/** Anything outside the closed set becomes UNKNOWN. No caller ever sees free text. */
export function normalizeUnreadableCode(raw: string | undefined): UnreadableCode {
  return (UNREADABLE_CODES as readonly string[]).includes(raw ?? "")
    ? (raw as UnreadableCode)
    : "UNKNOWN";
}

export class SpawnHomeUnreadable extends Error {
  readonly code: UnreadableCode;
  constructor(
    public readonly path: string,
    rawCode: string | undefined,
    /** The entry that could not be read, when the failure was per-entry. Log-only. */
    public readonly entry?: string,
  ) {
    const code = normalizeUnreadableCode(rawCode);
    super(`spawn home unreadable at ${path}: ${code}${entry ? ` (entry: ${entry})` : ""}`);
    this.code = code;
    this.name = "SpawnHomeUnreadable";
  }
}

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
  // ⛔ C2 (PR 91 review). This swallowed EVERY readdir error and returned an empty list, so a
  // cross-uid teardown that got EACCES wrote a receipt saying "complete, nothing here" —
  // a permission failure recorded as a clean stop, inside the audit record built to be truthful.
  // ENOENT genuinely means "already gone"; anything else means "I could not look".
  // ⛔ THE WHOLE AXIS, ENUMERATED (found by me at 4348a46; see the repro in the incident dir).
  // readdir() alone conflated states that must not be conflated: on a DANGLING SYMLINK it
  // returns ENOENT, and the C2 code read ENOENT as "already gone" — so a home that exists as a
  // link but does not resolve produced a clean `complete` receipt asserting "retained 0 entries
  // including conversation state" about contents nobody had read. A dangling symlink is NOT
  // "already gone": something is there, it just does not resolve.
  // This class has now cost one defect per case we failed to list (ENOENT, ENOTDIR, EACCES,
  // dangling link), so the cases are enumerated here rather than discovered one at a time:
  //   truly absent        -> "already gone", the ONLY clean outcome
  //   symlink (any)       -> refuse. A spawn home is a real directory; we never recurse through
  //                          a link, and `[ -d ]` on the remote side FOLLOWS links, so accepting
  //                          one here would put the two implementations back out of step.
  //   not a directory     -> refuse (ENOTDIR)
  //   unreadable          -> refuse (EACCES et al)
  let st;
  try {
    st = await lstat(codexHome);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return out;                       // truly absent
    throw new SpawnHomeUnreadable(codexHome, code);
  }
  if (st.isSymbolicLink()) throw new SpawnHomeUnreadable(codexHome, "ESYMLINK");
  if (!st.isDirectory()) throw new SpawnHomeUnreadable(codexHome, "ENOTDIR");

  let names: string[];
  try {
    names = await readdir(codexHome);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return out;                       // raced away between lstat and readdir
    throw new SpawnHomeUnreadable(codexHome, code);
  }
  const authTarget = join(home, ".codex", "auth.json");

  for (const name of names.sort()) {
    const path = join(codexHome, name);
    let st;
    try {
      st = await lstat(path);
    } catch (e) {
      // ⛔ N27 (review, the FAIL at e057eba). `catch { continue; }` swallowed EVERY per-entry
      // failure. On a home that is READABLE BUT NOT SEARCHABLE (0400) the shape guards above all
      // pass — it IS a directory — and readdir succeeds, because listing names needs only `r`.
      // Resolving a name INSIDE the directory needs `x`, so every per-entry lstat returned
      // EACCES, every entry was skipped, and `out` came back EMPTY — indistinguishable from an
      // empty home. The result: a state:"complete" receipt and the log line "retained 0
      // entr(ies) incl. conversation state" while thread_history_1.sqlite sat inside, unread.
      // THE AXIS ABOVE ENUMERATES WHAT THE HOME *IS*. IT NEVER ASKED WHETHER ITS ENTRIES CAN BE
      // READ. That is the same receipt shape and the same sentence that forced the 4348a46
      // withdrawal, reached through a different door.
      // ENOENT alone is benign here: an entry that vanished between readdir and lstat is a race
      // whose loser we are content to ignore. Anything else means we could not look.
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") continue;
      throw new SpawnHomeUnreadable(codexHome, code, name);
    }
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
      // ⛔ N33 (review). This read `catch { /* unreadable: retain */ }`, and the retention was
      // real but INCIDENTAL: readdir failed -> inner stayed [] -> `inner.length > 0` was false
      // -> retained. Safe because a counter stayed at its seed, not because any rule said
      // refuse. An ordinary `let allLocks = true;` refactor flipped the classification to
      // DISPOSABLE — measured — and the contents then survived only because rm -rf could not
      // recurse into a 0000 directory. THE FILESYSTEM REFUSED, NOT THE CODE, and no test in
      // this suite would have noticed. The root loop learned this at N27; one level down, in
      // the same function, it had not.
      let inner: string[] = [];
      try {
        inner = await readdir(path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        // ENOENT: the lock dir vanished between the root readdir and now — a benign race.
        if (code !== "ENOENT") throw new SpawnHomeUnreadable(codexHome, code, name);
      }
      // Reaching here means the directory WAS readable, so this now means exactly what it says:
      // a lock directory with no entries has no locks to have been cleaned, and is not disposable.
      let allLocks = inner.length > 0;
      for (const ln of inner.sort()) {
        const lp = join(path, ln);
        let lst;
        try {
          lst = await lstat(lp);
        } catch (e) {
          // Same rule as the root loop and the readdir above: only ENOENT is benign.
          const code = (e as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") throw new SpawnHomeUnreadable(codexHome, code, `${name}/${ln}`);
          allLocks = false; continue;
        }
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
  for (const e of entries.filter((x) => x.disposition === "retained").sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
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
  await mkdir(dir, { recursive: true, mode: 0o750 });   // S2: spec §5 — never world-readable
  const path = join(dir, `${agentId}.${stamp}.json`);
  // ⛔ F2 (PR 91 review). This used to open the FINAL path with "w", which truncates AT OPEN —
  // so a kill or ENOSPC during FINALIZE destroyed the INTENT record naming what was at risk,
  // after removal had already run. The durable record was destroyed by the act of reporting on
  // it. Write a temp, fsync it, then rename: a rename is atomic, so the reader sees either the
  // whole previous receipt or the whole new one, never a truncated one.
  const tmp = `${path}.tmp`;
  const fh = await fsOpen(tmp, "w", 0o640);            // S2: receipts enumerate every path in the home
  try {
    await fh.writeFile(JSON.stringify(r, null, 1));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  // ⛔ N9 (re-review). rename() is ATOMIC but not DURABLE: the fsync above flushes the file's
  // CONTENT, while the directory entry that makes it visible under this name is a separate
  // write. A power loss between them can leave the content safe and the name gone — which,
  // for a receipt whose whole job is to survive a crash, is the failure mode it exists for.
  // fsync the containing directory so the rename itself is on disk. Best effort: some
  // filesystems refuse a directory fsync, and failing the receipt over that would be worse
  // than the durability gap it closes.
  try {
    const dh = await fsOpen(dir, "r");
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* directory fsync unsupported here; content is still fsynced */ }
  // ⚠️ N20 (re-review): this is the LOCAL path only. The generated remote script cannot call
  // fsync(2) on a directory from /bin/sh, so it uses `sync` — a whole-filesystem flush, which
  // is broader but not a targeted guarantee about this directory entry. The two paths are
  // therefore NOT equivalent on durability, and that asymmetry is stated rather than implied.
  // Not "fixed" by weakening the local path to match; the remote is as strong as sh allows.
  return path;
}


/**
 * The remote (cross-uid) executor cannot import this module, so the rules are
 * COMPILED FROM THE SAME CONSTANTS into a /bin/sh program. One source of truth;
 * an equivalence test runs this generated script against the same fixture as the
 * TypeScript classifier and asserts identical outcomes.
 */
export function buildRemoteTeardownScript(): string {
  const bases = [...DISPOSABLE_BASENAMES].join(" ");
  const locks = LOCK_DIRS.join(" ");
  return [
    'set -u',
    'H="$CODEX_HOME"; A="$AUTH_TARGET"; R="$RECEIPT"; AG="$AGENT_ID"; T="${THREAD_PATH:-}"',
    `BASES="${bases}"; LOCKS="${locks}"`,
    'D=$(mktemp); K=$(mktemp); V=$(mktemp); B=$(mktemp)',
    // ⛔ C2 ON THE REMOTE PATH (review N1). The root loop globs, and a glob over a home we
    // cannot READ yields nothing — indistinguishable from a home that is genuinely empty.
    // Locally this is SpawnHomeUnreadable; here it was silently "nothing to do, complete".
    // ENOENT really is "already gone"; anything else is "I could not look".
    // ⛔ N21 (delta review). `[ ! -d "$H" ]` conflated TWO different states: "does not exist"
    // and "exists but is not a directory". A CODEX_HOME that is a regular file came out of the
    // remote path as a clean `complete` with absent=1 AND A RECEIPT WRITTEN, while the local
    // path refused it (readdir -> ENOTDIR -> SpawnHomeUnreadable -> skipped, no receipt). Two
    // implementations agreeing only on the cases anyone tested is finding C1's shape, and this
    // is its third appearance in this PR. ENOENT is "already gone"; ENOTDIR is "that is not a
    // spawn home", which is a refusal, not a completion.
    'if [ ! -e "$H" ] && [ ! -L "$H" ]; then echo "$H" >> "$B"; CREW_ABSENT=1;',
    // A SYMLINK is refused before the `-d` test, because `-d` FOLLOWS links: without this, a
    // symlink-to-a-directory would be accepted here and refused locally — the same divergence
    // one case over. Dangling links are caught here too, having survived the `-e`/`-L` test.
    'elif [ -L "$H" ]; then echo CREW_HOME_UNREADABLE; echo "CREW_CODE ESYMLINK"; echo "CREW_NOTE SYMLINK AT CODEX_HOME: $H for $AG — refusing; a spawn home is a real directory."; exit 8;',
    'elif [ ! -d "$H" ]; then echo CREW_HOME_UNREADABLE; echo "CREW_CODE ENOTDIR"; echo "CREW_NOTE NOT A DIRECTORY: $H for $AG — refusing; this is not \'already gone\'."; exit 8;',
    'else CREW_ABSENT=0;',
    // ⛔ N16: these explanations were on STDERR, and screen.sshRun returns STDOUT ONLY — so
    // production dropped every one of them. Explaining a refusal down a channel nobody reads is
    // the same as not explaining it. All diagnostics go to stdout.
    '  ls -A "$H" >/dev/null 2>&1 || { echo CREW_HOME_UNREADABLE; echo "CREW_CODE EACCES"; echo "CREW_NOTE NOTHING REMOVED for $AG at $H — this is not \'already gone\', it is \'I could not look\'."; exit 8; }',
    'fi',
    // JSON array from a newline list — quoting handled once, in awk.
    'jarr() { awk \'BEGIN{printf "["} {gsub(/\\\\/,"\\\\\\\\"); gsub(/"/,"\\\\\\""); printf "%s\\"%s\\"",(NR>1?",":""),$0} END{printf "]"}\' "$1"; }',
    '[ "$CREW_ABSENT" = 1 ] || for p in "$H"/* "$H"/.*; do',
    '  n=$(basename "$p"); [ "$n" = "." ] || [ "$n" = ".." ] && continue',
    '  [ -e "$p" ] || [ -L "$p" ] || continue',
    '  d=0',
    '  if [ -L "$p" ]; then t=$(readlink "$p"); [ "$n" = "auth.json" ] && [ "$t" = "$A" ] && d=1',
    '  elif [ -S "$p" ]; then d=1',
    '  elif [ -f "$p" ]; then for b in $BASES; do [ "$n" = "$b" ] && d=1; done',
    '  elif [ -d "$p" ]; then',
    '    for l in $LOCKS; do',
    '      [ "$n" = "$l" ] || continue',
    // ⛔ N33 on the remote side. An unreadable lock dir globbed to nothing, so `any` stayed 0
    // and `d` was never set — retained for the same incidental reason as the local seed. Make
    // the refusal explicit, matching the root-level check and the local path.
    '      ls -A "$p" >/dev/null 2>&1 || { echo CREW_HOME_UNREADABLE; echo "CREW_CODE EACCES"; echo "CREW_NOTE LOCK DIR UNREADABLE: $p for $AG — refusing; this is not \'no locks here\'."; exit 8; }',
    '      all=1; any=0',
    '      for q in "$p"/* "$p"/.*; do',
    '        m=$(basename "$q"); [ "$m" = "." ] || [ "$m" = ".." ] && continue',
    // C1(a): a DANGLING symlink is `[ -e ]`-false. The root loop already pairs -e with -L;
    // this inner loop dropped it, so a dangling .lock was skipped and never cleared `all`,
    // and the shell then disposed a directory the classifier retains.
    '        [ -e "$q" ] || [ -L "$q" ] || continue; any=1',
    // C1(b): `[ -f ]` FOLLOWS a symlink; the TS side uses lstat and does not. A `*.lock`
    // symlink pointing at a real file was disposed by the shell and retained by TS. Test the
    // link itself first and refuse to dispose it.
    '        case "$m" in *.lock) if [ -L "$q" ]; then all=0; echo "$q" >> "$K"; elif [ -f "$q" ]; then echo "$q" >> "$D"; else all=0; echo "$q" >> "$K"; fi;; *) all=0; echo "$q" >> "$K";; esac',
    '      done',
    '      [ "$any" = 1 ] && [ "$all" = 1 ] && d=1',
    '    done',
    '  fi',
    '  if [ "$d" = 1 ]; then echo "$p" >> "$D"; else echo "$p" >> "$K"; fi',
    'done',
    // ⛔ INTENT, valid JSON, durable, BEFORE any removal.
    'mkdir -p "$(dirname "$R")" 2>/dev/null || { echo CREW_INTENT_FAILED; exit 9; }',
    // ⛔ F2 ON THE REMOTE PATH (review N1). This wrote `> "$R"` directly, so FINALIZE
    // truncated the durable INTENT in place: a crash inside that window left a receipt that
    // PARSES and says nothing was at risk. Fixed locally, not carried here. Temp, sync, mv.
    'rcpt() { printf \'{"agent":"%s","state":"%s","manifest_scope":"root-metadata","disposable":%s,"retained":%s,"removed":%s,"failed":%s,"absent":%s}\' "$AG" "$1" "$(jarr "$D")" "$(jarr "$K")" "$(jarr "$2")" "$(jarr "$V")" "$(jarr "$B")" > "$3.tmp" 2>/dev/null && sync && [ -s "$3.tmp" ] && mv -f "$3.tmp" "$3" 2>/dev/null; }',
    'EMPTY=$(mktemp)',
    'rcpt in-progress "$EMPTY" "$R" || { echo CREW_INTENT_FAILED; exit 9; }',
    'while IFS= read -r p; do echo "DISPOSE $p"; done < "$D"',
    'while IFS= read -r p; do echo "RETAIN $p"; done < "$K"',
    // ⛔ N14: `absent` reached the RECEIPT and never the RETURNED CONTRACT, because the script
    // gained $B and its reader gained nothing. A field that is right in the audit record and
    // empty in the caller's result is two different answers to one question.
    // ⛔ N26 (delta review). `absent` MEANT DIFFERENT THINGS ON THE TWO PATHS: local reported
    // [home, threadPath] while remote reported [home] for the SAME state, so a consumer could
    // not use membership or length without knowing which implementation produced the result.
    // A LIVE contract divergence, not a coverage gap — measured before fixing. The thread
    // pointer lives on the REMOTE host, so only this script can observe it; the reader cannot
    // stat a path on another machine. Same order as local: home first, then pointer.
    '[ -n "$T" ] && [ ! -e "$T" ] && [ ! -L "$T" ] && echo "$T" >> "$B"',
    'while IFS= read -r p; do echo "ABSENT $p"; done < "$B"',
    // Every removal takes ONE path from the disposal list, and the list never contains $H:
    // the root loop only ever appends "$H"/<entry>. The `[ "$p" = "$H" ]` guard is the
    // belt to that brace — and it is ASSERTED, not merely asserted-about: the test
    // "T4: an explicit whole-home target on the disposal list is REFUSED by the guard"
    // forces "$H" onto the list and requires the home to survive. Construction is a
    // property of today's code; an edit can change it, and that test is what notices.
    'sort -r "$D" | while IFS= read -r p; do [ "$p" = "$H" ] && continue; rm -rf -- "$p" 2>/dev/null; if [ -e "$p" ] || [ -L "$p" ]; then echo "REMAIN $p"; echo "$p" >> "$V"; else echo "REMOVED $p"; fi; done',
    // FINALIZE, valid JSON, after removal, reporting what ACTUALLY happened.
    // ⛔ F3 ON THE REMOTE PATH (review N1). Finalize failure echoed a marker and left the
    // receipt saying "in-progress" forever, with removal ALREADY RUN. The spec's row-13
    // contract — an honest partial report, never success, never "everything retained" —
    // existed only locally. Now: try finalize; on failure write finalize-failed beside it;
    // if that also fails, say the storage will not accept a failure record.
    'REMOVEDLIST=$(mktemp); grep -v -x -F -f "$V" "$D" 2>/dev/null > "$REMOVEDLIST" || cp "$D" "$REMOVEDLIST"',
    'if ! rcpt complete "$REMOVEDLIST" "$R"; then',
    '  echo CREW_FINALIZE_FAILED',
    '  if rcpt finalize-failed "$REMOVEDLIST" "$R.finalize-failed"; then',
    '    echo "CREW_NOTE FINALIZE receipt failed for $AG — removal ALREADY RAN; honest partial report written to $R.finalize-failed. Not reported as success."',
    '  else',
    '    echo CREW_FINALIZE_RECORD_FAILED',
    '    echo "CREW_NOTE Could not write the finalize-failed receipt either for $AG — storage will not accept a failure record. The in-progress INTENT is the only durable record and it is INTACT."',
    '  fi',
    'fi',
    'sync',
    'rm -f "$D" "$K" "$V" "$B" "$EMPTY" "$REMOVEDLIST"',
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
  /**
   * ⛔ SEAM FOR THE SPEC'S MUTANT CONTROLS (rows 15-18). Production never passes this.
   * The spec's closing line is "rows 15-18 are what make the rest mean anything": a
   * classifier that cannot be replaced cannot be mutated, and a suite that cannot run a
   * KNOWN-BAD classifier has never shown its assertions are load-bearing. Every earlier
   * revision of this spec passed every test imagined for it at the time.
   */
  classify?: (codexHome: string, home: string) => Promise<SpawnEntry[]>;
  /**
   * ⛔ SEAM FOR SPEC ROW 13 (finalize fails AFTER removal). Production never passes this.
   * INTENT and FINALIZE write through the same function to the same directory, so the only
   * thing that distinguishes them is WHEN they run — which a fixture cannot reach from the
   * outside without racing the implementation. Row 13 is the one acceptance row that describes
   * a state the code can only enter mid-call, and F3 shipped unassigned precisely because
   * nothing could reach it.
   */
  writeReceipt?: (stateDir: string, agentId: string, stamp: string, r: StopReceipt) => Promise<string>;
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
  const write = deps.writeReceipt ?? writeReceipt;
  let entries: SpawnEntry[];
  try {
    entries = await (deps.classify ?? classifySpawnHome)(paths.codexHome, paths.home);
  } catch (e) {
    if (e instanceof SpawnHomeUnreadable) {
      log(`[crew] codex-spawn: spawn home UNREADABLE for '${agentId}' (${e.code}` +
          `${e.entry ? `, entry: ${e.entry}` : ""}) at ${e.path} — NOTHING REMOVED and no receipt ` +
          `written. This is not "already gone"; it is "I could not look".`);
      // ⛔ N29 (review). ESYMLINK / ENOTDIR / EACCES / ELOOP / entry:* all collapsed to one
      // string, so a deliberately-symlinked lane was indistinguishable from a broken one on
      // every stop, forever — and the symlink refusal is a JUDGEMENT I asked to be allowed to
      // keep. Carrying the code is the condition that makes that judgement inspectable.
      result.skipped = `home-unreadable:${e.code}`;
      return;
    }
    throw e;
  }
  // ⛔ C3 (PR 91 review). `absent` was populated only by removeLocal/removeRemote, both
  // deleted by F5, so every live path returned [] and a caller could not tell "there was
  // nothing to do" from "I did nothing". Those are the two outcomes C2 is about. Record it.
  if (!(await exists(paths.codexHome))) result.absent.push(paths.codexHome);
  // ⛔ M2 (PR 91 review). paths.threadPath is deliberately NOT in the disposal set: the
  // thread pointer is what `codex resume` reads, and deleting it is half of the incident.
  // It held by OMISSION — nothing constructed it and nothing would notice a future edit
  // adding it. Recording it here makes the retention explicit and gives the tests a handle.
  if (!(await exists(paths.threadPath))) result.absent.push(paths.threadPath);

  const disposable = entries.filter((e) => e.disposition === "disposable");
  const retained = entries.filter((e) => e.disposition === "retained");
  // ⛔ N10 (re-review). The remote path refuses a whole-home target (`[ "$p" = "$H" ]`); the
  // LOCAL path had no equivalent, so the guard existed on one implementation only — the same
  // asymmetry as C1 and N1, in the safety direction. bf3fdb0 removed the home itself; a
  // classifier that returns the home as one disposable entry reproduces the incident exactly.
  if (disposable.some((e) => e.path === paths.codexHome)) {
    log(`[crew] codex-spawn: REFUSING a whole-home disposal target ${paths.codexHome} for ` +
        `'${agentId}' — removal is per-entry by construction and the home is never an entry. ` +
        `Nothing removed.`);
    result.skipped = "whole-home-in-disposal-set";
    return;
  }
  // The thread pointer must never reach the disposal loop. Cheap, and it is the exact edit
  // a future refactor would make innocently.
  if (disposable.some((e) => e.path === paths.threadPath)) {
    log(`[crew] codex-spawn: REFUSING to dispose the thread pointer ${paths.threadPath} — ` +
        `it is what resume reads. Nothing removed.`);
    result.skipped = "thread-pointer-in-disposal-set";
    return;
  }

  // ⛔ INTENT IS A PRECONDITION. If it cannot be made durable, NOTHING is removed —
  // enforceable precisely because nothing has been destroyed yet.
  const receipt: StopReceipt = {
    agent: agentId, state: "in-progress", at: new Date().toISOString(),
    codexHome: paths.codexHome, manifest_scope: "root-metadata",
    disposable: disposable.map((e) => e.path), retained: retained.map((e) => e.path),
  };
  try {
    await write(stateDir, agentId, stamp, receipt);
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
    await write(stateDir, agentId, stamp, final);
  } catch (e) {
    // ⛔ F3 (PR 91 review). The spec requires a receipt in state "finalize-failed" carrying
    // INTENT's sets plus what is still observable. It was declared, typed, and never assigned.
    // Try once more at a sibling path so the honest partial report survives even when the
    // primary receipt cannot be rewritten; if THAT fails too, say so — never silently.
    log(`[crew] codex-spawn: FINALIZE receipt failed for '${agentId}' — removal ALREADY RAN; ` +
        `removed=${result.removed.length} retained=${retained.length}. Not reported as success.`);
    const partial: StopReceipt = { ...final, state: "finalize-failed" };
    try {
      await write(stateDir, agentId, `${stamp}.finalize-failed`, partial);
    } catch {
      log(`[crew] codex-spawn: could not write the finalize-failed receipt either for '${agentId}' — ` +
          `storage will not accept a failure record. removed=${result.removed.length}; ` +
          `the in-progress INTENT receipt is the only durable record and it is INTACT.`);
    }
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
    `AUTH_TARGET='${join(paths.home, ".codex", "auth.json")}' RECEIPT='${receipt}' AGENT_ID='${agentId}' ` +
    `THREAD_PATH='${paths.threadPath}' ` +
    `/bin/sh -c '${script.replace(/'/g, "'\\''")}'`;
  let out: string;
  try {
    out = await run(target, command);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    result.failed.push({ path: paths.codexHome, error });
    return;
  }
  // Declared before the FIRST marker test: every check below is exact-line membership.
  const markers = new Set(out.split("\n").map((l) => l.trim()));
  if (markers.has("CREW_INTENT_FAILED")) {
    // FAIL CLOSED AND SAY SO. The FV proved the safety worked and was SILENT: an
    // operator saw a successful stop with no hint that cleanup never ran. A guard
    // nobody can observe is indistinguishable from one that did not fire.
    (deps.log ?? ((m: string) => console.error(m)))(
      `[crew] codex-spawn: INTENT receipt undurable for '${agentId}' at ${receipt} — ` +
        `NOTHING REMOVED. The spawn home is intact, including scaffolding; fix the receipt path.`,
    );
    result.skipped = "intent-undurable";
    return;
  }
  // ⛔ N14/C2 on the REMOTE reader. The script distinguishes "I could not look" from ENOENT;
  // until now only the script knew. Same fail-closed semantics as the local path.
  // ⛔ N22 (delta review). These were unanchored `out.includes(...)` over a stream that carries
  // ROOT-ENTRY FILENAMES on its RETAIN/DISPOSE lines. A retained user file named
  // `notes-CREW_INTENT_FAILED.txt` made the reader announce "NOTHING REMOVED, the spawn home is
  // intact", set skipped:"intent-undurable" and return early — while config.toml and the auth
  // symlink had in fact been removed. Reproduced. That is false in the REASSURING direction,
  // which is the direction this whole change exists to distrust: a filename must never be able
  // to forge a control marker. Every marker is emitted by `echo <WORD>` as a line of its own,
  // so exact line membership is the correct test and a filename cannot satisfy it.
  if (markers.has("CREW_HOME_UNREADABLE")) {
    (deps.log ?? ((m: string) => console.error(m)))(
      `[crew] codex-spawn: spawn home UNREADABLE for '${agentId}' at ${paths.codexHome} — ` +
        `NOTHING REMOVED and no receipt written. This is not "already gone"; it is "I could not look".`,
    );
    // ⛔ N29 on the remote side. The CODE travels on its OWN line so the bare marker stays
    // exact-line matchable — appending it to the marker would have silently broken N22's fix.
    // N31/N32: normalise here too — the remote stream is data, so an unexpected CREW_CODE must
    // not become free text in `skipped` any more than a filename may.
    const raw = out.split("\n").map((l) => l.trim())
      .find((l) => l.startsWith("CREW_CODE "))?.slice("CREW_CODE ".length);
    result.skipped = `home-unreadable:${normalizeUnreadableCode(raw)}`;
    return;
  }
  if (markers.has("CREW_FINALIZE_FAILED")) {
    result.failed.push({ path: receipt, error: "finalize-failed" });
  }
  if (markers.has("CREW_FINALIZE_RECORD_FAILED")) {
    result.failed.push({ path: `${receipt}.finalize-failed`, error: "finalize-failure-record-unwritable" });
  }
  if (!markers.has("CREW_TEARDOWN_DONE")) {
    result.failed.push({ path: paths.codexHome, error: `remote teardown did not complete: ${out.trim() || "(no output)"}` });
    return;
  }
  const pick = (tag: string) =>
    out.split("\n").filter((l) => l.startsWith(tag + " ")).map((l) => l.slice(tag.length + 1).trim());
  result.absent.push(...pick("ABSENT"));
  result.removed.push(...pick("REMOVED"));
  for (const p of pick("REMAIN")) result.failed.push({ path: p, error: "still present after remote rm" });
}

// F5 (PR 91 review): the dead removeLocal/removeRemote were deleted. removeRemote referenced
// an out-of-scope `receipt` identifier that nothing typechecks, so it would have thrown
// ReferenceError the moment anyone re-wired it. Dead code that cannot run is still a loaded gun.

/** lstat, not stat: a dangling auth.json symlink still exists for removal. */
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
