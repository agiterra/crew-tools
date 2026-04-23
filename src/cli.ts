#!/usr/bin/env bun
/**
 * crew CLI — remote invocation target for fleet-level tools.
 *
 * Commands are thin wrappers over Orchestrator methods. Designed to be
 * invoked over SSH by crew-fleet-tools during agent handoffs:
 *
 *   ssh dest crew resume --json - < manifest.json
 *
 * Arg blobs that contain env maps (including secrets like
 * AGENT_PRIVATE_KEY) go in via stdin — never on the command line —
 * so they don't end up in shell history, process lists, or SSH audit
 * logs.
 *
 * Exit codes:
 *   0  success
 *   1  validation / usage error
 *   2  orchestrator error (command reached the orchestrator but failed)
 */

import { Orchestrator } from "./orchestrator.js";
import { createBackend } from "./terminal.js";
import pkg from "../package.json" with { type: "json" };

const USAGE = `Usage: crew <command> [args]

Commands:
  version                           Print crew-tools version.
  resume --json <path|->            Resume an agent. JSON opts fed to Orchestrator.resumeAgent().
                                    Use '-' to read from stdin (preferred for secrets).
  stop <id> [--cc-session-id ID]    Stop an agent. Matches crew's agent_stop MCP tool.
  agent-send <id> <text>            Send keystrokes to an agent's screen.

Exit codes: 0 success, 1 usage, 2 orchestrator error.
`;

type CliResult = { exit: number; stdout?: string; stderr?: string };

async function readJsonArg(src: string): Promise<unknown> {
  const text = src === "-" ? await Bun.stdin.text() : await Bun.file(src).text();
  return JSON.parse(text);
}

/** Parse `--flag value` pairs from a flat argv slice. */
function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a?.startsWith("--")) {
      out[a.slice(2)] = args[i + 1] ?? "";
      i++;
    }
  }
  return out;
}

export async function runCli(argv: string[]): Promise<CliResult> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    return { exit: 0, stdout: USAGE };
  }

  switch (cmd) {
    case "version":
      return { exit: 0, stdout: `${pkg.version}\n` };

    case "resume": {
      const flags = parseFlags(rest);
      if (!flags.json) {
        return { exit: 1, stderr: "resume requires --json <path-or-'-'>\n" };
      }
      let opts: Record<string, unknown>;
      try {
        opts = await readJsonArg(flags.json) as Record<string, unknown>;
      } catch (e) {
        return { exit: 1, stderr: `invalid JSON: ${(e as Error).message}\n` };
      }
      if (!opts.id || typeof opts.id !== "string") {
        return { exit: 1, stderr: "resume JSON must include 'id' (string)\n" };
      }
      try {
        const orch = new Orchestrator(await createBackend());
        const agent = await orch.resumeAgent(opts as Parameters<Orchestrator["resumeAgent"]>[0]);
        return { exit: 0, stdout: `${JSON.stringify(agent)}\n` };
      } catch (e) {
        return { exit: 2, stderr: `resume failed: ${(e as Error).message}\n` };
      }
    }

    case "stop": {
      const id = rest[0];
      if (!id) return { exit: 1, stderr: "stop requires <id>\n" };
      const flags = parseFlags(rest.slice(1));
      try {
        const orch = new Orchestrator(await createBackend());
        await orch.stopAgent(id, flags["cc-session-id"] || undefined);
        return { exit: 0, stdout: `${JSON.stringify({ stopped: id })}\n` };
      } catch (e) {
        return { exit: 2, stderr: `stop failed: ${(e as Error).message}\n` };
      }
    }

    case "agent-send": {
      const id = rest[0];
      const text = rest[1];
      if (!id || text === undefined) {
        return { exit: 1, stderr: "agent-send requires <id> <text>\n" };
      }
      try {
        const orch = new Orchestrator(await createBackend());
        await orch.sendToAgent(id, text);
        return { exit: 0, stdout: `${JSON.stringify({ sent: true, id })}\n` };
      } catch (e) {
        return { exit: 2, stderr: `agent-send failed: ${(e as Error).message}\n` };
      }
    }

    default:
      return { exit: 1, stderr: `unknown command: ${cmd}\n\n${USAGE}` };
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const result = await runCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exit);
}
