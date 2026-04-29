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
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";

export type RuntimeConfig = {
  command: string;
  description?: string;
};

const DEFAULTS: Record<string, RuntimeConfig> = {
  "claude-code": {
    command: "claude --dangerously-load-development-channels plugin:wire@agiterra --permission-mode bypassPermissions",
    description: "Claude Code with Wire channel (SSE push). MCP plugins (wire-ipc, personai, crew) load from installed_plugins.json per project scope.",
  },
  "codex": {
    command: "codex",
    description: "OpenAI Codex CLI",
  },
};

const CONFIG_PATH = join(process.env.HOME ?? "/tmp", ".wire", "runtimes.json");

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
 */
export function loadRuntimes(): Record<string, RuntimeConfig> {
  const runtimes = { ...DEFAULTS };

  if (existsSync(CONFIG_PATH)) {
    try {
      const userConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      for (const [name, config] of Object.entries(userConfig)) {
        if (typeof config === "string") {
          runtimes[name] = { command: config };
        } else if (typeof config === "object" && config !== null) {
          runtimes[name] = config as RuntimeConfig;
        }
      }
    } catch {
      // Bad config — use defaults
    }
  }

  return runtimes;
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

/**
 * Get the launch command for a runtime, with variables expanded.
 */
export function getLaunchCommand(
  runtime: string,
  vars: Record<string, string>,
): string {
  const runtimes = loadRuntimes();
  const config = runtimes[runtime];
  if (!config) {
    throw new Error(`unknown runtime '${runtime}'. Available: ${Object.keys(runtimes).join(", ")}`);
  }
  return expandCommand(config.command, vars);
}
