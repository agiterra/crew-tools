/**
 * Stop-preservation contract — docs/stop-preservation-spec-20260915.md rev4.
 *
 * Fixtures only. No real lane, no incident original, and never Rosquillo or
 * Zeppolina, per the GO. Every fixture is built and torn down under a temp dir.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile, stat, chmod } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  classifySpawnHome, manifestDigest, buildRemoteTeardownScript,
  removeCodexSpawnHome, DISPOSABLE_BASENAMES, LOCK_DIRS,
} from "./codex-spawn.js";

/** A spawn home carrying one of everything the spec cares about. */
async function fixture(): Promise<{ home: string; codexHome: string; stateDir: string }> {
  const home = await mkdtemp(join(tmpdir(), "spawnfix-"));
  const stateDir = join(home, ".wire", "codex-spawn");
  const codexHome = join(stateDir, "agentx");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "auth.json"), "CREDENTIAL-MUST-SURVIVE");
  await symlink(join(home, ".codex", "auth.json"), join(codexHome, "auth.json"));

  for (const b of DISPOSABLE_BASENAMES) await writeFile(join(codexHome, b), "regenerable");
  for (const d of LOCK_DIRS) {
    await mkdir(join(codexHome, d), { recursive: true });
    await writeFile(join(codexHome, d, "a.lock"), "lock");
  }
  // conversation state + sidecars
  for (const f of ["thread_history_1.sqlite", "thread_history_1.sqlite-wal", "thread_history_1.sqlite-shm",
                   "memories_1.sqlite", "state_5.sqlite", "goals_1.sqlite"]) {
    await writeFile(join(codexHome, f), "db");
  }
  // user content that must survive, including inside cache/ and tmp/
  await mkdir(join(codexHome, "cache", "a"), { recursive: true });
  await writeFile(join(codexHome, "cache", "a", "deadbeef.json"), "USER-WROTE-THIS");
  await mkdir(join(codexHome, "tmp", "arg0", "codex-arg0-example"), { recursive: true });
  await writeFile(join(codexHome, "tmp", "arg0", "codex-arg0-example", "userfile.txt"), "USER-WROTE-THIS");
  await writeFile(join(codexHome, "something-new-from-a-future-release"), "UNKNOWN");
  await mkdir(join(codexHome, "workspaces", "repo", ".git"), { recursive: true });
  await writeFile(join(codexHome, "workspaces", "repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(stateDir, "agentx.thread.json"), '{"threadId":"t-1"}');
  return { home, codexHome, stateDir };
}

const run = (f: { home: string; codexHome: string; stateDir: string }) =>
  removeCodexSpawnHome(
    { agentId: "agentx", runtime: "codex", selfHome: f.home, env: { STATE_DIR: f.stateDir } },
    { log: () => {} },
  );

const alive = async (p: string) => { try { await stat(p); return true; } catch { return false; } };

describe("classification", () => {
  test("1+11: conversation state, sidecars and unknown entries are retained", async () => {
    const f = await fixture();
    await run(f);
    for (const keep of ["thread_history_1.sqlite", "thread_history_1.sqlite-wal", "thread_history_1.sqlite-shm",
                        "memories_1.sqlite", "state_5.sqlite", "goals_1.sqlite",
                        "something-new-from-a-future-release"]) {
      expect(await alive(join(f.codexHome, keep))).toBe(true);
    }
    expect(await alive(join(f.stateDir, "agentx.thread.json"))).toBe(true);
  });

  test("2: disposable scaffolding is removed", async () => {
    const f = await fixture();
    await run(f);
    for (const b of DISPOSABLE_BASENAMES) expect(await alive(join(f.codexHome, b))).toBe(false);
    for (const d of LOCK_DIRS) expect(await alive(join(f.codexHome, d))).toBe(false);
  });

  test("3: auth.json is unlinked and the CREDENTIAL ITSELF is untouched", async () => {
    const f = await fixture();
    await run(f);
    expect(await alive(join(f.codexHome, "auth.json"))).toBe(false);
    expect(await readFile(join(f.home, ".codex", "auth.json"), "utf8")).toBe("CREDENTIAL-MUST-SURVIVE");
  });

  test("9: cache/** retained entirely — a user-written hex .json survives", async () => {
    const f = await fixture();
    await run(f);
    expect(await readFile(join(f.codexHome, "cache", "a", "deadbeef.json"), "utf8")).toBe("USER-WROTE-THIS");
  });

  test("10: tmp/** retained entirely — a user file under codex-arg0-example survives", async () => {
    const f = await fixture();
    await run(f);
    expect(await readFile(join(f.codexHome, "tmp", "arg0", "codex-arg0-example", "userfile.txt"), "utf8"))
      .toBe("USER-WROTE-THIS");
  });

  test("6: nested Git content is not mutated and is never descended into", async () => {
    const f = await fixture();
    const before = await readFile(join(f.codexHome, "workspaces", "repo", ".git", "HEAD"), "utf8");
    await run(f);
    expect(await readFile(join(f.codexHome, "workspaces", "repo", ".git", "HEAD"), "utf8")).toBe(before);
    const entries = await classifySpawnHome(f.codexHome, f.home);
    expect(entries.some((e) => e.path.includes("/workspaces/repo"))).toBe(false);
    expect(entries.some((e) => e.path.includes("/cache/a/"))).toBe(false);
  });

  test("5: retained entries keep their mode", async () => {
    const f = await fixture();
    await chmod(join(f.codexHome, "state_5.sqlite"), 0o600);
    await run(f);
    expect(((await stat(join(f.codexHome, "state_5.sqlite"))).mode & 0o777)).toBe(0o600);
  });
});

describe("receipt", () => {
  test("8+14: INTENT precedes removal; finalize records actual sets", async () => {
    const f = await fixture();
    const r = await run(f);
    const files = await readdir(join(f.stateDir, ".stopped"));
    expect(files.length).toBe(1);
    const rec = JSON.parse(await readFile(join(f.stateDir, ".stopped", files[0]!), "utf8"));
    expect(rec.state).toBe("complete");
    expect(rec.manifest_scope).toBe("root-metadata");
    expect(rec.removed.sort()).toEqual(r.removed.sort());
    expect(rec.retained.length).toBeGreaterThan(0);
  });

  test("the digest is over metadata only — content changes do not move it", async () => {
    const f = await fixture();
    const a = manifestDigest(await classifySpawnHome(f.codexHome, f.home));
    await writeFile(join(f.codexHome, "workspaces", "repo", ".git", "HEAD"), "ref: refs/heads/other\n");
    const b = manifestDigest(await classifySpawnHome(f.codexHome, f.home));
    expect(b).toBe(a); // never descends, so nested content cannot affect it
  });

  test("12: INTENT undurable -> NOTHING is removed", async () => {
    const f = await fixture();
    await writeFile(join(f.stateDir, ".stopped"), "not-a-directory"); // mkdir will fail
    const r = await run(f);
    expect(r.skipped).toBe("intent-undurable");
    expect(r.removed).toEqual([]);
    for (const b of DISPOSABLE_BASENAMES) expect(await alive(join(f.codexHome, b))).toBe(true);
    expect(await alive(join(f.codexHome, "auth.json"))).toBe(true);
  });
});

describe("remote parity", () => {
  test("the generated /bin/sh program yields the SAME disposition as the TS classifier", async () => {
    const f = await fixture();
    const ts = await classifySpawnHome(f.codexHome, f.home);
    const tsDisposable = new Set(ts.filter((e) => e.disposition === "disposable").map((e) => e.path));

    const script = buildRemoteTeardownScript();
    const proc = Bun.spawnSync(["/bin/sh", "-c", script], {
      env: {
        ...process.env,
        CODEX_HOME: f.codexHome,
        AUTH_TARGET: join(f.home, ".codex", "auth.json"),
        RECEIPT: join(f.stateDir, ".stopped", "agentx.remote.json"),
      },
    });
    const out = new TextDecoder().decode(proc.stdout);
    expect(out).toContain("CREW_TEARDOWN_DONE");
    const shDisposable = new Set(
      out.split("\n").filter((l) => l.startsWith("DISPOSE ")).map((l) => l.slice(8).trim()),
    );
    // Same rules, two implementations: the sets must agree exactly.
    expect([...shDisposable].sort()).toEqual([...tsDisposable].sort());
    // and the credential target must still exist after the remote program ran
    expect(await readFile(join(f.home, ".codex", "auth.json"), "utf8")).toBe("CREDENTIAL-MUST-SURVIVE");
  });
});
