# Vendored ACTUAL generator — provenance

`gen-codex-home.sh` in this directory is a **byte-for-byte copy of the real provisioner**, not a
surrogate. Row 7's integration claim is about THIS program's behaviour, so the program itself is
vendored rather than modelled.

| | |
|---|---|
| source | `/Users/tim/Projects/Agiterra/codex-wire/scripts/gen-codex-home.sh` |
| repository | `agiterra/codex-wire` |
| sha256 | `a33c96149fcc866ebbdc26cdde4f263bcd693af2b445ecd9d5f18179816e79ee` |
| bytes | 4105 |
| vendored | 2026-09-15, for PR 91 |

**Why vendored** (Brioche 616411): a row bound to an absolute path outside this repository can
never pass in CI, and *"warning + green with the actual generator absent weakens required
evidence"*. The instrument had to be made **reproducibly available** rather than traded against a
permanently-red gate — and **actual-generator coverage must not be claimed from a hand-built
surrogate**.

**Safe to execute in CI:** it writes files only — `mkdir -p`, `ln -sfn`, `cat > config.toml`,
`chmod 600`. The `bun`, `gh` and `linear-app-token` strings it contains are written INTO the
config it emits; none is invoked at provision time.

**Drift is caught, not assumed.** The row that uses this copy also asserts, whenever the real
source is reachable, that this file's sha256 still equals it. A vendored copy that silently
diverges from its original would be a surrogate wearing the original's name — the exact thing
this arrangement exists to avoid.
