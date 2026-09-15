/**
 * ⚠️ NOT A TEST. A one-shot operator instrument, used ONCE for the row-7 Phase B witness
 * (2026-09-15) to invoke the CANDIDATE local teardown directly against one synthetic fixture
 * lane, out of this working copy, WITHOUT installing anything. It is here so the Phase B
 * result is reproducible and auditable; it is not wired into the suite and must never be.
 *
 * Review finding N13: it was left untracked at the working-copy root, where it was neither
 * evidence nor code. Moved into test/e2e/ (outside the `files: ["src/"]` publish set) and
 * labelled, rather than deleted — deleting it would have made the witness unreproducible.
 *
 * Hard-codes the fixture agent id. Do not point it at a real lane.
 */
import { removeCodexSpawnHome } from "./src/codex-spawn.ts";
const res = await removeCodexSpawnHome(
  { agentId: "fvrow7", runtime: "codex", selfHome: "/Users/_ephemeral",
    env: { STATE_DIR: "/Users/_ephemeral/.wire/codex-spawn" } },
  { log: (m) => console.error("LOG " + m) },
);
console.log(JSON.stringify(res, null, 2));
