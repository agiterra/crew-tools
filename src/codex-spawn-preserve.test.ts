/**
 * Stop-preservation contract — docs/stop-preservation-spec-20260915.md rev4.
 *
 * Fixtures only. No real lane, no incident original, and never Rosquillo or
 * Zeppolina, per the GO. Every fixture is built and torn down under a temp dir.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile, stat, lstat, chmod } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import {
  classifySpawnHome, manifestDigest, buildRemoteTeardownScript,
  removeCodexSpawnHome, writeReceipt, DISPOSABLE_BASENAMES, LOCK_DIRS,
  type SpawnEntry, type StopReceipt,
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
  // ⛔ C1 (PR 91 review). The parity fixture held only plain `a.lock` files, so the two places
  // where /bin/sh and lstat disagree about "exists" and "is a file" were never exercised:
  //   (a) a DANGLING symlink is `[ -e ]`-false, so the shell skipped it and disposed the dir;
  //   (b) `[ -f ]` FOLLOWS a link, so a symlinked .lock was disposed by shell and kept by TS.
  // Both made the shell rm -rf a lock directory the classifier retains.
  await writeFile(join(codexHome, "realfile-for-lock-link"), "MUST-SURVIVE");
  await symlink(join(codexHome, "realfile-for-lock-link"), join(codexHome, "app-server-control", "sneaky.lock"));
  await symlink(join(codexHome, "does-not-exist"), join(codexHome, "mcp-oauth-locks", "dangling.lock"));
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

// ⛔ lstat, NOT stat. stat FOLLOWS symlinks, so a dangling link reads as absent and this helper
// would report a retained entry as removed. That is the same stat/lstat confusion as C1(b) —
// it was in the test harness as well as the shell, which is part of why C1 was invisible here.
const alive = async (p: string) => { try { await lstat(p); return true; } catch { return false; } };

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

  test("2: disposable scaffolding is removed, and a lock dir holding non-locks is NOT", async () => {
    const f = await fixture();
    await run(f);
    for (const b of DISPOSABLE_BASENAMES) expect(await alive(join(f.codexHome, b))).toBe(false);
    // A lock dir whose entries are ALL plain .lock files goes.
    expect(await alive(join(f.codexHome, "thread-writer-locks"))).toBe(false);
    // ⛔ C1 regression rows. These two hold a symlinked and a dangling .lock respectively, so the
    // DIRECTORY is retained while its plain a.lock is still removed. Before the fix the generated
    // shell disposed both directories outright — rm -rf on content the classifier retains.
    for (const d of ["app-server-control", "mcp-oauth-locks"]) {
      expect(await alive(join(f.codexHome, d))).toBe(true);
      expect(await alive(join(f.codexHome, d, "a.lock"))).toBe(false);
    }
    expect(await alive(join(f.codexHome, "app-server-control", "sneaky.lock"))).toBe(true);
    expect(await alive(join(f.codexHome, "mcp-oauth-locks", "dangling.lock"))).toBe(true);
    // the symlink target must be untouched
    expect(await readFile(join(f.codexHome, "realfile-for-lock-link"), "utf8")).toBe("MUST-SURVIVE");
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

describe("fail-closed is audible", () => {
  test("remote INTENT failure is LOGGED, not merely skipped", async () => {
    const f = await fixture();
    const logs: string[] = [];
    const r = await removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: f.home,
        env: { STATE_DIR: f.stateDir }, target: { runAsUid: "_ephemeral" } as any },
      { log: (m) => logs.push(m), sshRun: async () => "CREW_INTENT_FAILED\n" },
    );
    expect(r.skipped).toBe("intent-undurable");
    expect(logs.some((l) => l.includes("NOTHING REMOVED"))).toBe(true);
  });
});

describe("remote parity", () => {
  test("the generated /bin/sh program yields the SAME disposition as the TS classifier", async () => {
    const f = await fixture();
    const ts = await classifySpawnHome(f.codexHome, f.home);
    const tsDisposable = new Set(ts.filter((e) => e.disposition === "disposable").map((e) => e.path));

    const script = buildRemoteTeardownScript();
    const proc = Bun.spawnSync(["/bin/sh", "-c", script], {
      // ⛔ F1 (PR 91 review). This inherited AGENT_ID from the author's shell. The generated
      // script runs `set -u` then `AG="$AGENT_ID"`, so with AGENT_ID unset the shell exits
      // before the first loop iteration and every assertion below rides on a persona variable.
      // It was green here and red in CI, and it is WHY C1 went undetected: a test green for an
      // environmental reason is never under pressure. Supply it explicitly.
      env: {
        ...process.env,
        AGENT_ID: "agentx",
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

    // ⛔ THE FV FOUND THIS: the remote path wrote a malformed INTENT and never finalized,
    // so the primary (cross-uid) path left every receipt stuck at "in-progress" forever.
    // The classification test above passed throughout — a suite can agree with itself.
    const rec = JSON.parse(await readFile(join(f.stateDir, ".stopped", "agentx.remote.json"), "utf8"));
    expect(rec.state).toBe("complete");
    expect(rec.manifest_scope).toBe("root-metadata");
    expect(Array.isArray(rec.disposable)).toBe(true);
    expect(rec.disposable.length).toBeGreaterThan(0);
    expect(rec.retained.some((p: string) => p.endsWith("thread_history_1.sqlite"))).toBe(true);
    expect(rec.failed).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// SPEC ROWS 15-18 — MUTANT CONTROLS                                    (PR 91 review, T1)
//
// The spec's closing line: "Rows 15-18 are what make the rest mean anything: each earlier
// revision of this spec passed every test I had imagined for it at the time." That is the
// literal history of this file — rev1's allowlist would have deleted the 19.5 MB
// thread_history and kept a 32 KB goals file, and it passed review; rev2 named cache/ and
// tmp/ as disposable DIRECTORIES, the same bug one level down, and it passed review too.
//
// A test suite that has never been run against a KNOWN-BAD classifier has not been shown to
// be load-bearing. So: one auditor, both implementations, four mutants, and a positive
// control proving the auditor can return clean.
//
// ⚠️ ROW 7 (stop -> resume e2e) is named by spec row 15 and is NOT audited here: it is not
// in this suite at all (review finding T2, follow-up). The whole-home control below covers
// rows 1, 4, 5, 6, 9 and 10. Row 7 is stated as uncovered rather than quietly dropped.
// ════════════════════════════════════════════════════════════════════════════════════════

type Fx = { home: string; codexHome: string; stateDir: string };
type Classifier = (codexHome: string, home: string) => Promise<SpawnEntry[]>;

/** A fixture with the mode-sensitive entry row 5 measures already armed. */
async function armed(): Promise<Fx> {
  const f = await fixture();
  await chmod(join(f.codexHome, "state_5.sqlite"), 0o600);
  return f;
}

/**
 * ONE auditor, run against BOTH implementations and every mutant, returning the spec rows
 * that FAILED. Shared on purpose: a per-implementation auditor lets a mutant fail
 * "differently" on each side, which is precisely the divergence class C1 turned out to be.
 */
