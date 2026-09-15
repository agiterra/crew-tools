# VERDICT: FAIL — PR 91, agiterra/crew-tools, head commit 859bc9c83196b2605c0a30a1f14191f64f0d2425

Independent review, 2026-09-15. Reviewer had no part in authoring the change. Read-only; the only
file written is this one, at the requesting agent's explicit instruction.

**Contents:** Test-baseline correction · Lens 1 SECURITY (S1-S2, credential handling) · Lens 2 CORRECTNESS (C1-C4) · Lens 3 FAILURE PATHS (F1-F5, incl. the two questions set: INTENT-before-removal on the remote path, and whether finalize failure can report success) · Lens 4 TEST QUALITY (T1-T5, incl. a blunt verdict on the four rewritten orchestrator.test.ts assertions) · Lens 5 ANYTHING ELSE (M1-M4) · Per-finding disposition table · Minimum to reach PASS.

**Summary.** The retention idea is right and the local path largely implements it. The **remote
(cross-uid) path — the one that actually tore down the `_ephemeral` lane in the incident — is not in
the state the PR claims**: its only test is green for an environmental reason, and the generated
shell program deletes entries the TypeScript classifier retains. Five high-severity findings.

---

## 0. Test-baseline correction

The brief stated two pre-existing failures. Measured:

- Baseline `bf3fdb0`: **243 pass / 1 fail / 1 error**
- Impl `859bc9c8`: **255 pass / 1 fail / 1 error**

Per-file runs show the single failure is `src/cli.test.ts` (the missing `@agiterra/wire-tools`
module; the reported "error" is the same cause). **`agi82.test.ts` does not fail** — it passes 13/13
in isolation; the `error: screen unavailable` text is a deliberate log line emitted by a passing
test. There is ONE pre-existing failure, not two.

No new failures are introduced *in this environment*. That qualifier is load-bearing — see **F1**.

---

## 1. SECURITY

### S1 — Command injection into the sudo'd remote shell via a manifest-supplied path
`src/codex-spawn.ts:436-438`, guard at `:105-114`. Severity: **high**. Pre-existing in the old
`removeRemote`, but this PR carries it forward and *widens* it by adding `RECEIPT`, derived from the
previously-uninterpolated `STATE_DIR`.

The guard validates only `isAbsolute`, `basename(codexHome) === agentId`, and
`basename(dirname(codexHome)) === "codex-spawn"`. The **path prefix is entirely unvalidated**, so a
single quote passes. Demonstrated:

```
CODEX_HOME = /tmp/x'; cat $HOME/.codex/auth.json; echo '/codex-spawn/agentx
```

passes `resolveCodexSpawnPaths` unchanged and produces:

```
sudo -n -u _ephemeral env CODEX_HOME='/tmp/x'; cat $HOME/.codex/auth.json; echo '/codex-spawn/agentx' AUTH_TARGET='/Users/_ephemeral/.codex/auth.json' RECEIPT='...' AGENT_ID='agentx' /bin/sh -c '...'
```

The injected command runs on the remote host as the ssh user — outside the `sudo -n -u <uid>`
restriction, since the quote closes before `sudo`'s argument list is complete. **This is the direct
answer to the lens-1 question: yes, a path can expose `auth.json`** — not by dereference, by
injection. `STATE_DIR` has the same hole (`basename(stateDir)` must be `codex-spawn`; the prefix is
free). `agentId` (`SAFE_SEGMENT`) and `runAsUid` (`SAFE_UID`) are clean.

*Failure scenario:* any writer of a spawn manifest — a compromised launcher, a mis-merged template,
or a future feature that lets a caller name its own `CODEX_HOME` — achieves arbitrary command
execution on the target host at the moment an agent is stopped.

*Fix:* reject any shell metacharacter (minimally `'`) in `codexHome` and `stateDir` before
interpolation, or stop hand-quoting and pass the values through a real argv.

