# VERDICT: FAIL — PR 91, agiterra/crew-tools, head commit 06a6f9cbf945414ee00dda0cb8a924370d366e81

Independent re-review, 2026-09-15. Read-only. The only file written is this one.

**Narrower than the first FAIL, and the difference matters: the data-destruction class is genuinely
closed on both implementations, with working mutant controls. The residue is audit-record honesty on
the cross-uid path, plus two false claims in the packet.** Section 12 states exactly what flips this
to PASS.

---

## 0. Standing of this review

I am a fresh read-only child context with no memory of authoring the change, spawned under the same
host session as the original reviewer and bound to that thread's ref. **I am not a separate
principal.** My independence is scope-level: fresh context, no stake in the fixes, and every claim in
the author packet treated as a claim to check rather than as evidence. Where I could not verify
something myself, I say so rather than inheriting the author's word for it.

Authorization: Brioche (Engineering Director), seq 616252.

### Binding

| artifact | identity |
|---|---|
| head reviewed | `06a6f9cbf945414ee00dda0cb8a924370d366e81` |
| original reviewed base | `859bc9c83196b2605c0a30a1f14191f64f0d2425` |
| working copy | `/tmp/crew-preserve-impl`, `git rev-parse HEAD` = `06a6f9cb…` ✓ |
| working tree | clean except two untracked files: this review's predecessor and `row7-teardown.ts` (see N13) |
| original review preserved at | `/tmp/crew-preserve-impl/REVIEW-pr91-859bc9c8.md`, sha256 `3bcb190844895f690c976800456315c9c1dadb46989779f3465f36c458494222` |
| pruner reviewed | `/opt/agiterra/bin/codex-spawn-prune.sh`, sha256 `424358565089a7cdbeade1efbda7e220888b5b2804925dd70ae80af3928b7929` ✓ matches the brief |
| crew-service source read | `/opt/agiterra/crew-service/src/methods.ts`, sha256 `75eb2af0b5419dfeb32e1dfad45ff7e59e66dd43f27a151c0dd483705bf282c6`, mtime 2026-09-14 08:00 |

**Original verdict, preserved verbatim:**

> **VERDICT: FAIL** — bound to head commit `859bc9c83196b2605c0a30a1f14191f64f0d2425`.
>
> The retention idea is right and the local path largely implements it. The **remote (cross-uid)
> path — the one that actually tore down the `_ephemeral` lane in the incident — is not in the state
> the PR claims**: its only test is green for an environmental reason, and the generated shell
> program deletes entries the TypeScript classifier retains.

That verdict stands as issued and is not amended by this document.

---

## 1. Offline checks — rerun, not accepted

| check | author-reported | measured here | verdict |
|---|---|---|---|
| `bun test ./src/` | 124 pass / 0 fail | **285 pass / 0 fail**, 16 files, 767 expect() calls | reconciles |
| `bash scripts/typecheck.sh` | clean | **`typecheck: clean — 0 errors in src/`** (5 errors reported in `@agiterra/wire-tools` dependency source, correctly segregated as informational) | ✓ |
| pruner `--selftest` | 38/38 | **38 `ok` rows, 0 `FAIL` rows, `selftest: PASS`** | ✓ |

The 124/285 gap is not a false claim: 32 (`codex-spawn-preserve.test.ts`) + 92 (`orchestrator.test.ts`)
= 124, the two files this PR touches. State the denominator next time — a bare "124 pass" invites a
reader to think it is the suite.

**F1's acceptance check, run as specified:** `env -u AGENT_ID bun test ./src/` → **285 pass / 0 fail**.
The environmental dependence is genuinely gone, not merely commented about. I also scrubbed
`CODEX_HOME` and `STATE_DIR` for good measure; unchanged.

The two pre-existing failures I corrected to one in the first review are now zero: `@agiterra/wire-tools`
resolves (`bun.lock` updated), so `cli.test.ts` passes.

---

## 2. LENS 1 — SECURITY

