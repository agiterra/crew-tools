# BRIEF — Torta: AGI-69 (roster false-negative) + AGI-73 (bridge lifecycle reap)

You are Torta, a codex implementer under Fondant (Toolsmith) on the Agiterra AGI board.
Report to fondant via wire-ipc send_message (dest fondant) at every checkpoint. Workspace:
/Users/_ephemeral/torta-lane (clone of agiterra/crew-tools @ 2057892). Branch
`agi-69-73-lifecycle`; commit locally — NO push credential; fondant pulls/verifies/pushes.
Never modify /opt/agiterra/* or /Users/tim/Projects/* (read-only ok). bun test baseline is
155/155 — keep it green every commit.

## TASK 1 — AGI-69: crew_agent_read/roster returns 'no agent' for a LIVE codex agent (P-Med est3)
Field case 2026-07-28: a live, wire-responsive codex agent didn't show in crew_agent_list /
crew_agent_read (screen hardcopy false-negative class). Investigate src/orchestrator.ts
readAgent/listAgents + src/screen.ts hardcopy path + src/reconciler.ts: how can a live screen
report as absent/dead? Known adjacent bugs already fixed (screen socket-dir split via findScreen
absolute path; hardcopy read-before-write race in 2.13.2) — look for what REMAINS: e.g. roster
sourced from crews.db rows that a false-negative reconcile deleted, hardcopy of a screen whose
owner uid differs from the MCP process uid, stale .in_use/socket handling. Deliver: root cause
(file:line + repro test) + fix so liveness checks fail-open toward 'alive' when evidence is
ambiguous (fail-closed only on provable death — that's the repo's standing rule).

## TASK 2 — AGI-73: agent_close leaves zombie bridge stacks (P3 est2)
Field case 2026-07-29: kolache + eclair were agent_close'd but their full stacks (screen →
launch shell → codex-wire bridge → codex app-server x2) survived 11-21h. closeAgent (see 2.21.5
'reaps the whole process GROUP + verifies death') apparently didn't cover this path — find why
(close vs stop vs reap path? bridge runs in the screen but /exit is a claude-ism — codex
bridges don't take /exit). Fix: closeAgent/stopAgent must detect a non-claude (bridge) runtime
and SIGTERM the process group (the bridge's SIGTERM handler cleanly kills its app-server —
field-verified today), then verify the tree is dead before deleting the row. Add tests.

## Checkpoints (wire-ipc to fondant)
1. STEP-0 ack after repo boots (bun install; bun test 155/155).
2. AGI-69 root-cause (file:line) before fixing.
3. Done: branch + SHAs + test results per task.
Keep turns small; runtime auto-resumes interrupted turns — continue, never redo setup.
