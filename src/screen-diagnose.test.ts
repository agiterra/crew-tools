/**
 * AGI-43 — diagnoseLaunchFailure.
 *
 * ★ THE ACCEPT CASE LEADS. A gate that only ever refuses is indistinguishable
 * from one broken shut; proving it can say NO proves nothing about whether it
 * can ever say YES. The reachable-launcher case is therefore test #1.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diagnoseLaunchFailure } from "./screen.ts";

const root = mkdtempSync(join(tmpdir(), "agi43-"));

// a launcher this uid CAN reach and execute
const okDir = join(root, "reachable");
mkdirSync(okDir, { recursive: true });
const okScript = join(okDir, "cc-launch.sh");
writeFileSync(okScript, "#!/bin/sh\nexit 0\n");
chmodSync(okScript, 0o755);

// a launcher blocked by an ANCESTOR, not by its own mode (the AGI-43 shape)
const walled = join(root, "walled");
mkdirSync(walled, { recursive: true });
const hidden = join(walled, "grok-launch.sh");
writeFileSync(hidden, "#!/bin/sh\nexit 0\n");
chmodSync(hidden, 0o755); // permissive FILE ...
chmodSync(walled, 0o000); // ... inside an untraversable DIR

// exists, reachable, but not executable
const notExec = join(okDir, "inert.sh");
writeFileSync(notExec, "#!/bin/sh\n");
chmodSync(notExec, 0o644);

test("ACCEPT: a reachable, executable launcher is NOT flagged", () => {
  const out = diagnoseLaunchFailure(`cd /x && ${okScript}`);
  expect(out).toContain("exists and is executable");
  expect(out).not.toContain("unreachable");
});

test("ACCEPT says the failure is INSIDE the command, not a reachability verdict", () => {
  expect(diagnoseLaunchFailure(okScript)).toContain("INSIDE the command");
});

test("a nonexistent launcher is flagged", () => {
  expect(diagnoseLaunchFailure("/nope/missing.sh")).toContain("does not exist");
});

test("★ ancestor-denied traversal is caught even though the FILE is 0755", () => {
  const out = diagnoseLaunchFailure(hidden);
  expect(out).toContain("cannot traverse");
  expect(out).toContain(walled);
});

test("exists + reachable but non-executable is distinguished from unreachable", () => {
  const out = diagnoseLaunchFailure(notExec);
  expect(out).toContain("not executable");
  expect(out).not.toContain("does not exist");
});

test("ALL problems are reported, not just the first", () => {
  const out = diagnoseLaunchFailure(`/nope/a.sh && /nope/b.sh`);
  expect(out).toContain("/nope/a.sh");
  expect(out).toContain("/nope/b.sh");
});

test("★ no path to check reports UNKNOWN, never a clean bill of health", () => {
  const out = diagnoseLaunchFailure("claude --permission-mode bypassPermissions");
  expect(out).toContain("UNKNOWN");
  expect(out).not.toContain("exists and is executable");
});

test("⚠️ the command text is NEVER echoed (it carries AGENT_PRIVATE_KEY)", () => {
  const secret = "AAAAC3NzaC1lZDI1NTE5AAAAISECRETKEYMATERIAL";
  const cmd = `export AGENT_PRIVATE_KEY=${secret} && ${okScript}`;
  const out = diagnoseLaunchFailure(cmd);
  expect(out).not.toContain(secret);
  expect(out).not.toContain("AGENT_PRIVATE_KEY");
});

test("★★ ENOENT and EACCES are OPPOSITE answers, not one 'threw' case", () => {
  const absent = diagnoseLaunchFailure("/nope/missing.sh");
  expect(absent).toContain("does not exist");
  expect(absent).not.toContain("cannot traverse");
  const walledOut = diagnoseLaunchFailure(hidden);
  expect(walledOut).toContain("cannot traverse");
  expect(walledOut).not.toContain("does not exist");
});

test("★★★ THE REAL AGI-43 CASE: runtimes.json grok entry under /Users/tim", () => {
  // Not a fixture — this is the live, still-broken runtime entry found
  // 2026-08-01: runtimes.json points grok/grok-bridge at /Users/tim/.wire,
  // which is 0700 tim. The diagnosis must name the traversal wall.
  const out = diagnoseLaunchFailure("/Users/tim/.wire/grok-launch.sh");
  expect(out).toContain("cannot traverse");
  expect(out).toContain("/Users/tim");
});