**S1 is genuinely fixed.** `src/codex-spawn.ts:60` adds `SHELL_UNSAFE`, applied at `:117` to
`codexHome`, `stateDir` and `threadPath` before the shape guards. I re-ran my original injection
probe: `CODEX_HOME=/tmp/x'; cat $HOME/.codex/auth.json; echo '/codex-spawn/agentx` now yields
`resolveCodexSpawnPaths → null`, so no command is constructed. The remaining interpolants are
provably safe: `home` derives from a `SAFE_UID`-checked uid, `AUTH_TARGET` derives from `home`,
`RECEIPT` from the checked `stateDir` plus a `SAFE_SEGMENT` agent id and a generated timestamp.
`stateDir`'s second derivation at `:452` (`args.env?.STATE_DIR || dirname(paths.codexHome)`) is
covered either way, since a prefix of a checked path is itself checked.

**Credential handling remains correct and is now better tested.** Classification still uses
`lstat` + `readlink` only; `fs.rm` and `rm -rf --` unlink symlinks rather than following them. The
mutant-control positive controls assert the credential bytes survive on both implementations.

**New security-relevant findings: N4, N7** (below). Neither is an exposure of the OAuth credential.

Nothing else found in this lens.

## 3. LENS 2 — CORRECTNESS

**C1 is genuinely fixed on both implementations.** `:314` now reads `[ -e "$q" ] || [ -L "$q" ] || continue`,
and `:320` tests `[ -L "$q" ]` before `[ -f "$q" ]`, refusing to dispose a symlinked `.lock`. I
re-ran both of my original divergence fixtures (dangling `.lock`; `.lock` symlink to a real file)
and the shell now agrees with the classifier on both. This is the finding that actually deleted data,
and it is closed.

**The classifier is otherwise unchanged and still correct** on `cache/`, `tmp/`, `workspaces/`,
sqlite sidecars, unknown basenames, sockets, non-matching symlinks and empty lock directories.

**New finding N1 (the headline) is in this lens and lens 3.** Nothing else new in correctness.

## 4. LENS 3 — FAILURE PATHS

INTENT-before-removal still holds on both paths and is now better guarded (the `home-unreadable` and
`thread-pointer-in-disposal-set` refusals are both total and both audible). The local receipt path is
materially better: temp → fsync → rename, a real `finalize-failed` receipt, and a stated limitation
when even that cannot be written.

**And the whole of N1 lives here**: the same three fixes were not carried into the remote path.

## 5. LENS 4 — TEST QUALITY

**T1 is fixed well, and this is the strongest part of the change.** Four mutants × two
implementations, plus two positive controls, plus a shared auditor. Specifically good:

- `mutate()` (`codex-spawn-preserve.test.ts:309`) **throws if the replacement matched nothing**. A
  mutant control that silently failed to apply is worse than none, because it reports as evidence.
  This is the correct instinct and I did not ask for it.
- The auditor `failedRows()` includes **row 2** (`config.toml` must be gone), so a do-nothing mutant
  cannot read as clean. Without that row every mutant assertion would also pass against a classifier
  that removes nothing.
- Both positive controls exist, so "the auditor fails everything unconditionally" is excluded.
- The TS mutants drive **real removal** through the production `teardownLocal` via the `classify`
  seam — they are not scored against a parallel copy of the rules.
- Row 15's shell mutant reinstates `bf3fdb0`'s removal **and** drops the `$H` guard in one edit, so
  it cannot pass on the guard alone.

**T4 is fixed properly.** The mis-described assertion is gone and replaced by a runtime test that
forces `$H` onto the disposal list and requires the home to survive. A guard nobody has seen refuse
is indistinguishable from one that cannot; this one has now been seen to refuse.

**Row 13 and 13b** are real behavioural tests through a `writeReceipt` seam, and 13b's
`expect(w.calls()).toBe(3)` proves the retry actually ran rather than inferring it.

Remaining test-quality gaps are N1 (no remote-path coverage of the receipt failure branches), N8
(the gate is not in CI) and N10.

## 6. LENS 5 — ANYTHING ELSE

N3, N5, N6, N9, N11, N12, N13 below.

---

## 7. NEW FINDINGS

### N1 — HIGH — Four fixes were applied to the local path and left out of the remote path, and the packet reports them as FIXED without qualification