async function failedRows(f: Fx): Promise<number[]> {
  const at = (...p: string[]) => join(f.codexHome, ...p);
  const same = async (p: string, want: string) => {
    try { return (await readFile(p, "utf8")) === want; } catch { return false; }
  };
  const bad: number[] = [];

  if (!(await alive(at("thread_history_1.sqlite")))) bad.push(1);
  // 2 is audited so a mutant that removes NOTHING cannot read as a clean pass.
  if (await alive(at("config.toml"))) bad.push(2);
  if (!(await same(join(f.home, ".codex", "auth.json"), "CREDENTIAL-MUST-SURVIVE"))) bad.push(3);
  // 4: a sqlite is retained WITH its -wal and -shm. All three, or the row fails.
  const trio = ["thread_history_1.sqlite", "thread_history_1.sqlite-wal", "thread_history_1.sqlite-shm"];
  if (!(await Promise.all(trio.map((n) => alive(at(n))))).every(Boolean)) bad.push(4);
  let mode = -1;
  try { mode = (await stat(at("state_5.sqlite"))).mode & 0o777; } catch { /* gone */ }
  if (mode !== 0o600) bad.push(5);
  if (!(await same(at("workspaces", "repo", ".git", "HEAD"), "ref: refs/heads/main\n"))) bad.push(6);
  if (!(await same(at("cache", "a", "deadbeef.json"), "USER-WROTE-THIS"))) bad.push(9);
  if (!(await same(at("tmp", "arg0", "codex-arg0-example", "userfile.txt"), "USER-WROTE-THIS"))) bad.push(10);
  if (!(await alive(at("something-new-from-a-future-release")))) bad.push(11);
  return bad.sort((a, b) => a - b);
}

const runWith = (f: Fx, classify?: Classifier) =>
  removeCodexSpawnHome(
    { agentId: "agentx", runtime: "codex", selfHome: f.home, env: { STATE_DIR: f.stateDir } },
    { log: () => {}, classify },
  );

function runShell(f: Fx, script: string): string {
  const proc = Bun.spawnSync(["/bin/sh", "-c", script], {
    env: {
      ...process.env,
      AGENT_ID: "agentx",
      CODEX_HOME: f.codexHome,
      AUTH_TARGET: join(f.home, ".codex", "auth.json"),
      RECEIPT: join(f.stateDir, ".stopped", "agentx.remote.json"),
    },
  });
  return new TextDecoder().decode(proc.stdout);
}

/**
 * Mutate the REAL generated program. ⛔ A string replace that matches nothing produces a
 * perfectly valid script that passes every assertion — a mutant control that silently
 * failed to apply is worse than no control, because it reports as evidence. So each
 * mutation proves it changed the text before it is allowed to run.
 */
function mutate(find: string, replace: string): string {
  const src = buildRemoteTeardownScript();
  const out = src.replace(find, replace);
  if (out === src) throw new Error(`MUTATION DID NOT APPLY — anchor gone: ${find.slice(0, 70)}`);
  return out;
}

// ---- the four mutants, TS side -----------------------------------------------------------

/** Commit bf3fdb0 itself: the whole home is one disposable entry. This IS the incident. */
// ⛔ After N10 added a local whole-home guard, a mutant naming the home itself is REFUSED —
// which is correct, and would have made spec row 15 untestable if left that way. Row 15 is about
// the AUDITOR catching whole-home destruction, so the mutant now expresses the same EFFECT the
// way it can still reach: every root entry disposable. The guard gets its own row below.
const mutantWholeHome: Classifier = async (codexHome, home) =>
  (await classifySpawnHome(codexHome, home)).map((e) =>
    dirname(e.path) === codexHome
      ? { ...e, disposition: "disposable" as const, reason: "MUTANT: whole-home removal" }
      : e);

/** Revision 1 of the spec: an ALLOWLIST of what to keep. It named goals_1.sqlite (32 KB)
 *  and would have deleted thread_history_1.sqlite (19.5 MB). */
const REV1_KEEP = new Set(["goals_1.sqlite", "sessions", "skills", "plugins", "workspaces"]);
const mutantRev1Allowlist: Classifier = async (codexHome, home) =>
  (await classifySpawnHome(codexHome, home)).map((e) =>
    dirname(e.path) === codexHome && !REV1_KEEP.has(basename(e.path))
      ? { ...e, disposition: "disposable" as const, reason: "MUTANT: rev-1 allowlist" }
      : e);

/** Revision 2: cache/ and tmp/ named as disposable DIRECTORIES — the same bug, one level down. */
const mutantCacheTmpDirs: Classifier = async (codexHome, home) =>
  (await classifySpawnHome(codexHome, home)).map((e) =>
    dirname(e.path) === codexHome && ["cache", "tmp"].includes(basename(e.path))
      ? { ...e, disposition: "disposable" as const, reason: "MUTANT: cache/tmp disposable dirs" }
      : e);

/** The pre-structural heuristics: a hex basename "looks generated", codex-arg0* "looks like
 *  scaffolding". Both require DESCENDING, which the real classifier never does — so the
 *  mutant has to add the descent in order to express them at all. */
const mutantHexHeuristics: Classifier = async (codexHome, home) => {
  const out = await classifySpawnHome(codexHome, home);
  const walk = async (dir: string): Promise<void> => {
    let names: string[] = [];
    try { names = await readdir(dir); } catch { return; }
    for (const n of names) {
      const p = join(dir, n);
      const st = await lstat(p);
      const base = { path: p, size: st.size, mode: st.mode & 0o7777 };
      if (st.isDirectory()) {
        if (/^codex-arg0/.test(n)) {
          out.push({ ...base, kind: "dir", disposition: "disposable", reason: "MUTANT: codex-arg0 heuristic" });
        } else await walk(p);
      } else if (/^[0-9a-f]{8,}\./.test(n)) {
        out.push({ ...base, kind: "file", disposition: "disposable", reason: "MUTANT: hex-basename heuristic" });
      }
    }
  };
  await walk(join(codexHome, "cache"));
  await walk(join(codexHome, "tmp"));
  return out;
};