### S2 — Receipts are world-readable, violating spec §5
`src/codex-spawn.ts:241` (`mkdir` with no `mode`) and `:243` (`fsOpen(path,"w")`, no mode).
Severity: **low-medium**.

Measured on a live fixture (umask 002): `.stopped/` = `drwxrwxr-x` (0775), receipt =
`-rw-rw-r--` (0664). Spec §5: "Any incident or receipt directory is `0750` group-owned; never
world-readable." Receipts enumerate every path in the spawn home, including workspace and repo
names. The remote script's `mkdir -p` at `:292` has the same defect.

*Fix:* `mkdir(dir, { recursive: true, mode: 0o750 })` and an explicit mode on the open.

### Credential handling itself is correct
`classifySpawnHome` uses `lstat` + `readlink` only — never `stat`, never `open`. `fs.rm` and
`rm -rf --` both unlink a symlink rather than following it. Verified on fixtures that the credential
target survives byte-identical in both the local and remote paths, including the case of a
symlink-to-real-file inside a lock directory (the link is unlinked; `realfile` remained). There is
no copy, archive, tar or rsync path anywhere in the change, so the `cp -RL` / `tar -h` class of
dereference the spec warns about does not arise. The `.replace(/'/g, "'\\''")` escaping of the
*script body* at `:438` is correct — the injection in S1 is in the `env` assignments, not the script.

---

## 2. CORRECTNESS

### C1 — The generated `/bin/sh` program deletes entries the TypeScript classifier retains
`src/codex-spawn.ts:283-284` vs `:195-203`. Severity: **high**.

The comment at `:256-258` claims "One source of truth; an equivalence test runs this generated
script against the same fixture as the TypeScript classifier and asserts identical outcomes." They
are not equivalent. Two demonstrated classes:

**(a) Dangling symlink in a lock directory.** Shell `:283` gates on `[ -e "$q" ]`, which is false
for a dangling link, so the entry is skipped entirely and never clears `all`. TS `:195` uses
`lstat`, classifies it `retained`, and sets `allLocks = false`. Measured on a fixture with
`app-server-control/a.lock` (plain file) and `app-server-control/dangling.lock -> /nonexistent/target`:

```
TS   disposable  …/app-server-control/a.lock
TS   retained    …/app-server-control/dangling.lock
TS   retained    …/app-server-control
SH   DISPOSE     …/app-server-control/a.lock
SH   DISPOSE     …/app-server-control        → rm -rf removed the whole directory
```

The root loop at `:272` correctly writes `[ -e "$p" ] || [ -L "$p" ] || continue`; the inner
lock-directory loop at `:283` dropped the `-L`.

**(b) Symlink named `*.lock` pointing at a real file.** Shell `:284` uses `[ -f "$q" ]`, which
**follows the link**; TS `:196` uses `lst.isFile()` on an `lstat`, which does not. Measured on a
fixture with `mcp-oauth-locks/a.lock` plus `mcp-oauth-locks/sneaky.lock -> ../realfile`:

```
TS   disposable  …/mcp-oauth-locks/a.lock
TS   retained    …/mcp-oauth-locks/sneaky.lock
TS   retained    …/mcp-oauth-locks
SH   DISPOSE     …/mcp-oauth-locks/a.lock
SH   DISPOSE     …/mcp-oauth-locks/sneaky.lock
SH   DISPOSE     …/mcp-oauth-locks           → rm -rf'd the whole directory
```

Both classes violate spec RULE 1a ("Unknown descendants at any depth are RETAINED") on the primary
cross-uid path, and both are invisible to the parity test because its fixture contains only plain
`a.lock` files. The target `realfile` survived in case (b) — `rm -rf --` on a symlink unlinks the
link, not the target — so this is a retention-contract violation, not a second credential-exposure
path.

*Fix:* `[ -e "$q" ] || [ -L "$q" ] || continue` at `:283`; replace `[ -f "$q" ]` at `:284` with a
no-follow test. Add both cases to the parity fixture.

