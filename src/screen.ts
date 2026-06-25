/**
 * GNU screen session management.
 *
 * Agents run inside named screen sessions. Screen provides:
 * - Persistent processes that survive terminal crashes
 * - Detach/reattach without interrupting the process
 * - Headless I/O via screen -X stuff (send keystrokes) and screen -X hardcopy (read output)
 */

import { $ } from "bun";
import { existsSync, statSync } from "node:fs";
import { join } from "path";

// Resolve screen binary: prefer homebrew 5.x (color support) over macOS built-in 4.0.
// macOS screen 4.0 and homebrew screen 5.x use DIFFERENT default socket directories
// (`/var/folders/.../T/.screen` vs `~/.screen`), so if PATH resolution differs across
// bun MCP instances, one instance may create sessions invisible to another instance's
// `screen -ls`. The reconciler then treats live agents as dead and deletes their DB
// rows. Pinning a known path eliminates that drift.
async function findScreen(): Promise<string> {
  const preferred = ["/opt/homebrew/bin/screen", "/usr/local/bin/screen"];
  for (const path of preferred) {
    if (existsSync(path)) return path;
  }
  try {
    const result = await $`command -v screen`.quiet();
    return result.stdout.toString().trim() || "screen";
  } catch {
    return "screen";
  }
}
const SCREEN = await findScreen();

export type ScreenSession = {
  name: string;
  pid: number;
};

/**
 * Create a detached screen session running a command.
 * Returns the screen session name and PID.
 */
export async function createSession(
  name: string,
  command: string,
): Promise<ScreenSession> {
  // Create detached screen session with login shell (loads profile, PATH, env)
  // Write command to a self-deleting temp script to avoid quoting issues.
  // Bun's $ escapes interpolated values, but screen passes remaining args
  // as argv to the child — so "zsh -lc 'cd /a && cmd'" gets split at &&.
  const shell = process.env.SHELL ?? "/bin/zsh";
  const wireDir = join(process.env.HOME ?? "/tmp", ".wire");
  const screenrc = join(wireDir, "screenrc");
  // Defensive: `screen -c <missing-file>` fails silently. Ensure the screenrc
  // exists (empty is fine) so a fresh install — where the wire installer
  // hasn't yet written this file — doesn't break agent launches.
  await $`mkdir -p ${wireDir} && touch -a ${screenrc}`.quiet().nothrow();
  const scriptFile = `/tmp/crew-launch-${name}-${Date.now()}.sh`;
  await Bun.write(scriptFile, `#!/usr/bin/env -S ${shell} -l\nrm -f '${scriptFile}'\n${command}\n`);
  await $`chmod +x ${scriptFile}`.quiet();
  await $`${SCREEN} -c ${screenrc} -dmS ${name} ${scriptFile}`.quiet();

  // Get the screen PID
  const pid = await getSessionPid(name);
  if (pid === null) {
    throw new Error(`screen session '${name}' failed to start`);
  }
  return { name, pid };
}

// --- Cross-machine (remote) screen sessions ---
//
// A remote agent runs in a screen session on ANOTHER machine, owned by a
// different UID (the per-UID `_ephemeral` pool). We reach it over SSH and
// `sudo -u <uid>`. Two load-bearing gotchas, both proven 2026-06-25:
//   1. macOS `sudo -H/-u <uid>` does NOT deliver HOME — screen then uses the
//      SSH user's `~/.screen` and dies 'Cannot opendir … Permission denied'.
//      We set HOME + SCREENDIR explicitly via `env` (allowed by the box's broad
//      NOPASSWD sudo for tim; the personae→_ephemeral screen-only rule isn't
//      enough on its own).
//   2. The launch command (cd && export && agent prompt) is full of &&, quotes
//      and shell metachars — base64 the launch SCRIPT so it crosses SSH cleanly.

export type RemoteTarget = { sshHost: string; runAsUid: string };

/** `sudo -n -u <uid> env HOME=… SCREENDIR=… <screen>` — the remote screen prefix. */
function remoteScreen(t: RemoteTarget): string {
  const home = `/Users/${t.runAsUid}`;
  return `sudo -n -u ${t.runAsUid} env HOME=${home} SCREENDIR=${home}/.screen ${SCREEN}`;
}

/** Run a command on the remote host's login shell (pipes/&& work). Returns stdout. */
async function sshRun(t: RemoteTarget, remoteCommand: string): Promise<string> {
  const r = await $`ssh -o BatchMode=yes -o ConnectTimeout=15 ${t.sshHost} ${remoteCommand}`
    .quiet()
    .nothrow();
  return r.stdout.toString();
}

