import { describe, test, expect, beforeEach } from "bun:test";
import { getClaudeCodeSessionId } from "./claude-session";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("claude-session", () => {
  test("returns null when no session file exists for ppid", () => {
    // In test context, ppid is bun's parent (not claude), so no session file
    const id = getClaudeCodeSessionId();
    expect(id).toBeNull();
  });

  test("reads session ID from mock session file", () => {
    // Create a mock sessions dir with a file for our ppid
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-session-test-"));
    const sessionsDir = join(tmpDir, ".claude", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const mockSessionId = "test-uuid-1234-5678";
    writeFileSync(
      join(sessionsDir, `${process.ppid}.json`),
      JSON.stringify({ pid: process.ppid, sessionId: mockSessionId, cwd: "/tmp" }),
    );

    // Override HOME to point to our mock
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const id = getClaudeCodeSessionId();
      expect(id).toBe(mockSessionId);
    } finally {
      process.env.HOME = origHome;
    }
  });

  test("returns null for malformed session file", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-session-test-"));
    const sessionsDir = join(tmpDir, ".claude", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, `${process.ppid}.json`), "not json");

    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const id = getClaudeCodeSessionId();
      expect(id).toBeNull();
    } finally {
      process.env.HOME = origHome;
    }
  });

  test("returns null for session file without sessionId field", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-session-test-"));
    const sessionsDir = join(tmpDir, ".claude", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    writeFileSync(join(sessionsDir, `${process.ppid}.json`), JSON.stringify({ pid: 1234 }));

    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const id = getClaudeCodeSessionId();
      expect(id).toBeNull();
    } finally {
      process.env.HOME = origHome;
    }
  });
});
