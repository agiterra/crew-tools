/**
 * Read the Claude Code session ID for the current process.
 *
 * CC persists session data at ~/.claude/sessions/<PID>.json (keyed by
 * the CC process's own PID). MCP servers are NOT necessarily direct
 * children of the CC process — bun's `bun run` wrapper inserts a layer,
 * so process.ppid is the wrapper, not CC. We walk up the process tree
 * looking for an ancestor whose sessions/<pid>.json exists.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const MAX_DEPTH = 10;

function getParentPid(pid: number): number | null {
  try {
    const out = execSync(`ps -o ppid= -p ${pid}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const parent = parseInt(out, 10);
    if (!parent || parent === 1 || parent === pid) return null;
    return parent;
  } catch {
    return null;
  }
}

export function getClaudeCodeSessionId(): string | null {
  const sessionsDir = join(process.env.HOME ?? "/tmp", ".claude", "sessions");
  let pid: number | null = process.ppid;

  for (let depth = 0; depth < MAX_DEPTH && pid; depth++) {
    const sessionFile = join(sessionsDir, `${pid}.json`);
    if (existsSync(sessionFile)) {
      try {
        const data = JSON.parse(readFileSync(sessionFile, "utf-8"));
        if (data.sessionId) return data.sessionId;
      } catch {
        // Malformed file — keep walking up in case a higher ancestor has a valid one.
      }
    }
    pid = getParentPid(pid);
  }

  return null;
}