### C2 — An unreadable spawn home reports `state: "complete"` with empty sets
`src/codex-spawn.ts:158` — `try { names = await readdir(codexHome); } catch { return out; }`.
Severity: **medium**.

A local teardown of an agent whose home lives under another uid, with no `target` resolved, gets
EACCES on `readdir`, produces zero entries, writes a receipt saying `complete`, and returns
`removed: []` with **no `skipped` and no `failed`**. That is indistinguishable from "the home was
already gone". The old code distinguished this case via `absent`.

*Failure scenario:* an operator stops a cross-uid codex lane from a session that resolved no
`target`. The receipt reads `state: "complete", disposable: [], retained: []`. The operator reads
that as "clean stop, nothing worth keeping" and the home is swept by hand later.

*Fix:* distinguish EACCES/EPERM from ENOENT; set `skipped` on the former.

### C3 — `absent` is dead
`CodexSpawnTeardownResult.absent` (`:310`) is populated only by `removeLocal` (`:485`) and
`removeRemote` (`:540`), both now unreachable. Every live path returns `absent: []`. Callers can no
longer distinguish "nothing to do" from "did nothing". Severity: low.

### C4 — AGI-74's actual purpose is silently reverted with no replacement
Severity: **medium**.

The module docstring at `:14-16` records the motivation for the code being changed: 142 MB under
`/Users/fondant` and 128 MB under `/Users/_ephemeral` of leaked spawn homes for agents that no
longer exist. After this change, **nothing ever removes a dead agent's home** — `closeAgent`,
`stopAgent` and therefore the idle reaper all retain. The docstring still points at
`codex-spawn-prune.sh` as the opt-in sweeper, but the PR neither verifies that script exists nor
states that the disk-leak fix now depends entirely on it.

This is not a defect in the retention logic — retention is the point, and spec §6 is explicit that
"the failure direction of every rollback is 'too much data kept'". It is a defect in what the PR
owns. Spec §6 makes this a permanent steady state, not a transient one.

*Failure scenario:* three months of ephemeral lane churn refills the disk, and the next person
diagnosing it reads a docstring claiming teardown removes the home.

*Fix:* state it in the PR description, update the docstring, and file the sweeper as a follow-up
with an owner.

### The lock-directory logic itself is right in TS
An empty lock dir → `allLocks = inner.length > 0` is false → retained (conservative; the shell's
`any=0` guard agrees). Removal is deepest-first at `:402`. A lock dir that is *retained* still has
its individual `.lock` files removed, and the shell agrees. `cache/`, `tmp/`, `workspaces/`, sqlite
`-wal`/`-shm` sidecars, unknown root basenames, sockets, non-matching symlinks, FIFOs and devices
are all correctly retained in both implementations — verified against the fixture.

---

## 3. FAILURE PATHS

### F1 — The remote-parity test passes only because the author's shell exports `AGENT_ID=fondant`
`src/codex-spawn-preserve.test.ts:166-173`. Severity: **high**.

The mechanism, exactly. The test spawns the generated script with:

```js
env: { ...process.env, CODEX_HOME: …, AUTH_TARGET: …, RECEIPT: … }
```

It **never sets `AGENT_ID`**. The generated script opens with `set -u` (`codex-spawn.ts:264`) and
immediately evaluates `AG="$AGENT_ID"` (`:265`). Under `set -u`, expanding an unset parameter in a
non-interactive POSIX shell is a fatal error: the shell writes a diagnostic and **exits before the
first loop iteration**. Nothing is classified, nothing is printed, `CREW_TEARDOWN_DONE` never
appears.

It passes on this box because `...process.env` carries the persona's own exported `AGENT_ID`:

```
$ echo "AGENT_ID in env: [${AGENT_ID:-<unset>}]"
AGENT_ID in env: [fondant]

$ env -u AGENT_ID bun test src/codex-spawn-preserve.test.ts
175 |     expect(out).toContain("CREW_TEARDOWN_DONE");
                      ^
error: expect(received).toContain(expected)
Expected to contain: "CREW_TEARDOWN_DONE"
Received: ""
(fail) remote parity > the generated /bin/sh program yields the SAME disposition as the TS classifier
 11 pass, 1 fail
```

