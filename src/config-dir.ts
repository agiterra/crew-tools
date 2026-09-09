/**
 * Per-agent CLAUDE_CONFIG_DIR — crew-service Phase 2 increment #2 (Option B).
 *
 * Each claude-code agent gets an isolated config dir at
 * `$HOME/.claude-agents/<agent-id>`, seeded at spawn time by a shell snippet
 * injected into the launch command (same one-code-path-for-local-and-remote
 * approach as SOURCE_NEAREST_ENV — the snippet runs in the spawn shell, in
 * the home the agent actually runs under).
 *
 * SHARED (symlinked into the real ~/.claude — see the 2026-07-01 _ephemeral
 * home survey in Fondant's vault):
 *   - .credentials.json          — ONE fleet credential, fanned by credential-sync;
 *                                  per-agent copies would recreate the 401-rot
 *   - plugins/                   — installed_plugins.json + cache; without this the
 *                                  wire plugin can't load and the agent never connects
 *   - settings.json              — hooks
 *   - remote-settings.json, policy-limits.json, mcp-needs-auth-cache.json — shared
 *                                  policy/caches, harmless and avoids re-auth churn
 * ISOLATED (everything else lands in the per-agent dir): projects/ (session
 * transcripts), todos/, statsig/, telemetry/, history.jsonl, backups/,
 * shell-snapshots/ — the cross-agent bleed this increment removes.
 *
 * A minimal `.claude.json` is seeded so a fresh isolated dir doesn't park the
 * boot on first-run dialogs (onboarding, bypass-permissions acceptance) that
 * launchd/screen can't click through.
 *
 * Escape hatch: the snippet only fires when CLAUDE_CONFIG_DIR is unset — pass
 * `CLAUDE_CONFIG_DIR=$HOME/.claude` in the spawn env to opt back into the
 * shared dir (needed e.g. to resume a pre-isolation agent whose CC session
 * transcript lives in the shared ~/.claude).
 */

/** Entries shared from the real ~/.claude into the per-agent config dir. */
export const SHARED_CONFIG_ENTRIES = [
  ".credentials.json",
  "plugins",
  "settings.json",
  "remote-settings.json",
  "policy-limits.json",
  "mcp-needs-auth-cache.json",
] as const;

/**
 * Seed state that suppresses first-run dialogs in a fresh config dir.
 * `hasCompletedOnboarding` skips global onboarding; the per-project
 * `hasTrustDialogAccepted` skips the folder-trust dialog, which otherwise
 * parks a fresh isolated boot exactly like the dev-channel prompt does
 * (caught by the fondant-configdir-gate dogfood, 2026-07-01). Bypass-mode
 * acceptance needs no seeding — it rides the symlinked settings.json.
 */
