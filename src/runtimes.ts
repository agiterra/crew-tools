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
    description: "Claude Code with Wire channel (SSE push). MCP plugins (wire-ipc, personai, pane) load from installed_plugins.json per project scope.",
  },
  "codex": {
    command: "codex",
    description: "OpenAI Codex CLI",
  },
};

const CONFIG_PATH = join(process.env.HOME ?? "/tmp", ".wire", "runtimes.json");

let _cache: Record<string, RuntimeConfig> | null = null;

/**
 * Load runtime registry: defaults merged with user config.
 */
export function loadRuntimes(): Record<string, RuntimeConfig> {
  if (_cache) return _cache;

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

  _cache = runtimes;
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
