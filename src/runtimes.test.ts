import { describe, test, expect } from "bun:test";
import { expandCommand } from "./runtimes";

describe("expandCommand — shell-default passthrough", () => {
  test("substitutes bare ${KEY} but leaves ${KEY:-default} for the launch shell", () => {
    // The claude-code launcher pins the model via ${CLAUDE_MODEL:-claude-fable-5};
    // expandCommand must NOT eat the shell-default form, so the exported env
    // resolves it at launch (per-agent model pin).
    expect(expandCommand("run ${FOO} m=${CLAUDE_MODEL:-claude-fable-5}", { FOO: "1", CLAUDE_MODEL: "opus" }))
      .toBe("run 1 m=${CLAUDE_MODEL:-claude-fable-5}");
  });

  test("leaves an unknown bare ${KEY} untouched (shell resolves or errors)", () => {
    expect(expandCommand("x ${UNSET}", { FOO: "1" })).toBe("x ${UNSET}");
  });
});
