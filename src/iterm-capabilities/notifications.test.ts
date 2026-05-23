import { describe, test, expect } from "bun:test";
import { ItermNotifications, type EscapeWriter } from "./notifications";
import { runNotificationsContract } from "../capabilities/notifications.contract";

function makeMocks(opts: { throws?: Error } = {}) {
  const calls: Array<{ sessionId: string; escape: string }> = [];
  const writeEscape: EscapeWriter = async (sessionId, escape) => {
    calls.push({ sessionId, escape });
    if (opts.throws) throw opts.throws;
  };
  return { writeEscape, calls };
}

describe("ItermNotifications transport", () => {
  test("notify writes OSC 9 with title only", async () => {
    const { writeEscape, calls } = makeMocks();
    const impl = new ItermNotifications(writeEscape);
    await impl.notify("iterm:session:abc", "hello");
    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe("iterm:session:abc");
    // OSC 9 ; <text> BEL
    expect(calls[0].escape).toBe("\x1b]9;hello\x07");
  });

  test("notify writes OSC 9 with combined title:body", async () => {
    const { writeEscape, calls } = makeMocks();
    const impl = new ItermNotifications(writeEscape);
    await impl.notify("iterm:session:abc", "hello", "world");
    expect(calls[0].escape).toBe("\x1b]9;hello: world\x07");
  });

  test("flash writes OSC 1337 RequestAttention=fireworks", async () => {
    const { writeEscape, calls } = makeMocks();
    const impl = new ItermNotifications(writeEscape);
    await impl.flash("iterm:session:abc");
    expect(calls).toHaveLength(1);
    expect(calls[0].escape).toBe("\x1b]1337;RequestAttention=fireworks\x07");
  });

  test("empty body falls back to title-only encoding (no trailing colon)", async () => {
    const { writeEscape, calls } = makeMocks();
    const impl = new ItermNotifications(writeEscape);
    await impl.notify("iterm:session:abc", "title", "");
    // Falsy body skips the title:body join
    expect(calls[0].escape).toBe("\x1b]9;title\x07");
  });
});

runNotificationsContract(
  "iterm",
  () => {
    const { writeEscape } = makeMocks();
    return new ItermNotifications(writeEscape);
  },
  { exampleSessionId: "iterm:session:abc" },
);
