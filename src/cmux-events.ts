/**
 * cmux event stream consumer.
 *
 * cmux exposes a JSONL event firehose via `cmux events`:
 *   - `--cursor-file <path>` — persist position across restarts of this consumer.
 *   - `--reconnect` — cmux reconnects internally if the daemon restarts.
 *   - `--no-ack` — don't require ACK-back, suitable for read-only observers.
 *
 * Each line is a JSON object with `boot_id`, `seq`, `name`, `category`,
 * `payload`, and optional `workspace_id` / `surface_id` / `window_id` /
 * `pane_id`. The `boot_id` field changes on daemon restart — that's the
 * "daemon restarted" signal Fondant's audit identified as a missing primitive
 * (turns out it's already here, we just hadn't found it).
 *
 * This module is the foundation. Wiring to orchestrator reconciliation is a
 * follow-up — for v1, the stream is opt-in (call `.start()`), exposes raw
 * events to handlers, and surfaces boot-id changes as a distinct signal.
 *
 * Status: experimental. Not started by default. Importers must call
 * `.start()` explicitly. iTerm2 backend has no equivalent — this is
 * cmux-only.
 */

import type { Subprocess } from "bun";
import { spawn } from "bun";

/**
 * A single cmux event, mirroring the JSON shape on the wire.
 *
 * Some fields are nullable depending on event source — surface-scoped events
 * carry `surface_id`, workspace-scoped events carry `workspace_id`, etc.
 * Consumers should treat any of these as may-be-null.
 */
export interface CmuxEvent {
  /** Unique-per-daemon-launch ID. Changes when cmux daemon restarts. */
  boot_id: string;
  /** High-level grouping: "agent", "feed", "notification", "surface", etc. */
  category: string;
  /** Globally unique event ID — `<boot_id>-<seq>`. */
  id: string;
  /** Event name, e.g. "surface.closed", "feed.item.received". */
  name: string;
  /** ISO 8601 timestamp when cmux observed the event. */
  occurred_at: string;
  /** Event-specific payload. Shape varies by name; consumers cast as needed. */
  payload: Record<string, unknown>;
  /** Monotonic sequence number within this boot_id. Use with `--after` to resume. */
  seq: number;
  /** Origin of the event: "claude", "socket.v1", etc. */
  source: string;
  /** Surface this event pertains to, if any. */
  surface_id: string | null;
  /** "event" — cmux may emit other top-level kinds (e.g. "heartbeat"). */
  type: string;
  /** Protocol version. */
  version: number;
  /** Window this event pertains to, if any. */
  window_id: string | null;
  /** Workspace this event pertains to, if any. */
  workspace_id: string | null;
  /** Pane this event pertains to, if any. */
  pane_id?: string | null;
}

export type EventHandler = (event: CmuxEvent) => void | Promise<void>;
export type BootChangeHandler = (oldBootId: string, newBootId: string) => void | Promise<void>;

export interface CmuxEventStreamOptions {
  /**
   * Path to cmux's cursor file. cmux writes the last-consumed seq here so
   * restarting the consumer resumes from that point. Default:
   * `~/.crew/cmux-events.cursor`.
   */
  cursorFile?: string;
  /**
   * Filter by event name. cmux applies this server-side, reducing JSONL
   * bandwidth. Multiple values via `--name <a> --name <b>`.
   */
  names?: string[];
  /**
   * Filter by category ("agent", "feed", "notification", "surface", ...).
   */
  categories?: string[];
}

/**
 * Long-lived consumer of cmux's event stream. Spawns `cmux events --reconnect`
 * as a subprocess, reads JSONL from stdout, parses each line, and dispatches
 * to registered handlers.
 *
 * Boot-id changes (daemon restart) are surfaced via a dedicated handler kind
 * so callers can react without inspecting every event.
 */
export class CmuxEventStream {
  private proc?: Subprocess;
  private handlers = new Set<EventHandler>();
  private bootChangeHandlers = new Set<BootChangeHandler>();
  private knownBootId?: string;
  private stopped = false;

  constructor(private readonly options: CmuxEventStreamOptions = {}) {}

  /**
   * Register an event handler. Returns a disposer that removes it.
   */
  on(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Register a handler for daemon restart (boot_id change). Returns a disposer.
   */
  onBootChange(handler: BootChangeHandler): () => void {
    this.bootChangeHandlers.add(handler);
    return () => this.bootChangeHandlers.delete(handler);
  }

  /**
   * Start the consumer. Idempotent: a second call while already running is
   * a no-op. Throws if cmux is not on PATH.
   */
  start(): void {
    if (this.proc) return;
    this.stopped = false;
    const args = ["cmux", "events", "--reconnect", "--no-ack"];
    if (this.options.cursorFile) {
      args.push("--cursor-file", this.options.cursorFile);
    }
    for (const n of this.options.names ?? []) {
      args.push("--name", n);
    }
    for (const c of this.options.categories ?? []) {
      args.push("--category", c);
    }
    this.proc = spawn({
      cmd: args,
      stdout: "pipe",
      stderr: "inherit",
    });
    void this.readLoop();
  }

  /**
   * Stop the consumer. Idempotent.
   */
  stop(): void {
    this.stopped = true;
    this.proc?.kill();
    this.proc = undefined;
  }

  /**
   * Feed a single line into the dispatcher. Public for testability — the
   * normal flow is the readLoop calling this on each stdout line.
   *
   * Malformed lines are dropped with a console.error rather than throwing,
   * so a single bad event can't kill the stream.
   */
  ingestLine(line: string): void {
    if (!line.trim()) return;
    let event: CmuxEvent;
    try {
      event = JSON.parse(line) as CmuxEvent;
    } catch (e) {
      console.error(`[crew] cmux-events: failed to parse line: ${line.slice(0, 120)}…`, e);
      return;
    }
    this.dispatch(event);
  }

  private async readLoop(): Promise<void> {
    const stream = this.proc?.stdout;
    if (!stream || typeof stream === "number") return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the trailing partial line (if any) for the next read.
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          this.ingestLine(line);
        }
      }
    } catch (e) {
      if (!this.stopped) {
        console.error(`[crew] cmux-events: read loop crashed:`, e);
      }
    }
  }

  private dispatch(event: CmuxEvent): void {
    // Boot-id change = daemon restart. Fire dedicated handlers BEFORE the
    // general dispatch so consumers can invalidate caches first.
    if (this.knownBootId && this.knownBootId !== event.boot_id) {
      const old = this.knownBootId;
      for (const h of this.bootChangeHandlers) {
        try {
          void Promise.resolve(h(old, event.boot_id)).catch((e) =>
            console.error(`[crew] cmux-events: bootChange handler threw:`, e),
          );
        } catch (e) {
          console.error(`[crew] cmux-events: bootChange handler threw sync:`, e);
        }
      }
    }
    this.knownBootId = event.boot_id;

    for (const h of this.handlers) {
      try {
        void Promise.resolve(h(event)).catch((e) =>
          console.error(`[crew] cmux-events: handler threw:`, e),
        );
      } catch (e) {
        console.error(`[crew] cmux-events: handler threw sync:`, e);
      }
    }
  }
}
