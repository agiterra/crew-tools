/**
 * MOCK ISOLATION — the guard for the cross-file contamination CI found.
 *
 * `mock.module` replaces a module PROCESS-WIDE for every later import in the run. Both
 * `cli.test.ts` and `orchestrator.test.ts` mock `./screen`; each listed a hand-picked subset of
 * its surface and omitted `parseScreenList`, so once either had run, `screen.test.ts`'s import
 * resolved against the mock and the file died with
 *     SyntaxError: Export named 'parseScreenList' not found in module 'screen.ts'
 * ORDER-DEPENDENT, and therefore invisible until something changed the order — which adding a
 * large test file to this suite did. It reached CI and nothing local ever saw it.
 *
 * Two guards, because they fail for different reasons:
 *   1. STRUCTURAL — every mock must cover the real module's whole export surface. Deterministic,
 *      and it fires the moment someone adds an export to screen.ts, which is when the next
 *      instance would be created.
 *   2. ORDER CONTROL — actually run the contaminating orders in a subprocess. Slower, but it is
 *      the only thing that tests what `mock.module` really does to a RUN rather than to an object.
 * Brioche 616414 asked for both order controls with their full-suite result; a measurement I
 * quoted in a message is not a guard.
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import * as realScreen from "./screen";

const MOCKING_FILES = ["./src/cli.test.ts", "./src/orchestrator.test.ts"] as const;

describe("mock isolation — ./screen", () => {
  // ⛔ 1. STRUCTURAL. Read the mock factory's keys out of each file's source rather than
  // importing it (importing would itself install the mock and contaminate THIS run).
  for (const f of MOCKING_FILES) {
    test(`${f} spreads the real module, so its mock cannot omit an export`, async () => {
      const src = await Bun.file(f).text();
      expect(src).toContain('mock.module("./screen"');
      // The only maintainable way to be complete is to spread; a hand-listed subset is what broke.
      expect(src).toContain("...__realScreen");
      expect(src).toContain('import * as __realScreen from "./screen"');
    });
  }

  test("the real module's export surface is non-trivial, so the check above means something", () => {
    const names = Object.keys(realScreen).sort();
    expect(names).toContain("parseScreenList");     // the export that actually broke
    expect(names.length).toBeGreaterThan(5);
  });

  // ⛔ 2. ORDER CONTROL. The contaminating order, run for real. Each pairing puts a mocking file
  // FIRST and screen.test.ts second — the order that produced the CI failure.
  for (const f of MOCKING_FILES) {
    // ⛔ EXPLICIT TIMEOUT. Bun's default is 5s per test; the orchestrator pairing runs 99 real
    // tests and takes ~26s, so it was TIMING OUT, not failing an assertion — and a timeout reads
    // in the output exactly like a failed expectation. I diagnosed it twice wrongly (first the
    // regex, then the exit code) before spawning it standalone and seeing exitCode 0, 99 pass.
    // A guard that cannot finish is not a guard.
    test(`ORDER: ${f} before screen.test.ts leaves screen.test.ts intact`, () => {
      // ⛔ process.execPath, NOT "bun": the running interpreter is guaranteed present, a PATH
      // lookup is not — and a spawn that cannot find its binary fails identically to a spawn
      // whose assertion failed. (It did, here, on a restricted PATH.)
      // AGENT_ID is DELETED rather than set to undefined — `set -u` fires on unset, not empty,
      // and spreading an undefined value can yield the literal string. That is finding N15's
      // lesson, in a different place.
      const childEnv: Record<string, string> = { ...process.env } as Record<string, string>;
      delete childEnv.AGENT_ID;
      const p = Bun.spawnSync([process.execPath, "test", f, "./src/screen.test.ts"], {
        cwd: join(import.meta.dir, ".."),
        env: childEnv,
      });
      const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr);
      // ⛔ ASSERT THE EXIT CODE, NOT A COUNT SCRAPED FROM STDOUT. My first version matched
      // /\b0 fail\b/ against the captured stream and failed on a run that had genuinely passed
      // 99/0 — the capture is truncated and a summary line is not guaranteed to be in it. A
      // test that greps another process's console is reading a display, not a result.
      expect({ order: f, symptom: out.includes("Export named 'parseScreenList' not found") })
        .toEqual({ order: f, symptom: false });
      expect({ order: f, exitCode: p.exitCode }).toEqual({ order: f, exitCode: 0 });
    }, 120_000);
  }
});
