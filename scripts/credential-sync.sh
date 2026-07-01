#!/usr/bin/env bash
#
# agiterra-credential-sync — fleet Claude-subscription credential fan-out.
#
# THE PROBLEM (2026-06-30): every fleet identity (personae + the shared
# `_ephemeral` spawn pool) authenticates to Claude with a file credential at
# `~/.claude/.credentials.json`. They were all copies of ONE subscription, so
# they shared ONE OAuth refresh token. When any copy's claude-code refreshed,
# the provider ROTATED that refresh token — invalidating every other copy →
# cascade 401s. herald and _ephemeral both died this way (expired 19:5x,
# refresh broken), which halts the whole fleet: NOTHING can spawn (engineers
# all run as `_ephemeral`) and Slack (herald) goes dark.
#
# THE FIX: one healthy identity is the ANCHOR (keeps its FULL credential and
# refreshes normally). Every other identity gets the anchor's credential with
# the REFRESH TOKEN STRIPPED (access-token-only) — verified sufficient to auth
# 2026-06-30. A refresh-token-less copy physically CANNOT rotate the anchor's
# token, so copies never contend. Re-running this far more often than the
# access-token lifetime (~8h) via a LaunchDaemon keeps copies always-fresh, so
# they never even reach their own refresh threshold. If the anchor itself ever
# fully dies, the fleet degrades together (visible) and the operator re-logs-in
# the anchor once — the "centralized refresh" model.
#
# Machine-local: fans among identity homes on the box it runs on. Deploy one
# per spawn host with its own healthy anchor. Stopgap until the federated
# crew-service (Phase 3) owns credential provisioning.
#
# Env overrides: CRED_ANCHOR (default brioche), CRED_SYNC_LOG.
set -uo pipefail

ANCHOR="${CRED_ANCHOR:-brioche}"
LOG="${CRED_SYNC_LOG:-/tmp/agiterra-credential-sync.log}"
# Root (LaunchDaemon) writes any home directly; a manual run as `tim` uses the
# box's broad NOPASSWD sudo. A function (not an array) keeps this safe under
# `set -u` on macOS's stock bash 3.2, where "${EMPTY[@]}" is an unbound error.
if [ "$(id -u)" = "0" ]; then run() { "$@"; }; else run() { sudo -n "$@"; }; fi

log() { echo "$(date '+%Y-%m-%dT%H:%M:%S%z') $*" | tee -a "$LOG" >&2; }

SRC="/Users/$ANCHOR/.claude/.credentials.json"
now=$(date +%s)

if ! run test -f "$SRC"; then log "ABORT: anchor cred $SRC missing"; exit 1; fi
anchor_json=$(run cat "$SRC")
if ! printf '%s' "$anchor_json" | jq -e '.claudeAiOauth.accessToken' >/dev/null 2>&1; then
  log "ABORT: anchor '$ANCHOR' has no claudeAiOauth.accessToken"; exit 1
fi
exp=$(printf '%s' "$anchor_json" | jq -r '.claudeAiOauth.expiresAt // 0')
if [ "$((exp/1000))" -le "$now" ]; then
  # Never fan a dead credential — leave copies on their last-good until the
  # anchor self-heals. Loud so a stuck anchor is visible in the log.
  log "SKIP: anchor '$ANCHOR' cred EXPIRED (expiresAt=$exp) — leaving copies on last-good; anchor needs re-login"
  exit 0
fi

# Access-token-only block: strip the refresh token so copies cannot rotate.
stripped=$(printf '%s' "$anchor_json" | jq -c '.claudeAiOauth | (if has("refreshToken") then del(.refreshToken) else . end)')

fanned=0
for home in /Users/*/; do
  id=$(basename "$home")
  case "$id" in "$ANCHOR"|tim|Shared|Guest|.localized) continue;; esac
  d="${home}.claude"
  run test -d "$d" || continue
  t="$d/.credentials.json"
  own=$(run stat -f '%Su:%Sg' "$home")
  # Preserve the target's existing file (its mcpOAuth etc.); replace only the
  # Claude-subscription block. Tolerate a missing/corrupt existing file.
  existing=$(run cat "$t" 2>/dev/null || echo '{}')
  printf '%s' "$existing" | jq empty >/dev/null 2>&1 || existing='{}'
  merged=$(printf '%s' "$existing" | jq --argjson c "$stripped" '.claudeAiOauth = $c')
  # Atomic write: a running claude may read this file at any moment, and this
  # runs every few minutes. Stage a sibling temp then rename (atomic on the
  # same filesystem) so a reader never sees a half-written file.
  tmp="${t}.tmp.$$"
  printf '%s' "$merged" | run tee "$tmp" >/dev/null
  run chown "$own" "$tmp"
  run chmod 600 "$tmp"
  run mv -f "$tmp" "$t"
  fanned=$((fanned+1))
done
log "OK: fanned access-token-only cred from '$ANCHOR' (valid until $(date -r $((exp/1000)))) to $fanned identities"