`src/codex-spawn.ts`. This is the same boundary error the original review was about, one layer in:
the cross-uid path is the incident path, and it is the path that did not receive the fix.

| original finding | local path | remote path |
|---|---|---|
| **F2** INTENT destroyed by the finalize write | **fixed** — `writeReceipt:273-281` writes `<path>.tmp`, `fh.sync()`, then `rename` | **NOT fixed** — `:343` still does `printf … > "$R"` directly on the live receipt |
| **F3** `state:"finalize-failed"` never assigned | **fixed** — `:510-522` writes a sibling `…finalize-failed` receipt, and says so when it cannot | **NOT fixed** — `CREW_FINALIZE_FAILED` produces a `result.failed` entry only; no receipt in that state is ever written remotely |
| **C2** unreadable home reported as a clean complete | **fixed** — `SpawnHomeUnreadable` at `:147`, caught at `:445`, `skipped:"home-unreadable"`, no receipt written | **NOT fixed** — the shell cannot distinguish EACCES from empty; the globs yield nothing, INTENT is written with empty sets, FINALIZE writes `state:"complete"` |
| **C3** `absent` never populated | **fixed** — `:457-465` in `teardownLocal` | **NOT fixed** — `teardownRemote` (`:530-570`) never pushes to `absent` |

**F2 remote, demonstrated rather than asserted.** `>` truncates at open, so a death or write failure
after the open destroys the record:

```
$ printf 'INTENT{"state":"in-progress","retained":[...]}' > R.json     # 68 bytes
$ /bin/sh -c 'kill -9 $$' > R.json                                     # redirect opens, then dies
$ wc -c < R.json
0
```

That is exactly the window the local fix closed and the remote one still has. On a cross-uid home the
operator frequently cannot list the directory themselves, so the receipt is the *only* artifact
telling them what was retained — the audit gap has more teeth there than locally, not less.

**Why this is the headline.** The author's disposition table marks F2, F3, C2 and C3 as flatly
"FIXED". Two of them were rated HIGH by both of us. A reader of that table concludes the five highs
are closed. On the path where the incident happened, two are not. The failure mode being reported is
identical to the one this whole change exists to prevent: a claim whose executor covers only half its
subject.

*Failure scenario:* a cross-uid lane is stopped; removal runs; the receipt filesystem fills during
FINALIZE. The receipt is left at zero bytes, `CREW_FINALIZE_FAILED` is the only trace, and because of
N2 the operator's `agent_stop` still returns `outcome: "stopped"`. Nothing on disk or in the response
names what was retained.

*Fix:* mirror temp+rename and the finalize-failed state into the generated script (both are a few
lines of `sh`), or — if that is deliberately deferred — say so in the docstring and in the
disposition, and downgrade those four rows to PARTIAL.

### N2 — HIGH (as a claim) / MEDIUM (as code) — F4 does not reach the RPC, and the packet says it does

The disposition row for F4 reads: *"FIXED — result returned; `stopAgent` returns `StopAgentResult`;
`{skipped?, removed, failed}` **on the RPC**."* The last clause is false, and I verified it in
crew-service source rather than inferring it:

- `/opt/agiterra/crew-service/src/methods.ts:848` — `crew.agent_stop` calls `await orch.stopAgent(p.id);`
  and **discards the return value entirely** (it is not even assigned). The response is
  `{...event, stopped: p.id}` with `outcome: "stopped"` set unconditionally after the call returns.
- `:981` — `crew.agent_close` captures `closeResult` but reads only `closeResult.fallbackUsed`. The
  new `teardown` field is forwarded into neither the audit event nor the response.

The MCP tools `agent_stop`/`agent_close` do not call the orchestrator directly; they go through
`crewRpc` (`src/mcp-server.ts:811,815`), as does the CLI (`src/cli.ts:149,167`). So **every real
caller reaches crew-service, and crew-service drops the field.** The library change is correct and
useful; the claim that it is visible at the RPC is not.

This is stronger than disclosure B. B says the integration is *unverified*. What I found is that it
is **verifiably not wired** — running it would not have surfaced the outcome either.