/** Create a detached screen session on a remote host, owned by `runAsUid`. */
export async function createRemoteSession(
  name: string,
  command: string,
  t: RemoteTarget,
): Promise<ScreenSession> {
  const scriptFile = `/tmp/crew-launch-${name}-${Date.now()}.sh`;
  const body = `#!/usr/bin/env -S /bin/zsh -l\nrm -f '${scriptFile}'\n${command}\n`;
  const b64 = Buffer.from(body).toString("base64");
  // Write the script (as the SSH user, in world-readable /tmp so the ephemeral
  // UID can exec it), then sudo to the ephemeral UID and launch screen.
  const remote =
    `printf %s ${b64} | base64 -d > ${scriptFile}; chmod 755 ${scriptFile}; ` +
    `${remoteScreen(t)} -dmS ${name} ${scriptFile}`;
  await sshRun(t, remote);
  const pid = await getRemoteSessionPid(name, t);
  if (pid === null) {
    throw new Error(`remote screen session '${name}' on ${t.sshHost} failed to start`);
  }
  return { name, pid };
}

/** PID of a named screen session on a remote host, or null. */
export async function getRemoteSessionPid(name: string, t: RemoteTarget): Promise<number | null> {
  const out = await sshRun(t, `${remoteScreen(t)} -ls`);
  for (const line of out.split("\n")) {
    const match = line.match(/^\t(\d+)\.(\S+)\t/);
    if (match && match[2] === name) return parseInt(match[1]);
  }
  return null;
}

/** Read the screen buffer of a remote session (hardcopy + cat in one round-trip). */
export async function readRemoteOutput(name: string, t: RemoteTarget): Promise<string> {
  const tmp = `/tmp/screen-hc-${name}-${Date.now()}`;
  // hardcopy runs as the ephemeral UID (writes $tmp owned by it); `sudo cat`
  // (as the SSH user, broad NOPASSWD) reads it regardless of mode.
  const out = await sshRun(
    t,
    `${remoteScreen(t)} -S ${name} -X hardcopy ${tmp}; sleep 0.3; sudo -n cat ${tmp} 2>/dev/null; rm -f ${tmp}`,
  );
  return out.trimEnd();
}

/** Send keystrokes to a remote session (e.g. the dev-channel confirm CR). */
export async function sendRemoteKeys(name: string, text: string, t: RemoteTarget): Promise<void> {
  // base64 the payload so CRs / metachars survive the SSH + sudo + screen hop.
  const b64 = Buffer.from(text).toString("base64");
  await sshRun(
    t,
    `${remoteScreen(t)} -S ${name} -X stuff "$(printf %s ${b64} | base64 -d)"`,
  );
}

/**
 * List all screen sessions.
 */
export async function listSessions(): Promise<ScreenSession[]> {
  try {
    const result = await $`${SCREEN} -ls`.quiet().nothrow();
    const output = result.stdout.toString();
    const sessions: ScreenSession[] = [];
    for (const line of output.split("\n")) {
      // Format: "	12345.name	(Detached)" or "(Attached)"
      const match = line.match(/^\t(\d+)\.(\S+)\t/);
      if (match) {
        sessions.push({ name: match[2], pid: parseInt(match[1]) });
      }
    }
    return sessions;
  } catch {
    return [];
  }
}

/**
 * Get PID of a named screen session, or null if not running.
 */
export async function getSessionPid(name: string): Promise<number | null> {
  const sessions = await listSessions();
  const session = sessions.find((s) => s.name === name);
  return session?.pid ?? null;
}

/**
 * Check whether a screen session is currently attached to a terminal.
 * Returns false for detached-but-alive sessions and for sessions that
 * don't exist. Used by registerAgent to avoid auto-linking a headless
 * agent to a pane — a detached screen has no iTerm session of its own
 * and any ITERM_SESSION_ID env it sees is inherited from whoever ran
 * `screen -dmS`, not where it's actually displayed.
 */
