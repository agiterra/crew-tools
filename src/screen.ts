/**
 * GNU screen session management.
 *
 * Agents run inside named screen sessions. Screen provides:
 * - Persistent processes that survive terminal crashes
 * - Detach/reattach without interrupting the process
 * - Headless I/O via screen -X stuff (send keystrokes) and screen -X hardcopy (read output)
 */

import { $ } from "bun";
import { accessSync, constants, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "path";

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
// Exported so terminal backends type the SAME binary into pane shells: a pane
// whose PATH resolves Apple screen 4 attaches against the wrong socket dir and
// reports "no screen session found" for a live agent (task #29).
export const SCREEN = await findScreen();

export type ScreenSession = {
  name: string;
  pid: number;
};

/**
 * Explain WHY a launch produced no screen session.
 *
 * ★★★ WHY THIS EXISTS (AGI-43). `createSession` threw a bare
 * "screen session '<name>' failed to start" for every failure. That message
 * names a SYMPTOM and destroys the CAUSE:
 *
 *   - the launch script `rm -f`s itself on its first line (deliberate — it
 *     embeds AGENT_PRIVATE_KEY), so there is nothing left to inspect;
 *   - the command is an interactive TUI inside screen, so its stdout/stderr
 *     CANNOT be redirected to a log without breaking every spawn;
 *   - screen `-dmS` reports nothing about a child that exited.
 *
 * ★★ The message was ALSO read as a poll bug, and it is not one. Verified
 * 2026-08-01: a trivial `sleep 60` through the identical mechanism is detected
 * in ~200ms, and `screen -ls` lists a session regardless of what the program
 * inside is doing — so "the agent sits at the dev-channel prompt during the
 * poll window" cannot make it disappear. `pollSessionPid` returning null is a
 * TRUE negative: the session really did exit. The defect was never the poll —
 * it was that the launcher's reason went unrecorded, so an unreachable-path
 * failure and a crashed-agent failure printed the same sentence.
 *
 * ⇒ We cannot capture the child's output, so we reconstruct what we still can:
 * whether the thing we asked it to run was reachable AT ALL, checked as the
 * uid that just tried to run it.
 *
 * ⚠️ NEVER interpolate `command` into the result. It carries AGENT_PRIVATE_KEY
 * in its export prologue; an error string flows to logs, MCP responses and
 * dashboards. Only paths matched out of it are echoed, never the raw text.
 */
export function diagnoseLaunchFailure(command: string): string {
  // Absolute paths that look like something we were asked to EXECUTE. Extension
  // -anchored on purpose: a bare `claude --flag` has no path to check, and
  // saying so is more honest than silently finding nothing.
  const candidates = [...new Set(command.match(/\/[A-Za-z0-9._\/-]+\.(?:sh|ts|js|mjs|py)\b/g) ?? [])];
  if (candidates.length === 0) {
    return "no absolute launcher path appears in the command, so reachability could NOT be checked — this is UNKNOWN, not a clean bill of health.";
  }

  const problems: string[] = [];
  for (const p of candidates) {
    // ★★★ REACHABILITY IS TESTED **BEFORE** EXISTENCE, AND THE ORDER IS THE
    // WHOLE POINT. `existsSync` needs to traverse the path to answer, so behind
    // an untraversable ancestor it returns FALSE for a file that is really
    // there. My first cut checked existence first and reported "does not
    // exist" for a 0755 launcher sitting inside a 0700 directory — the exact
    // AGI-43 case, and a CONFIDENTLY WRONG cause that sends the reader hunting
    // for a missing file. That is worse than the vague message this replaces:
    // a wrong cause outranks no cause in how far it travels.
    //
    // ★ ACCESS IS A CONJUNCTION OVER THE WHOLE PATH. A launcher can be 0755 and
    // still be unreachable because an ANCESTOR denies traversal — runtimes.json
    // pointed at /Users/tim/.wire/*.sh with /Users/tim at 0750 and .wire at
    // 0700. Checking only the file's own mode reports "fine" for a path this
    // uid can never reach.
    // ⚠️ accessSync throws for BOTH "no such directory" (ENOENT) and "permission
    // denied" (EACCES), and those are OPPOSITE answers: one means the path is
    // genuinely absent, the other means its existence is unknowable from here.
    // Discriminating on the THROW alone collapses them — the same mistake as
    // reading `screen -ls` exit 1 as a probe failure when it encodes "empty".
    // Only the errno separates them.
    let blocked: string | null = null;
    let missingAncestor: string | null = null;
    for (let d = dirname(p); ; d = dirname(d)) {
      try {
        accessSync(d, constants.X_OK);
      } catch (err) {
        // Structural cast, not NodeJS.ErrnoException: that namespace appears
        // nowhere else in this repo and needs @types/node to resolve.
        if ((err as { code?: string }).code === "ENOENT") missingAncestor = d;
        else blocked = d;
        break;
      }
      if (d === "/" || dirname(d) === d) break;
    }
    if (missingAncestor) {
      problems.push(`${p}: does not exist (its parent directory ${missingAncestor} is itself absent — not a permission problem)`);
      continue;
    }
    if (blocked) {
      // Deliberately does NOT claim the file exists — from here that is
      // unknowable, and asserting either way would be the same error again.
      problems.push(
        `${p}: this uid cannot traverse ${blocked} (ancestor denies +x). Whether the file exists is UNKNOWABLE from this uid — the file's own mode is irrelevant while an ancestor blocks the path`,
      );
      continue;
    }
    if (!existsSync(p)) {
      // Only trustworthy now that every ancestor is known traversable.
      problems.push(`${p}: does not exist (path is fully traversable by this uid, so this absence is real)`);
      continue;
    }
    try {
      accessSync(p, constants.X_OK);
    } catch {
      problems.push(`${p}: exists and is reachable, but is not executable by this uid`);
    }
  }

  if (problems.length === 0) {
    // ★ Reachable is not runnable. Say which question was answered — an
    // unqualified "checked, fine" would read as "the launcher works".
    return `every launcher path in the command exists and is executable by this uid (${candidates.join(", ")}), so the failure is INSIDE the command, not in reaching it.`;
  }
  // Report ALL of them: the first problem found is not necessarily the only one.
  return `launcher unreachable — ${problems.join("; ")}`;
}

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
  // Plain fs, NOT `$\`touch -a\``: Bun shell's builtin touch rejects -a
  // ("unsupported option", exit 1) and the old .nothrow() swallowed that,
  // so the guard silently never created the file (herald/vacherin sidecar
  // launches all failed on fresh homes, 2026-07-29).
  mkdirSync(wireDir, { recursive: true });
  if (!existsSync(screenrc)) writeFileSync(screenrc, "");
  const scriptFile = `/tmp/crew-launch-${name}-${Date.now()}.sh`;
  await Bun.write(scriptFile, `#!/usr/bin/env -S ${shell} -l\nrm -f '${scriptFile}'\n${command}\n`);
  // 0700, NOT world-readable: the launch chain embeds AGENT_PRIVATE_KEY, so a
  // 0755 script in shared /tmp leaks the key to every local user until the
  // self-rm runs (and it doesn't always — see the remote path). Same uid writes
  // and execs here, so owner-only is sufficient.
  await $`chmod 700 ${scriptFile}`.quiet();
  // -U forces UTF-8 so box-drawing / symbols in a TUI (claude/codex) render
  // clean on attach instead of â/Â mojibake. The screenrc on a fresh install
  // doesn't set defutf8, so the flag is load-bearing (2026-06-30).
  await $`${SCREEN} -U -c ${screenrc} -dmS ${name} ${scriptFile}`.quiet();

  // `screen -dmS` forks; the session can lag a beat before `screen -ls` lists
  // it. A single immediate getSessionPid() loses that race and spuriously
  // throws "failed to start" (the kouign/palmier spawn failures, 2026-06-30).
  // Poll instead.
  const pid = await pollSessionPid(name);
  if (pid === null) {
    // The session is gone, so the child already exited. Say what we can still
    // establish about WHY (see diagnoseLaunchFailure) instead of naming only
    // the symptom — this sentence is usually the sole artifact of the failure.
    throw new Error(
      `screen session '${name}' failed to start (the session exited before it could be listed; ` +
        `the poll is not at fault — a live session is listed regardless of what runs inside it). ` +
        `Diagnosis: ${diagnoseLaunchFailure(command)}`,
    );
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

/**
 * Where a cross-UID screen lives. `sshHost: "local"` is the SAME-HOST case:
 * the command runs through a local login shell instead of ssh, but still
 * `sudo -n -u <runAsUid>` — used by a machine-resident service (crew-service)
 * spawning agents under the per-UID account without an ssh loopback.
 */
export type RemoteTarget = { sshHost: string; runAsUid: string };

export const LOCAL_SUDO_HOST = "local";

/** `sudo -n -u <uid> env HOME=… SCREENDIR=… LANG/LC_ALL <screen>` — remote screen prefix. */
function remoteScreen(t: RemoteTarget): string {
  const home = `/Users/${t.runAsUid}`;
  // `sudo` strips the locale → screen runs in the C/POSIX locale and mangles
  // UTF-8 (box-drawing chars become â/Â). Force UTF-8 in the env so BOTH session
  // creation (-U below) AND hardcopy reads (readRemoteOutput) come back clean
  // (the 2026-06-29 cross-machine-attach mojibake; same class hit herald's read).
  return `sudo -n -u ${t.runAsUid} env HOME=${home} SCREENDIR=${home}/.screen LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ${SCREEN}`;
}

/** Run a command on the target's login shell (pipes/&& work). Returns stdout.
 *  `sshHost: "local"` executes through a local `/bin/zsh -lc` — identical shell
 *  semantics to the ssh path (login shell), minus the network hop. */
export async function sshRun(t: RemoteTarget, remoteCommand: string): Promise<string> {
  if (t.sshHost === LOCAL_SUDO_HOST) {
    const r = await $`/bin/zsh -lc ${remoteCommand}`.quiet().nothrow();
    return r.stdout.toString();
  }
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
  // The launch script embeds AGENT_PRIVATE_KEY. It's written by the SSH/service
  // user (tim) but exec'd by the ephemeral UID via sudo, so it can't be
  // owner-only-tim. The OLD form (chmod 755) left it WORLD-READABLE in sticky
  // /tmp — and the in-script self-rm runs as the ephemeral UID, which can't
  // delete a tim-owned file in sticky /tmp, so every spawn leaked a readable
  // key at rest (profiterole, 2026-07-06). Fix: chmod 600 while tim owns it,
  // then chown to the ephemeral UID — now ONLY that UID (and root) can read it,
  // AND the self-rm succeeds because the runner owns the file. chown needs root;
  // the box's NOPASSWD sudo (same grant the spawn itself rides) provides it.
  const remote =
    `printf %s ${b64} | base64 -d > ${scriptFile}; chmod 700 ${scriptFile}; ` +
    `sudo -n chown ${t.runAsUid} ${scriptFile}; ` +
    `${remoteScreen(t)} -U -dmS ${name} ${scriptFile}`;
  await sshRun(t, remote);
  // Poll — same forked-screen race as the local path, but over SSH (slower), so
  // a longer deadline. A single check would intermittently false-fail a healthy
  // cross-machine spawn.
  const pid = await pollRemoteSessionPid(name, t);
  if (pid === null) {
    throw new Error(`remote screen session '${name}' on ${t.sshHost} failed to start`);
  }
  return { name, pid };
}

/** Target-aware isAlive — a session under another UID (and/or another host). */
export async function isRemoteAlive(name: string, t: RemoteTarget): Promise<boolean> {
  return (await getRemoteSessionPid(name, t)) !== null;
}

/**
 * Reap the agent's REAL process tree and report how many processes survive.
 *
 * The login shell, the runtime (claude/codex), and every MCP subprocess share
 * ONE process group — the screen child's pgid. `screen` starts each window in
 * a fresh session, so the child shell and its whole subtree get a pgid
 * distinct from screen's own. The old `pkill -P <screenPid>` reaped only the
 * DIRECT child (the login shell) and orphaned the runtime + MCP procs into
 * init — the "closed but 430MB alive" zombie (madeleine/profiterole/fraisier,
 * 2026-07-06). Killing the whole process group takes the subtree down at once.
 *
 * `killPrefix` is "" for a same-uid local kill, or `sudo -n -u <uid>` for a
 * cross-uid target. `run` executes a POSIX-sh string and returns its stdout.
 * Returns the count of processes still in the group after SIGKILL + a settle
 * (init reaps the killed children near-instantly); 0 = tree confirmed dead.
 * NOTE: does NOT quit the screen wrapper itself — screen sits in its own pgid,
 * so the caller still runs `screen -X quit` after.
 */
async function reapTree(
  screenPid: number,
  killPrefix: string,
  run: (cmd: string) => Promise<string>,
): Promise<number> {
  const snippet =
    `c=$(pgrep -P ${screenPid} | head -1); ` +
    `if [ -z "$c" ]; then echo "SURV=0"; else ` +
    `g=$(ps -o pgid= -p "$c" | tr -d " "); ` +
    `if [ -z "$g" ]; then echo "SURV=0"; else ` +
    `${killPrefix} kill -TERM -"$g" 2>/dev/null; sleep 0.5; ` +
    `${killPrefix} kill -KILL -"$g" 2>/dev/null; sleep 0.3; ` +
    `echo "SURV=$(pgrep -g "$g" 2>/dev/null | wc -l | tr -d " ")"; ` +
    `fi; fi`;
  const out = await run(snippet);
  const m = out.match(/SURV=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Send SIGTERM to the agent process group and wait for a clean exit. Unlike
 * reapTree, this gives runtimes with real signal handlers (notably Codex Wire
 * bridge launchers) time to shut down their own app-server children before the
 * caller decides whether to escalate to SIGKILL.
 */
async function terminateTree(
  screenPid: number,
  killPrefix: string,
  timeoutMs: number,
  run: (cmd: string) => Promise<string>,
): Promise<number> {
  const polls = Math.max(1, Math.ceil(timeoutMs / 250));
  const snippet =
    `c=$(pgrep -P ${screenPid} | head -1); ` +
    `if [ -z "$c" ]; then echo "SURV=0"; else ` +
    `g=$(ps -o pgid= -p "$c" | tr -d " "); ` +
    `if [ -z "$g" ]; then echo "SURV=0"; else ` +
    `${killPrefix} kill -TERM -"$g" 2>/dev/null; ` +
    `i=0; while [ "$i" -lt ${polls} ]; do ` +
    `n=$(pgrep -g "$g" 2>/dev/null | wc -l | tr -d " "); ` +
    `if [ "$n" = "0" ]; then echo "SURV=0"; exit 0; fi; ` +
    `sleep 0.25; i=$((i + 1)); ` +
    `done; ` +
    `echo "SURV=$(pgrep -g "$g" 2>/dev/null | wc -l | tr -d " ")"; ` +
    `fi; fi`;
  const out = await run(snippet);
  const m = out.match(/SURV=(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Kill a screen session owned by another UID (and/or on another host) — the
 * target-aware analogue of killSession. Reaps the whole agent process group,
 * then quits the screen wrapper. Returns surviving-process count (0 = clean).
 */
export async function killRemoteSession(name: string, t: RemoteTarget): Promise<number> {
  const pid = await getRemoteSessionPid(name, t);
  let survivors = 0;
  if (pid) {
    survivors = await reapTree(pid, `sudo -n -u ${t.runAsUid}`, (cmd) => sshRun(t, cmd));
  }
  await sshRun(t, `${remoteScreen(t)} -S ${name} -X quit; true`);
  return survivors;
}

/**
 * Gracefully terminate a remote/cross-UID agent process group via SIGTERM.
 * Does not quit the screen wrapper; callers should follow with killRemoteSession
 * once the tree is confirmed dead or escalation is required.
 */
export async function terminateRemoteSessionTree(
  name: string,
  t: RemoteTarget,
  timeoutMs = 10_000,
): Promise<number> {
  const pid = await getRemoteSessionPid(name, t);
  if (!pid) return 0;
  return terminateTree(pid, `sudo -n -u ${t.runAsUid}`, timeoutMs, (cmd) => sshRun(t, cmd));
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

/**
 * Poll for a remote screen session's PID (the cross-machine analogue of
 * pollSessionPid). Longer default deadline since each check is an SSH round-trip.
 */
export async function pollRemoteSessionPid(
  name: string,
  t: RemoteTarget,
  timeoutMs = 8000,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = await getRemoteSessionPid(name, t);
    if (pid !== null) return pid;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
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
 * Poll for a screen session's PID until it appears or the deadline elapses.
 * `screen -dmS` returns before the forked session is necessarily listed by
 * `screen -ls`; a single immediate getSessionPid() loses that race and reports
 * a healthy spawn as failed (kouign/palmier, 2026-06-30). Returns the PID once
 * the session shows up, or null if it never does within `timeoutMs`.
 */
export async function pollSessionPid(name: string, timeoutMs = 5000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = await getSessionPid(name);
    if (pid !== null) return pid;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 200));
  }
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
export async function killSession(name: string): Promise<number> {
  const pid = await getSessionPid(name);
  let survivors = 0;
  if (pid) {
    survivors = await reapTree(pid, "", async (cmd) => {
      const r = await $`/bin/sh -c ${cmd}`.quiet().nothrow();
      return r.stdout.toString();
    });
  }
  await $`${SCREEN} -S ${name} -X quit`.quiet().nothrow();
  return survivors;
}

/**
 * Gracefully terminate a local agent process group via SIGTERM. Does not quit
 * the screen wrapper; callers should follow with killSession once the tree is
 * confirmed dead or escalation is required.
 */
export async function terminateSessionTree(name: string, timeoutMs = 10_000): Promise<number> {
  const pid = await getSessionPid(name);
  if (!pid) return 0;
  return terminateTree(pid, "", timeoutMs, async (cmd) => {
    const r = await $`/bin/sh -c ${cmd}`.quiet().nothrow();
    return r.stdout.toString();
  });
}
