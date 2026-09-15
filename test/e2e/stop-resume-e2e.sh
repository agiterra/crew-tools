#!/bin/bash
# Row 7: stop -> resume with REAL git objects and REAL conversation state.
# Disposable fixture only. Never a live lane, never an incident original.
set -uo pipefail
pass=0; fail=0
ck(){ if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok    $1"; else fail=$((fail+1)); echo "  FAIL  $1: want [$2] got [$3]"; fi; }

FIX=$(mktemp -d /tmp/e2e-spawn-XXXXXX)
export HOME_FIX="$FIX"
SD="$FIX/.wire/codex-spawn"; CH="$SD/e2elane"
mkdir -p "$CH/workspaces" "$FIX/.codex"
echo 'CREDENTIAL' > "$FIX/.codex/auth.json"
ln -sfn "$FIX/.codex/auth.json" "$CH/auth.json"
printf 'regenerable\n' > "$CH/config.toml"
: > "$CH/installation_id"

# --- REAL git repo with REAL objects, unpushed ---
R="$CH/workspaces/proj"; mkdir -p "$R"
git -C "$R" init -q; git -C "$R" config user.email e2e@t; git -C "$R" config user.name e2e
echo 'line one' > "$R/harness.cjs"; git -C "$R" add -A; git -C "$R" commit -qm "base"
git -C "$R" checkout -q -b e2e/work
echo 'line two' >> "$R/harness.cjs"; git -C "$R" add -A; git -C "$R" commit -qm "logic commit"
HEAD_BEFORE=$(git -C "$R" rev-parse HEAD); BR_BEFORE=$(git -C "$R" rev-parse --abbrev-ref HEAD)
COUNT_BEFORE=$(git -C "$R" rev-list --count HEAD)

# --- REAL conversation state ---
/usr/bin/sqlite3 "$CH/thread_history_1.sqlite" "create table t(id text, body text); insert into t values('th-1','the conversation');"
/usr/bin/sqlite3 "$CH/thread_history_1.sqlite" "pragma journal_mode=wal;" >/dev/null
/usr/bin/sqlite3 "$CH/thread_history_1.sqlite" "insert into t values('th-2','after wal');"
printf '{"threadId":"01a0-e2e","agentId":"e2elane","projectDir":"%s"}\n' "$R" > "$SD/e2elane.thread.json"

echo "== STOP =="
bun -e '
 import {removeCodexSpawnHome} from "./src/codex-spawn.ts";
 const home=process.env.HOME_FIX;
 const r=await removeCodexSpawnHome({agentId:"e2elane",runtime:"codex",selfHome:home,
   env:{STATE_DIR:home+"/.wire/codex-spawn"}},{log:()=>{}});
 console.log("removed="+r.removed.length+" failed="+r.failed.length+" skipped="+(r.skipped??"-"));
' | sed 's/^/  /'

ck "git objects survive the stop"        "$HEAD_BEFORE" "$(git -C "$R" rev-parse HEAD 2>/dev/null)"
ck "branch survives"                     "$BR_BEFORE"   "$(git -C "$R" rev-parse --abbrev-ref HEAD 2>/dev/null)"
ck "commit count survives"               "$COUNT_BEFORE" "$(git -C "$R" rev-list --count HEAD 2>/dev/null)"
ck "git fsck clean after stop"           "0" "$(git -C "$R" fsck --no-progress >/dev/null 2>&1; echo $?)"
ck "conversation rows survive"           "2" "$(/usr/bin/sqlite3 "$CH/thread_history_1.sqlite" 'select count(*) from t;' 2>/dev/null)"
ck "thread pointer survives"             "01a0-e2e" "$(python3 -c "import json;print(json.load(open('$SD/e2elane.thread.json'))['threadId'])" 2>/dev/null)"
ck "scaffolding config.toml removed"     "absent" "$([ -e "$CH/config.toml" ] && echo present || echo absent)"
ck "auth.json symlink removed"           "absent" "$([ -L "$CH/auth.json" ] && echo present || echo absent)"
ck "CREDENTIAL ITSELF untouched"         "CREDENTIAL" "$(cat "$FIX/.codex/auth.json" 2>/dev/null)"

echo "== RESUME (the REAL provisioner, HOME redirected to the fixture) =="
HOME="$FIX" AGENT_ID=e2elane AGENT_NAME=e2elane AGENT_PRIVATE_KEY=dummy WIRE_URL=http://127.0.0.1:9800 \
  bash /Users/tim/Projects/Agiterra/codex-wire/scripts/gen-codex-home.sh >/dev/null 2>&1
ck "provisioner re-created config.toml"  "present" "$([ -f "$CH/config.toml" ] && echo present || echo absent)"
ck "provisioner re-linked auth.json"     "present" "$([ -L "$CH/auth.json" ] && echo present || echo absent)"
ck "git objects STILL intact after resume" "$HEAD_BEFORE" "$(git -C "$R" rev-parse HEAD 2>/dev/null)"
ck "conversation STILL intact after resume" "2" "$(/usr/bin/sqlite3 "$CH/thread_history_1.sqlite" 'select count(*) from t;' 2>/dev/null)"
ck "worktree clean (no content mutated)" "" "$(git -C "$R" status --porcelain 2>/dev/null)"

rm -rf "$FIX"
echo "E2E: $pass passed, $fail failed"; [ "$fail" -eq 0 ]
