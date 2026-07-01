import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, readlinkSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildConfigDirSetup, SHARED_CONFIG_ENTRIES } from "./config-dir";

describe("buildConfigDirSetup (string shape)", () => {
  test("guards on CLAUDE_CONFIG_DIR being unset and a file credential being present", () => {
    const s = buildConfigDirSetup("gateau", "/tmp/proj");
    expect(s).toStartWith('if [ -z "${CLAUDE_CONFIG_DIR:-}" ]');
    expect(s).toContain('grep -qs claudeAiOauth "$HOME/.claude/.credentials.json"');
  });

  test("targets $HOME/.claude-agents/<id> and symlinks every shared entry", () => {
    const s = buildConfigDirSetup("gateau", "/tmp/proj");
    expect(s).toContain('CLAUDE_CONFIG_DIR="$HOME/.claude-agents/gateau"');
    for (const entry of SHARED_CONFIG_ENTRIES) expect(s).toContain(entry);
  });

  test("seeds .claude.json against first-run dialogs, including project trust", () => {
    const s = buildConfigDirSetup("gateau", "/tmp/proj");
    expect(s).toContain('"bypassPermissionsModeAccepted":true');
    expect(s).toContain('"hasCompletedOnboarding":true');
    expect(s).toContain('"/tmp/proj":{"hasTrustDialogAccepted":true');
  });

  test("sh-escapes single quotes in the project dir", () => {
    const s = buildConfigDirSetup("gateau", "/tmp/it's-a-dir");
    expect(s).toContain(`it'\\''s-a-dir`);
  });

  test("copies oauthAccount from the anchor ~/.claude.json (login marker)", () => {
    expect(buildConfigDirSetup("gateau", "/tmp/proj")).toContain('"oauthAccount"');
  });

  test("rejects shell-unsafe agent ids", () => {
    expect(() => buildConfigDirSetup("a; rm -rf /", "/tmp/proj")).toThrow(/unsafe agent id/);
    expect(() => buildConfigDirSetup("$(boom)", "/tmp/proj")).toThrow(/unsafe agent id/);
    expect(() => buildConfigDirSetup("-leading-dash", "/tmp/proj")).toThrow(/unsafe agent id/);
  });
});

describe("buildConfigDirSetup (executed against a fake home)", () => {
  function runInFakeHome(agentId: string, prep?: (home: string) => void): string {
    const home = mkdtempSync(join(tmpdir(), "crew-configdir-"));
    mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }));
    writeFileSync(join(home, ".claude", "settings.json"), "{}");
    prep?.(home);
    execSync(buildConfigDirSetup(agentId, "/tmp/proj"), { shell: "/bin/sh", env: { HOME: home, PATH: process.env.PATH } });
    return home;
  }

  test("creates the dir, symlinks existing shared entries, skips missing ones, seeds .claude.json", () => {
    const home = runInFakeHome("gateau");
    const dir = join(home, ".claude-agents", "gateau");
    for (const entry of [".credentials.json", "plugins", "settings.json"]) {
      expect(lstatSync(join(dir, entry)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(dir, entry))).toBe(join(home, ".claude", entry));
    }
    // Not present in the fake home → not linked, and not an error.
    expect(existsSync(join(dir, "policy-limits.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf-8")).bypassPermissionsModeAccepted).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("idempotent: second run leaves an existing dir intact", () => {
    const home = runInFakeHome("gateau");
    const marker = join(home, ".claude-agents", "gateau", ".claude.json");
    writeFileSync(marker, '{"custom":true}');
    execSync(buildConfigDirSetup("gateau", "/tmp/proj"), { shell: "/bin/sh", env: { HOME: home, PATH: process.env.PATH } });
    expect(JSON.parse(readFileSync(marker, "utf-8")).custom).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("merges oauthAccount from an anchor ~/.claude.json into the seed", () => {
    const home = runInFakeHome("gateau", (h) =>
      writeFileSync(join(h, ".claude.json"), '{"oauthAccount":{"emailAddress":"x@y.z"},"other":"ignored"}'),
    );
    const seeded = JSON.parse(readFileSync(join(home, ".claude-agents", "gateau", ".claude.json"), "utf-8"));
    expect(seeded.oauthAccount.emailAddress).toBe("x@y.z");
    expect(seeded.other).toBeUndefined();
    expect(seeded.hasCompletedOnboarding).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("skips isolation on a keychain-auth host (no claudeAiOauth in the credential file)", () => {
    const home = mkdtempSync(join(tmpdir(), "crew-configdir-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"mcpOAuth":{}}');
    const out = execSync(buildConfigDirSetup("gateau", "/tmp/proj"), { shell: "/bin/sh", env: { HOME: home, PATH: process.env.PATH } });
    expect(out.toString()).toContain("isolation skipped");
    expect(existsSync(join(home, ".claude-agents"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  test("no-ops when CLAUDE_CONFIG_DIR is already set (shared-dir escape hatch)", () => {
    const home = mkdtempSync(join(tmpdir(), "crew-configdir-"));
    execSync(buildConfigDirSetup("gateau", "/tmp/proj"), {
      shell: "/bin/sh",
      env: { HOME: home, PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(home, ".claude") },
    });
    expect(existsSync(join(home, ".claude-agents"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });
});