*Note of fairness:* crew-service is a separate package outside this PR, and the spec predicted zero
change there. The defect is the overclaim, not the omission.

### N3 — MEDIUM — The C4 docstring now states a falsehood about the pruner

`src/orchestrator.ts`, the C4 block, present tense: *"AND IT DOES NOT HONOUR THIS SPEC.
codex-spawn-prune.sh predates it and still does a whole-home `rm -rf` — run against a
stopped-but-preserved home it destroys exactly what this code retained… until then the prune script
is the sharp edge, not the safety net."*

The installed pruner at the sha the brief gave me does not behave that way. It was modified today at
15:17 and now carries a **content gate**: `home_retention()` (`:150-190`) refuses any home holding a
non-scaffolding entry, an unrecognised basename, an unreadable lock dir, a symlinked `.lock`, or a
home it cannot read; thread pointers are kept unconditionally; a home with a stop receipt is kept as
well. Its selftest exercises those refusals.

So the shipped docstring warns operators off a tool that has been made safe. It fails in the
cautious direction, which is why this is MEDIUM and not HIGH — but it is a false factual claim about
a named external tool, in durable source, and it is the **second instance of the class disclosure E
corrects**. Disclosure E was volunteered; this one was not, and it post-dates E.

*Fix:* update the docstring to describe the content gate and name the residual hazards (N4), or
pin the claim to the pruner sha it was true of.

### N4 — MEDIUM — The pruner is a third implementation of the classifier, and its `auth.json` rule diverges in the deletion direction

`/opt/agiterra/bin/codex-spawn-prune.sh:156`:

```sh
if [ -L "$e" ]; then
  [ "$base" = "auth.json" ] && continue      # treated as scaffolding
  printf 'symlink:%s' "$base"; return 0
fi
```

Both other implementations require the link **target** to equal `<HOME>/.codex/auth.json` before
calling it disposable (`codex-spawn.ts:198`, and `[ "$t" = "$A" ]` in the generated script). The
pruner checks the **name only**. A home whose `auth.json` points somewhere unexpected is RETAINED by
the classifier and counts as SCAFFOLDING to the pruner — so that home becomes prunable, and the
divergence expresses itself as deletion. The 38-row selftest never builds a mis-targeted `auth.json`
(its only fixtures at `:333,343` link to the real credential), so this is untested as well as
divergent.

To the script's credit, its own header says exactly the right thing — *"deriving the lists gives DATA
parity… It does NOT give ALGORITHM parity — `home_retention` below is a second implementation of the
rule, in a different language, and two implementations of one rule is exactly what review finding C1
was"* — and it declines to overclaim the mitigation. This finding is an instance of the hazard the
author already named, not a contradiction of it.

Secondary, lower: `load_contract()` reads `DISPOSABLE_BASENAMES` from the **installed** crew-tools
(`/opt/agiterra/crew-service/node_modules/@agiterra/crew-tools/src/codex-spawn.ts`), which today is the
containment build. Until crew-tools is redeployed the pruner classifies against the old contract. It
currently fails safe (an older list is not larger), but the coupling is undeclared and the direction
is not guaranteed for future edits.

### N5 — MEDIUM — The row-7 witness hash in the brief does not match any file on disk

The brief binds `docs/fvrow7-evidence/13-RAW-WITNESS.txt` to sha256
`3847fad5454df18dfa836474f5a699ada98aaec250590095c9e02ae107292a58`.

Measured: `a3712879cc833f917a237b7f1fbf28e8779e825e57d6f6131f79069e64a59faa`, 3260 bytes, mtime
**15:32**. I hashed every file in `docs/fvrow7-evidence/` and **none** matches the claimed value.

The file's own text explains the likely cause — it carries a *"NEGATIVE CONTROL, run 1 — WORDING
TIGHTENED (Brioche 616260…)"* revision. So the witness was edited after the hash was quoted. The
content is not thereby wrong, but **the immutability binding fails**: I cannot verify the version
that was certified, and a hash-bound evidence claim whose hash does not bind is not hash-bound.

### N6 — MEDIUM — A non-resuming relaunch overwrites the thread pointer, which bounds what this PR's preservation delivers