Consequences, in ascending order of how much they should matter:

1. It will be **red in CI** — GitHub Actions has no `AGENT_ID`.
2. Until fixed, the **only test covering the cross-uid path proves nothing about the script**. It
   proves that this lane exports a persona variable. Every assertion in it — the disposition-set
   equality, `rec.state === "complete"`, the `thread_history_1.sqlite` retention check, the
   `rec.failed` emptiness — rides on that.
3. It is *why* C1 went undetected. A test that is green for an environmental reason cannot be
   reasoned about as coverage, so the fixture's blind spots were never under pressure.

The comment written at `:184-186` — "the classification test above passed throughout — a suite can
agree with itself" — is an accurate description of the test it is attached to.

*Fix:* set `AGENT_ID` explicitly in the test env, and make `env -u AGENT_ID bun test ./src` the
acceptance check for this PR.

### Question set by the brief #1: does INTENT-before-removal actually hold on the REMOTE path?

**Yes — structurally, on both paths. This part of the design is sound.**

Remote, `src/codex-spawn.ts:292-294`:

```sh
mkdir -p "$(dirname "$R")" 2>/dev/null || { echo CREW_INTENT_FAILED; exit 9; }
printf '{…"state":"in-progress"…}' … > "$R" 2>/dev/null || { echo CREW_INTENT_FAILED; exit 9; }
sync; [ -s "$R" ] || { echo CREW_INTENT_FAILED; exit 9; }
```

The `rm` loop is at `:297`, strictly after all three gates, and `exit 9` leaves it unreached. The
non-empty check *after* `sync` is a genuine durability probe rather than a trust of the redirect's
exit status — that is the right instinct and it is implemented correctly. The caller's handling at
`:447-456` sets `skipped: "intent-undurable"` and logs audibly, which closes the "a guard nobody can
observe" gap the commit message claims to close.

Local, `:392-399`, is equally correctly ordered, and the orchestrator test at `:1558` proves it: with
the spawn root at `0500`, nothing is removed.

The caveat is F1 and C1: the remote ordering is currently **unproven by any passing test on a clean
machine**, and the classifier the ordering protects is wrong in two cases.

### Question set by the brief #2: can a finalize failure report success?

**At the module boundary, no. At the API boundary, yes.**

The module is honest: a finalize failure lands in `result.failed` (`:422` local, `:459` remote), and
`removeCodexSpawnHome:367-372` logs every failed entry loudly with its path. `teardownLocal`'s log
line at `:420-421` says explicitly "removal ALREADY RAN … Not reported as success." So neither
teardown function claims success.

But **`src/orchestrator.ts:1623-1637` discards the entire result** — `skipped`, `failed` and
`removed` are all dropped on the floor. `agent_stop` and `agent_close` return success regardless of
whether INTENT failed closed, finalize failed, or every removal errored. See F4.

### F2 — FINALIZE truncates the INTENT receipt in place
`src/codex-spawn.ts:418` reuses the same path through `writeReceipt`, which opens `"w"` (`:243`).
Severity: **high**.

Spec §4 promises: "If the process dies between 1 and 3, INTENT survives with `state:"in-progress"`
and names what was at risk." It does not. `open(…, "w")` truncates at open, before a byte is
written, so a kill or ENOSPC during finalize leaves a zero-length or partial-JSON receipt — and by
then removal has already run. **The durable record of what was at risk is destroyed by the act of
reporting on it.** The remote script has the identical defect at `:299`: `> "$R"` truncates the
INTENT it is replacing.

The test at `:117-118` asserting `files.length === 1` is what locks this shape in.

*Failure scenario:* a stop runs, removal completes, the box loses power (or the receipt filesystem
fills) mid-finalize. The operator finds a 0-byte receipt and has no record of either set — the exact
post-incident position this mechanism was built to prevent.

*Fix:* write `<name>.tmp`, fsync, `rename`. Both paths.

