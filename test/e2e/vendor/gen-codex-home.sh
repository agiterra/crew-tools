#!/usr/bin/env bash
# gen-codex-home.sh — provision a per-agent CODEX_HOME for a bridged Codex agent.
#
# Mirrors ~/.wire/codex-launch.sh policy (isolated config.toml, persistent MCP
# entries so tool_search indexes them, tsx not bun, auth.json symlink) with the
# bridge-specific differences:
#   - NO 'wire' MCP: the codex-wire owns this agent's inbound SSE; a
#     second SSE under the same id recreates the dual-connection duel
#     (2026-06-10, Brioche's session).
#   - GITHUB_APP_TOKEN_CMD instead of a static GITHUB_TOKEN: installation
#     tokens expire in ~1h; github-tools v1.8.0+ mints on demand.
#   - Linear MCP included (palmier friction list, ENG-3330 wrap-up).
#
# Usage: AGENT_ID=<id> AGENT_PRIVATE_KEY=<pkcs8-b64> [WIRE_URL=...] \
#        [GH_APP_TOKEN_CMD=...] [LINEAR_MCP_URL=...] \
#        [CODEX_MODEL_CONTEXT_WINDOW=<n>] [CODEX_AUTO_COMPACT_TOKEN_LIMIT=<n>] gen-codex-home.sh
# Prints the CODEX_HOME path on stdout.
set -euo pipefail

: "${AGENT_ID:?AGENT_ID required}"
: "${AGENT_PRIVATE_KEY:?AGENT_PRIVATE_KEY required}"
WIRE_URL="${WIRE_URL:-http://localhost:9800}"
WIRE_EXTERNAL_URL="${WIRE_EXTERNAL_URL:-https://patisserie.ngrok.io}"
AGITERRA_REPOS="${AGITERRA_REPOS:-/Users/tim/Projects/Agiterra}"
GH_APP_TOKEN_CMD="${GH_APP_TOKEN_CMD:-bash /opt/fabrica/fabrica-v3/.claude/scripts/gh-app-token.sh}"   # /opt is the shared root; the /Users/tim/Projects/Fabrica path was laptop-era and does not exist on Patisserie (j:1521)
LINEAR_MCP_URL="${LINEAR_MCP_URL:-https://mcp.linear.app/mcp}"

# PER-SPAWN CONTEXT WINDOW (2026-10-01, ASK-47: Tim's paid 872k test, ONE lane). Unset = no line = codex's own default
# (272k; the fleet default does not change). CODEX_MODEL_CONTEXT_WINDOW sets model_context_window;
# CODEX_AUTO_COMPACT_TOKEN_LIMIT sets model_auto_compact_token_limit, for when the raised window alone still compacts
# near the old line. A value that is not a positive integer REFUSES the generation: a typo silently falling back to
# 272k would spend the paid test measuring the default.
CTX_STANZA=""
# AUTO-COMPACT DEFAULT 60000 (2026-10-06, AGI-187, Brioche GO 671886): the replay measured -54% lane tokens at the same
# outcome (peak context 152k -> 60k). It is the DEFAULT so a missed spawn-env line cannot drop it; CODEX_AUTO_COMPACT_TOKEN_LIMIT
# overrides, and the value 'off' omits the line (codex's own default). Revert rule: more review hits or a lost handoff.
case "${CODEX_AUTO_COMPACT_TOKEN_LIMIT:-60000}" in off) _acl="" ;; *) _acl="${CODEX_AUTO_COMPACT_TOKEN_LIMIT:-60000}" ;; esac
for _kv in "model_context_window=${CODEX_MODEL_CONTEXT_WINDOW:-}" "model_auto_compact_token_limit=${_acl}"; do
  _v="${_kv#*=}"
  [ -z "$_v" ] && continue
  case "$_v" in
    *[!0-9]*|0*) echo "gen-codex-home: ✗ ${_kv%%=*} value '${_v}' is not a positive integer — refusing to write config.toml" >&2; exit 1 ;;
  esac
  CTX_STANZA="${CTX_STANZA}${_kv%%=*} = ${_v}
"
  # Say where the value came from: the auto-compact line is the 60000 DEFAULT unless the spawn env set it (Baguette
  # 726657 read '(per-spawn override)' as a value her spawn had passed).
  _src="per-spawn override"
  [ "${_kv%%=*}" = model_auto_compact_token_limit ] && [ -z "${CODEX_AUTO_COMPACT_TOKEN_LIMIT:+x}" ] && _src="default (AGI-187)"
  echo "gen-codex-home: ${_kv%%=*} = ${_v} (${_src})" >&2
done

SPAWN_HOME="${HOME}/.wire/codex-spawn/${AGENT_ID}"
mkdir -p "$SPAWN_HOME"
ln -sfn "${HOME}/.codex/auth.json" "${SPAWN_HOME}/auth.json"