Observed in the author's own run 1, quoted in the witness: launched without `CODEX_RESUME_ON_START=1`,
*"the runtime logged 'startup: NOT resuming persisted thread — new session', abandoned 01a0a682-…,
started 01a0a683-… and **overwrote the pointer**."*

I accept Brioche's ruling that the mislaunch was a test-execution error and that default-off resume is
deliberate and ticketed (AGI-94). But a product fact falls out of it that nobody has stated: the
thread pointer this change goes to some trouble to retain — including a dedicated refusal guard — can
be **destroyed by the very next ordinary spawn of the same agent id**. `thread_history_1.sqlite`
survives, but nothing then names the thread it holds.

This is upstream of this PR and is not a defect in its code. It belongs in the spec and the docstring
because it materially bounds the claim "retention on stop composes with resume" (spec §2). Retention
composes with a *resuming* relaunch only.

### N7 — LOW-MEDIUM — The new fail-closed paths retain `config.toml`, which contains an Ed25519 private key

Per the author's own correction (disclosure E), `gen-codex-home.sh` writes `AGENT_PRIVATE_KEY = "…"`
into `config.toml` twice. Disposal is correctly justified on regeneration grounds, and the correction
notes that retaining it *"would leave the key sitting in a stopped home."*

That is now a live consequence of this PR's own hardening. Every path added or strengthened in this
round leaves `config.toml` in place: `skipped:"intent-undurable"`, the new `skipped:"home-unreadable"`
(C2), the new `skipped:"thread-pointer-in-disposal-set"` (M2), and the new S1 refusal
(`skipped:"unsafe-path"`). Each is correct as a data-safety decision; together they enlarge the
population of homes at rest holding a private key, and nothing says so.

Not an exposure on its own — the key is at rest in that file during normal operation too. Worth one
sentence in §5 of the spec so the tradeoff is recorded rather than discovered.

### N8 — LOW-MEDIUM — The typecheck and test gates exist but are not wired into CI

`package.json` gains `"test"` and `"typecheck"` scripts and `scripts/typecheck.sh`; `tsconfig.json` is
added. But `.github/workflows/pr-check.yml` is unchanged and calls only the shared
`agiterra/.github/.github/workflows/plugin-check.yml@main`; `grep -rn typecheck .github/` returns
nothing.

M4's finding was *"nothing catches it"*. An instrument an author must remember to run is a better
instrument, not yet a gate. **I cannot read the shared `plugin-check` workflow from this checkout**,
so I cannot say whether it happens to run `bun test` or `bun run typecheck`; I am reporting the local
fact, not asserting the shared workflow's contents.

### N9 — LOW — `rename` is atomic but its durability is not fsynced

`writeReceipt:281` writes a temp, fsyncs the **file**, then renames. The parent directory is never
fsynced, so after a power loss the rename may not have reached stable storage even though removal
proceeded. Atomicity for concurrent readers is achieved; crash-durability of INTENT — the property
spec §4 actually requires — is not fully. Second-order, and strictly better than what it replaced.

Minor companion: `fsOpen(tmp, "w", 0o640)` applies the mode only on creation, so a stale `.tmp`
left by an earlier crash is reused with its existing mode.

### N10 — LOW — The whole-home guard exists on the remote path only

The generated script gained `[ "$p" = "$H" ] && continue`. `teardownLocal` has no equivalent — and
the mutant test documents the absence: test 15 TS asserts `expect(await alive(f.codexHome)).toBe(false)`,
i.e. the local path happily removes the entire home when a classifier tells it to. That is correct as
a mutant demonstration and fine as a design choice, but the same belt-and-braces guard on one path
only is the asymmetry pattern of N1 in miniature.

### N11 — LOW — `SHELL_UNSAFE` is applied globally rather than at the shell boundary

`resolveCodexSpawnPaths` returns `null` — which becomes `skipped:"unsafe-path"`, i.e. no cleanup at
all — for any path containing `' " \` $ \ ; & | < > ( ) { } * ? ! # ~ [ ]` or whitespace controls,
**including on the local path, where no shell is involved**. Unreachable in practice on macOS home
paths, and it fails in the retention direction, so this is a note rather than a defect. Correct
placement is at the interpolation site in `teardownRemote`.

