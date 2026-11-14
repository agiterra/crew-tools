import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildLaneOutSetup } from "./lane-out";

function run(snippet: string, env: Record<string, string>): { code: number; out: string } {
  const r = Bun.spawnSync(["/bin/sh", "-c", `${snippet} && printf %s "$LANE_OUT"`], { env });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}

describe("buildLaneOutSetup", () => {
  // A group the test uid is in, so chgrp succeeds on any host (Patisserie: agiterra).
  const grp = Bun.spawnSync(["id", "-gn"]).stdout.toString().trim();
  const gid = Bun.spawnSync(["id", "-g"]).stdout.toString().trim();

  test("exports $HOME/lanes/<id>/out, group LANE_OUT_GROUP, mode 2770", () => {
    const home = mkdtempSync(join(tmpdir(), "laneout-"));
    try {
      const r = run(buildLaneOutSetup("eng-1-2-x"), { HOME: home, LANE_OUT_GROUP: grp, PATH: "/usr/bin:/bin" });
      expect(r.code).toBe(0);
      expect(r.out).toBe(`${home}/lanes/eng-1-2-x/out`);
      const st = statSync(r.out);
      expect(st.mode & 0o7777).toBe(0o2770);
      expect(String(st.gid)).toBe(gid);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("two lanes in one HOME get two different dirs", () => {
    const home = mkdtempSync(join(tmpdir(), "laneout-"));
    try {
      const a = run(buildLaneOutSetup("lane-a"), { HOME: home, PATH: "/usr/bin:/bin" }).out;
      const b = run(buildLaneOutSetup("lane-b"), { HOME: home, PATH: "/usr/bin:/bin" }).out;
      expect(a).not.toBe(b);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a failed chgrp warns but the spawn goes on", () => {
    const home = mkdtempSync(join(tmpdir(), "laneout-"));
    try {
      const r = run(buildLaneOutSetup("lane-a"), { HOME: home, LANE_OUT_GROUP: "no-such-group-xyz", PATH: "/usr/bin:/bin" });
      expect(r.code).toBe(0);
      expect(r.out).toContain("chgrp no-such-group-xyz failed");
      expect(statSync(`${home}/lanes/lane-a/out`).mode & 0o7777).toBe(0o700);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a caller-set LANE_OUT wins", () => {
    const home = mkdtempSync(join(tmpdir(), "laneout-"));
    try {
      const want = join(home, "mine");
      const r = run(buildLaneOutSetup("lane-a"), { HOME: home, LANE_OUT: want, PATH: "/usr/bin:/bin" });
      expect(r.code).toBe(0);
      expect(r.out).toBe(want);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("fails closed (exit 95) when the dir cannot be made", () => {
    const home = mkdtempSync(join(tmpdir(), "laneout-"));
    try {
      mkdirSync(join(home, "lanes"), { mode: 0o500 });
      const r = run(buildLaneOutSetup("lane-a"), { HOME: home, PATH: "/usr/bin:/bin" });
      expect(r.code).toBe(95);
      expect(r.out).toContain("cannot create LANE_OUT");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("refuses an unsafe agent id", () => {
    expect(() => buildLaneOutSetup("a; rm -rf /")).toThrow(/unsafe agent id/);
    expect(() => buildLaneOutSetup("$(boom)")).toThrow(/unsafe agent id/);
  });
});
