import { describe, expect, test } from "bun:test";
import { CmuxEventStream, type CmuxEvent } from "./cmux-events.js";

function sampleEvent(overrides: Partial<CmuxEvent> = {}): CmuxEvent {
  return {
    boot_id: "boot-A",
    category: "feed",
    id: "boot-A-1",
    name: "feed.item.received",
    occurred_at: "2026-05-19T15:00:00.000Z",
    payload: {},
    seq: 1,
    source: "claude",
    surface_id: null,
    type: "event",
    version: 1,
    window_id: null,
    workspace_id: "ws-1",
    ...overrides,
  };
}

describe("CmuxEventStream.ingestLine", () => {
  test("parses valid JSON line and dispatches to handlers", async () => {
    const stream = new CmuxEventStream();
    const seen: CmuxEvent[] = [];
    stream.on((e) => { seen.push(e); });

    const ev = sampleEvent();
    stream.ingestLine(JSON.stringify(ev));

    // Handlers are dispatched synchronously in dispatch() but the wrapped
    // Promise.resolve schedules a microtask — let it settle.
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe("boot-A-1");
  });

  test("blank and whitespace-only lines are ignored", () => {
    const stream = new CmuxEventStream();
    const seen: CmuxEvent[] = [];
    stream.on((e) => { seen.push(e); });
    stream.ingestLine("");
    stream.ingestLine("   ");
    stream.ingestLine("\n");
    expect(seen).toHaveLength(0);
  });

  test("malformed JSON is dropped without throwing", () => {
    const stream = new CmuxEventStream();
    const seen: CmuxEvent[] = [];
    stream.on((e) => { seen.push(e); });
    // Suppress console noise for the test.
    const origErr = console.error;
    console.error = () => {};
    try {
      expect(() => stream.ingestLine("not-json-{")).not.toThrow();
      expect(seen).toHaveLength(0);
    } finally {
      console.error = origErr;
    }
  });
});

describe("CmuxEventStream.onBootChange", () => {
  test("fires when boot_id changes between consecutive events", async () => {
    const stream = new CmuxEventStream();
    const boots: Array<[string, string]> = [];
    stream.onBootChange((oldId, newId) => { boots.push([oldId, newId]); });

    stream.ingestLine(JSON.stringify(sampleEvent({ boot_id: "boot-A", seq: 1 })));
    stream.ingestLine(JSON.stringify(sampleEvent({ boot_id: "boot-A", seq: 2 })));
    // Daemon restart → new boot_id.
    stream.ingestLine(JSON.stringify(sampleEvent({ boot_id: "boot-B", seq: 1 })));

    await new Promise((r) => setTimeout(r, 0));

    expect(boots).toEqual([["boot-A", "boot-B"]]);
  });

  test("first event does NOT fire bootChange (no prior boot_id known)", async () => {
    const stream = new CmuxEventStream();
    const boots: Array<[string, string]> = [];
    stream.onBootChange((oldId, newId) => { boots.push([oldId, newId]); });

    stream.ingestLine(JSON.stringify(sampleEvent({ boot_id: "boot-X", seq: 1 })));

    await new Promise((r) => setTimeout(r, 0));
    expect(boots).toHaveLength(0);
  });
});

describe("CmuxEventStream.on disposer", () => {
  test("removes the handler so subsequent events skip it", async () => {
    const stream = new CmuxEventStream();
    const seen: CmuxEvent[] = [];
    const off = stream.on((e) => { seen.push(e); });

    stream.ingestLine(JSON.stringify(sampleEvent({ seq: 1 })));
    off();
    stream.ingestLine(JSON.stringify(sampleEvent({ seq: 2 })));

    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.seq).toBe(1);
  });
});

describe("CmuxEventStream handler isolation", () => {
  test("a throwing handler does not prevent other handlers from running", async () => {
    const stream = new CmuxEventStream();
    const ok: CmuxEvent[] = [];
    const origErr = console.error;
    console.error = () => {};
    try {
      stream.on(() => { throw new Error("boom"); });
      stream.on((e) => { ok.push(e); });

      stream.ingestLine(JSON.stringify(sampleEvent()));
      await new Promise((r) => setTimeout(r, 0));
      expect(ok).toHaveLength(1);
    } finally {
      console.error = origErr;
    }
  });
});