export async function isAttached(name: string): Promise<boolean> {
  try {
    const result = await $`${SCREEN} -ls`.quiet().nothrow();
    const output = result.stdout.toString();
    for (const line of output.split("\n")) {
      const match = line.match(/^\t(\d+)\.(\S+)\t.*\((Attached|Detached)\)/);
      if (match && match[2] === name) {
        return match[3] === "Attached";
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a screen session is alive.
 */
export async function isAlive(name: string): Promise<boolean> {
  return (await getSessionPid(name)) !== null;
}

/**
 * Detach a screen session via the control socket.
 * Works even from inside the session itself.
 */
export async function detachSession(name: string): Promise<void> {
  await $`${SCREEN} -S ${name} -X detach`.quiet().nothrow();
}

/**
 * Send keystrokes to a screen session (works even when detached).
 *
 * If the text ends in `\r` or `\n` (and has a prefix), the call is split
 * into two `stuff` invocations with a brief settle delay between:
 *
 *   1. stuff prefix    — types the visible text
 *   2. sleep ~100ms    — lets the receiving REPL settle
 *   3. stuff submit    — fires the Enter key
 *
 * Why: when screen stuffs `"text\r"` in a single event, the receiving
 * application sometimes sees the CR before the prefix has fully landed
 * in its input buffer. The lingering CR then has to be cleared by the
 * caller with a manual backspace + retry. Splitting into two events
 * with a settle gap mirrors what a human types and avoids the
 * race entirely.
 *
 * Affects CC slash commands (e.g. `/exit\r`), codex REPL submissions,
 * and any agent_send/pane_send caller that appends a submit key.
 * (orchestrator.closeAgent already does this manually; auto-splitting
 * here means callers no longer have to remember to.)
 */
// `screen -X stuff` has a ~1KB per-command cap; a larger payload fails with
// "Total length of the command to send too large" and lands NOTHING (found
// 2026-06-02 relaying a 1.2KB engineer steer). Chunk into sub-cap pieces; the
// bytes concatenate in the receiver's input buffer, so even multibyte chars
// split across a boundary reassemble correctly. 256 chars ≈ ≤768 bytes worst
// case (3-byte UTF-8), comfortably under the cap.
const STUFF_CHUNK = 256;
async function stuffChunked(name: string, s: string): Promise<void> {
  if (s.length === 0) return;
  for (let i = 0; i < s.length; i += STUFF_CHUNK) {
    await $`${SCREEN} -S ${name} -X stuff ${s.slice(i, i + STUFF_CHUNK)}`.quiet();
    if (i + STUFF_CHUNK < s.length) await new Promise((r) => setTimeout(r, 30));
  }
}

export async function sendKeys(name: string, text: string): Promise<void> {
  if (text.length > 1) {
    const last = text[text.length - 1];
    if (last === "\r" || last === "\n") {
      const prefix = text.slice(0, -1);
      await stuffChunked(name, prefix);
      await new Promise((r) => setTimeout(r, 100));
      await $`${SCREEN} -S ${name} -X stuff ${last}`.quiet();
      return;
    }
  }
  await stuffChunked(name, text);
}

/**
 * Read the current screen buffer contents.
 */
export async function readOutput(name: string): Promise<string> {
  const tmpFile = `/tmp/screen-hardcopy-${name}-${Date.now()}`;
  try {
    await $`${SCREEN} -S ${name} -X hardcopy ${tmpFile}`.quiet();
    // `screen -X hardcopy` is ASYNC: the -X command is queued to the screen
    // server and returns before the server has written the file. Reading
    // immediately races the write → intermittent ENOENT, or a truncated
    // mid-write frame. Poll until the file exists AND its size has settled
    // across two consecutive stats (or a 2s deadline). This is the fix for
    // agent_read's ENOENT + partial-frame reads (Brioche 2026-06-02).
    const deadline = Date.now() + 2000;
    let prev = -1;
    while (Date.now() < deadline) {
      let size: number;
      try {
        size = statSync(tmpFile).size;
      } catch {
        // Not written yet (ENOENT) — keep polling.
        await new Promise((r) => setTimeout(r, 25));
        continue;
      }
      if (size === prev) break; // file exists and size has stabilized
      prev = size;
      await new Promise((r) => setTimeout(r, 25));
    }
    const content = await Bun.file(tmpFile).text();
    await $`rm -f ${tmpFile}`.quiet();
    return content.trimEnd();
  } catch (e) {
    throw new Error(`failed to read screen output for '${name}': ${e}`);
  }
}

/**
 * Kill a screen session and all its child processes.
 * Screen's quit only sends SIGHUP which some processes ignore (e.g. Codex).
 */
export async function killSession(name: string): Promise<void> {
  // Find the screen PID and kill the entire process group
  const pid = await getSessionPid(name);
  if (pid) {
    // Kill all children of the screen process first
    await $`pkill -TERM -P ${pid}`.quiet().nothrow();
    // Give them a moment to exit gracefully
    await new Promise((r) => setTimeout(r, 500));
    // Force-kill any survivors
    await $`pkill -KILL -P ${pid}`.quiet().nothrow();
  }
  await $`${SCREEN} -S ${name} -X quit`.quiet().nothrow();
}