describe("spec rows 15-18 — mutant controls", () => {
  // ⛔ POSITIVE CONTROLS FIRST. Without these two rows, every mutant assertion below is
  // equally satisfied by an auditor that fails everything unconditionally.
  test("control: the REAL TS classifier passes every audited row", async () => {
    const f = await armed();
    await runWith(f);
    expect(await failedRows(f)).toEqual([]);
  });

  test("control: the REAL shell program passes every audited row", async () => {
    const f = await armed();
    expect(runShell(f, buildRemoteTeardownScript())).toContain("CREW_TEARDOWN_DONE");
    expect(await failedRows(f)).toEqual([]);
  });

  test("15 TS: whole-home mutant fails rows 1, 4, 5, 6, 9, 10", async () => {
    const f = await armed();
    await runWith(f, mutantWholeHome);
    expect(await failedRows(f)).toEqual(expect.arrayContaining([1, 4, 5, 6, 9, 10]));
  });

  // ⛔ N10: the guard itself, on the LOCAL path — the remote one has had a row since T4.
  test("N10 TS: the home itself in the disposal set is REFUSED, nothing removed", async () => {
    const f = await armed();
    const res = await runWith(f, async (codexHome, home) => [
      ...(await classifySpawnHome(codexHome, home)),
      { path: codexHome, disposition: "disposable" as const, reason: "MUTANT: whole home",
        kind: "dir" as const, size: 0, mode: 0o700 },
    ]);
    expect(res.skipped).toBe("whole-home-in-disposal-set");
    expect(res.removed).toEqual([]);
    expect(await alive(f.codexHome)).toBe(true);
    expect(await failedRows(f)).toEqual([2]);   // refusal is TOTAL: even scaffolding stays
  });

  test("15 shell: whole-home mutant fails rows 1, 4, 5, 6, 9, 10", async () => {
    const f = await armed();
    // Reinstates bf3fdb0's removal AND drops the `$H` guard, in one edit.
    runShell(f, mutate(
      'sort -r "$D" | while IFS= read -r p; do [ "$p" = "$H" ] && continue;',
      'rm -rf -- "$H"\nsort -r "$D" | while IFS= read -r p; do',
    ));
    expect(await failedRows(f)).toEqual(expect.arrayContaining([1, 4, 5, 6, 9, 10]));
  });

  test("16 TS: rev-1 allowlist mutant fails row 1 on thread_history_1.sqlite specifically", async () => {
    const f = await armed();
    await runWith(f, mutantRev1Allowlist);
    expect(await failedRows(f)).toContain(1);
    expect(await alive(join(f.codexHome, "thread_history_1.sqlite"))).toBe(false);
    // The exact inversion that made rev1 look reasonable: the small file lives, the big one dies.
    expect(await alive(join(f.codexHome, "goals_1.sqlite"))).toBe(true);
  });

  test("16 shell: rev-1 allowlist mutant fails row 1 on thread_history_1.sqlite specifically", async () => {
    const f = await armed();
    runShell(f, mutate(
      '  elif [ -f "$p" ]; then for b in $BASES; do [ "$n" = "$b" ] && d=1; done',
      '  elif [ -f "$p" ]; then d=1; for b in goals_1.sqlite; do [ "$n" = "$b" ] && d=0; done',
    ));
    expect(await failedRows(f)).toContain(1);
    expect(await alive(join(f.codexHome, "thread_history_1.sqlite"))).toBe(false);
    expect(await alive(join(f.codexHome, "goals_1.sqlite"))).toBe(true);
  });

  test("17 TS: cache/ and tmp/ as disposable directories fails rows 9 and 10", async () => {
    const f = await armed();
    await runWith(f, mutantCacheTmpDirs);
    expect(await failedRows(f)).toEqual(expect.arrayContaining([9, 10]));
  });

  test("17 shell: cache/ and tmp/ as disposable directories fails rows 9 and 10", async () => {
    const f = await armed();
    runShell(f, mutate(
      '  elif [ -d "$p" ]; then',
      '  elif [ -d "$p" ]; then\n    [ "$n" = "cache" ] && d=1\n    [ "$n" = "tmp" ] && d=1',
    ));
    expect(await failedRows(f)).toEqual(expect.arrayContaining([9, 10]));
  });

  test("18 TS: hex-basename / codex-arg0 heuristics fail rows 9 and 10", async () => {
    const f = await armed();
    await runWith(f, mutantHexHeuristics);
    expect(await failedRows(f)).toEqual(expect.arrayContaining([9, 10]));
  });

  test("18 shell: hex-basename / codex-arg0 heuristics fail rows 9 and 10", async () => {
    const f = await armed();
    runShell(f, mutate(
      'mkdir -p "$(dirname "$R")"',
      'find "$H/cache" "$H/tmp" \\( -type d -name "codex-arg0*" -o -type f -name "[0-9a-f][0-9a-f][0-9a-f][0-9a-f]*" \\) >> "$D" 2>/dev/null\n'
        + 'mkdir -p "$(dirname "$R")"',
    ));
    expect(await failedRows(f)).toEqual(expect.arrayContaining([9, 10]));
  });

  // ⛔ T4 (PR 91 review). The generator's comment claims a whole-home target is "unreachable
  // by construction rather than by assertion". Construction can be changed by an edit; this
  // row is what notices. It forces `$H` onto the disposal list and requires the guard to
  // REFUSE it — a guard nobody has seen refuse is indistinguishable from one that cannot.
  test("T4: an explicit whole-home target on the disposal list is REFUSED by the guard", async () => {
    const f = await armed();
    const out = runShell(f, mutate(
      'while IFS= read -r p; do echo "DISPOSE $p"; done < "$D"',
      'echo "$H" >> "$D"\nwhile IFS= read -r p; do echo "DISPOSE $p"; done < "$D"',
    ));
    expect(out).toContain("CREW_TEARDOWN_DONE");
    expect(await alive(f.codexHome)).toBe(true);
    expect(await failedRows(f)).toEqual([]);
  });
});

// ── spec row 13 — FINALIZE FAILS AFTER REMOVAL ────────────────────────────────────────────
// The receipt is the whole audit story, and this is the branch where it is hardest to tell the
// truth: removal has ALREADY RUN, so "nothing was removed" and "everything was retained" are
// both lies, and "complete" is the worst lie of the three. F3 shipped with `state:
// "finalize-failed"` declared, typed — and never assigned to anything.
describe("spec row 13 — finalize-failed", () => {
  /** Succeeds for the first `okFor` calls, then throws. Records every receipt it accepted. */
  function flakyWriter(okFor: number) {
    const accepted: Array<{ stamp: string; r: StopReceipt }> = [];
    let n = 0;
    const fn = async (stateDir: string, agentId: string, stamp: string, r: StopReceipt) => {
      if (++n > okFor) throw new Error("ENOSPC: simulated storage failure");
      accepted.push({ stamp, r });
      return writeReceipt(stateDir, agentId, stamp, r);
    };
    return { fn, accepted, calls: () => n };
  }

  test("13: finalize fails -> a finalize-failed receipt carries the ACTUAL sets, never 'complete'", async () => {
    const f = await armed();
    const w = flakyWriter(1); // INTENT succeeds; the finalize write throws; the retry succeeds.
    const logs: string[] = [];
    const res = await removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: f.home, env: { STATE_DIR: f.stateDir } },
      { log: (m) => logs.push(m), writeReceipt: async (sd, a, st, r) => {
          if (st.endsWith(".finalize-failed")) return writeReceipt(sd, a, st, r);
          return w.fn(sd, a, st, r);
        } },
    );

    // Removal DID run — this is the state the row exists to describe.
    expect(res.removed.length).toBeGreaterThan(0);

    const names = await readdir(join(f.stateDir, ".stopped"));
    const ff = names.find((n) => n.includes("finalize-failed"));
    expect(ff).toBeDefined();
    const rec = JSON.parse(await readFile(join(f.stateDir, ".stopped", ff!), "utf8"));

    expect(rec.state).toBe("finalize-failed");           // never "complete"
    expect(rec.removed).toEqual(res.removed);            // the ACTUAL removed set
    expect(rec.retained.length).toBeGreaterThan(0);
    expect(rec.retained.some((p: string) => p.endsWith("thread_history_1.sqlite"))).toBe(true);
    expect(rec.manifest_scope).toBe("root-metadata");
    // and the caller is told, rather than handed a success.
    expect(res.failed.some((x) => x.error === "finalize-failed")).toBe(true);
    expect(logs.join("\n")).toContain("Not reported as success");
    // ⛔ the row's negative half: it must NOT claim everything survived.
    expect(logs.join("\n")).not.toContain("retained 0 entr");
  });

  test("13b: when the failure receipt ALSO cannot be written, that limitation is stated", async () => {
    const f = await armed();
    const w = flakyWriter(1); // INTENT succeeds; finalize AND its retry both throw.
    const logs: string[] = [];
    const res = await removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: f.home, env: { STATE_DIR: f.stateDir } },
      { log: (m) => logs.push(m), writeReceipt: w.fn },
    );
    expect(w.calls()).toBe(3);                            // INTENT, finalize, finalize-failed retry
    expect(res.removed.length).toBeGreaterThan(0);
    const all = logs.join("\n");
    expect(all).toContain("storage will not accept a failure record");
    expect(all).toContain("the in-progress INTENT receipt is the only durable record");
    // The INTENT really is intact and really does name what was at risk.
    const names = await readdir(join(f.stateDir, ".stopped"));
    expect(names.some((n) => n.includes("finalize-failed"))).toBe(false);
    const intent = JSON.parse(await readFile(join(f.stateDir, ".stopped", names[0]), "utf8"));
    expect(intent.state).toBe("in-progress");
    expect(intent.retained.some((p: string) => p.endsWith("thread_history_1.sqlite"))).toBe(true);
  });
});

