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

/**
 * AGI-157 (2026-10-03, Brioche 656703): `/clear` starts a new Claude Code session in the SAME
 * process. CC rewrites sessions/<pid>.json, but the MCP server read the id once at startup, so
 * the crews.db row (and every later agent_register fallback) kept the pre-clear id — a reader
 * of the row then measured a dead transcript (432,464 tokens vs a live 202,240).
 *
 * The tracker holds the id last STAMPED into crews.db. `changed()` reports a newer live id;
 * the caller stamps it and only then calls `commit()`, so a failed stamp is retried next poll.
 */
export class SessionIdTracker {
  private stamped: string | null;

  constructor(
    private readonly read: () => string | null = getClaudeCodeSessionId,
    initial: string | null = read(),
  ) {
    this.stamped = initial;
  }

  /** The live id, or the last stamped one when the live read fails. */
  current(): string | null {
    return this.read() ?? this.stamped;
  }

  /** A live id that differs from the stamped one, else null. A failed read is never a change. */
  changed(): string | null {
    const live = this.read();
    return live && live !== this.stamped ? live : null;
  }

  commit(id: string): void {
    this.stamped = id;
  }
}