### N12 — LOW — The disclosure-E correction block is misplaced in the spec

The correction is inserted at `docs/stop-preservation-spec-20260915.md:196`, between items 1 and 2 of
§8's numbered test contract, **splitting that list**. The row it corrects is the `config.toml` row of
the §1 table at `:54`, which points forward to "the correction note below" ~145 lines away in an
unrelated section. The correction's content is honest and adequate — it names the false claim, the
mechanism (a scanner that only knows prefix-shaped tokens), and why the decision is unchanged. Only
its placement is wrong, and placement is what decides whether a reviewer finds it.

### N13 — LOW — An ad-hoc Phase B instrument is left untracked in the working copy

`/tmp/crew-preserve-impl/row7-teardown.ts` — an unreviewed script that calls
`removeCodexSpawnHome({agentId:"fvrow7", runtime:"codex", selfHome:"/Users/_ephemeral", …})` directly
against a real home. It is untracked so it will not merge, but it is the actual instrument of Phase B
and it is not listed in `docs/fvrow7-evidence/`. Name it in the evidence set, or remove it.

---

## 8. Disposition of all 19 original findings

Verdicts are mine, measured; the "author says" column is the claim I was checking.

| # | finding | sev | author says | **my verdict** | evidence |
|---|---|---|---|---|---|
| **F1** | Parity test green only via exported `AGENT_ID` | high | FIXED | **CONFIRMED FIXED** | `AGENT_ID` set explicitly at test `:199`; `env -u AGENT_ID bun test ./src/` → 285/0 |
| **C1** | Shell/TS divergence deletes retained entries | high | FIXED | **CONFIRMED FIXED** | `:314`, `:320`; both original fixtures re-run, shell now agrees with TS |
| **F2** | FINALIZE truncates INTENT in place | high | FIXED | **PARTIAL — local only** | `writeReceipt:273-281` fixed; remote `:343` still `> "$R"` (N1) |
| **F3** | `state:"finalize-failed"` never assigned | high | FIXED | **PARTIAL — local only** | `:510-522` + rows 13/13b; no remote equivalent (N1) |
| **T1** | No mutant controls | high | FIXED | **CONFIRMED FIXED, exceeds the ask** | 4 mutants × 2 implementations + 2 positive controls; `mutate()` refuses a no-op anchor |
| **S1** | Shell injection via manifest paths | high | FIXED | **CONFIRMED FIXED** | `SHELL_UNSAFE` at `:60`/`:117`; original probe now returns `null` |
| **F5** | Dead `removeRemote` / out-of-scope `receipt` | med | FIXED | **CONFIRMED FIXED** | both functions deleted; typecheck clean |
| **F4** | Result discarded by the orchestrator | med | FIXED, "on the RPC" | **PARTIAL — library only; the RPC claim is FALSE** | crew-service `methods.ts:848` discards it (N2) |
| **C2** | Unreadable home → `complete` | med | FIXED | **PARTIAL — local only** | `SpawnHomeUnreadable` local; remote cannot distinguish (N1) |
| **C4** | AGI-74 reverted, no replacement | med | FIXED beyond the ask | **PARTIAL — disclosure is good, one claim is false** | measured 832 MB cost is a real improvement; the pruner sentence is false (N3) |
| **T2** | e2e unwired, machine-specific, shipped in `src/` | med | FIXED (merge-blocking half) | **CONFIRMED as scoped** | moved to `test/e2e/`; out of `files:["src/"]`. Wiring remains follow-up, correctly stated |
| **S2** | Receipts world-readable | low-med | FIXED | **CONFIRMED FIXED** | `mode: 0o750` at `:265`, `0o640` at `:274` |
| **T4** | `rm -rf` assertion mis-described | low-med | FIXED | **CONFIRMED FIXED, properly** | comment corrected; runtime test forces `$H` onto the list and requires refusal |
| **T3** | Row 14 accept path mislabeled | low | FIXED | **CONFIRMED FIXED** | real `onlyDisposable()` fixture at `:541` |
| **M1** | Stale orchestrator docstring | low | FIXED | **FIXED, then re-broken** | the whole-home lie is gone; a new false claim replaced it (N3) |
| **C3** | Dead `absent` field | low | FIXED | **PARTIAL — local only** | `:457-465`; `teardownRemote` never populates it (N1) |
| **M2** | Thread retention holds by omission | low | FIXED | **CONFIRMED FIXED, exceeds the ask** | explicit refusal guard, total abort, and a test that watches it refuse |
| **M3** | `manifestDigest` comparator | low | FIXED | **CONFIRMED FIXED** | `:254` returns 0 on equality |
| **M4** | Nothing typechecks the repo | low | FIXED | **PARTIAL** | instrument exists and is clean; not a CI gate (N8) |

