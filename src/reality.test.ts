import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { CrewStore } from "./store";
import { RealityLayer } from "./reality";
import type { ScreenSession } from "./screen";
import type { TerminalSession } from "./terminal";

let store: CrewStore;
let localMachine: string;

beforeEach(() => {
  const tmp = mkdtempSync(join(tmpdir(), "reality-test-"));
  store = new CrewStore(join(tmp, "test.db"));
  localMachine = store.localMachineName();
});

/**
 * Build a RealityLayer whose reality sources + clock are fully controllable.
 * Default ttlMs:0 makes every snapshot() re-probe, so a test can mutate the
 * `screens` closure between heal() calls to simulate an agent dying/reviving.
 */
function makeReality(opts: {
  screens?: () => ScreenSession[];
  terminals?: () => TerminalSession[];
  now?: () => number;
  ttlMs?: number;
  graceMs?: number;
}): RealityLayer {
  return new RealityLayer(undefined, {
    ttlMs: opts.ttlMs ?? 0,
    graceMs: opts.graceMs ?? 60_000,
    now: opts.now,
    screenLister: async () => (opts.screens ? opts.screens() : []),
    terminalEnumerator: async () => (opts.terminals ? opts.terminals() : []),
  });
}

/** Mark an agent row as living on a peer machine (simulates a fleet_list insert). */
function makeRemote(id: string, machine = "home-mini"): void {
  const existing = store.getMachine(machine);
  if (!existing) store.createMachine({ name: machine, hostname: machine, ssh_host: `tim@${machine}` });
  store["db"].prepare("UPDATE agents SET machine_name = ? WHERE id = ?").run(machine, id);
}

describe("RealityLayer.snapshot", () => {
  test("caches within TTL, re-probes after expiry, invalidate() forces re-probe", async () => {
    let calls = 0;
    let clock = 1000;
    const reality = new RealityLayer(undefined, {
      ttlMs: 750,
      now: () => clock,
      screenLister: async () => {
        calls++;
        return [];
      },
      terminalEnumerator: async () => [],
    });

    await reality.snapshot();
    await reality.snapshot();
    expect(calls).toBe(1); // second read served from cache

    clock += 800; // past TTL
    await reality.snapshot();
    expect(calls).toBe(2);

    reality.invalidate();
    await reality.snapshot();
    expect(calls).toBe(3);
  });

  test("includes terminal sessions keyed by id", async () => {
    const reality = makeReality({
      terminals: () => [{ id: "s1", tty: "/dev/ttys001", title: "Oak" }],
    });
    const snap = await reality.snapshot();
    expect(snap.terminals.get("s1")?.title).toBe("Oak");
    expect(snap.terminals.size).toBe(1);
  });

  test("a throwing source is logged loudly then degrades to an empty map", async () => {
    const reality = new RealityLayer(undefined, {
      screenLister: async () => {
        throw new Error("screen -ls exploded");
      },
      terminalEnumerator: async () => [],
    });
    // Capture the loud log (we never swallow silently) while keeping test
    // output clean.
    const orig = console.error;
    const logged: unknown[][] = [];
    console.error = (...a: unknown[]) => { logged.push(a); };
    try {
      const snap = await reality.snapshot();
      expect(snap.screens.size).toBe(0);
    } finally {
      console.error = orig;
    }
    expect(logged.length).toBeGreaterThan(0);
  });
});

describe("RealityLayer.liveAgentRows (reality LEFT JOIN db)", () => {
  test("surfaces live local agents, hides dead, passes remote through", async () => {
    store.createAgent({ id: "alive", display_name: "Alive", runtime: "claude-code", screen_name: "wire-alive" });
    store.createAgent({ id: "dead", display_name: "Dead", runtime: "claude-code", screen_name: "wire-dead" });
    store.createAgent({ id: "remote", display_name: "Remote", runtime: "claude-code", screen_name: "wire-remote" });
    makeRemote("remote");

    const reality = makeReality({ screens: () => [{ name: "wire-alive", pid: 111 }] });
    const live = await reality.liveAgentRows(store.listAgents(), localMachine);

    expect(live.map((a) => a.id).sort()).toEqual(["alive", "remote"]);
  });

  test("hides a local row even while it is inside the delete grace", async () => {
    store.createAgent({ id: "dead", display_name: "Dead", runtime: "claude-code", screen_name: "wire-dead" });
    let clock = 1000;
    const reality = makeReality({ screens: () => [], now: () => clock, graceMs: 60_000 });

    await reality.heal(store, localMachine); // marks but keeps the row (within grace)
    const live = await reality.liveAgentRows(store.listAgents(), localMachine);

    // Row still in the DB (not yet GC'd) but reality says the screen is gone,
    // so the read must not surface it.
    expect(store.getAgent("dead")).not.toBeNull();
    expect(live.map((a) => a.id)).not.toContain("dead");
  });
});

