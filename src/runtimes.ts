/**
 * Runtime registry — launch command templates for agent runtimes.
 *
 * Built-in defaults for known runtimes. Config file (~/.wire/runtimes.json)
 * can override or add more. No dependency on any runtime being installed —
 * these are just shell command strings.
 *
 * Template variables:
 *   ${AGENT_ID}     — Wire agent ID
 *   ${AGENT_NAME}   — Display name
 *   ${WIRE_URL}     — Wire server URL
 *   ${PROJECT_DIR}  — Working directory for the agent
 *
 * AGI-70 — THE BARE-CODEX TRAP. This module resolves ONE home: the $HOME of
 * the process that calls it. For a crew-service spawn that is the SERVICE
 * uid's home, never the spawn uid's — the command string is built here and
 * only then handed to `sudo -n -u <spawnUid> env HOME=/Users/<spawnUid> …`
 * (screen.ts remoteScreen), by which point resolution is over. Per-home
 * config does NOT follow a service across uids, and until now a missing file
 * fell through to the built-in `codex` — a bare CLI with no Wire bridge, no
 * identity, no MCP — SILENTLY. It bit four spawns in April 2026
 * (Beignet/Madeleine/Cruller/Strudel), the 2026-07-22 galette recycle, and
 * again on 2026-07-28 after crew-svc moved to run as tim.
 *
 * Three changes close the class:
 *   1. The config path is resolved PER CALL, not frozen at module import
 *      (see configPathFor). The old module-level `const CONFIG_PATH` meant a
 *      HOME set after import was never honoured.
 *   2. Resolution keeps PROVENANCE — loadRuntimesFrom reports which names came
 *      from the file and which are built-in fallbacks, plus whether the file is
 *      present / absent / UNREADABLE / malformed. Unreadable is never reported
 *      as absent.
 *   3. getLaunchCommand accepts `requireConfigured`: a runtime in that list
 *      that resolves only from the built-in defaults THROWS
 *      RuntimeNotProvisionedError naming the file and the uid, instead of
 *      silently launching the bare default.
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";

export type RuntimeConfig = {
  command: string;
  description?: string;
};

const DEFAULTS: Record<string, RuntimeConfig> = {
  "claude-code": {
    command: "claude --dangerously-load-development-channels plugin:wire@agiterra --permission-mode bypassPermissions --model ${CLAUDE_MODEL:-claude-opus-4-8} --effort ${CLAUDE_EFFORT:-high}",
    description: "Claude Code with Wire channel (SSE push). MCP plugins (wire-ipc, personai, crew) load from installed_plugins.json per project scope. Model honours env CLAUDE_MODEL, defaulting to Opus (Tim 2026-07-06: no Fable engineers). A MISSING pin FAILS SAFE to the policy model rather than to Fable. WARNING: do NOT restore a hardcoded --model here: a command-line flag beats an exported env var, so the pin arrives and is never read. And the previous text advertised a per-machine ~/.wire/runtimes.json override that does NOT exist for shared-topology personae, whose runtimes are resolved by crew-service under a different HOME.",
  },
  "codex": {
    command: "codex",
    description: "OpenAI Codex CLI",
  },
};

/** Runtime names that have a built-in default at all. */
export function builtinRuntimeNames(): string[] {
  return Object.keys(DEFAULTS);
}

/**
 * Built-in defaults that are a BARE CLI invocation — no Wire bridge, no
 * identity, no MCP. Launching one instead of the fleet's configured template
 * produces an agent that looks spawned and is deaf. These are the runtimes a
 * caller should put in `requireConfigured`.
 */
export const BARE_FALLBACK_RUNTIMES: readonly string[] = ["codex"];

/** State of a home's runtimes.json. UNREADABLE is never collapsed into ABSENT. */
export type RuntimesFileState = "present" | "absent" | "unreadable" | "malformed";

export type RuntimesResolution = {
  /** Home the resolution was performed against. */
  home: string;
  /** uid label, when the caller knows it. Diagnostics only. */
  uid?: string;
  /** `<home>/.wire/runtimes.json`. */
  path: string;
  state: RuntimesFileState;
  /** errno / parse message behind a non-`present` state. */
  error?: string;
  /** Runtime names the FILE defines. Empty unless state === "present". */
  configured: string[];
  /** Names resolvable here = built-ins overlaid by the file. */
  effective: string[];
  /** Effective registry (built-ins overlaid by the file). */
  runtimes: Record<string, RuntimeConfig>;
};

/** `<home>/.wire/runtimes.json` for an explicit home, or this process's $HOME. */
export function configPathFor(home?: string): string {
  return join(home ?? process.env.HOME ?? "/tmp", ".wire", "runtimes.json");
}

/**
 * Thrown when a runtime the caller declared as must-be-configured resolves
 * only from the built-in defaults. Carries the file and uid so the operator is
 * told exactly what to create and where — the whole point of AGI-70.
 */
