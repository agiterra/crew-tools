import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expandCommand } from "./runtimes";

// AGI — the claude-code DEFAULT hardcoded `--model claude-fable-5`, so an exported
// CLAUDE_MODEL was delivered and never read: a command-line flag always beats an env
// var. Three live occurrences (lamington2, zaletti, kouign-amann) before it was fixed.
//
// ⚠️ These assertions read the SOURCE LITERAL, deliberately, and not loadRuntimes().
// loadRuntimes() merges the caller's ~/.wire/runtimes.json over DEFAULTS, so on any
// machine with a local claude-code override it would assert about that override and
// PASS while the built-in regressed. DEFAULTS is not exported; the file is the only
// honest surface for "what does the built-in say".
const SRC = readFileSync(join(import.meta.dir, "runtimes.ts"), "utf8");
const claudeCmd = SRC.match(
  /"claude-code"\s*:\s*\{\s*command:\s*"([^"]+)"/,
)?.[1];

describe("claude-code DEFAULT model pin (asserted against the source literal)", () => {
  test("the claude-code default command is findable at all", () => {
    expect(claudeCmd).toBeDefined();
  });

  test("REFUSE: no hardcoded fable model in the built-in", () => {
    expect(claudeCmd).not.toContain("claude-fable-5");
    expect(claudeCmd!.toLowerCase()).not.toContain("fable");
  });

  test("ACCEPT: the built-in defers to CLAUDE_MODEL", () => {
    expect(claudeCmd).toContain("${CLAUDE_MODEL:-");
  });

  test("a MISSING pin fails safe to the policy model, not to Fable", () => {
    const m = claudeCmd!.match(/\$\{CLAUDE_MODEL:-([^}]+)\}/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("claude-opus-4-8");
  });

  // LOAD-BEARING: expandCommand does replaceAll("${KEY}", value), matching only the
  // EXACT bare form. The shell default-value form must survive untouched so that the
  // SHELL performs the expansion — crew builds a `cd … && export … && <command>`
  // string that screen runs under zsh, so ${VAR:-default} resolves there.
  test("expandCommand leaves ${VAR:-default} INTACT — the shell expands it, not us", () => {
    const out = expandCommand(claudeCmd!, { CLAUDE_MODEL: "claude-opus-5" });
    expect(out).toContain("${CLAUDE_MODEL:-claude-opus-4-8}");
    expect(out).not.toContain("claude-opus-5");
  });

  test("…but the BARE form still substitutes, so this is not a blanket break", () => {
    expect(expandCommand("x ${CLAUDE_MODEL} y", { CLAUDE_MODEL: "claude-opus-5" }))
      .toBe("x claude-opus-5 y");
  });
});
