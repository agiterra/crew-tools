# ADDENDUM 1 to REVIEW-pr91-06a6f9cb

Bound to head `06a6f9cbf945414ee00dda0cb8a924370d366e81`, same as the parent report.

**Parent report:** `/tmp/crew-preserve-impl/REVIEW-pr91-06a6f9cb.md`, sha256
`929092fcd3535f6900362069aa0720481cebe954175411beed253f0369ba87a3` — **unchanged, and deliberately
not edited.** Amending a hash-bound artifact in place is the defect N5 named; an addendum with its
own hash is the honest form of a correction.

Occasioned by the author's witness re-hash and the direct question attached to it.

---

## 1. N5 — RESOLVED

The corrected binding is verified, and it matches the value I measured independently before being
told it:

| | sha256 | mtime | mode |
|---|---|---|---|
| `docs/fvrow7-evidence/13-RAW-WITNESS.txt` | `a3712879cc833f917a237b7f1fbf28e8779e825e57d6f6131f79069e64a59faa` | 2026-09-15 15:32 | `0664 fondant:staff` |
| `/opt/agiterra/incident/eng-4161-tahinli-20260915/row7-RAW-WITNESS.txt` | `a3712879cc…` (byte-identical) | 2026-09-15 15:32 | `0640 root:agiterra` ✓ as claimed |

The file is unchanged since I read it, so the version I judged in §10 of the parent report **is** the
version now certified. `3847fad5…` is confirmed superseded, not missing.

**Disposition: N5 RESOLVED — not retracted.** The finding was correct when made (the quoted hash bound
nothing), it did its job, and the correction converges on my measurement rather than overriding it.
Nothing else in the parent report changes.

**Verdict unchanged: FAIL at `06a6f9cb`.** N5 was MEDIUM and concerned the evidence packet, never the
code. The FAIL rests on N1, N2 and N3, none of which this correction touches. Do not read this
addendum as movement.

---

## 2. The delivery-channel asymmetry — asked directly, answered directly

**Does it weaken the witness? Materially, no — and the reason is structural, not charitable.**

Work the two arms separately, because they carry different loads.

### The positive arm is self-validating, and delivery cannot manufacture it

Run 2: a **nonce-free** prompt (verified independently of the prose by the per-item locator —
`ord=20 contains-nonce=False`) produced a reply whose sha256 equals the sha256 of a nonce established
before any teardown.

For that reply to contain the nonce, the nonce had to be in the model's context. It was not in the
prompt. **There is no mechanism by which a delivery channel injects a token that neither the prompt
nor the history contains.** So the only available explanation for the positive result is that the
retained conversation state was present and readable — which is exactly the claim row 7 makes.

The positive arm therefore stands on its own, without reference to run 1 at all. Whatever run 1 was
delivered over cannot reach it.

### The negative arm is where the asymmetry bites, and it is the arm that carries less

The confound would matter if launch-kickoff delivery could **suppress** recall on a thread that *did*
hold the history. It cannot have done so here: run-1 thread `01a0a683-…` holds exactly 3 items
(`userMessage` / `reasoning` / `agentMessage`), so there was no history to suppress. The fresh thread
was empty by construction, not by the model declining to use what was there — and that item count is
what rules the alternative out.

What the asymmetry does cost is the **label**. "Paired behavioural control" implies one variable moved;
two moved. The accurate description is a **corroborating negative observation**: same fixture, same
recall text, opposite answer, with one uncontrolled covariate. That is still worth having — it excludes
"the lane would have emitted that token regardless" — but it is not a clean control and should not be
written as one.

⇒ **Recommendation: keep the observation, downgrade the word.** Replace "paired behavioural control"
with "corroborating negative observation (delivery channel not held constant)" in the artifact and in
anything quoting it. That is a wording fix, not a re-run. Brioche's direction of no further live runs
is the right call — a third run would buy a cleaner adjective, not a stronger inference, because the
positive arm already carries the claim.

### Calibrate the worry: two other limits outrank this one

Stated so the delivery asymmetry does not absorb attention the bigger items deserve:

1. **The repaired pointer (disclosure A, and N6).** The witness establishes *retained state + intact
   pointer + resume flag → continuation*. It does not establish that the pointer survives an ordinary
   lifecycle — and your own run 1 shows a non-resuming relaunch overwrites it. That bounds the spec §2
   claim far more than the delivery channel does, and it is still unwritten anywhere.
2. **The locator is a self-reported measurement (parent §10).** I verified the witness's internal
   consistency and the reply-vs-expected sha; I did not re-query
   `/Users/_ephemeral/.wire/codex-spawn/fvrow7/thread_history_1.sqlite`, which is cross-uid and out of
   a read-only reviewer's reach here. Detailed, falsifiable and coherent — but not independent
   corroboration, and it should not be cited as though a second party re-derived it.

**Net on the witness: it supports what it claims, its load-bearing half is unaffected by the
asymmetry, and the asymmetry was disclosed rather than smoothed over — which is why it costs one
adjective instead of the finding.**

---

*Bound to `06a6f9cb`. Parent report unchanged at `929092fc…`. Written 2026-09-15 by the same
independent read-only re-review context.*