// ── T3 (row 14, ACCEPT PATH) and M2 (the thread pointer) ──────────────────────────────────
describe("spec row 14 — accept path, and the thread pointer", () => {
  /** A home containing NOTHING but disposable entries. */
  async function onlyDisposable(): Promise<Fx> {
    const home = await mkdtemp(join(tmpdir(), "spawnacc-"));
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
    await writeFile(join(stateDir, "agentx.thread.json"), '{"threadId":"t-1"}');
    return { home, codexHome, stateDir };
  }

  // ⛔ The previous suite labelled a full-fixture test "8+14" and never ran the accept path at
  // all. A gate suite that only ever shows the gate REFUSING has not shown it can say yes —
  // and a classifier that says no to everything passes every retention row in this file.
  test("14: a lane with only disposable entries stops cleanly and the receipt says so", async () => {
    const f = await onlyDisposable();
    const res = await runWith(f);

    expect(res.skipped).toBeUndefined();
    expect(res.failed).toEqual([]);
    expect(res.removed.length).toBeGreaterThan(0);
    // Everything classified went; nothing is left but the emptied home itself.
    expect(await readdir(f.codexHome)).toEqual([]);
    // and the credential is still untouched.
    expect(await readFile(join(f.home, ".codex", "auth.json"), "utf8")).toBe("CREDENTIAL-MUST-SURVIVE");

    const names = await readdir(join(f.stateDir, ".stopped"));
    const rec = JSON.parse(await readFile(join(f.stateDir, ".stopped", names[0]), "utf8"));
    expect(rec.state).toBe("complete");
    expect(rec.retained).toEqual([]);
    expect(rec.removed.length).toBe(res.removed.length);
  });

  // ⛔ M2. Deleting the thread pointer is half of ENG-4161: the spawn home can be rebuilt,
  // but `<id>.thread.json` is what `codex resume` reads to find the conversation. It was
  // retained by OMISSION — no code path referenced it, so nothing would have noticed an edit
  // that added it to the disposal set. Asserted now on BOTH implementations.
  test("M2 local: the thread pointer survives and is reported, not merely unmentioned", async () => {
    const f = await fixture();
    const res = await runWith(f);
    const thread = join(f.stateDir, "agentx.thread.json");
    expect(await alive(thread)).toBe(true);
    expect(await readFile(thread, "utf8")).toBe('{"threadId":"t-1"}');
    expect(res.removed).not.toContain(thread);
    expect(res.absent).not.toContain(thread);   // present, so it must NOT be reported absent
  });

  test("M2 remote: the generated program never disposes the thread pointer", async () => {
    const f = await fixture();
    const out = runShell(f, buildRemoteTeardownScript());
    expect(out).toContain("CREW_TEARDOWN_DONE");
    const thread = join(f.stateDir, "agentx.thread.json");
    expect(await alive(thread)).toBe(true);
    expect(out).not.toContain(`DISPOSE ${thread}`);
  });

  // ⛔ C3. `absent` was dead — every live path returned []. A caller must be able to tell
  // "there was nothing to do" from "I did nothing", which is exactly the C2 distinction.
  test("C3: a never-started agent reports its missing paths as ABSENT, not as a clean removal", async () => {
    const home = await mkdtemp(join(tmpdir(), "spawnabs-"));
    const stateDir = join(home, ".wire", "codex-spawn");
    await mkdir(stateDir, { recursive: true });
    const res = await removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: home, env: { STATE_DIR: stateDir } },
      { log: () => {} },
    );
    expect(res.removed).toEqual([]);
    expect(res.failed).toEqual([]);
    expect(res.absent.length).toBe(2);           // the home and the thread pointer
    expect(res.absent.some((p) => p.endsWith("agentx"))).toBe(true);
    expect(res.absent.some((p) => p.endsWith("agentx.thread.json"))).toBe(true);
  });

  // The refusal guard added for M2: if a future edit ever routes the thread pointer into the
  // disposal set, nothing is removed at all. A guard nobody has seen refuse is indistinguishable
  // from one that cannot.
  test("M2 guard: the thread pointer in the disposal set aborts the whole teardown", async () => {
    const f = await fixture();
    const thread = join(f.stateDir, "agentx.thread.json");
    const res = await runWith(f, async (codexHome, home) => [
      ...(await classifySpawnHome(codexHome, home)),
      { path: thread, disposition: "disposable" as const, reason: "MUTANT: thread pointer",
        kind: "file" as const, size: 0, mode: 0o640 },
    ]);
    expect(res.skipped).toBe("thread-pointer-in-disposal-set");
    expect(res.removed).toEqual([]);
    expect(await alive(thread)).toBe(true);
    // and nothing else was touched either — refusal is total, not partial.
    expect(await alive(join(f.codexHome, "config.toml"))).toBe(true);
  });
});