### F3 — `state: "finalize-failed"` is specified, typed, and never assigned
Declared at `src/codex-spawn.ts:218`. Severity: **high**.

`grep -rn "finalize-failed" src/` finds it only as an *error string* at `:422`, `:459` and `:523` —
never as a `state`. Spec §4 requires a receipt in that state "carrying INTENT's declared sets plus
whatever is still observable on disk … an honest partial report, never a claim that nothing was
removed". Local path `:419-423` logs and pushes a `failed` entry, leaving the truncated/partial
receipt from F2. Remote path `:458-460` leaves the in-progress receipt intact and pushes a `failed`
entry. Neither writes the specified receipt. **Spec test row 13 is unimplemented and untested.**

### F4 — "Never reported as success" holds only in the log, not in the API
`src/orchestrator.ts:1623-1637`. Severity: **medium**.

The result of `removeCodexSpawnHome` is discarded entirely. The only surfacing is `console.error` in
the service log. Spec §4: "The caller sees the failure and the sets; it is not reported as success."
The caller sees nothing.

Structurally this is the same shape as the incident the PR exists to fix — an outcome routed into a
field with no reader, the mirror image of an intent routed into a field with no executor.

*Failure scenario:* the receipt path is unwritable on a host. Every stop fails closed and removes
nothing. The fleet dashboard shows a clean stop every time, because the RPC returned success and
nobody reads the service log.

### F5 — Dead `removeRemote` references an out-of-scope identifier
`src/codex-spawn.ts:523` — `result.failed.push({ path: receipt, … })`, where `receipt` is a local of
`teardownRemote` (`:434`), not in scope here and not defined at module level. Severity: **medium**
as a latent bug, **high** as a signal.

There is no `tsconfig.json`, no `tsc` in `devDependencies`, and `.github/workflows/pr-check.yml`
runs only the shared `plugin-check` workflow. Bun strips types without checking them, so nothing
catches it. If anyone re-wires `removeRemote`, it throws `ReferenceError` at runtime. `removeLocal`
(`:471`) is likewise dead.

*Fix:* delete both functions.

---

## 4. TEST QUALITY

### T1 — Spec rows 15-18, the mutant controls, do not exist
Severity: **high**. `grep -rn mutant src/` returns nothing. The spec's own closing line: "Rows 15-18
are what make the rest mean anything: each earlier revision of this spec passed every test I had
imagined for it at the time." Nothing was built to satisfy that.

C1 is precisely the defect a whole-home-removal mutant applied to the **shell** path would have
caught. F1 is what a mutant run in a scrubbed environment would have caught.

### T2 — Row 7, the stop→resume e2e, is not in the suite
Severity: **medium**. `src/stop-resume-e2e.sh` is referenced by nothing: not `package.json` (which
has no `test` script at all), not `.github/workflows/pr-check.yml`, not a README. It hardcodes
`/Users/tim/Projects/Agiterra/codex-wire/scripts/gen-codex-home.sh` at line 53, so it runs on exactly
one machine. Spec §2 calls this "the check that decides whether this whole design is worth building."

Separately: `"files": ["src/"]` in `package.json` means it **ships to consumers** as a stray
executable shell script inside the published package.

### T3 — Row 14, the accept path, is mislabeled and not tested
`src/codex-spawn-preserve.test.ts:114` is titled `"8+14: INTENT precedes removal; finalize records
actual sets"` but runs the full fixture. A home containing *only* disposable entries — the spec's
explicit accept-path row — is never exercised. Severity: low, but it is the row that proves the
classifier can say yes.

### T4 — The four rewritten `orchestrator.test.ts` tests: blunt verdict

The question asked was whether the regression net was reshaped to fit the behaviour it was supposed
to catch. Answer: **three of the four are honest; one is not weakened but is mis-described; none of
them is a do-nothing pass.** The regression net was not quietly reshaped. Detail:

