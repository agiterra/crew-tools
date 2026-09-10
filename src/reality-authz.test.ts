/**
 * AGI-27 items 1–2: the last direct-write surface reachable from an _ephemeral
 * agent's MCP process is the lazy-GC-on-read heal behind `agent_list`.
 *
 * Two exposures are pinned here:
 *   F1 (forge/poison) — heal writes ARBITRARY rows, with no per-agent authz.
 *      An unrelated lane calling agent_list can tombstone+delete a row it has
 *      no self/owner/ED claim on.
 *   F2 (interim regression) — post-interim every non-service CrewStore opens
 *      readonly, and heal has no readonly guard, so agent_list throws
 *      'attempt to write a readonly database' instead of reading.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CrewStore } from "./store";
import { RealityLayer } from "./reality";
import type { ScreenSession } from "./screen";

let dbPath: string;
let store: CrewStore;
let localMachine: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "reality-authz-"));
  dbPath = join(tmp, "test.db");
  store = new CrewStore(dbPath);
  localMachine = store.localMachineName();
});

function makeReality(opts: { screens?: () => ScreenSession[]; graceMs?: number; now?: () => number }): RealityLayer {
  return new RealityLayer(undefined, {
    ttlMs: 0,
    graceMs: opts.graceMs ?? 0,
    now: opts.now,
    screenLister: async () => (opts.screens ? opts.screens() : []),
    terminalEnumerator: async () => [],
  });
}

/** A row spawned by `parent` — the same provenance authz.parentOf() reads. */
function spawnedBy(id: string, parent: string): void {
  store.createAgent({
    id,
    display_name: id,
    runtime: "claude-code",
    screen_name: `wire-${id}`,
    spawn_manifest: JSON.stringify({ env: { AGENT_PARENT: parent } }),
  });
}

describe("AGI-27 F1: heal must be authz-scoped per row", () => {
  test("deny: an unrelated lane cannot reap a row it has no claim on", async () => {
    // `victim` belongs to brioche's tree. `attacker` is unrelated.
    spawnedBy("victim", "brioche");
    const reality = makeReality({ screens: () => [] }); // victim's screen is absent

    // Scoped heal: only rows the caller may write are eligible for a write.
    const canWrite = (a: { id: string }) => a.id === "attacker";
    await reality.heal(store, localMachine, undefined, { canWrite });
    await reality.heal(store, localMachine, undefined, { canWrite });

    expect(store.getAgent("victim")).not.toBeNull();
    expect(store.listTombstones("victim")).toHaveLength(0);
  });

  test("allow: a lane may reap a row it spawned (spawner-scoped, nested)", async () => {
    spawnedBy("child", "lane-a");
    const reality = makeReality({ screens: () => [] });
    const canWrite = (a: { id: string }) => a.id === "child"; // lane-a owns child
    await reality.heal(store, localMachine, undefined, { canWrite });
    await reality.heal(store, localMachine, undefined, { canWrite });
    expect(store.getAgent("child")).toBeNull();
    expect(store.listTombstones("child")).toHaveLength(1);
  });

  test("allow: no predicate (operator/ED path) reaps everything, as today", async () => {
    spawnedBy("victim", "brioche");
    const reality = makeReality({ screens: () => [] });
    await reality.heal(store, localMachine);
    await reality.heal(store, localMachine);
    expect(store.getAgent("victim")).toBeNull();
  });

  test("skipped rows are reported, so a denial is attributable", async () => {
    spawnedBy("victim", "brioche");
    const reality = makeReality({ screens: () => [] });
    const { result } = await reality.heal(store, localMachine, undefined, {
      canWrite: () => false,
    });
    expect(result.skipped).toContain("victim");
  });
});

describe("AGI-27 F2: a readonly store must not attempt heal writes", () => {
  test("heal on a readonly store reads without throwing and writes nothing", async () => {
    store.createAgent({ id: "alive", display_name: "A", runtime: "claude-code", screen_name: "wire-alive" });
    const ro = new CrewStore(dbPath, { readonly: true });
    expect(ro.readonly).toBe(true);

    const reality = makeReality({
      screens: () => [{ name: "wire-alive", pid: 4242 } as ScreenSession],
    });
    const { live } = await reality.heal(ro, localMachine);
    expect(live.map((a) => a.id)).toEqual(["alive"]);
    // pid stamping must NOT have happened through the readonly handle
    expect(store.getAgent("alive")!.screen_pid).toBeNull();
  });
});