// ── SPEC ROW 7 — stop → resume, PHASE A (fixture-only) ────────────────────────────────────
// Brioche 616204, GO for Phase A. Row 7 reads: "stop → resume end-to-end: branch, commit SHAs
// and thread id all survive and the lane resumes."
//
// This exercises the CANDIDATE teardown (this working copy — NOT the deployed containment
// build, which disables teardown entirely and would therefore test nothing) followed by the
// REAL generator, against a fixture home containing a REAL git repository.
//
// ⚠️ WHAT THIS DOES AND DOES NOT WITNESS. It witnesses PERSISTENCE: that stop followed by
// re-provision leaves branch, commit SHAs, the thread pointer and every retained byte exactly
// as they were. It does NOT witness CONVERSATION CONTINUATION — that a live codex lane
// actually resumes its thread. No fixture can show that; it needs a real lane (Phase B, not
// approved as drafted). Row 7 is therefore PARTIALLY covered, and the gap is named here rather
// than implied by a green tick.
//
// ⚠️ MACHINE-SPECIFIC DEPENDENCY, deliberately not hidden: the real generator lives outside
// this repo. Override with GEN_CODEX_HOME. If it cannot be found this test FAILS rather than
// skipping — a skipped row for an unavailable instrument reads as coverage it never had.
describe("spec row 7 — stop then re-provision (Phase A: persistence, not continuation)", () => {
  const GEN = process.env.GEN_CODEX_HOME
    ?? "/Users/tim/Projects/Agiterra/codex-wire/scripts/gen-codex-home.sh";

  const sh = (cmd: string[], cwd?: string, env?: Record<string, string>) => {
    const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...(env ?? {}) } });
    return { code: p.exitCode, out: new TextDecoder().decode(p.stdout).trim(),
             err: new TextDecoder().decode(p.stderr).trim() };
  };

  /** sha256 of every file under a tree, keyed by path relative to it. Symlinks by target. */
  async function treeDigest(root: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const walk = async (dir: string, rel: string) => {
      let names: string[] = [];
      try { names = await readdir(dir); } catch { return; }
      for (const n of names.sort()) {
        const p = join(dir, n), r = rel ? `${rel}/${n}` : n;
        const st = await lstat(p);
        if (st.isSymbolicLink()) { out.set(r, `link:${await import("fs/promises").then(m => m.readlink(p))}`); }
        else if (st.isDirectory()) { out.set(r, "dir"); await walk(p, r); }
        else if (st.isFile()) {
          out.set(r, Bun.SHA256.hash(await Bun.file(p).arrayBuffer(), "hex") as unknown as string);
        }
      }
    };
    await walk(root, "");
    return out;
  }

  test("7a: branch, commit SHAs, thread id and every retained byte survive stop + re-provision", async () => {
    const f = await fixture();

    // A REAL repository, not a .git-shaped fixture — row 7 is about real commit SHAs.
    const repo = join(f.codexHome, "workspaces", "realrepo");
    await mkdir(repo, { recursive: true });
    expect(sh(["git", "init", "-q", "-b", "feat/row7"], repo).code).toBe(0);
    sh(["git", "config", "user.email", "row7@fixture.invalid"], repo);
    sh(["git", "config", "user.name", "Row Seven"], repo);
    await writeFile(join(repo, "work.txt"), "UNPUBLISHED WORK\n");
    sh(["git", "add", "-A"], repo);
    expect(sh(["git", "commit", "-qm", "the work an agent would lose"], repo).code).toBe(0);

    const branchBefore = sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).out;
    const shaBefore = sh(["git", "rev-parse", "HEAD"], repo).out;
    expect(branchBefore).toBe("feat/row7");
    expect(shaBefore).toMatch(/^[0-9a-f]{40}$/);

    const threadBefore = await readFile(join(f.stateDir, "agentx.thread.json"), "utf8");
    const threadIdBefore = JSON.parse(threadBefore).threadId;

    // Digest everything the classifier says it will RETAIN, before anything runs.
    const entries = await classifySpawnHome(f.codexHome, f.home);
    const retainedPaths = entries.filter((e) => e.disposition === "retained").map((e) => e.path);
    // ⛔ A RETAINED DIRECTORY DOES NOT MEAN A RETAINED SUBTREE. The three lock dirs are the one
    // place classification descends, so `app-server-control/` can be retained (it holds a
    // symlinked .lock) while the plain `a.lock` inside it is disposed. My first version swept
    // those children in by prefix and reported the correct removal as a mutation — the test was
    // wrong, not the code. Exclude what the classifier explicitly disposed.
    const disposedRel = new Set(
      entries.filter((e) => e.disposition === "disposable")
             .map((e) => e.path.slice(f.codexHome.length + 1)),
    );
    const before = await treeDigest(f.codexHome);

    // ── the CANDIDATE teardown ──
    const res = await runWith(f);
    expect(res.skipped).toBeUndefined();
    expect(res.failed).toEqual([]);

    // ── the REAL generator, re-provisioning the same home ──
    const genStat = await lstat(GEN).catch(() => null);
    expect(genStat, `real generator not found at ${GEN}. Set GEN_CODEX_HOME. ` +
      `Row 7 cannot be witnessed without it, and a skipped row would read as coverage.`).not.toBeNull();
    const gen = sh(["bash", GEN], undefined, {
      HOME: f.home,
      AGENT_ID: "agentx",
      // fixture-only dummy; the generator writes it into config.toml, which is disposable.
      AGENT_PRIVATE_KEY: "fixture-not-a-real-key",
    });
    expect(gen.code, `generator failed: ${gen.err}`).toBe(0);

    // ── 1. the repository is byte-identical, branch and SHA included ──
    expect(sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], repo).out).toBe(branchBefore);
    expect(sh(["git", "rev-parse", "HEAD"], repo).out).toBe(shaBefore);
    expect(sh(["git", "status", "--porcelain"], repo).out).toBe("");
    expect(await readFile(join(repo, "work.txt"), "utf8")).toBe("UNPUBLISHED WORK\n");

    // ── 2. the thread pointer is byte-identical; the thread id survives ──
    const threadAfter = await readFile(join(f.stateDir, "agentx.thread.json"), "utf8");
    expect(threadAfter).toBe(threadBefore);
    expect(JSON.parse(threadAfter).threadId).toBe(threadIdBefore);

    // ── 3. EVERY retained entry is byte-identical. Not a sample — the whole set. ──
    const after = await treeDigest(f.codexHome);
    const changed: string[] = [];
    for (const p of retainedPaths) {
      const rel = p.slice(f.codexHome.length + 1);
      for (const [k, v] of before) {
        if (disposedRel.has(k)) continue;
        if (k === rel || k.startsWith(`${rel}/`)) {
          if (after.get(k) !== v) changed.push(`${k}: ${v} -> ${after.get(k)}`);
        }
      }
    }
    expect(changed).toEqual([]);

    // ── 4. and the scaffolding really was re-provisioned, or "nothing changed" is trivial ──
    expect(await alive(join(f.codexHome, "config.toml"))).toBe(true);
    expect(await alive(join(f.codexHome, "auth.json"))).toBe(true);
    expect(await readFile(join(f.home, ".codex", "auth.json"), "utf8")).toBe("CREDENTIAL-MUST-SURVIVE");
  });

  // ⛔ The control for 7a. If the teardown removed the repository, 7a's identity assertions
  // would have nothing to compare and could pass vacuously on an empty set. This proves the
  // retained set is non-empty and contains the things row 7 names.
  test("7b: the retained set actually CONTAINS the conversation state and the repo", async () => {
    const f = await fixture();
    const entries = await classifySpawnHome(f.codexHome, f.home);
    const retained = entries.filter((e) => e.disposition === "retained").map((e) => e.path);
    expect(retained.some((p) => p.endsWith("thread_history_1.sqlite"))).toBe(true);
    expect(retained.some((p) => p.endsWith("/workspaces"))).toBe(true);
    expect(retained.length).toBeGreaterThan(3);
  });
});