**`"closeAgent removes only THIS agent scaffolding…"` (`:1495`) — HONEST.** The assertions that
carried the original protective intent were the *scoping* ones — `sibling.dir`, `sibling.thread`,
the persona's own home — and they **survive intact and unmodified**. The removed assertions
(`target.dir` absent, `target.thread` absent) asserted the destructive behaviour itself, which is
the thing being deliberately changed; keeping them would have been asserting the bug. The
replacement positive assertion (`config.toml` absent) still proves teardown *acted* on the target,
so this cannot pass against a do-nothing implementation. The added `sessions/rollout.jsonl` and
`target.thread` present assertions are genuine new coverage of the new contract. Fair replacement.

**`"stopAgent (and the idle reaper)…"` (`:1518`) — HONEST.** Same analysis. `sibling.dir` retained.

**`"an unwritable spawn root fails CLOSED…"` (`:1558`) — STRONGER.** The old test asserted a loud log
*after* teardown deleted whatever it could; the new one asserts nothing was removed at all
(`stuck.dir` present AND `join(stuck.dir, "config.toml")` present) and that the failure is audible
with the words "NOTHING REMOVED". That is a real upgrade, and the inline comment saying so is
accurate. It also keeps the original tombstone/row assertions.

**The remote test's `rm -rf` assertion (`orchestrator.test.ts:1611`) — NOT WEAKENED, BUT
MIS-DESCRIBED, AND BOTH VERSIONS ARE WEAK.** The new form is:

```js
for (const line of teardown!.split("\n").filter((l) => l.includes("rm -rf"))) {
  expect(line).toContain('rm -rf -- "$p"');
}
```

This asserts a literal substring of a string the module under test just built, and by construction
the generated script contains exactly one `rm -rf` line. It rejects `rm -rf "$H"/*`. But it
**passes cleanly against `rm -rf -- "$H"`** — whole-home removal with a single explicit path, which
is the exact defect this PR exists to prevent. The replaced `not.toContain("*")` had the same hole,
so this is a lateral move rather than a regression.

The problem is the inline comment claiming it is "stronger than asserting the command string
contains no asterisk anywhere." It is not stronger; it is differently weak. That comment should not
stand in the tree, because the next reader will trust it and stop looking.

Also note: that test feeds a canned `sshRunResult`, so it never executes the script and asserts
nothing about retention on the remote path. Combined with F1, **the remote path currently has zero
working behavioural coverage.**

### T5 — What is asserted well
This is not a blanket dismissal. The classification tests assert *behaviour*, not presence:
`cache/a/deadbeef.json` and `tmp/arg0/codex-arg0-example/userfile.txt` are read back for content,
the credential is read back for its exact bytes, the mode test chmods to `0600` and re-stats. The
digest test correctly proves non-descent by mutating nested content and asserting the digest is
unmoved. Test 12 (INTENT undurable) genuinely proves nothing was removed and would fail against an
implementation that removed-then-checked. Those five are real tests that would catch real
regressions.

---

## 5. ANYTHING ELSE

**M1 — `src/orchestrator.ts:1602` doc comment is now false.** "Remove the agent's per-agent
CODEX_HOME and its `<id>.thread.json` (AGI-74)." Both halves are wrong after this change. `:1613`
("a leaked 48 MB home must not keep a dead agent's row alive") also no longer describes the design.
Severity: low, but that comment sits directly on the path of the next incident — it is what the next
maintainer reads before concluding the thread pointer is disposable.

**M2 — `paths.threadPath` (`:107`) is used by nothing** in either live teardown path. The "thread
pointer is retained" property therefore holds by *omission*, not by construction. No test asserts it
on the remote path, and nothing would notice if a future edit added it to the disposal set.

**M3 — `manifestDigest`'s comparator at `:229`** (`a.path < b.path ? -1 : 1`) never returns 0.
Deterministic for distinct paths, so no live bug; sloppy.

**M4 — Nothing typechecks this repository.** No `tsconfig.json`, no `tsc` in `devDependencies`, CI
runs only the shared `plugin-check` workflow, and bun strips types without checking them. That is
why F5's out-of-scope identifier can sit in the tree. Any typecheck or lint gate catches it on the
first run.

