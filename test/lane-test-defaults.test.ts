import { describe, test, expect } from "bun:test";
import { LANE_TEST_DEFAULTS } from "../src/orchestrator";

const sh = (pre: string) =>
  Bun.spawnSync(["/bin/sh", "-c", `${pre} true${LANE_TEST_DEFAULTS} && printf %s "$LANE_TEST_WORKERS"`]).stdout.toString();

describe("LANE_TEST_DEFAULTS (Brioche 727420)", () => {
  test("unset -> 2", () => expect(sh("unset LANE_TEST_WORKERS;")).toBe("2"));
  test("a value already in the env wins", () => expect(sh("export LANE_TEST_WORKERS=1;")).toBe("1"));
  test("it is exported to children", () => {
    const out = Bun.spawnSync(["/bin/sh", "-c", `true${LANE_TEST_DEFAULTS} && /bin/sh -c 'printf %s "$LANE_TEST_WORKERS"'`]).stdout.toString();
    expect(out).toBe("2");
  });
});