**Tally: 11 confirmed fixed, 7 partial, 1 fixed-then-re-broken. Zero regressions in the classifier
itself.**

---

## 9. The crew-service-stop integration gap — explicit assessment

**Asked plainly: should it block merge? No — but the F4 claim must be corrected before merge, and
that is a separate thing.**

Three distinct items are being run together in disclosure B, and they have different answers:

1. **"Stop → resume works end to end through crew-service" is not established.** Correct, and it
   cannot be established before merge: crew-service consumes crew-tools as an installed dependency,
   so the candidate can only run under the service after it is published and redeployed. Requiring
   the integration first inverts the dependency. **Not merge-blocking.** It is a rollout gate — the
   first post-deploy cross-uid stop should be watched, with the receipt read.

2. **The deployed build is containment and wrote 0 receipts.** That is the correct reading of
   "process quiescence only", and it means the candidate has never executed under the service at all.
   **Not merge-blocking; it raises the rollout risk**, because the first real exercise of this code
   in production will be its first exercise anywhere outside fixtures and one direct invocation.

3. **F4's outcome does not reach the RPC at all (N2).** This is the item that changes the picture.
   The gap is not "untested"; it is "not wired" — I read `methods.ts` and the return value is
   discarded. So even a successful post-merge integration run would show an operator
   `outcome: "stopped"` on a stop that fail-closed and removed nothing. **The false claim in the
   disposition is merge-blocking as a correctness-of-record matter; the crew-service wiring itself is
   a follow-up ticket on that repo.**

**What Phase B did and did not establish.** Phase B invoked the candidate directly out of the working
copy via `row7-teardown.ts` (N13), bypassing crew-service entirely. It therefore witnesses the
library's behaviour against a real home — which is real evidence, and better than a fixture — but it
carries no information about the service path. Saying so plainly, as disclosure B does, is the right
call and I am not marking it down for it.

---

## 10. The row-7 witness — judged on its own terms

**What the witness establishes, on its content:** a nonce-free recall prompt (quoted literally, and
corroborated by the per-item locator showing `ord=20 contains-nonce=False`) drew a reply whose sha256
equals the sha256 of a nonce established before any teardown. The paired negative control — the same
recall text, same fixture, fresh thread — returned `NO-RECALL`. That pairing is what turns a
structural observation into a behavioural one, and the author is right that Brioche's challenge
improved it.

**Its disclosed limits, which I accept as stated:** the delivery channel differs between run 1
(launch kickoff) and run 2 (Wire seq 616228), so what is controlled is thread selection, not delivery.
And the pointer was repaired from a preserved byte-original between runs, so the lifecycle witnessed
is "resume works when the pointer is intact", not "an uninterrupted stop→resume preserves the
pointer". Brioche's ruling that the mislaunch is an execution error is defensible, because
default-off resume is deliberate and ticketed — but see N6 for the product fact that falls out of it
and is not yet written down anywhere.

**Two limits on my own reading, stated so nobody inherits more confidence than I have:**

1. **The hash does not bind (N5).** The version I read is not the version the brief certified.
2. **The transcript locator is a self-reported measurement.** The `contains-nonce` flags and the
   item ordinals are the author's derivation from a sqlite table under `/Users/_ephemeral`. I did not
   re-query that database — it is cross-uid and outside a read-only reviewer's reach here. So I
   verified the witness's internal consistency and the reply-vs-expected sha, not the underlying
   transcript. An author's account of their own instrument is a claim; this one is detailed,
   falsifiable and internally coherent, which is most of what a witness can be. It is not
   independent corroboration.