// ── N1 (re-review): the REMOTE path's failure contracts ───────────────────────────────────
// F2, F3, C2 and C3 were fixed locally and NOT carried into the generated script. The remote
// path is where the incident happened, so "fixed" that stops at the language boundary is the
// same defect the first review named, one layer in. These rows are the boundary.
describe("N1 — remote path failure contracts", () => {
  const shellEnv = (f: Fx, over: Record<string, string> = {}) => ({
    ...process.env, AGENT_ID: "agentx", CODEX_HOME: f.codexHome,
    AUTH_TARGET: join(f.home, ".codex", "auth.json"),
    RECEIPT: join(f.stateDir, ".stopped", "agentx.remote.json"), ...over,
  });
  const runSh = (f: Fx, script: string, over: Record<string, string> = {}) => {
    const p = Bun.spawnSync(["/bin/sh", "-c", script], { env: shellEnv(f, over) });
    return { out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr), code: p.exitCode };
  };

  test("C2 remote: an UNREADABLE home is refused, not read as empty", async () => {
    if (process.getuid?.() === 0) return;              // root ignores the mode; skip honestly
    const f = await fixture();
    await chmod(f.codexHome, 0o000);
    const r = runSh(f, buildRemoteTeardownScript());
    await chmod(f.codexHome, 0o755);
    expect(r.out).toContain("CREW_HOME_UNREADABLE");
    expect(r.out).not.toContain("CREW_TEARDOWN_DONE");
    expect(r.out).toContain("I could not look");        // ⛔ N16: stdout, the stream production reads
    // nothing removed, and no receipt claiming completeness
    expect(await alive(join(f.codexHome, "thread_history_1.sqlite"))).toBe(true);
    expect(await alive(join(f.stateDir, ".stopped", "agentx.remote.json"))).toBe(false);
  });

  test("C3 remote: an ABSENT home completes and reports it as absent, not removed", async () => {
    const f = await fixture();
    const gone = join(f.stateDir, "never-existed");
    const r = runSh(f, buildRemoteTeardownScript(), { CODEX_HOME: gone });
    expect(r.out).toContain("CREW_TEARDOWN_DONE");
    const rec = JSON.parse(await readFile(join(f.stateDir, ".stopped", "agentx.remote.json"), "utf8"));
    expect(rec.state).toBe("complete");
    expect(rec.absent).toContain(gone);
    expect(rec.removed).toEqual([]);
    expect(rec.disposable).toEqual([]);
  });

  test("F3 remote: a failing FINALIZE writes a finalize-failed receipt, never 'complete'", async () => {
    const f = await fixture();
    // force only the FINALIZE write to fail; INTENT already succeeded at $R
    const script = mutate('rcpt complete "$REMOVEDLIST" "$R"',
                          'rcpt complete "$REMOVEDLIST" "/nonexistent-dir-for-test/x"');
    const r = runSh(f, script);
    expect(r.out).toContain("CREW_FINALIZE_FAILED");
    expect(r.out).toContain("Not reported as success");

    // ⛔ F2 remote, the whole point: the durable INTENT is STILL INTACT and parses.
    const intent = JSON.parse(await readFile(join(f.stateDir, ".stopped", "agentx.remote.json"), "utf8"));
    expect(intent.state).toBe("in-progress");
    expect(intent.retained.some((p: string) => p.endsWith("thread_history_1.sqlite"))).toBe(true);

    const ff = JSON.parse(await readFile(join(f.stateDir, ".stopped", "agentx.remote.json.finalize-failed"), "utf8"));
    expect(ff.state).toBe("finalize-failed");
    expect(ff.removed.length).toBeGreaterThan(0);        // removal ALREADY RAN; say so
    expect(ff.retained.some((p: string) => p.endsWith("thread_history_1.sqlite"))).toBe(true);
  });

  test("F3 remote: when the failure receipt ALSO cannot be written, it says so", async () => {
    const f = await fixture();
    let script = mutate('rcpt complete "$REMOVEDLIST" "$R"',
                        'rcpt complete "$REMOVEDLIST" "/nonexistent-dir-for-test/x"');
    script = script.replace('rcpt finalize-failed "$REMOVEDLIST" "$R.finalize-failed"',
                            'rcpt finalize-failed "$REMOVEDLIST" "/nonexistent-dir-for-test/y"');
    const r = runSh(f, script);
    expect(r.out).toContain("CREW_FINALIZE_RECORD_FAILED");
    expect(r.out).toContain("storage will not accept a failure record");
    expect(r.out).toContain("INTENT is the only durable record");
    const intent = JSON.parse(await readFile(join(f.stateDir, ".stopped", "agentx.remote.json"), "utf8"));
    expect(intent.state).toBe("in-progress");           // intact, per F2
  });

  test("F2 remote: the receipt is written via temp+mv, never truncated in place", () => {
    const script = buildRemoteTeardownScript();
    expect(script).toContain('"$3.tmp"');
    expect(script).toContain('mv -f "$3.tmp" "$3"');
    // the old in-place form must not reappear
    expect(script).not.toContain('> "$R" 2>/dev/null');
  });
});

// ── N14 (re-review): the RETURNED CONTRACT, not just the receipt ──────────────────────────
// "absent populated" was true of the receipt and false of what the caller gets back, because
// the script gained `$B` and its READER gained nothing. A field that is right in the audit
// record and empty in the result is two different answers to one question. These rows drive
// removeCodexSpawnHome through a STDOUT-ONLY sshRun stand-in — the shape screen.sshRun actually
// has — so they fail if the reader ever stops parsing what the script emits.
describe("N14 — the remote RESULT contract, via a stdout-only sshRun", () => {
  const stdoutOnly = (f: Fx) => async (_t: unknown, command: string): Promise<string> => {
    const m = command.match(/CODEX_HOME='([^']*)'/);
    // ⛔ N23-adjacent: this stub previously invented its own AUTH_TARGET/RECEIPT and now also
    // THREAD_PATH, so it cannot catch teardownRemote computing them wrong. Parse what the real
    // command line actually carries wherever possible — that is what a production sshRun sees.
    const t = command.match(/THREAD_PATH='([^']*)'/);
    const p = Bun.spawnSync(["/bin/sh", "-c", buildRemoteTeardownScript()], {
      env: { ...process.env, AGENT_ID: "agentx", CODEX_HOME: m?.[1] ?? f.codexHome,
             AUTH_TARGET: join(f.home, ".codex", "auth.json"),
             THREAD_PATH: t?.[1] ?? join(f.stateDir, "agentx.thread.json"),
             RECEIPT: join(f.stateDir, ".stopped", "agentx.remote.json") },
    });
    return new TextDecoder().decode(p.stdout);   // ⛔ stdout ONLY, exactly like screen.sshRun
  };
  const remote = (f: Fx, codexHome: string, log: (m: string) => void = () => {}) =>
    removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: f.home, runAsUid: "someuid",
        env: { STATE_DIR: f.stateDir, CODEX_HOME: codexHome },
        target: { runAsUid: "someuid", host: "localhost" } as never },
      { log, sshRun: stdoutOnly(f) as never },
    );

  test("N14: an ABSENT home reaches result.absent, not just the receipt", async () => {
    // ⛔ The absent home must still have the SHAPE resolveCodexSpawnPaths accepts —
    // <…>/codex-spawn/<agentId> — or the S1 guard refuses it as an unrecognised manifest and
    // sshRun is never called. My first version named it "never-existed" and tested the guard
    // instead of the contract, which is a different (and already covered) row.
    const bare = await mkdtemp(join(tmpdir(), "spawnabsent-"));
    const stateDir = join(bare, ".wire", "codex-spawn");
    await mkdir(stateDir, { recursive: true });
    await mkdir(join(bare, ".codex"), { recursive: true });
    await writeFile(join(bare, ".codex", "auth.json"), "CREDENTIAL-MUST-SURVIVE");
    const gone = join(stateDir, "agentx");          // correct shape, does not exist
    const g: Fx = { home: bare, codexHome: gone, stateDir };
    const res = await remote(g, gone);
    expect(res.skipped).toBeUndefined();            // the guard did NOT refuse it
    expect(res.absent).toContain(gone);
    expect(res.removed).toEqual([]);
    expect(res.failed).toEqual([]);
  });

  test("N14/C2: an UNREADABLE home sets skipped on the RESULT, not a generic failure", async () => {
    if (process.getuid?.() === 0) return;
    const f = await fixture();
    await chmod(f.codexHome, 0o000);
    const logs: string[] = [];
    const res = await remote(f, f.codexHome, (m) => logs.push(m));
    await chmod(f.codexHome, 0o755);
    expect(res.skipped).toMatch(/^home-unreadable:/);   // N29: class + code
    expect(res.failed).toEqual([]);                       // NOT a generic "did not complete"
    expect(logs.join("\n")).toContain("I could not look");
  });

  test("N14: a healthy remote run still reports removed, and absent stays empty", async () => {
    const f = await fixture();
    const res = await remote(f, f.codexHome);
    expect(res.skipped).toBeUndefined();
    expect(res.removed.length).toBeGreaterThan(0);
    expect(res.absent).toEqual([]);
    expect(await alive(join(f.codexHome, "thread_history_1.sqlite"))).toBe(true);
  });
});

