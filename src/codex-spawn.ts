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

import { lstat, rm } from "fs/promises";
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

  const targets = [paths.codexHome, paths.threadPath];
  const result: CodexSpawnTeardownResult = { removed: [], absent: [], failed: [] };

  if (args.target) {
    await removeRemote(args.target, targets, result, deps);
  } else {
    await removeLocal(targets, result);
  }

  for (const f of result.failed) {
    log(
      `[crew] codex-spawn teardown FAILED for '${args.agentId}': ${f.path} still present — ${f.error}. ` +
        `Remove it by hand: it holds an auth.json symlink to a LIVE credential.`,
    );
  }
  if (result.removed.length > 0) {
    log(`[crew] codex-spawn: removed ${result.removed.join(" ")} for agent '${args.agentId}'`);
  }
  return result;
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