function seedClaudeJson(projectDir: string): string {
  return JSON.stringify({
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      [projectDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  });
}

/**
 * Build the POSIX-sh setup snippet for an agent's isolated config dir.
 * Composes into the launch chain: `cd … && exports && env && SNIPPET && claude …`.
 *
 * Failure semantics: a failed mkdir/symlink exits the spawn shell (fail closed —
 * an agent missing its credential or plugins symlink boots broken in ways that
 * are worse than not booting). "Already exists" is idempotent, not an error,
 * so resume and relaunch reuse the dir.
 */
export function buildConfigDirSetup(agentId: string, projectDir: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId)) {
    throw new Error(`buildConfigDirSetup: unsafe agent id '${agentId}'`);
  }
  const entries = SHARED_CONFIG_ENTRIES.join(" ");
  // The seed JSON rides inside a single-quoted sh string; POSIX quoting for
  // any embedded single quote is '\'' (end, escaped quote, reopen).
  const seedJson = seedClaudeJson(projectDir).replaceAll("'", `'\\''`);
  return (
    // Isolation requires a FILE credential: setting CLAUDE_CONFIG_DIR at all
    // makes CC ignore the macOS keychain (verified empirically on CC 2.1.198,
    // 2026-07-01 — even CLAUDE_CONFIG_DIR=$HOME/.claude boots "Not logged in"
    // on a keychain-auth host). Fleet homes carry claudeAiOauth in
    // .credentials.json (credential-sync fan) → isolate; keychain-auth hosts
    // (operator laptops) → skip loudly and keep today's shared behavior.
    `if [ -z "\${CLAUDE_CONFIG_DIR:-}" ] && ! grep -qs claudeAiOauth "$HOME/.claude/.credentials.json"; then ` +
    `echo "[crew] config-dir isolation skipped for ${agentId}: no claudeAiOauth file credential (keychain-auth host)"; ` +
    `fi; ` +
    `if [ -z "\${CLAUDE_CONFIG_DIR:-}" ] && grep -qs claudeAiOauth "$HOME/.claude/.credentials.json"; then ` +
    `export CLAUDE_CONFIG_DIR="$HOME/.claude-agents/${agentId}"; ` +
    `mkdir -p "$CLAUDE_CONFIG_DIR" || exit 90; ` +
    // .credentials.json MUST be a live symlink to the fanned credential, ALWAYS
    // re-linked (ln -sf) — never a skip-if-exists copy. A stale REAL file here
    // (left by older code or a prior spawn) shadows both the live fanned
    // credential AND the CLAUDE_CODE_OAUTH_TOKEN env, so it silently expires and
    // 401s the agent while the real ~/.claude credential is perfectly valid
    // (profiterole canary, 2026-07-06 — expired 07-03 copy in a reused dir).
    // Per-lane ACCOUNT choice (Tim 2026-09-09): CLAUDE_ACCOUNT=<slot> in the spawn env
    // links the lane to the fan's per-slot copy ~/.claude/accounts/<slot>.credentials.json
    // (agiterra-credential-sync writes one per slot in the root store) instead of the
    // home's pinned/active main copy — so a lane can draw on the OTHER subscription's
    // quota. The choice is recorded in the lane dir (.claude-account) and is STICKY: a
    // resume without the env var keeps it (cred-symlink-heal honours the file too).
    // FAIL CLOSED when the chosen slot has no fanned copy: a lane silently launched on
    // the wrong account defeats the only reason the account was chosen.
    `if [ -z "\${CLAUDE_ACCOUNT:-}" ] && [ -f "$CLAUDE_CONFIG_DIR/.claude-account" ]; then CLAUDE_ACCOUNT=$(cat "$CLAUDE_CONFIG_DIR/.claude-account"); fi; ` +
    `if [ -n "\${CLAUDE_ACCOUNT:-}" ]; then ` +
    `case "$CLAUDE_ACCOUNT" in *[!a-z0-9-]*) echo "[crew] CLAUDE_ACCOUNT '$CLAUDE_ACCOUNT' is not a slot name (a-z0-9-)" >&2; exit 94;; esac; ` +
    `if [ ! -e "$HOME/.claude/accounts/$CLAUDE_ACCOUNT.credentials.json" ]; then ` +
    `echo "[crew] CLAUDE_ACCOUNT '$CLAUDE_ACCOUNT': no fanned copy at $HOME/.claude/accounts/$CLAUDE_ACCOUNT.credentials.json (unknown slot, or the credential fan has not written it) — refusing to spawn on the wrong account" >&2; exit 94; ` +
    `fi; ` +
    `ln -sf "$HOME/.claude/accounts/$CLAUDE_ACCOUNT.credentials.json" "$CLAUDE_CONFIG_DIR/.credentials.json" || exit 91; ` +
    `printf %s "$CLAUDE_ACCOUNT" > "$CLAUDE_CONFIG_DIR/.claude-account" || exit 91; ` +
    `elif [ -e "$HOME/.claude/.credentials.json" ]; then ` +
    `ln -sf "$HOME/.claude/.credentials.json" "$CLAUDE_CONFIG_DIR/.credentials.json" || exit 91; ` +
    `fi; ` +
    `for e in ${entries}; do ` +
    `if [ "$e" = ".credentials.json" ]; then continue; fi; ` +
    `if [ -e "$HOME/.claude/$e" ] && [ ! -e "$CLAUDE_CONFIG_DIR/$e" ]; then ` +
    `ln -s "$HOME/.claude/$e" "$CLAUDE_CONFIG_DIR/$e" || exit 91; ` +
    `fi; done; ` +
    `if [ ! -f "$CLAUDE_CONFIG_DIR/.claude.json" ]; then ` +
    `printf %s '${seedJson}' > "$CLAUDE_CONFIG_DIR/.claude.json" || exit 92; ` +
    // Login state is marked by `oauthAccount` in .claude.json, not (only) by
    // the credential file — a fresh isolated dir without it boots "Not logged
    // in" and CC then disables dev channels, so the wire plugin never loads
    // (fondant-configdir-gate dogfood, 2026-07-01). Copy it from the anchor.
    `if [ -f "$HOME/.claude.json" ]; then ` +
    `python3 -c 'import json,os; p=os.environ["CLAUDE_CONFIG_DIR"]+"/.claude.json"; h=json.load(open(os.path.expanduser("~/.claude.json"))); d=json.load(open(p)); d.update({k:h[k] for k in ["oauthAccount"] if k in h}); json.dump(d,open(p,"w"))' || exit 93; ` +
    `fi; fi; fi`
  );
}