# RTK SHELL-OUTPUT COMPRESSION (2026-10-06, AGI-187, Tim via Brioche 670807): LANE_RTK=1 installs rtk's PreToolUse hook,
# which rewrites a Bash call (git, grep, tests…) to its `rtk <cmd>` form so the output reaches the model condensed.
# OFF unless LANE_RTK=1: the fleet default changes only after a measured replay shows a saving (AGI-187 acceptance).
# Codex skips a hook that is not TRUSTED, with no error, so the stanza below persists the trust. The key is
# "<realpath of hooks.json>:pre_tool_use:0:0"; the hash covers the handler only (measured equal across two homes with
# codex-cli 0.155.1). A Codex upgrade can change that hash: then hook-trust-check.py below prints ✗ at every spawn.
RTK_BIN="${RTK_BIN:-/opt/homebrew/bin/rtk}"
RTK_HOOK_HASH="sha256:f84d55ed8e3a6ed233bbb0538fe06ed37add24ff7707d653cb0c9c93e219dcbe"
HOOK_STANZA=""
if [ "${LANE_RTK:-0}" = 1 ]; then
  [ -x "$RTK_BIN" ] || { echo "gen-codex-home: ✗ LANE_RTK=1 but ${RTK_BIN} is not executable — refusing to write config.toml" >&2; exit 1; }
  printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"%s hook codex"}]}]}}\n' "$RTK_BIN" > "${SPAWN_HOME}/hooks.json"
  cat > "${SPAWN_HOME}/AGENTS.md" <<'RTKEOF'
<!-- rtk-owned: written by gen-codex-home.sh when LANE_RTK=1 (AGI-187) -->
# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk proxy <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.
RTKEOF
  HOOK_STANZA="[hooks.state.\"$(cd "$SPAWN_HOME" && pwd -P)/hooks.json:pre_tool_use:0:0\"]
trusted_hash = \"${RTK_HOOK_HASH}\"
"
  echo "gen-codex-home: LANE_RTK=1 — rtk PreToolUse hook installed" >&2
else
  # A re-generated home must not keep a hook from an earlier LANE_RTK=1 spawn of the same id.
  rm -f "${SPAWN_HOME}/hooks.json"
  grep -q '^<!-- rtk-owned' "${SPAWN_HOME}/AGENTS.md" 2>/dev/null && rm -f "${SPAWN_HOME}/AGENTS.md"
fi

# WALLET MCP (2026-09-23, Brioche 625247/625261): the same server Claude lanes run (wallet-claude-code), from the lane
# uid's plugin cache — the HIGHEST version whose server.ts AND installed @agiterra/wallet-tools both exist (a version dir
# can lack node_modules). Run by bun (the plugin runs it under bun; verified by an MCP handshake as _ephemeral the same
# day for Grok lanes). Identity via env exactly like wire-ipc. ⛔ WIRE_DASHBOARD_TOKEN is deliberately NOT passed: it
# unlocks the OPERATOR-ONLY tools (grant/revoke/access-mode). No usable cache → no stanza, and a warning on stderr.
BUN_BIN="${BUN_BIN:-/Users/tim/.bun/bin/bun}"
WALLET_ROOT=""
for _wd in $(ls -d "${HOME}/.claude/plugins/cache/agiterra/wallet-claude-code/"*/ 2>/dev/null | sed 's#/$##' | sort -V); do
  [ -f "$_wd/server.ts" ] && [ -d "$_wd/node_modules/@agiterra/wallet-tools" ] && WALLET_ROOT="$_wd"
done
WALLET_STANZA=""
if [ -n "$WALLET_ROOT" ]; then
  WALLET_STANZA="[mcp_servers.wallet]