**Verdict on row 7: partially covered, and honestly labelled.** Phase A is a real persistence test in
the suite. Phase B is real but carries a repair inside its scope and does not touch the service path.
The test file says so in its own header rather than implying coverage with a green tick, which is the
correct way to ship a partial row.

---

## 11. Disclosures, weighed

| | my assessment |
|---|---|
| **A** — Phase B used a repaired pointer | **Accepted as framed.** The ruling is defensible; default-off resume is deliberate and ticketed. But it surfaces an unstated product fact — N6 — that belongs in the spec. |
| **B** — crew-service integration unverified | **Understated, not overstated.** Section 9: it is not merely unverified, the field is dropped (N2). Disclosing it was right; the disclosure did not go far enough. |
| **C** — the raw witness | **Judged in section 10.** Strong content, honest limits, broken hash binding (N5). |
| **D** — C4 is a disclosed hazard, not closed | **Accepted, and now inaccurate in the other direction.** The pruner is materially safer than D and the docstring imply (N3), while retaining a real untested divergence (N4). |
| **E** — false evidentiary claim, self-corrected | **The correction is adequate in content and misplaced in the document (N12).** Naming the mechanism — a scanner that only knows the token shapes it was taught — is the part that generalises, and it is there. Credit where due: this was volunteered. It is weakened only by N3 being a second instance of the same class, post-dating E and not volunteered. |

---

## 12. What flips this to PASS

1. **Mirror F2 and F3 into the generated script** — write the remote receipt to a temp and `mv` it;
   emit a `finalize-failed` receipt when the finalize write fails. Or, if deferred: downgrade F2, F3,
   C2, C3 to PARTIAL in the disposition and say in the docstring that the remote path's receipt is
   best-effort. Either is acceptable; silence is not. **(N1)**
2. **Correct the F4 claim.** Strike "on the RPC". Open a crew-service ticket to forward `teardown`
   in `agent_stop`/`agent_close`. **(N2)**
3. **Correct the C4 docstring** to describe the pruner's content gate, and add the `auth.json`
   target check to the pruner with a selftest row. **(N3, N4)**
4. **Re-hash the row-7 witness** and restate the binding, or state that it was revised after
   certification. **(N5)**
5. **One sentence each** in the spec for N6 (a non-resuming relaunch clobbers the pointer) and N7
   (fail-closed paths retain a private key), and move the E correction next to the row it corrects
   **(N12)**.

Items 1-3 are merge-blocking. Items 4-5 are documentation and can ride a follow-up commit.

---

## 13. Summary

The work between `859bc9c8` and `06a6f9cb` is substantially good, and two parts of it are better than
what I asked for: the mutant harness refuses to run an unapplied mutation and carries its own positive
controls, and M2 grew a refusal guard that has been watched refusing. **C1 — the defect that actually
deleted data — is closed on both implementations and is now covered by controls that have been shown
capable of failing.** F1, S1, F5, S2, T4, T3, M3 are closed. 285 tests pass, including with the
environment scrubbed.

It fails on the same axis as the first review, one layer in: **four fixes were applied to the local
path and not carried to the cross-uid path, and the packet reports them as closed.** Two of those were
rated HIGH by both the author and me. Added to that are a false claim about where F4 surfaces, a false
claim about the pruner in shipped source, and an evidence hash that does not bind.

None of the residue destroys user data. All of it degrades the audit record on the path where the
operator can see least — and the packet's own table would tell a reader otherwise. That is what makes
it FAIL rather than PASS-WITH-FINDINGS, and the remedy in section 12 is small.

**Do not read this document as a merge, release or completion decision. It is a scope review.**

---

*Bound to `06a6f9cbf945414ee00dda0cb8a924370d366e81`. Written 2026-09-15 by an independent read-only
re-review context. Original verdict at `859bc9c8` preserved verbatim in section 0 and unamended.*