export class RuntimeNotProvisionedError extends Error {
  readonly runtime: string;
  readonly path: string;
  readonly uid?: string;
  readonly state: RuntimesFileState;
  constructor(args: { runtime: string; path: string; uid?: string; state: RuntimesFileState; error?: string }) {
    const who = args.uid ? `uid '${args.uid}'` : "the resolving uid";
    const why =
      args.state === "absent"
        ? `does not exist`
        : args.state === "unreadable"
          ? `is UNREADABLE (${args.error ?? "permission denied"}) — unreadable is not absent, do not assume its contents`
          : args.state === "malformed"
            ? `is malformed (${args.error ?? "parse error"})`
            : `defines no '${args.runtime}' entry`;
    super(
      `runtime '${args.runtime}' is not provisioned for ${who}: ${args.path} ${why}. ` +
        `Refusing to fall back to the built-in bare '${args.runtime}' command (AGI-70: a bare spawn boots with no Wire bridge and no identity, and fails silently). ` +
        `Fix: define '${args.runtime}' in ${args.path}, owned by ${args.uid ?? "that uid"}.`,
    );
    this.name = "RuntimeNotProvisionedError";
    this.runtime = args.runtime;
    this.path = args.path;
    this.uid = args.uid;
    this.state = args.state;
  }
}

/**
 * Resolve the registry for ONE home, keeping provenance and file state.
 *
 * Read-only and total: every failure becomes a state, never a throw, so a
 * boot-time audit can report on a home it cannot read without dying.
 */
export function loadRuntimesFrom(opts: { home?: string; uid?: string } = {}): RuntimesResolution {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const path = configPathFor(home);
  const runtimes: Record<string, RuntimeConfig> = { ...DEFAULTS };
  const base: Omit<RuntimesResolution, "state" | "configured" | "effective" | "runtimes"> = {
    home,
    uid: opts.uid,
    path,
  };
  const done = (state: RuntimesFileState, configured: string[], error?: string): RuntimesResolution => ({
    ...base,
    state,
    error,
    configured,
    effective: Object.keys(runtimes),
    runtimes,
  });

  // stat first: existsSync() answers false for BOTH "no such file" and "cannot
  // traverse the parent directory", and conflating those is how an unreadable
  // config gets reported as a missing one.
  try {
    statSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return done("absent", [], code);
    return done("unreadable", [], code ?? String((e as Error).message));
  }

  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return done("unreadable", [], code ?? String((e as Error).message));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Deliberately NOT silent any more. The caller decides whether a malformed
    // file is fatal for a given runtime; previously it degraded to defaults
    // with no trace at all.
    return done("malformed", [], String((e as Error).message));
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return done("malformed", [], "top-level value is not a JSON object");
  }

  const configured: string[] = [];
  for (const [name, config] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof config === "string") {
      runtimes[name] = { command: config };
      configured.push(name);
    } else if (typeof config === "object" && config !== null && typeof (config as RuntimeConfig).command === "string") {
      runtimes[name] = config as RuntimeConfig;
      configured.push(name);
    }
    // An entry with no usable command is skipped — and, because it never lands
    // in `configured`, a requireConfigured runtime still refuses rather than
    // quietly using the built-in.
  }
  return done("present", configured);
}

/**
 * Load runtime registry: defaults merged with user config.
 *
 * Re-reads ~/.wire/runtimes.json on every call. The file is tiny and
 * agent_launch is rare; the previous module-level cache silently ignored
 * runtimes.json edits made after process startup. That bit four codex
 * spawns across 2026-04-27 / 04-28 / 04-29 (Beignet, Madeleine, Cruller,
 * Strudel) — each agent ran the default `codex` command bypassing the
 * `~/.wire/codex-launch.sh` override, even after CC restarts. Read-fresh
 * removes the bug class entirely; no race between restart, MCP child
 * orphaning, and edits to runtimes.json.
 *
 * AGI-70: the PATH is now recomputed per call too (it used to be a
 * module-level const, so a HOME assigned after import was never seen).
 */
export function loadRuntimes(home?: string): Record<string, RuntimeConfig> {
  return loadRuntimesFrom({ home }).runtimes;
}

/**
 * Expand template variables in a launch command.
 */
export function expandCommand(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`\${${key}}`, value);
  }
  return result;
}

export type LaunchResolveOpts = {
  /**
   * Runtimes that MUST come from the config file. One of these resolving only
   * from the built-in defaults throws RuntimeNotProvisionedError instead of
   * silently launching the bare default. Absent → legacy permissive behaviour.
   */
  requireConfigured?: readonly string[];
  /** Home whose ~/.wire/runtimes.json is consulted. Default: this process's $HOME. */
  home?: string;
  /** uid label for the error text. Diagnostics only — never used as a path. */
  uid?: string;
};

/**
 * Get the launch command for a runtime, with variables expanded.
 */
export function getLaunchCommand(
  runtime: string,
  vars: Record<string, string>,
  opts: LaunchResolveOpts = {},
): string {
  const res = loadRuntimesFrom({ home: opts.home, uid: opts.uid });
  const config = res.runtimes[runtime];
  if (!config) {
    throw new Error(`unknown runtime '${runtime}'. Available: ${Object.keys(res.runtimes).join(", ")}`);
  }
  if (opts.requireConfigured?.includes(runtime) && !res.configured.includes(runtime)) {
    throw new RuntimeNotProvisionedError({
      runtime,
      path: res.path,
      uid: opts.uid,
      state: res.state,
      error: res.error,
    });
  }
  return expandCommand(config.command, vars);
}

/** Kept for callers that only need the existence check. */
export function runtimesFileExists(home?: string): boolean {
  return existsSync(configPathFor(home));
}
