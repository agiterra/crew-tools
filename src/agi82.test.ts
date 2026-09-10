/**
 * AGI-82 — single source of truth for the crew roster.
 *
 * Two regressions, both measured against the deployed copy on patisserie
 * 2026-09-10 before these patches landed:
 *
 *   1. DEFAULT_DB fell back to `$HOME/.wire/crews.db` unconditionally, so a
 *      process with no CREW_DB read a PRIVATE per-uid shard and reported a
 *      roster nobody else could see.
 *   2. `screenNamespaceVerifiableHere` compared run_as_uid to the NUMERIC uid
 *      only, so rows stamped with a username ("_ephemeral" — i.e. every
 *      agiterra spawn) always took the fail-open branch and the reality-join
 *      filtered nothing: 23/23 rows surfaced, 14 of them dead.
 */
import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveDefaultDb, PrivateCrewShardError, SHARED_DB } from "./store.js";
import { RealityLayer } from "./reality.js";
import type { Agent } from "./store.js";

const temps: string[] = [];
function fakeHome(withLocalDb = true): string {
  const home = mkdtempSync(join(tmpdir(), "agi82-home-"));
  temps.push(home);
  if (withLocalDb) {
    mkdirSync(join(home, ".wire"), { recursive: true });
    writeFileSync(join(home, ".wire", "crews.db"), "");
  }
  return home;
}
function fakeShared(): string {
  const dir = mkdtempSync(join(tmpdir(), "agi82-shared-"));
  temps.push(dir);
  const p = join(dir, "crews.db");
  writeFileSync(p, "");
  return p;
}
afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe("resolveDefaultDb — a private shard can never be read by accident", () => {
  it("prefers the shared store over a private ~/.wire/crews.db when CREW_DB is unset", () => {
    // The exact 2026-09-10 fondant condition. DEPLOYED returns the private
    // shard here; that is the bug.
    const home = fakeHome();
    const shared = fakeShared();
    expect(resolveDefaultDb({ HOME: home }, shared)).toBe(shared);
    expect(resolveDefaultDb({ HOME: home }, shared)).not.toBe(join(home, ".wire", "crews.db"));
  });

  it("refuses an explicit CREW_DB that points at a private shard", () => {
    const home = fakeHome();
    const shared = fakeShared();
    const priv = join(home, ".wire", "crews.db");
    expect(() => resolveDefaultDb({ HOME: home, CREW_DB: priv }, shared)).toThrow(PrivateCrewShardError);
    try {
      resolveDefaultDb({ HOME: home, CREW_DB: priv }, shared);
    } catch (e) {
      // The error names both paths and the remedy — a sweep can act on it.
      expect((e as Error).message).toContain(priv);
      expect((e as Error).message).toContain(shared);
    }
  });

  it("accepts CREW_DB when it IS the shared store", () => {
    const shared = fakeShared();
    expect(resolveDefaultDb({ HOME: fakeHome(), CREW_DB: shared }, shared)).toBe(shared);
  });

  it("accepts ~/.wire/crews.db when it is a symlink to the shared store", () => {
    // tim's and _ephemeral's current arrangement — must keep working.
    const home = fakeHome(false);
    const shared = fakeShared();
    mkdirSync(join(home, ".wire"), { recursive: true });
    require("fs").symlinkSync(shared, join(home, ".wire", "crews.db"));
    expect(resolveDefaultDb({ HOME: home }, shared)).toBe(join(home, ".wire", "crews.db"));
  });

  it("falls back to the local db on a box with no shared store (first-run bootstrap)", () => {
    const home = fakeHome();
    expect(resolveDefaultDb({ HOME: home }, join(home, "no-such-shared.db")))
      .toBe(join(home, ".wire", "crews.db"));
  });

  it("honours CREW_DB_ALLOW_PRIVATE=1 for fixtures and forensics", () => {
    const home = fakeHome();
    const shared = fakeShared();
    expect(resolveDefaultDb({ HOME: home, CREW_DB_ALLOW_PRIVATE: "1" }, shared))
      .toBe(join(home, ".wire", "crews.db"));
  });

  it("names the fleet's shared store", () => {
    expect(SHARED_DB).toBe("/opt/agiterra/crew/crews.db");
  });
});

