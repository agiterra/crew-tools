/**
 * Claude-subscription credential liveness — the fail-closed guard for
 * claude-code spawns (crew-service Phase 2, credential model).
 *
 * The fleet auths to Claude with a file credential at
 * `<home>/.claude/.credentials.json` (`claudeAiOauth.accessToken`). The
 * agiterra-credential-sync daemon fans a shared subscription credential —
 * refresh token stripped, access-token-only — into every identity home
 * (scripts/credential-sync.sh). If that credential is missing or expired, a
 * spawned claude-code agent 401-loops immediately: it burns a screen slot,
 * and for engineers spawned as `_ephemeral` it silently stalls the fleet
 * (nothing spawns; Slack/herald goes dark). So we check the credential BEFORE
 * spawning and FAIL CLOSED — surfacing an actionable "re-run credential-sync
 * / re-login the anchor" error instead of launching a doomed agent.
 *
 * Liveness fails CLOSED only on PROVABLE death, to avoid ever blocking a spawn
 * whose auth actually works:
 *   - No `.credentials.json` at all → dead (the fan never reached this home).
 *   - A `claudeAiOauth` block whose `accessToken` is expired AND that has no
 *     `refreshToken` → dead. This is precisely the access-token-only copy the
 *     fan distributes (refresh stripped so copies can't rotate) once it ages
 *     out — the exact cascade that 401-killed herald/_ephemeral.
 *   - A `refreshToken` present → LIVE even if the access token is expired on
 *     disk: claude-code self-refreshes (the full/anchor credential).
 *   - A credential file that exists but has NO `claudeAiOauth` block → LIVE:
 *     a different, non-fanned auth scheme is in use (e.g. a cockpit on console
 *     auth). We only guard the fleet's fanned-subscription model; we do not
 *     second-guess an auth scheme we don't manage.
 *
 * Escape hatch: `CREW_SKIP_CRED_CHECK` bypasses the guard entirely — a guard
 * must never permanently brick fleet spawns.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { sshRun, type RemoteTarget } from "./screen.js";

/** Where a claude-code agent will read its subscription credential. */
export type CredentialTarget =
  | { kind: "local"; home: string }
  | { kind: "remote"; target: RemoteTarget };

export type CredentialStatus = { live: true } | { live: false; reason: string };

/**
 * Pure liveness verdict from raw `.credentials.json` content. Fails closed only
 * on provable death (see the module header for the full rule). Exported for
 * unit tests. `expiresAt` is epoch MILLISECONDS (as credential-sync.sh writes).
 */
export function credentialStatus(
  content: string | null,
  now: number = Date.now(),
): CredentialStatus {
  if (content == null || content.trim() === "") {
    return { live: false, reason: "missing (no .credentials.json)" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { live: false, reason: "unparseable (.credentials.json is not valid JSON)" };
  }
  const oauth = (parsed as { claudeAiOauth?: unknown })?.claudeAiOauth;
  // No subscription block → a non-fanned auth scheme (e.g. a cockpit on console
  // auth). Not the model we guard; don't block a spawn we can't prove is broken.
  if (oauth == null || typeof oauth !== "object") {
    return { live: true };
  }
  const { accessToken, refreshToken, expiresAt } = oauth as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
  const hasAccess = typeof accessToken === "string" && accessToken !== "";
  const hasRefresh = typeof refreshToken === "string" && refreshToken !== "";
  if (!hasAccess && !hasRefresh) {
    return { live: false, reason: "claudeAiOauth present but has neither accessToken nor refreshToken" };
  }
  // A refresh token means claude-code can self-refresh even past the access
  // token's expiry — the full/anchor credential recovers on its own.
  if (hasRefresh) {
    return { live: true };
  }
  // Access-token-only (refresh stripped by the fan): hard-dead once expired.
  const exp = typeof expiresAt === "number" ? expiresAt : 0;
  if (exp <= now) {
    const when = exp ? new Date(exp).toISOString() : "unknown";
    return {
      live: false,
      reason: `access-token-only credential expired (expiresAt=${when}) — re-run credential-sync`,
    };
  }
  return { live: true };
}

/** Absolute path to the credential file for a target (used in messages). */
export function credentialPath(target: CredentialTarget): string {
  return target.kind === "local"
    ? join(target.home, ".claude", ".credentials.json")
    : `/Users/${target.target.runAsUid}/.claude/.credentials.json`;
}

/** Read the credential file content, or null if absent/unreadable. */
export async function readCredential(target: CredentialTarget): Promise<string | null> {
  const path = credentialPath(target);
  if (target.kind === "local") {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return null;
    }
  }
  // Remote: the file is mode 600 owned by runAsUid; the SSH user holds NOPASSWD
  // sudo (same transport as the spawn itself). `2>/dev/null` + empty-string
  // fallback means an absent/unreadable file reads as null.
  const out = await sshRun(target.target, `sudo -n cat ${path} 2>/dev/null`);
  return out.trim() === "" ? null : out;
}

/**
 * FAIL CLOSED: throw unless the target has a live Claude credential. No-op when
 * `CREW_SKIP_CRED_CHECK` is set. Call before spawning a claude-code agent.
 */
export async function assertClaudeCredentialLive(target: CredentialTarget): Promise<void> {
  if (process.env.CREW_SKIP_CRED_CHECK) return;
  const content = await readCredential(target);
  const status = credentialStatus(content);
  if (!status.live) {
    throw new Error(
      `crew: refusing to spawn claude-code — Claude credential ${status.reason} at ${credentialPath(target)}. ` +
        `Re-run agiterra-credential-sync (or re-login the anchor). Override with CREW_SKIP_CRED_CHECK=1.`,
    );
  }
}