---

## Per-finding disposition

| # | Finding | Severity | Disposition |
|---|---|---|---|
| **F1** | Parity test green only via exported `AGENT_ID` | high | **Blocks merge.** Set `AGENT_ID` in the test env; make `env -u AGENT_ID bun test ./src` the acceptance check. |
| **C1** | Shell/TS divergence deletes retained entries (2 classes) | high | **Blocks merge.** `[ -e ] \|\| [ -L ]` at `:283`; no-follow file test at `:284`. Add both cases to the parity fixture. |
| **F2** | FINALIZE truncates INTENT in place | high | **Blocks merge.** temp → fsync → rename, both paths. Replace the `files.length === 1` assertion accordingly. |
| **F3** | `state: "finalize-failed"` never assigned | high | **Blocks merge.** Implement in both paths; add spec test row 13. |
| **T1** | No mutant controls (spec rows 15-18) | high | **Blocks merge** per the spec's own terms. Minimum: whole-home mutant and rev-1 allowlist mutant, against **both** classifier implementations. |
| **S1** | Shell injection via manifest `CODEX_HOME`/`STATE_DIR` | high | **Fix in this PR.** Pre-existing, but this PR widens it and is itself a preservation/safety fix — shipping it untouched is the wrong direction. |
| **F5** | Dead `removeRemote` references out-of-scope `receipt` | medium | **Fix in this PR** — delete `removeLocal` and `removeRemote`. |
| **F4** | Result discarded by the orchestrator | medium | **Fix in this PR** or file immediately with an owner. Surface `skipped`/`failed` in the RPC response. |
| **C2** | Unreadable home → `state: "complete"` | medium | **Fix in this PR** — distinguish EACCES from ENOENT; set `skipped`. |
| **C4** | AGI-74 disk-leak fix reverted, no replacement | medium | **Follow-up ticket, stated in the PR description.** Update the docstring before merge. |
| **T2** | Row 7 e2e unwired, machine-specific, shipped in `src/` | medium | **Follow-up**, except: move it out of `src/` before merge so it stops shipping to consumers. |
| **S2** | Receipts world-readable (0775/0664) | low-med | **Fix in this PR** — a mode argument in two places. |
| **T4** | `rm -rf -- "$p"` assertion mis-described as stronger | low-med | **Fix the comment in this PR**; strengthen the assertion to reject an explicit whole-home target. |
| **T3** | Row 14 accept path mislabeled | low | Follow-up. |
| **M1** | Stale orchestrator doc comment | low | **Fix in this PR** — two sentences, and it sits on the incident path. |
| **C3** | Dead `absent` field | low | Follow-up. |
| **M2** | Thread retention holds by omission, unasserted | low | Follow-up — add an explicit assertion or a comment at the disposal site. |
| **M3** | `manifestDigest` comparator never returns 0 | low | Follow-up. |
| **M4** | Nothing typechecks the repo | low | **Own ticket.** |

---

## Minimum to reach PASS

1. Set `AGENT_ID` in the parity test; confirm green under `env -u AGENT_ID` (**F1**).
2. Fix both shell/TS divergences and add the dangling-link and symlink-`.lock` cases to the parity
   fixture (**C1**).
3. Write FINALIZE to a temp path and rename (**F2**); implement `state: "finalize-failed"` and spec
   test row 13 (**F3**).
4. Reject shell metacharacters in `codexHome` / `stateDir` before interpolation (**S1**).
5. Delete `removeLocal` / `removeRemote` (**F5**); add the row 15-18 mutant controls (**T1**).

**The verdict stands: FAIL at `859bc9c8`.** Five high-severity findings, three of which (F1, C1, F2)
mean the cross-uid path is not in the state the PR claims. The local path and the retention design
are good work and I would expect a fast turnaround — but the incident being fixed happened on the
remote path, and that is the path with no working test.
