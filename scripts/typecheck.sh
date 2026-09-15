#!/bin/bash
# typecheck.sh — the gate this repository did not have (PR 91 review, M4).
#
# WHY. The reviewer's finding was exact: no tsconfig.json, no tsc in devDependencies, CI runs
# only the shared plugin-check workflow, and bun STRIPS types without checking them. "That is
# why F5's out-of-scope identifier can sit in the tree." On its first run this gate found a
# real defect in the F4 fix itself — cleanupCodexSpawn's catch block fell through returning
# `undefined`, so an unexpected teardown crash reached the RPC looking exactly like a clean
# no-op. Nothing else in the suite could see it.
#
# ⛔ WHY IT FILTERS. tsc typechecks the .ts sources it follows through imports, which includes
# @agiterra/wire-tools inside node_modules. Those 5 errors are real but they are another
# package's to fix, and a gate that can never go green is a gate nobody runs. So: dependency
# errors are PRINTED as information and do not fail the build; errors in this repo's own
# sources fail it. The filter is on PATH, never on error code — nothing is suppressed by kind.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

out=$(bunx tsc --noEmit 2>&1 || true)
own=$(printf '%s\n' "$out" | grep 'error TS' | grep -v 'node_modules' || true)
dep=$(printf '%s\n' "$out" | grep 'error TS' | grep 'node_modules' || true)

if [ -n "$dep" ]; then
  echo "── dependency-source type errors (informational, not this package's to fix) ──"
  printf '%s\n' "$dep" | sed 's/^/    /'
  echo
fi

if [ -n "$own" ]; then
  echo "⛔ TYPE ERRORS IN THIS PACKAGE'S OWN SOURCES:"
  printf '%s\n' "$own" | sed 's/^/    /'
  echo
  echo "typecheck: $(printf '%s\n' "$own" | grep -c .) error(s). Fix them — bun will run this code either way."
  exit 1
fi
echo "typecheck: clean — 0 errors in src/"