describe("RealityLayer.heal (grace-gated metadata healer)", () => {
  test("marks a missing local row, then GCs it after grace with a tombstone", async () => {
    store.createAgent({
      id: "dead",
      display_name: "Dead",
      runtime: "claude-code",
      screen_name: "wire-dead",
      spawn_manifest: JSON.stringify({ project_dir: "/x", display_name: "Dead", runtime: "claude-code", env: {} }),
    });
    let clock = 1000;
    const reality = makeReality({ screens: () => [], now: () => clock, graceMs: 60_000 });

    let r = await reality.heal(store, localMachine);
    expect(r.result.marked).toContain("dead");
    expect(r.result.gcd).toEqual([]);
    expect(store.getAgent("dead")).not.toBeNull();

    clock += 30_000; // still within grace
    r = await reality.heal(store, localMachine);
    expect(r.result.gcd).toEqual([]);
    expect(store.getAgent("dead")).not.toBeNull();

    clock += 31_000; // 61s since first mark → past grace
    r = await reality.heal(store, localMachine);
    expect(r.result.gcd).toContain("dead");
    expect(store.getAgent("dead")).toBeNull();
    // Tombstoned before delete so agent_resume still works (the old reconciler
    // deleted without one, losing the manifest).
    const tomb = store.getLatestTombstone("dead");
    expect(tomb).not.toBeNull();
    expect(tomb!.spawn_manifest).not.toBeNull();
  });

  test("a screen that reappears (even past grace) clears the mark and survives", async () => {
    store.createAgent({ id: "flap", display_name: "Flap", runtime: "claude-code", screen_name: "wire-flap" });
    let clock = 1000;
    let present = false;
    const reality = makeReality({
      screens: () => (present ? [{ name: "wire-flap", pid: 5 }] : []),
      now: () => clock,
      graceMs: 60_000,
    });

    await reality.heal(store, localMachine); // marked missing
    clock += 90_000; // past grace…
    present = true; // …but the screen is back
    const r = await reality.heal(store, localMachine);

    expect(r.result.gcd).toEqual([]);
    expect(r.result.alive).toContain("flap");
    expect(store.getAgent("flap")).not.toBeNull();
  });

  test("refreshes screen_pid for live agents", async () => {
    store.createAgent({ id: "a", display_name: "A", runtime: "claude-code", screen_name: "wire-a", screen_pid: 1 });
    const reality = makeReality({ screens: () => [{ name: "wire-a", pid: 999 }] });
    await reality.heal(store, localMachine);
    expect(store.getAgent("a")!.screen_pid).toBe(999);
  });

  test("never marks, GCs, or claims-alive a remote agent — and keeps it readable", async () => {
    store.createAgent({ id: "remote", display_name: "Remote", runtime: "claude-code", screen_name: "wire-remote" });
    makeRemote("remote");
    let clock = 1000;
    const reality = makeReality({ screens: () => [], now: () => clock, graceMs: 1 });

    clock += 10_000;
    const r = await reality.heal(store, localMachine);
    expect(r.result.marked).not.toContain("remote");
    expect(r.result.gcd).not.toContain("remote");
    expect(r.result.alive).not.toContain("remote");
    expect(store.getAgent("remote")).not.toBeNull();

    const live = await reality.liveAgentRows(store.listAgents(), localMachine);
    expect(live.map((a) => a.id)).toContain("remote");
  });

  test("reports orphan wire- screens that have no agent row", async () => {
    const reality = makeReality({
      screens: () => [
        { name: "wire-ghost", pid: 7 },
        { name: "not-wire", pid: 8 },
      ],
    });
    const r = await reality.heal(store, localMachine);
    expect(r.result.orphans.map((o) => o.name)).toEqual(["wire-ghost"]);
  });

  test("cross-machine safety: local-dead is pruned, remote-alive is untouched", async () => {
    store.createAgent({ id: "local-dead", display_name: "LocalDead", runtime: "claude-code", screen_name: "wire-local-dead" });
    store.createAgent({ id: "remote-alive", display_name: "RemoteAlive", runtime: "claude-code", screen_name: "wire-remote-alive" });
    makeRemote("remote-alive");

    const reality = makeReality({ screens: () => [], graceMs: 0 });
    await reality.heal(store, localMachine); // first sight → mark
    const r = await reality.heal(store, localMachine); // grace 0 → GC the marked local row

    expect(r.result.gcd).toContain("local-dead");
    expect(store.getAgent("local-dead")).toBeNull();
    expect(r.result.gcd).not.toContain("remote-alive");
    expect(store.getAgent("remote-alive")).not.toBeNull();
  });
});