// --- The reality-join --------------------------------------------------

const MACHINE = "patisserie";
function row(id: string, runAsUid: string | undefined, opts: { machine?: string } = {}): Agent {
  return {
    id,
    display_name: id,
    runtime: "claude-code",
    screen_name: `wire-${id}`,
    screen_pid: 999_999,
    cc_session_id: null,
    pane: null,
    status_name: null,
    status_desc: null,
    badge: null,
    launched_at: 1,
    last_seen: 1,
    ttl_idle_minutes: null,
    spawn_manifest: runAsUid === undefined ? null : JSON.stringify({ run_as_uid: runAsUid }),
    machine_name: opts.machine ?? MACHINE,
  } as Agent;
}

/** A store stub: heal() only needs listAgents + the write methods it may call. */
function storeStub(rows: Agent[]) {
  return {
    listAgents: () => rows,
    localMachineName: () => MACHINE,
    readonly: true,
    updateAgentPid: () => {},
    deleteAgent: () => {},
    tombstoneAgent: () => {},
    createTombstone: () => {},
  } as any;
}

async function surfaced(rows: Agent[], liveScreens: string[]): Promise<string[]> {
  const reality = new RealityLayer(undefined, {
    screenLister: async () => liveScreens.map((name, i) => ({ name, pid: 1000 + i })),
    terminalEnumerator: async () => [],
  });
  const { live } = await reality.heal(storeStub(rows), MACHINE);
  return live.map((a) => a.id);
}

describe("reality-join — a dead-screen row must not surface", () => {
  it("hides a dead row stamped with a USERNAME run_as_uid matching this process", async () => {
    // THE REGRESSION. Deployed: ["ghost","alive"] — the username never equalled
    // String(getuid()), so the row took the fail-open branch untested.
    const me = require("os").userInfo().username;
    const ids = await surfaced(
      [row("ghost", me), row("alive", me)],
      ["wire-alive"],
    );
    expect(ids).toEqual(["alive"]);
  });

  it("still hides a dead row with no run_as_uid (the legacy same-uid path)", async () => {
    expect(await surfaced([row("ghost", undefined), row("alive", undefined)], ["wire-alive"]))
      .toEqual(["alive"]);
  });

  it("still fails OPEN for another uid's screens — not ours to prove dead", async () => {
    const ids = await surfaced([row("elsewhere", "someone-else")], []);
    expect(ids).toEqual(["elsewhere"]);
  });

  it("still fails OPEN when SCREENDIR points outside our own home", async () => {
    // Right user, wrong namespace: absence proves nothing. This is the half of
    // the original AGI-27 caution that remains correct.
    const me = require("os").userInfo().username;
    const prev = process.env.SCREENDIR;
    process.env.SCREENDIR = "/Users/somebody-else/.screen";
    try {
      expect(await surfaced([row("ghost", me)], [])).toEqual(["ghost"]);
    } finally {
      if (prev === undefined) delete process.env.SCREENDIR;
      else process.env.SCREENDIR = prev;
    }
  });

  it("still passes peer-machine rows through unverified", async () => {
    const ids = await surfaced([row("remote", undefined, { machine: "mini" })], []);
    expect(ids).toEqual(["remote"]);
  });

  it("still keeps every row readable when the screen probe itself fails", async () => {
    const reality = new RealityLayer(undefined, {
      screenLister: async () => { throw new Error("screen unavailable"); },
      terminalEnumerator: async () => [],
    });
    const { live } = await reality.heal(storeStub([row("ghost", require("os").userInfo().username)]), MACHINE);
    expect(live.map((a) => a.id)).toEqual(["ghost"]);
  });
});