// ── N21 / N22 (delta review at 5276c3cf) ──────────────────────────────────────────────────
describe("N21/N22 — remote classification parity, and markers a filename cannot forge", () => {
  const runSh2 = (codexHome: string, stateDir: string, home: string) => {
    const p = Bun.spawnSync(["/bin/sh", "-c", buildRemoteTeardownScript()], {
      env: { ...process.env, AGENT_ID: "agentx", CODEX_HOME: codexHome,
             AUTH_TARGET: join(home, ".codex", "auth.json"),
             RECEIPT: join(stateDir, ".stopped", "agentx.remote.json") },
    });
    return new TextDecoder().decode(p.stdout);
  };

  // ⛔ N21: `[ ! -d "$H" ]` conflated "does not exist" with "is not a directory". A CODEX_HOME
  // that is a regular FILE came out of the remote path as a clean `complete` with a receipt,
  // while the local path refused it. Neither of us had tested ENOTDIR — only EACCES.
  test("N21: a CODEX_HOME that is a FILE is refused on BOTH paths, identically", async () => {
    // ⛔ THIRD TIME THIS EXACT ERROR: the path must have the SHAPE resolveCodexSpawnPaths
    // accepts — <…>/codex-spawn/<agentId> — or the S1 guard refuses it as an unrecognised
    // manifest (skipped:"unsafe-path") and nothing is classified at all. Naming it
    // "agentx-file" tested the guard, exactly as "never-existed" did in the N14 row. The
    // reviewer warned me to assume I had repeated the class; I had.
    const alt = await mkdtemp(join(tmpdir(), "notdir-"));
    const altState = join(alt, ".wire", "codex-spawn");
    await mkdir(altState, { recursive: true });
    await mkdir(join(alt, ".codex"), { recursive: true });
    await writeFile(join(alt, ".codex", "auth.json"), "CREDENTIAL-MUST-SURVIVE");
    const notDir = join(altState, "agentx");
    await writeFile(notDir, "I am not a directory");

    // remote
    const out = runSh2(notDir, altState, alt);
    expect(out.split("\n").map((l) => l.trim())).toContain("CREW_HOME_UNREADABLE");
    expect(out).toContain("NOT A DIRECTORY");
    expect(out.split("\n").map((l) => l.trim())).not.toContain("CREW_TEARDOWN_DONE");

    // ⛔ CORRECTED (reviewer, 4348a46): this tested the CLASSIFIER while the row is named
    // "on BOTH paths, identically" — a result-level claim. Asserting the RESULT now.
    const localRes = await removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: alt,
        env: { STATE_DIR: altState, CODEX_HOME: notDir } },
      { log: () => {} });
    expect(localRes.skipped).toBe("home-unreadable:ENOTDIR");   // N29 carries the code; NOT "unsafe-path"
    expect(localRes.removed).toEqual([]);
  });

  test("N21: a genuinely ABSENT home still completes and reports absent (ENOENT ≠ ENOTDIR)", async () => {
    const f = await fixture();
    const gone = join(f.stateDir, "agentx-gone");
    const out = runSh2(gone, f.stateDir, f.home);
    expect(out.split("\n").map((l) => l.trim())).toContain("CREW_TEARDOWN_DONE");
    expect(out).toContain(`ABSENT ${gone}`);
    expect(out.split("\n").map((l) => l.trim())).not.toContain("CREW_HOME_UNREADABLE");
  });

  // ⛔ N22: the marker checks were unanchored `out.includes()` over a stream carrying root-entry
  // FILENAMES. A retained file named `notes-CREW_INTENT_FAILED.txt` made the reader announce
  // "NOTHING REMOVED, the spawn home is intact" and return early — while removal had ALREADY
  // RUN. False in the reassuring direction, which is the direction this change exists to
  // distrust. A filename must never be able to forge a control marker.
  test("N22: a FILENAME containing a marker word cannot forge that marker", async () => {
    const f = await fixture();
    const forged = join(f.codexHome, "notes-CREW_INTENT_FAILED.txt");
    await writeFile(forged, "a retained user file whose NAME is a control word");

    const stdoutOnly = async (): Promise<string> => runSh2(f.codexHome, f.stateDir, f.home);
    const res = await removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: f.home, runAsUid: "someuid",
        env: { STATE_DIR: f.stateDir, CODEX_HOME: f.codexHome },
        target: { runAsUid: "someuid", host: "localhost" } as never },
      { log: () => {}, sshRun: stdoutOnly as never },
    );

    // the word IS in the stream, via the filename — and must change nothing
    expect(runSh2(f.codexHome, f.stateDir, f.home)).toContain("CREW_INTENT_FAILED");
    expect(res.skipped).toBeUndefined();                       // NOT "intent-undurable"
    expect(res.removed.length).toBeGreaterThan(0);             // removal really ran, and is reported
    expect(await alive(forged)).toBe(true);                    // and the forging file is retained
  });
});

