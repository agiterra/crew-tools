import { describe, test, expect } from "bun:test";
import { getClaudeCodeSessionId, SessionIdTracker } from "./claude-session";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("claude-session", () => {
  test("returns null when no session file exists in any ancestor", () => {
    // Point HOME at an empty dir so the walk-up finds nothing.
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-session-test-"));
    mkdirSync(join(tmpDir, ".claude", "sessions"), { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      expect(getClaudeCodeSessionId()).toBeNull();
    } finally {
      process.env.HOME = origHome;
    }
  });

  test("walks up the process tree to find session file", () => {
    // Get the actual ancestor chain: ppid → ppid.ppid → ...
    // The test process's grandparent (or higher) might be the test runner,
    // which is itself launched from somewhere. Write the session file at the
    // immediate ppid — the simplest case the walk handles.
    const tmpDir = mkdtempSync(join(tmpdir(), "claude-session-test-"));
    const sessionsDir = join(tmpDir, ".claude", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${process.ppid}.json`),
      JSON.stringify({ pid: process.ppid, sessionId: "ancestor-uuid", cwd: "/tmp" }),
    );
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      expect(getClaudeCodeSessionId()).toBe("ancestor-uuid");
    } finally {
      process.env.HOME = origHome;
    }
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

// AGI-157: /clear changes the session id inside one process; the crews.db row must follow it.
describe("SessionIdTracker", () => {
  const reader = (vals: Array<string | null>) => {
    let i = 0;
    return () => vals[Math.min(i++, vals.length - 1)];
  };

  test("no change while the live id equals the stamped one", () => {
    const t = new SessionIdTracker(() => "aaa");
    expect(t.changed()).toBeNull();
  });

  test("a /clear (new live id) is reported until it is committed", () => {
    let live = "aaa";
    const t = new SessionIdTracker(() => live);
    live = "bbb";
    expect(t.changed()).toBe("bbb");
    // stamp failed -> not committed -> still reported on the next poll
    expect(t.changed()).toBe("bbb");
    t.commit("bbb");
    expect(t.changed()).toBeNull();
  });

  test("a failed live read is never a change, and current() falls back to the stamped id", () => {
    const t = new SessionIdTracker(reader(["aaa", null, null]));
    expect(t.changed()).toBeNull();
    expect(t.current()).toBe("aaa");
  });

  test("current() prefers the live id over the startup one (agent_register fallback)", () => {
    let live = "aaa";
    const t = new SessionIdTracker(() => live);
    live = "bbb";
    expect(t.current()).toBe("bbb");
  });

  test("an unknown startup id is filled by the first live read", () => {
    let live: string | null = null;
    const t = new SessionIdTracker(() => live);
    live = "ccc";
    expect(t.changed()).toBe("ccc");
  });
});
