import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  credentialStatus,
  credentialPath,
  readCredential,
  assertClaudeCredentialLive,
} from "./credentials";

const HOUR = 3600_000;

/** Access-token-only `.credentials.json` (the fan's stripped shape). */
function cred(accessToken: string, expiresAt: number): string {
  return JSON.stringify({ claudeAiOauth: { accessToken, expiresAt } });
}

describe("credentialStatus (pure)", () => {
  const now = 1_000_000_000_000;

  test("live when accessToken present and expiresAt in the future", () => {
    expect(credentialStatus(cred("tok", now + HOUR), now).live).toBe(true);
  });

  test("missing when null or blank", () => {
    expect(credentialStatus(null, now).live).toBe(false);
    expect(credentialStatus("   ", now).live).toBe(false);
  });

  test("unparseable when not JSON", () => {
    const st = credentialStatus("{not json", now);
    expect(st.live).toBe(false);
    if (!st.live) expect(st.reason).toContain("unparseable");
  });

  test("no claudeAiOauth block → LIVE (alternate/console auth, not our model)", () => {
    // A cockpit whose .credentials.json carries a non-subscription scheme.
    expect(credentialStatus(JSON.stringify({}), now).live).toBe(true);
    expect(credentialStatus(JSON.stringify({ mcpOAuth: { foo: 1 } }), now).live).toBe(true);
  });

  test("claudeAiOauth present but no tokens → dead", () => {
    const st = credentialStatus(JSON.stringify({ claudeAiOauth: {} }), now);
    expect(st.live).toBe(false);
    if (!st.live) expect(st.reason).toContain("neither accessToken nor refreshToken");
  });

  test("access-token-only: expired (<= now) → dead", () => {
    expect(credentialStatus(cred("tok", now), now).live).toBe(false); // == now → expired
    expect(credentialStatus(cred("tok", now - 1), now).live).toBe(false);
    const st = credentialStatus(cred("tok", now - HOUR), now);
    if (!st.live) expect(st.reason).toContain("expired");
  });

  test("access-token-only: missing expiresAt treated as expired", () => {
    expect(
      credentialStatus(JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }), now).live,
    ).toBe(false);
  });

  test("refreshToken present → LIVE even if access token expired (self-refreshes)", () => {
    // The full/anchor credential (the exact case that would have false-blocked
    // a cockpit-local spawn — caught by dogfooding 2026-07-01).
    const full = JSON.stringify({
      claudeAiOauth: { accessToken: "tok", refreshToken: "rt", expiresAt: now - HOUR },
    });
    expect(credentialStatus(full, now).live).toBe(true);
  });

  test("refreshToken present with no access token → LIVE", () => {
    const st = credentialStatus(JSON.stringify({ claudeAiOauth: { refreshToken: "rt" } }), now);
    expect(st.live).toBe(true);
  });
});

describe("local readCredential + assertClaudeCredentialLive", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "crew-cred-"));
    mkdirSync(join(home, ".claude"), { recursive: true });
    delete process.env.CREW_SKIP_CRED_CHECK;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    delete process.env.CREW_SKIP_CRED_CHECK;
  });

  test("credentialPath resolves under home/.claude", () => {
    expect(credentialPath({ kind: "local", home })).toBe(
      join(home, ".claude", ".credentials.json"),
    );
  });

  test("readCredential returns null when file absent", async () => {
    expect(await readCredential({ kind: "local", home })).toBeNull();
  });

  test("assert passes for a live credential", async () => {
    writeFileSync(join(home, ".claude", ".credentials.json"), cred("tok", Date.now() + HOUR));
    await expect(assertClaudeCredentialLive({ kind: "local", home })).resolves.toBeUndefined();
  });

  test("assert throws for a missing credential", async () => {
    await expect(assertClaudeCredentialLive({ kind: "local", home })).rejects.toThrow(
      /refusing to spawn/,
    );
  });

  test("assert throws for an expired credential", async () => {
    writeFileSync(join(home, ".claude", ".credentials.json"), cred("tok", Date.now() - HOUR));
    await expect(assertClaudeCredentialLive({ kind: "local", home })).rejects.toThrow(/expired/);
  });

  test("CREW_SKIP_CRED_CHECK bypasses the guard even with no credential", async () => {
    process.env.CREW_SKIP_CRED_CHECK = "1";
    await expect(assertClaudeCredentialLive({ kind: "local", home })).resolves.toBeUndefined();
  });
});