// ── CODEX_HOME SHAPE PARITY — the whole axis, both implementations ────────────────────────
// One table, five cases, driven through BOTH classifiers. Written this way because this class
// has cost exactly one defect per case we failed to enumerate: EACCES (C2), ENOTDIR (N21), and
// a dangling symlink (found at 4348a46, in the code written to fix N21). Discovering them one
// at a time is the pattern; the table is the fix for the pattern.
describe("CODEX_HOME shape parity — absent / symlink / dangling / not-a-dir / unreadable", () => {
  type Case = { name: string; build: (sd: string) => Promise<string>; refuse: boolean };
  const cases: Case[] = [
    { name: "truly absent (ENOENT)", refuse: false,
      build: async (sd) => join(sd, "agentx") },
    { name: "DANGLING symlink", refuse: true,
      build: async (sd) => { const p = join(sd, "agentx");
        await symlink(join(sd, "no-such-target"), p); return p; } },
    { name: "symlink to a real directory", refuse: true,
      build: async (sd) => { const real = join(sd, "real-dir"); await mkdir(real, { recursive: true });
        const p = join(sd, "agentx"); await symlink(real, p); return p; } },
    { name: "not a directory (ENOTDIR)", refuse: true,
      build: async (sd) => { const p = join(sd, "agentx"); await writeFile(p, "not a dir"); return p; } },
    // ⛔ N27 — THE CASE THE AXIS MISSED, and the one that produced the FAIL at e057eba. The
    // home IS a directory and readdir SUCCEEDS (listing names needs only `r`); it is resolving
    // a name INSIDE it that needs `x`. So every shape guard passed and every per-entry lstat
    // returned EACCES, and the classifier's `catch { continue; }` turned that into an empty
    // listing — indistinguishable from an empty home, with a state:"complete" receipt and
    // "retained 0 entr(ies) incl. conversation state" logged over a live sqlite file.
    { name: "readable but NOT searchable (0400)", refuse: true,
      build: async (sd) => { const p = join(sd, "agentx"); await mkdir(p, { recursive: true });
        await writeFile(join(p, "thread_history_1.sqlite"), "CONVERSATION-MUST-SURVIVE");
        await chmod(p, 0o400); return p; } },
    { name: "unreadable (EACCES)", refuse: true,
      build: async (sd) => { const p = join(sd, "agentx"); await mkdir(p, { recursive: true });
        await writeFile(join(p, "thread_history_1.sqlite"), "db"); await chmod(p, 0o000); return p; } },
  ];

  for (const c of cases) {
    test(`${c.name} -> both implementations ${c.refuse ? "REFUSE" : "treat as already-gone"}`, async () => {
      // root ignores permission bits, so the two permission cases cannot be exercised as root
      if ((c.name.includes("EACCES") || c.name.includes("0400")) && process.getuid?.() === 0) return;
      const home = await mkdtemp(join(tmpdir(), "shape-"));
      const sd = join(home, ".wire", "codex-spawn");
      await mkdir(sd, { recursive: true });
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(join(home, ".codex", "auth.json"), "CREDENTIAL-MUST-SURVIVE");
      const ch = await c.build(sd);

      // ⛔ CORRECTED (reviewer, 4348a46): this asserted on classifySpawnHome, i.e. that the
      // CLASSIFIER throws — while the row is named for the IMPLEMENTATIONS, which claims
      // result-level parity it never checked. A test whose name claims more than its body is
      // the same species as the stale docstring that cost an operator an hour today. Assert on
      // the RESULT CONTRACT, which is what a caller actually sees.
      const localRes = await removeCodexSpawnHome(
        { agentId: "agentx", runtime: "codex", selfHome: home,
          env: { STATE_DIR: sd, CODEX_HOME: ch } },
        { log: () => {} });
      const localRefused = (localRes.skipped ?? "").startsWith("home-unreadable");

      // ── REMOTE ──
      const p = Bun.spawnSync(["/bin/sh", "-c", buildRemoteTeardownScript()], {
        env: { ...process.env, AGENT_ID: "agentx", CODEX_HOME: ch,
               AUTH_TARGET: join(home, ".codex", "auth.json"),
               RECEIPT: join(sd, ".stopped", "agentx.remote.json") },
      });
      const lines = new TextDecoder().decode(p.stdout).split("\n").map((l) => l.trim());
      const remoteRefused = lines.includes("CREW_HOME_UNREADABLE");

      if (c.name.includes("EACCES") || c.name.includes("0400")) await chmod(ch, 0o755);

      // ⛔ THE POINT OF THE TABLE: they must agree, and agree on the RIGHT answer.
      expect({ impl: "local", refused: localRefused }).toEqual({ impl: "local", refused: c.refuse });
      expect({ impl: "remote", refused: remoteRefused }).toEqual({ impl: "remote", refused: c.refuse });
      // and a refusal is total — no completion marker, so no receipt claims success
      if (c.refuse) {
        expect(lines).not.toContain("CREW_TEARDOWN_DONE");
        expect(localRes.removed).toEqual([]);          // a refusal is TOTAL on the result too
        // ⛔ N28. This block's comment claimed "a refusal is total — no receipt can claim
        // success", and that assertion was applied ONLY to the remote lines. There was no
        // local-receipt assertion anywhere in the table, so a change in teardownLocal — which
        // is exactly where the withdrawn 4348a46 defect lived — could not turn these rows red.
        // A receipt is the artifact an operator reads; its ABSENCE is the claim under test.
        let stopped: string[] = [];
        try { stopped = await readdir(join(sd, ".stopped")); } catch { /* never created: fine */ }
        expect({ case: c.name, receipts: stopped }).toEqual({ case: c.name, receipts: [] });
      } else {
        expect(lines).toContain("CREW_TEARDOWN_DONE");
        expect(localRes.skipped).toBeUndefined();      // and an accept really accepts
      }
    });
  }
});

// ── N25 / N26 (delta review at 4348a46) ───────────────────────────────────────────────────
describe("N25/N26 — finalize markers at the READER level, and absent-contract parity", () => {
  const rawSsh = (f: Fx, script: string) => (async (_t: unknown, command: string): Promise<string> => {
    const ch = command.match(/CODEX_HOME='([^']*)'/)?.[1] ?? f.codexHome;
    const tp = command.match(/THREAD_PATH='([^']*)'/)?.[1] ?? join(f.stateDir, "agentx.thread.json");
    const p = Bun.spawnSync(["/bin/sh", "-c", script], {
      env: { ...process.env, AGENT_ID: "agentx", CODEX_HOME: ch, THREAD_PATH: tp,
             AUTH_TARGET: join(f.home, ".codex", "auth.json"),
             RECEIPT: join(f.stateDir, ".stopped", "agentx.remote.json") },
    });
    return new TextDecoder().decode(p.stdout);
  });
  const sshFor = (f: Fx, script: string) => rawSsh(f, script) as never;
  const remoteWith = (f: Fx, script: string, log: (m: string) => void = () => {}) =>
    removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: f.home, runAsUid: "someuid",
        env: { STATE_DIR: f.stateDir, CODEX_HOME: f.codexHome },
        target: { runAsUid: "someuid", host: "localhost" } as never },
      { log, sshRun: sshFor(f, script) });

  // ⛔ N25. Of the five markers, a missed INTENT_FAILED / HOME_UNREADABLE / TEARDOWN_DONE
  // degrades to a LOUD failure. FINALIZE_FAILED and FINALIZE_RECORD_FAILED are the two whose
  // miss reads as CLEAN SUCCESS — and they were the only marker->result edges with no
  // reader-level row: the F3 rows drive the script directly and never touch the reader. An
  // untested edge whose failure mode is reassurance is the shape this change exists to
  // distrust, so the two silent guards get the coverage, not the loud ones.
  test("N25: CREW_FINALIZE_FAILED reaches result.failed through the READER", async () => {
    const f = await fixture();
    const script = mutate('rcpt complete "$REMOVEDLIST" "$R"',
                          'rcpt complete "$REMOVEDLIST" "/nonexistent-dir-for-test/x"');
    const res = await remoteWith(f, script);
    expect(res.failed.some((x) => x.error === "finalize-failed")).toBe(true);
    expect(res.skipped).toBeUndefined();
    // ⛔ the anti-vacuity half: prove the marker was LIVE in the stream this run
    expect(await rawSsh(f, script)(null, "CODEX_HOME='x'")).toContain("CREW_FINALIZE_FAILED");
  });

  test("N25: CREW_FINALIZE_RECORD_FAILED reaches result.failed through the READER", async () => {
    const f = await fixture();
    let script = mutate('rcpt complete "$REMOVEDLIST" "$R"',
                        'rcpt complete "$REMOVEDLIST" "/nonexistent-dir-for-test/x"');
    script = script.replace('rcpt finalize-failed "$REMOVEDLIST" "$R.finalize-failed"',
                            'rcpt finalize-failed "$REMOVEDLIST" "/nonexistent-dir-for-test/y"');
    const res = await remoteWith(f, script);
    expect(res.failed.some((x) => x.error === "finalize-failure-record-unwritable")).toBe(true);
    expect(res.skipped).toBeUndefined();
  });

  // ⛔ N26. `absent` meant different things on the two paths for the SAME state.
  test("N26: absent is the SAME SET on both implementations for the same state", async () => {
    const bare = async () => {
      const home = await mkdtemp(join(tmpdir(), "n26-"));
      const stateDir = join(home, ".wire", "codex-spawn");
      await mkdir(stateDir, { recursive: true });
      await mkdir(join(home, ".codex"), { recursive: true });
      await writeFile(join(home, ".codex", "auth.json"), "CREDENTIAL-MUST-SURVIVE");
      return { home, codexHome: join(stateDir, "agentx"), stateDir } as Fx;
    };
    const rel = (arr: string[], sd: string) => arr.map((p) => p.replace(`${sd}/`, "")).sort();

    const a = await bare();
    const local = await removeCodexSpawnHome(
      { agentId: "agentx", runtime: "codex", selfHome: a.home, env: { STATE_DIR: a.stateDir } },
      { log: () => {} });

    const b = await bare();
    const remote = await remoteWith(b, buildRemoteTeardownScript());

    expect(rel(remote.absent, b.stateDir)).toEqual(rel(local.absent, a.stateDir));
    expect(rel(local.absent, a.stateDir)).toEqual(["agentx", "agentx.thread.json"]);
  });
});