command = \"${BUN_BIN}\"
args = [\"${WALLET_ROOT}/server.ts\"]
startup_timeout_sec = 30

[mcp_servers.wallet.env]
AGENT_ID = \"${AGENT_ID}\"
AGENT_NAME = \"${AGENT_NAME:-$AGENT_ID}\"
AGENT_PRIVATE_KEY = \"${AGENT_PRIVATE_KEY}\"
WIRE_URL = \"${WIRE_URL}\"
"
else
  echo "gen-codex-home: ⚠ no usable wallet-claude-code under ${HOME}/.claude/plugins/cache (server.ts + wallet-tools) — lane gets NO wallet MCP" >&2
fi

cat > "${SPAWN_HOME}/config.toml" <<EOF
# Auto-generated by codex-wire/scripts/gen-codex-home.sh for AGENT_ID=${AGENT_ID}.
# Hand-edits will be overwritten on next generation.
# 'wire' MCP deliberately OMITTED — the bridge owns inbound (see script header).

model = "${CODEX_MODEL:-gpt-6-sol}"
model_reasoning_effort = "${MODEL_REASONING_EFFORT:-high}"
${CTX_STANZA}approval_policy = "never"
sandbox_mode = "danger-full-access"

${HOOK_STANZA}
[features]
rmcp_client = true
# apps = false (2026-09-12, j:1521): Codex "Apps" are the OpenAI account's OAuth connectors — on this account
# GitHub as mividtim and Gmail. With the flag on (stable, default true) every lane gets a codex_apps MCP whose
# _add_review_to_pr posts PR reviews AS TIM (shufta, api#1887/#1888) and whose _send_email sends from his
# mailbox. Lanes act only as the GitHub App (gh-shim / agiterra-github); the operator's identity is never theirs.
apps = false

[mcp_servers.wire-ipc]
command = "tsx"
args = ["${AGITERRA_REPOS}/wire-ipc-codex/server.ts"]
startup_timeout_sec = 30

[mcp_servers.wire-ipc.env]
AGENT_ID = "${AGENT_ID}"
AGENT_NAME = "${AGENT_NAME:-$AGENT_ID}"
AGENT_PRIVATE_KEY = "${AGENT_PRIVATE_KEY}"
WIRE_URL = "${WIRE_URL}"
WIRE_EXTERNAL_URL = "${WIRE_EXTERNAL_URL}"

[mcp_servers.agiterra-github]
command = "tsx"
args = ["${AGITERRA_REPOS}/github-codex/server.ts"]
startup_timeout_sec = 30

[mcp_servers.agiterra-github.env]
AGENT_ID = "${AGENT_ID}"
AGENT_PRIVATE_KEY = "${AGENT_PRIVATE_KEY}"
GITHUB_APP_TOKEN_CMD = "${GH_APP_TOKEN_CMD}"
WIRE_URL = "${WIRE_URL}"

${WALLET_STANZA}
[mcp_servers.linear]
url = "${LINEAR_MCP_URL}"
# STATIC BEARER, not OAuth. Interactive OAuth cannot complete in a headless spawn:
# \`codex mcp login\` has no non-interactive flag, and its OAuth token store is
# per-CODEX_HOME, so even a successful login would not survive to the next lane.
# Without this line every lane declared an MCP it had no way to authenticate — the
# app-server transport died with AuthRequired and codex then dropped the server
# ENTIRELY, so the lane saw NO linear namespace at all rather than a broken tool
# (cruller, 2026-07-31). codex-bridge-launch.sh ALREADY mints and exports
# LINEAR_TOKEN via linear-app-token.sh (client_credentials, actor = 'Engineering
# Agent' app, ~30d, cached + auto-reminted); the token was there all along and only
# this reference was missing. Verified: POST /mcp with that Bearer -> HTTP 200
# handshake; identical POST with no token -> 401.
bearer_token_env_var = "LINEAR_TOKEN"

[mcp_servers.playwright]
# 2026-09-29 (Brioche 640640): browser FVs on Codex lanes. The same wallet-extension rig Claude lanes load via
# /opt/agiterra/etc/browser-mcp.json and Grok lanes via grok-bridge-launch.sh: a persistent per-lane profile,
# env scrubbed by the wrapper, the same two flags. Codex hands MCP servers a filtered env, so the wrapper's lane
# id is passed explicitly below. Tools appear as browser_*.
command = "/opt/agiterra/bin/wallet-browser-mcp.sh"
args = ["--headless", "--no-sandbox"]
startup_timeout_sec = 60

[mcp_servers.playwright.env]
AGENT_ID = "${AGENT_ID}"
EOF
chmod 600 "${SPAWN_HOME}/config.toml"
if [ "${LANE_RTK:-0}" = 1 ]; then
  # Ask codex itself whether it will run the hook. Warn, do not abort: the lane works without rtk, only unmeasured.
  CODEX_HOME="$SPAWN_HOME" python3 "$(dirname "$0")/hook-trust-check.py" "${PROJECT_DIR:-$PWD}" >&2 \
    || echo "gen-codex-home: ✗ rtk hook NOT trusted by codex — this lane runs WITHOUT rtk (AGI-187 measurement invalid)" >&2
fi
# CONFIG RECEIPT (2026-10-06, Baguette 671889): config.toml is 0600 under the lane uid, so the spawner cannot verify what
# the lane runs with. Copy the top-level model keys, READ BACK from the written file (not from the env that fed it), to a
# group-readable receipt: cat ${CONFIG_RECEIPT_DIR}/<agent>.txt. No secrets: only keys above the first [table].
# Warn-only: a receipt failure never blocks a spawn.
CONFIG_RECEIPT_DIR="${CONFIG_RECEIPT_DIR:-/tmp/agiterra-codex-config}"
{
  mkdir -p -m 1777 "$CONFIG_RECEIPT_DIR" 2>/dev/null
  _rcpt="${CONFIG_RECEIPT_DIR}/${AGENT_ID}.txt"
  {
    echo "# gen-codex-home config receipt agent=${AGENT_ID} uid=$(id -un) at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    awk '/^\[/{exit} /^(model|model_reasoning_effort|model_context_window|model_auto_compact_token_limit) *=/' "${SPAWN_HOME}/config.toml"
    if [ "${LANE_RTK:-0}" = 1 ]; then echo "lane_rtk = 1"; else echo "lane_rtk = 0"; fi
  } > "${_rcpt}.tmp.$$" && chmod 644 "${_rcpt}.tmp.$$" && mv -f "${_rcpt}.tmp.$$" "$_rcpt"
} || echo "gen-codex-home: ⚠ config receipt NOT written to ${CONFIG_RECEIPT_DIR} — the spawner cannot verify this lane's config" >&2
echo "$SPAWN_HOME"
