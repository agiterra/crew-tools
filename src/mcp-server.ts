#!/usr/bin/env bun
/**
 * Crew MCP server — runtime-agnostic adapter over crew-tools.
 *
 * Exposes agent lifecycle, tab/pane management, and screen I/O as MCP tools.
 * Used by both crew-claude-code and crew-codex plugins.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Orchestrator } from "./orchestrator.js";
import { createBackend } from "./terminal.js";
import { listThemes, loadTheme, resolveThemeDir } from "./themes.js";
import { getClaudeCodeSessionId } from "./claude-session.js";
import { createCrewRpcWriter, type CrewRpcWriter } from "./crew-rpc.js";
import { execSync } from "child_process";

/**
 * Start the crew MCP server. Blocks until the transport disconnects.
 */
export async function startServer(): Promise<void> {
  const terminal = await createBackend();
  const orchestrator = new Orchestrator(terminal);
  const terminalName = terminal.name;
  const CALLER_AGENT_ID =
    process.env.AGENT_ID ?? "unknown";
  const ccSessionId = getClaudeCodeSessionId();
  let rpcWriter: CrewRpcWriter | null = null;
  const rpcWriterReady = createCrewRpcWriter()
    .then((writer) => {
      rpcWriter = writer;
      console.error(`[crew] RPC writer ready (dest=${writer.dest})`);
      return writer;
    })
    .catch((e) => {
      console.error(`[crew] RPC writer unavailable; write tools will fail closed: ${(e as Error).message}`);
      return null;
    });

  async function crewRpc(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const writer = rpcWriter ?? await rpcWriterReady;
    if (!writer) throw new Error("crew RPC writer unavailable; refusing direct crews.db write");
    return writer.request(method, params, timeoutMs);
  }

  async function crewRpcTo(dest: string, method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    const writer = rpcWriter ?? await rpcWriterReady;
    if (!writer) throw new Error("crew RPC writer unavailable; refusing direct crews.db write");
    return writer.requestTo(dest, method, params, timeoutMs);
  }

  async function tryCrewRpc(method: string, params: unknown, label: string): Promise<boolean> {
    try {
      await crewRpc(method, params);
      return true;
    } catch (e) {
      console.error(`[crew] ${label} via RPC failed: ${(e as Error).message}`);
      return false;
    }
  }

  // Self-stamp: if we can identify the current agent (via STY) and we have a
  // session ID, update the agent's cc_session_id immediately. Without this,
  // existing agent records keep null cc_session_id forever — agent_register
  // is never automatically called on restart.
  const sty = process.env.STY;
  const screenName = sty ? sty.split(".").slice(1).join(".") : undefined;
  const myAgent = screenName ? orchestrator.store.getAgentByScreen(screenName) : null;

  if (ccSessionId && myAgent) {
    if (await tryCrewRpc("crew.agent_register", {
      id: myAgent.id,
      name: myAgent.display_name,
      runtime: myAgent.runtime,
      caller_session_id: await callerSession(),
      cc_session_id: ccSessionId,
    }, `self-stamp ${myAgent.id} cc_session_id`)) {
      console.error(`[crew] self-stamped ${myAgent.id} cc_session_id=${ccSessionId.slice(0, 8)}\u2026`);
    }
  }

  // Self-stamp pane.iterm_id and agent.pane. The MCP server inherits the
  // terminal session ID of the agent's pane via env (ITERM_SESSION_ID's UUID
  // suffix on iTerm2, CMUX_SURFACE_ID on cmux). Without this, panes keep null
  // iterm_id forever and reconcile's live theme heal is inert because it only
  // touches panes WITH iterm_id. Same class of fix as cc_session_id self-stamp.
  if (myAgent) {
    const itermSession = process.env.ITERM_SESSION_ID?.split(":").pop();
    const cmuxSurface = process.env.CMUX_SURFACE_ID;
    const sessionId = cmuxSurface ?? itermSession;

    if (sessionId) {
      // Find the pane this agent occupies. Prefer existing iterm_id match.
      let myPane = orchestrator.store.listPanes().find((p) => p.iterm_id === sessionId);

      // Fallback A: agent.pane already assigned but missing iterm_id — stamp it.
      if (!myPane && myAgent.pane) {
        const named = orchestrator.store.getPane(myAgent.pane);
        if (named && !named.iterm_id) {
          await tryCrewRpc("crew.pane_register", {
            tab: named.tab,
            name: myAgent.pane,
            iterm_session_id: sessionId,
          }, `self-stamp pane '${myAgent.pane}' iterm_id`);
          myPane = orchestrator.store.getPane(myAgent.pane) ?? undefined;
          console.error(`[crew] self-stamped pane '${myAgent.pane}' iterm_id=${sessionId}`);
        } else if (named) {
          myPane = named;
        }
      }

      // Fallback B: no agent.pane — try to find an unambiguous pane in the tab
      // matching the agent's id (common convention: tab name == agent id).
      if (!myPane && !myAgent.pane) {
        const tabName = myAgent.id;
        const candidates = orchestrator.store.listPanes(tabName).filter((p) => !p.iterm_id);
        if (candidates.length === 1) {
          await tryCrewRpc("crew.pane_register", {
            tab: candidates[0].tab,
            name: candidates[0].name,
            iterm_session_id: sessionId,
          }, `self-stamp pane '${candidates[0].name}' iterm_id`);
          myPane = orchestrator.store.getPane(candidates[0].name) ?? undefined;
          console.error(`[crew] self-stamped pane '${candidates[0].name}' iterm_id=${sessionId} (matched via tab='${tabName}')`);
        } else if (candidates.length > 1) {
          console.error(`[crew] cannot auto-bind: tab '${tabName}' has ${candidates.length} unbound panes — call agent_register with caller_session_id`);
        }
      }

      // Bind agent to pane ONLY when it's still unset.
      //
      // agent_attach is authoritative for pane bindings — self-stamp may
      // not override it. Classic race: agent is spawned via `screen -dmS`
      // from a launcher shell, inheriting that shell's ITERM_SESSION_ID
      // (which points at the LAUNCHER's pane, not where the agent ends up).
      // Meanwhile the orchestrator agent_attach'es this agent to its real
      // pane. The self-stamp's `myAgent` snapshot predates that write, so
      // `myAgent.pane` looks null. Without this guard we'd write the env-
      // derived guess and clobber the correct binding. Re-read RIGHT before
      // writing so a racing agent_attach wins.
      if (myPane) {
        const fresh = orchestrator.store.getAgentByScreen(screenName!);
        if (fresh && !fresh.pane) {
          if (await tryCrewRpc("crew.agent_attach", {
            id: fresh.id,
            pane: myPane.name,
          }, `self-stamp agent '${fresh.id}' pane`)) {
            console.error(`[crew] self-stamped agent '${fresh.id}' pane='${myPane.name}'`);
          }
        } else if (fresh && fresh.pane !== myPane.name) {
          console.error(
            `[crew] self-stamp: env-derived pane '${myPane.name}' differs from DB pane '${fresh.pane}' for '${fresh.id}' — NOT overriding (agent_attach is authoritative). ` +
            `This usually means ITERM_SESSION_ID was inherited from a launcher shell in a different pane.`,
          );
        }
      }
    }
  }

  /**
   * Detect the caller's terminal session ID.
   * Works with both iTerm2 (TTY lookup + ITERM_SESSION_ID) and cmux (CMUX_SURFACE_ID).
   */
  async function callerSession(): Promise<string | undefined> {
    // cmux: use CMUX_SURFACE_ID env var directly
    if (terminalName === "cmux" && process.env.CMUX_SURFACE_ID) {
      return process.env.CMUX_SURFACE_ID;
    }

    // Try resolving via TTY → terminal session lookup
    try {
      const tty = execSync(`ps -o tty= -p ${process.ppid}`, { encoding: "utf-8" }).trim();
      if (tty && tty !== "??") {
        const id = await terminal.sessionIdForTty(tty);
        if (id) return id;
      }
    } catch (e) {
      console.error(`[crew] TTY lookup failed for ppid ${process.ppid}:`, e);
    }

    // Fall back to env vars
    if (process.env.CMUX_SURFACE_ID) return process.env.CMUX_SURFACE_ID;
    const raw = process.env.ITERM_SESSION_ID;
    if (raw) return raw.split(":")[1];
    return undefined;
  }

  const mcp = new Server(
    { name: "crew", version: "0.3.0" },
    {
      capabilities: { tools: {} },
      instructions:
        `Crew manages agents across three independent layers (terminal: ${terminalName}):\n` +
        "- AGENT = the full stack: identity + CC session + CC process + screen. 1:1:1:1. Survives pane closes and terminal crashes.\n" +
        "- PANE = a terminal pane. A viewport — nothing more. Think of panes as conference rooms.\n" +
        "- TAB = a terminal tab/workspace containing a layout of panes.\n\n" +
        "Agents and panes are independent. An agent can run without a pane (headless), " +
        "and a pane can exist without an agent (empty shell). " +
        "`agent_attach` connects an agent's screen to a pane. `agent_detach` disconnects without stopping the agent.\n\n" +
        "Standard sequence: agent_launch → pane_create → agent_attach → agent_send '\\r' (confirm dev-channel prompt).\n\n" +
        "RULES:\n" +
        "- Name panes by position or purpose (e.g. 'engineering-nw', 'oak', 'review-left'), NOT by agent name. " +
        "Agents don't own rooms — they sit in them.\n" +
        "- To close a pane you no longer need: agent_detach first (if occupied), then pane_close.\n" +
        "- To stop watching an agent without closing the pane: agent_detach.\n" +
        "- **To shut down an agent: prefer agent_close** — it uses the runtime's clean path (`/exit` for Claude Code, SIGTERM for bridge runtimes), verifies process-tree death, and fires runtime cleanup hooks when supported. Then pane_close if you want the pane gone too.\n" +
        "- agent_stop (hard kill) is for exceptional circumstances only — runtime is unresponsive, hung, or you specifically need to skip clean-shutdown hooks.\n" +
        "- NEVER close a pane you are sitting in — it will kill your process.",
    },
  );

  const TOOLS = [
    {
      name: "agent_launch",
      description: "Launch an agent in a persistent screen session (runs headless until attached to a pane). Identity and configuration flow through the env map; crew is a pure env-forwarder with no domain knowledge of what the vars mean.",
      inputSchema: {
        type: "object" as const,
        properties: {
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "Env vars exported into the spawned agent's environment. " +
              "MUST include AGENT_ID — crew uses it as the agent's primary identifier (screen session name, DB key). AGENT_NAME defaults to AGENT_ID. " +
              "All other vars are opaque to crew. " +
              "For Wire-using agents, include AGENT_PRIVATE_KEY. The orchestrator is responsible for provisioning the keypair BEFORE calling agent_launch — typically by calling `mcp__plugin_wire_wire__register_agent({ id })` (fresh mode mints a keypair and returns `private_key_b64`) and passing that string here as base64 PKCS8. Crew itself does NOT register, sponsor, or generate keys; it only forwards the env map verbatim to the spawned process. (The v2.9.x `autosponsor` shortcut was removed in v2.10.0 per the cross-refs rule — composite register+spawn workflows belong in a bundle plugin, not in crew-tools.)",
          },
          prompt: { type: "string", description: "Initial prompt — passed as positional arg to the runtime command." },
          runtime: { type: "string", description: "Runtime: claude-code, codex, etc. Default: claude-code" },
          project_dir: { type: "string", description: "Working directory for the spawned process" },
          machine: { type: "string", description: "Cross-machine spawn: name of a registered machine (machine_register) to spawn ON. When it names a non-local machine, the agent's screen is created there via ssh + `sudo -u <run_as_uid>` and runs headless from this orchestrator's POV (no local pane); machine_name is stamped so the reconciler won't false-reap it. Omit → local spawn." },
          run_as_uid: { type: "string", description: "Per-UID account to spawn the remote agent under (e.g. '_ephemeral'). REQUIRED when `machine` is non-local. Ignored for local spawns." },
          extra_flags: { type: "string", description: "Additional CLI flags appended to the runtime command" },
          badge: { type: "string", description: "Badge text shown in pane top-right when attached (e.g. 'ENG-2998 Mochi')" },
          ttl_idle_minutes: {
            type: "number",
            description:
              "Optional idle TTL in minutes. If set, crew's reaper stops the agent once it has been idle (no agent_send / agent_attach / status update) for longer than this. Use for ephemeral spawns (e.g. indexing sidecars) that should self-clean rather than run forever.",
          },
          split_in_caller_workspace: {
            type: "object",
            description:
              "If set, after the agent's screen session is up, split the caller's terminal surface and attach the agent's screen into the new sibling pane. Best-effort UX sugar — failures (no caller surface, backend doesn't support it, split refused) leave the agent headless. Today only the cmux backend implements this; iTerm2 silently ignores it. The new surface is NOT registered as a crew pane.",
            properties: {
              direction: {
                type: "string",
                enum: ["right", "down"],
                description: "Which side of the caller's surface to put the new pane on.",
              },
            },
            required: ["direction"],
          },
        },
        required: ["env"],
      },
    },
    {
      name: "agent_badge",
      description:
        "Set an agent's badge. Writes the text to the agent's DB row AND, " +
        "if the agent is currently attached to a pane, pushes the text to " +
        "that pane's iTerm2/cmux overlay immediately. This is the single " +
        "call you should reach for when you want a badge to appear — no " +
        "need to also call pane_badge. " +
        "On subsequent agent_attach, the saved badge is re-rendered " +
        "automatically. On agent_detach or agent_stop, the pane's badge is " +
        "cleared. Badge color is determined by the pane's theme profile.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          text: { type: "string", description: "Badge text to display" },
        },
        required: ["id", "text"],
      },
    },
    {
      name: "agent_resume",
      description:
        "Resume a stopped agent from its tombstone. Since v2.3.0, every " +
        "agent_launch persists a spawn manifest (project_dir, env, channels, " +
        "badge, ttl_idle_minutes, …). agent_stop copies that manifest into a " +
        "tombstone row. Calling agent_resume({ id }) looks up the most " +
        "recent tombstone for that id and reconstructs the spawn with one " +
        "call — no re-supplying inputs.\n\n" +
        "Wire identity: AGENT_PRIVATE_KEY is stripped from the stored " +
        "manifest, so if the agent uses Wire, first call " +
        "`mcp__plugin_wire_wire__register_agent({ id, force_rotate: true })` to mint a fresh keypair on Wire " +
        "(the `register_agent` tool moved from wire-ipc to the wire plugin in wire-ipc v1.3.0), " +
        "then pass the returned `private_key_b64` as `env.AGENT_PRIVATE_KEY` here. Wire's " +
        "/agents/register is UPSERT keyed on id, so the same agent id " +
        "continues to exist with a new pubkey.\n\n" +
        "Any explicit field overrides the tombstone's value (including " +
        "cc_session_id and project_dir — useful for resuming into a " +
        "different worktree).",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID to resume (the id it was running under before agent_stop)." },
          cc_session_id: { type: "string", description: "Claude Code session ID — the JSONL filename stem. If omitted, falls back to the tombstone's cc_session_id (the session that was live when the agent was stopped)." },
          project_dir: { type: "string", description: "Working directory. Defaults to the tombstone manifest's project_dir." },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Env overrides, merged on top of the tombstone's sanitized env. AGENT_PRIVATE_KEY is never in the tombstone — supply it here for Wire-using agents.",
          },
          channels: {
            type: "array",
            items: { type: "string" },
            description: "Dev-channel plugin list. Overrides the tombstone's recorded list; falls back to ['plugin:wire@agiterra'].",
          },
          extra_flags: { type: "string", description: "Additional CLI flags appended after --resume. Defaults to tombstone's extra_flags." },
          attach_to_pane: { type: "string", description: "Optional pane to attach the resumed agent to once the screen is up." },
          display_name: { type: "string", description: "Display name. Defaults to tombstone's display_name." },
          badge: { type: "string", description: "Badge text. Defaults to tombstone's badge." },
          runtime: { type: "string", description: "Runtime. Defaults to tombstone's runtime. Only 'claude-code' is supported today." },
        },
        required: ["id"],
      },
    },
    {
      name: "tombstone_list",
      description:
        "List tombstones (stopped-agent records) with their manifests. " +
        "Useful for discovering what's resumable. Without `id`, returns " +
        "the most recent tombstones across all agents; with `id`, returns " +
        "all tombstones for that agent, most recent first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Filter by agent id." },
          limit: { type: "number", description: "Max rows (default 50)." },
        },
      },
    },
    {
      name: "agent_register",
      description: "Register yourself as a crew agent. Call this on boot if you're running in a screen session. Auto-links to your pane if one exists with the same name.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID (your Wire agent name)" },
          name: { type: "string", description: "Display name" },
          runtime: { type: "string", description: "Runtime: claude-code, codex, etc. Default: claude-code" },
          cc_session_id: { type: "string", description: "Claude Code session ID. Auto-detected from ~/.claude/sessions/ if omitted." },
        },
        required: ["id", "name"],
      },
    },
    {
      name: "agent_close",
      description:
        "Gracefully close an agent. Uses the runtime's clean shutdown path (`/exit` + Enter for Claude Code, SIGTERM to the process group for bridge runtimes), then verifies the tree is dead before deleting the row. Falls back to a hard kill if the runtime hasn't exited within 10s. The pane stays open — use pane_close if you want the pane gone too.\n\n**Prefer agent_close for normal shutdown.** Use agent_stop only when the runtime is unresponsive or you specifically need to skip clean-shutdown hooks.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          cc_session_id: { type: "string", description: "Claude Code session ID — disambiguates when multiple instances share an agent ID (e.g. during handoff)" },
        },
        required: ["id"],
      },
    },
    {
      name: "agent_stop",
      description:
        "Hard-stop an agent (kills the screen session and all child processes). Use only for exceptional circumstances — runtime is unresponsive, hung agent, etc. **For normal shutdown, prefer agent_close**, which lets the runtime exit cleanly and fire its SessionEnd hooks (so e.g. ephemeral wire agents are removed from the dashboard immediately instead of greyed for an hour). The pane stays open — use pane_close separately if you want the pane gone too.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          cc_session_id: { type: "string", description: "Claude Code session ID — disambiguates when multiple instances share an agent ID (e.g. during handoff)" },
        },
        required: ["id"],
      },
    },
    {
      name: "agent_list",
      description:
        "List agents with status, pane, and runtime. Optional filters narrow the result — useful when you only want attached agents (for routing) or headless ones (for cleanup). The list is reality-joined: a local agent appears only if its screen session is live at read time (stale rows are hidden immediately and pruned on a grace), while agents on peer machines pass through unverified.",
      inputSchema: {
        type: "object" as const,
        properties: {
          attached: {
            type: "boolean",
            description: "If true, return only agents attached to a pane. If false, return only headless agents. Omit for all.",
          },
          pane: {
            type: "string",
            description: "Return only agents attached to this exact pane.",
          },
          with_ttl: {
            type: "boolean",
            description: "If true, return only agents that have a ttl_idle_minutes set (ephemeral spawns). If false, return only agents without a TTL (permanent).",
          },
        },
      },
    },
    {
      name: "agent_attach",
      description: "Attach an agent's screen session to a pane, making it visible. If another agent occupies the pane, it is detached first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          pane: { type: "string", description: "Pane name" },
        },
        required: ["id", "pane"],
      },
    },
    {
      name: "agent_detach",
      description: "Detach an agent from its pane. The agent keeps running headless in its screen session. The pane stays open with an empty shell.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "agent_move",
      description: "Move an agent to a different pane",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          pane: { type: "string", description: "Target pane name" },
        },
        required: ["id", "pane"],
      },
    },
    {
      name: "agent_swap",
      description: "Swap two agents' panes",
      inputSchema: {
        type: "object" as const,
        properties: {
          id_a: { type: "string", description: "First agent ID" },
          id_b: { type: "string", description: "Second agent ID" },
        },
        required: ["id_a", "id_b"],
      },
    },
    {
      name: "agent_send",
      description: "Send keystrokes to an agent's screen session (attached or headless). Returns { sent, landed, screen }: `landed` is true/false when the text is verifiable (printable, no trailing \\r/\\n) — confirming it actually appeared in the input — or null for control/submit keys (\\r, Esc, arrows) which leave no stable visible text. `screen` is the post-send hardcopy so you can confirm delivery rather than trust a blind sent:true. NOTE: AskUserQuestion menus ignore free text + digits as a SELECT — use arrows+Enter, or Esc to cancel then send the answer as a fresh prompt.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          text: { type: "string", description: "Text to send (use \\r for enter in screen sessions)" },
          session: { type: "string", description: "Screen session name — disambiguates when multiple sessions share an agent ID" },
        },
        required: ["id", "text"],
      },
    },
    {
      name: "agent_interrupt",
      description: "Interrupt an agent. Returns screen output so you can assess the result.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          cc_session_id: { type: "string", description: "Claude Code session ID — disambiguates during handoff" },
          background: { type: "boolean", description: "If true, Ctrl-B Ctrl-B (background task). Default: Escape (cancel)." },
        },
        required: ["id"],
      },
    },
    {
      name: "agent_read",
      description: "Read an agent's current screen output. Works whether the agent is attached to a pane or running headless.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Agent ID" },
          cc_session_id: { type: "string", description: "Claude Code session ID — disambiguates when multiple instances share an agent ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "tab_register",
      description: "Register an EXISTING terminal tab (the one you're already running in, or one the operator opened manually) without spawning a new iTerm tab via AppleScript. Use this when an agent boots in a manually-opened tab and wants crew to track it. Defaults iterm_session_id to the caller's current session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Tab name" },
          theme: { type: "string", description: "Pane naming theme: trees, rivers, stones, peaks, spices, cities" },
          iterm_session_id: { type: "string", description: "Terminal session uuid (default: caller's current session)" },
        },
        required: ["name"],
      },
    },
    {
      name: "tab_create",
      description: "Create a named tab (a container for panes) by SPAWNING a new iTerm tab via AppleScript. To bind an existing iTerm tab, use tab_register instead. Optionally set a theme for auto-naming panes.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Tab name" },
          theme: { type: "string", description: "Pane naming theme: trees, rivers, stones, peaks, spices, cities. Panes created without a name get one from this pool." },
        },
        required: ["name"],
      },
    },
    {
      name: "tab_list",
      description: "List all tabs",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "tab_destroy",
      description: "Destroy a tab and all its panes. Agents in those panes are detached (keep running headless). NEVER destroy a tab containing a pane you are sitting in.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Tab name" },
        },
        required: ["name"],
      },
    },
    {
      name: "pane_register",
      description: "Register your own terminal pane. Call this at session start so other agents can split relative to your pane.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tab: { type: "string", description: "Tab name (created if missing)" },
          name: { type: "string", description: "Pane name (optional — auto-assigned from tab theme if omitted)" },
        },
        required: ["tab"],
      },
    },
    {
      name: "pane_create",
      description: "Create a pane by splitting an existing terminal pane.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tab: { type: "string", description: "Tab name" },
          name: { type: "string", description: "Pane name (optional — auto-assigned from tab theme if omitted)" },
          position: { type: "string", description: "Split direction: below (default), right, left, above" },
          relative_to: { type: "string", description: "Pane name or session ID to split from (default: tab's session or caller's pane)" },
        },
        required: ["tab"],
      },
    },
    {
      name: "pane_send",
      description: "Send keystrokes to a pane's terminal session.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pane: { type: "string", description: "Pane name" },
          text: { type: "string", description: "Text to send" },
        },
        required: ["pane", "text"],
      },
    },
    {
      name: "pane_badge",
      description:
        "Set a badge on a pane directly, bypassing any agent that may be " +
        "attached. Use this for pane-purpose labels on panes that don't " +
        "currently host an agent (e.g., an empty pane reserved for a future " +
        "role, a tab-metadata slot). For agent-identity badges, prefer " +
        "agent_badge — it writes the DB and auto-renders when the agent " +
        "attaches, and it survives detach/reattach cycles. A badge set via " +
        "pane_badge is transient — an agent attaching to the pane will " +
        "overwrite it with its own badge.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pane: { type: "string", description: "Pane name" },
          text: { type: "string", description: "Badge text" },
        },
        required: ["pane", "text"],
      },
    },
    {
      name: "pane_notify",
      description: "Flash a pane's tab and send a notification. On cmux: triggers the notification ring + desktop alert. On iTerm2: sets badge text.",
      inputSchema: {
        type: "object" as const,
        properties: {
          pane: { type: "string", description: "Pane name" },
          title: { type: "string", description: "Notification title" },
          body: { type: "string", description: "Notification body (optional)" },
        },
        required: ["pane", "title"],
      },
    },
    {
      name: "pane_list",
      description: "List all panes, optionally filtered by tab",
      inputSchema: {
        type: "object" as const,
        properties: {
          tab: { type: "string", description: "Optional tab filter" },
        },
      },
    },
    {
      name: "pane_close",
      description: "Close a pane. Detaches any agent first. NEVER close a pane you are sitting in.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Pane name" },
        },
        required: ["name"],
      },
    },
    {
      name: "url_open",
      description: "Open a URL in a new pane",
      inputSchema: {
        type: "object" as const,
        properties: {
          tab: { type: "string", description: "Tab name (must exist)" },
          pane: { type: "string", description: "Pane name (auto-generated if omitted)" },
          url: { type: "string", description: "URL to open" },
          position: { type: "string", description: "Split direction: below (default), right" },
          relative_to: { type: "string", description: "Pane name to split from" },
        },
        required: ["tab", "url"],
      },
    },
    {
      name: "theme_update",
      description: "Update a theme's blend, mode, or images, then rebuild all live panes using that theme.",
      inputSchema: {
        type: "object" as const,
        properties: {
          theme: { type: "string", description: "Theme name" },
          blend: { type: "number", description: "Background blend/opacity (0-1)" },
          mode: { type: "number", description: "Background image mode (0=tile, 1=stretch, 2=scale-to-fill)" },
          images: {
            type: "object",
            description: "Map of pane name → image filename to update",
            additionalProperties: { type: "string" },
          },
        },
        required: ["theme"],
      },
    },
    {
      name: "theme_list",
      description: "List installed themes with pool coverage",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "reconcile",
      description: "Sync DB state with running screen sessions.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "machine_register",
      description:
        "Register a machine in the local crew DB so cross-machine tools " +
        "(crew-fleet, fleet_move) can reach it. Probes SSH with " +
        "BatchMode=yes + ConnectTimeout=5 and reads the remote crew " +
        "plugin version. Each crew DB is local-truth for 'machines I " +
        "know how to reach' — no central registry. Pass `reciprocal: " +
        "true` to also register the local machine on the remote side.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "User-friendly alias (e.g. 'home-mini')." },
          ssh_host: { type: "string", description: "SSH destination (e.g. 'tim@mac-mini.local')." },
          ssh_port: { type: "number", description: "Optional SSH port. Default: 22." },
          broker_url: { type: "string", description: "Externally-reachable Wire broker URL for agents spawned ON this machine (e.g. 'https://patisserie.ngrok.io'). Required for cross-machine spawn: the sponsoring parent registers the new ephemeral against this url so the remote broker knows its key, and the agent receives it as WIRE_EXTERNAL_URL. Omit for machines with no distinct broker." },
          notes: { type: "string", description: "Free-form notes." },
          skip_probe: { type: "boolean", description: "Skip the SSH reachability check at register time (default false)." },
          reciprocal: { type: "boolean", description: "If true, after registering the destination, SSH to it and register the LOCAL machine in its DB. Best-effort — SSH failure during reciprocal step does not undo the local row." },
          local_address: { type: "string", description: "Override the SSH-reachable address of the local machine for the reciprocal call. Defaults to '${USER}@${hostname}.local'." },
        },
        required: ["name", "ssh_host"],
      },
    },
    {
      name: "machine_list",
      description:
        "List all machines registered in the local crew DB. The local " +
        "machine is auto-registered on first boot and appears as a row " +
        "with ssh_host='localhost'.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "machine_remove",
      description:
        "Remove a registered machine. Refuses to delete the local " +
        "machine — its row is required for agents.machine_name joins.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Machine name to remove." },
        },
        required: ["name"],
      },
    },
    {
      name: "machine_probe",
      description:
        "Re-probe a registered machine for reachability. Updates " +
        "last_seen + crew_version on success; returns the probe result " +
        "either way.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: { type: "string", description: "Machine name to probe." },
        },
        required: ["name"],
      },
    },
  ];

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case "agent_launch": {
          const params = {
            env: a.env as Record<string, string>,
            runtime: a.runtime as string | undefined,
            project_dir: a.project_dir as string | undefined,
            extra_flags: a.extra_flags as string | undefined,
            prompt: a.prompt as string | undefined,
            badge: a.badge as string | undefined,
            ttl_idle_minutes: a.ttl_idle_minutes as number | undefined,
          };
          const machine = a.machine as string | undefined;
          const localMachine = orchestrator.store.localMachineName();
          result = machine && machine !== localMachine
            ? await crewRpcTo(`crew-svc@${machine}`, "crew.agent_spawn", params, 120_000)
            : await crewRpc("crew.agent_spawn", params, 120_000);
          break;
        }
        case "agent_resume": {
          result = await crewRpc("crew.agent_resume", {
            id: a.id as string,
            cc_session_id: a.cc_session_id as string | undefined,
            project_dir: a.project_dir as string | undefined,
            env: a.env as Record<string, string> | undefined,
          }, 120_000);
          break;
        }
        case "tombstone_list": {
          result = orchestrator.store.listTombstones(
            a.id as string | undefined,
            a.limit as number | undefined,
          );
          break;
        }
        case "agent_register":
          result = await crewRpc("crew.agent_register", {
            id: a.id as string,
            name: a.name as string,
            runtime: a.runtime as string | undefined,
            caller_session_id: await callerSession(),
            cc_session_id: (a.cc_session_id as string | undefined) ?? ccSessionId ?? undefined,
          });
          break;
        case "agent_badge": {
          result = await crewRpc("crew.agent_badge", { id: a.id, text: a.text });
          break;
        }
        case "agent_interrupt":
          result = await crewRpc("crew.agent_interrupt", {
            id: a.id,
            background: !!a.background,
            cc_session_id: a.cc_session_id,
          });
          break;
        case "agent_close":
          result = await crewRpc("crew.agent_close", { id: a.id, cc_session_id: a.cc_session_id }, 120_000);
          break;
        case "agent_stop":
          result = await crewRpc("crew.agent_stop", { id: a.id }, 120_000);
          break;
        case "agent_list": {
          let agents = await orchestrator.listAgents();
          if (typeof a.attached === "boolean") {
            agents = agents.filter((ag) => (ag.pane !== null) === a.attached);
          }
          if (typeof a.pane === "string") {
            agents = agents.filter((ag) => ag.pane === a.pane);
          }
          if (typeof a.with_ttl === "boolean") {
            agents = agents.filter((ag) => (ag.ttl_idle_minutes !== null) === a.with_ttl);
          }
          result = agents;
          break;
        }
        case "agent_attach":
          result = await crewRpc("crew.agent_attach", { id: a.id, pane: a.pane });
          break;
        case "agent_detach":
          result = await crewRpc("crew.agent_detach", { id: a.id });
          break;
        case "agent_move":
          result = await crewRpc("crew.agent_move", { id: a.id, pane: a.pane });
          break;
        case "agent_swap":
          result = await crewRpc("crew.agent_swap", { id_a: a.id_a, id_b: a.id_b });
          break;
        case "agent_send": {
          result = await crewRpc("crew.agent_send", {
            id: a.id,
            text: a.text,
            cc_session_id: (a.cc_session_id as string | undefined) ?? (a.session as string | undefined),
          });
          break;
        }
        case "agent_read":
          result = { output: await orchestrator.readAgent(a.id as string, a.cc_session_id as string | undefined) };
          break;
        case "tab_register": {
          const sessionId = (a.iterm_session_id as string | undefined) ?? (await callerSession());
          if (!sessionId) throw new Error(`cannot detect terminal session — pass iterm_session_id explicitly or run from inside ${terminalName}`);
          result = await crewRpc("crew.tab_register", {
            name: a.name,
            iterm_session_id: sessionId,
            theme: a.theme,
          });
          break;
        }
        case "tab_create":
          result = await crewRpc("crew.tab_create", { name: a.name, theme: a.theme });
          break;
        case "tab_list":
          result = orchestrator.listTabs();
          break;
        case "tab_destroy":
          result = await crewRpc("crew.tab_destroy", { name: a.name });
          break;
        case "pane_register": {
          const sessionId = await callerSession();
          if (!sessionId) throw new Error(`cannot detect terminal session — are you running in ${terminalName}?`);
          result = await crewRpc("crew.pane_register", {
            tab: a.tab,
            name: a.name,
            iterm_session_id: sessionId,
          });
          break;
        }
        case "pane_create": {
          // Only fall back to caller's session if creating in the caller's OWN tab.
          // Cross-tab creates must NOT use the caller's pane as splitTarget — that's
          // how new panes ended up in the caller's tab instead of the target.
          const targetTab = a.tab as string;
          let relTo = a.relative_to as string | undefined;
          if (!relTo) {
            const callerId = await callerSession();
            if (callerId) {
              const callerPane = orchestrator.store.listPanes().find((p) => p.iterm_id === callerId);
              if (callerPane && callerPane.tab === targetTab) relTo = callerId;
            }
          }
          result = await crewRpc("crew.pane_create", {
            tab: targetTab,
            name: a.name,
            position: a.position,
            relative_to: relTo,
          });
          break;
        }
        case "pane_send":
          result = await crewRpc("crew.pane_send", { pane: a.pane, text: a.text });
          break;
        case "pane_badge":
          result = await crewRpc("crew.pane_badge", { pane: a.pane, text: a.text });
          break;
        case "pane_notify":
          result = await crewRpc("crew.pane_notify", { pane: a.pane, title: a.title, body: a.body });
          break;
        case "pane_list":
          result = orchestrator.listPanes(a.tab as string | undefined);
          break;
        case "pane_close":
          result = await crewRpc("crew.pane_close", { name: a.name, caller_session_id: await callerSession() });
          break;
        case "url_open":
          if (!orchestrator.store.getTab(a.tab as string)) throw new Error(`tab '${a.tab as string}' not found`);
          {
            const paneName = (a.pane as string | undefined) ?? `url-${Date.now()}`;
            const position = (a.position as string | undefined) ?? "below";
            const direction = (position === "left" || position === "right") ? "vertical" : "horizontal";
            const relativeTo = (a.relative_to as string | undefined) ?? await callerSession();
            const resolvedRelativeTo = relativeTo
              ? (orchestrator.store.getPane(relativeTo)?.iterm_id ?? relativeTo)
              : undefined;
            const sessionId = resolvedRelativeTo
              ? await terminal.splitSessionWebBrowser(resolvedRelativeTo, a.url as string, direction)
              : await terminal.splitWebBrowser(a.url as string, direction);
            const pane = await crewRpc("crew.pane_register", {
              tab: a.tab,
              name: paneName,
              iterm_session_id: sessionId,
            });
            result = { pane, url: a.url };
          }
          break;
        case "theme_update": {
          const updates: { blend?: number; mode?: number; images?: Record<string, string> } = {};
          if (a.blend !== undefined) updates.blend = a.blend as number;
          if (a.mode !== undefined) updates.mode = a.mode as number;
          if (a.images) updates.images = a.images as Record<string, string>;
          result = await crewRpc("crew.theme_update", { theme: a.theme, ...updates }, 120_000);
          break;
        }
        case "theme_list": {
          const themes = listThemes();
          result = themes.map((n) => {
            const config = loadTheme(n);
            const dir = resolveThemeDir(n);
            const imageCount = config ? Object.keys(config.background.images).length : 0;
            const poolSize = config?.pool.length ?? 0;
            return {
              name: n, dir, pool: poolSize, images: imageCount,
              coverage: poolSize > 0 ? `${imageCount}/${poolSize}` : "no pool",
              blend: config?.background.blend, mode: config?.background.mode,
            };
          });
          break;
        }
        case "reconcile":
          result = await crewRpc("crew.reconcile", {}, 120_000);
          break;
        case "machine_register": {
          result = await crewRpc("crew.machine_register", {
            name: a.name as string,
            ssh_host: a.ssh_host as string,
            ssh_port: a.ssh_port as number | undefined,
            broker_url: a.broker_url as string | undefined,
            notes: a.notes as string | undefined,
            skip_probe: Boolean(a.skip_probe),
            reciprocal: Boolean(a.reciprocal),
            local_address: a.local_address as string | undefined,
          });
          break;
        }
        case "machine_list":
          result = orchestrator.listMachines();
          break;
        case "machine_remove":
          result = await crewRpc("crew.machine_remove", { name: a.name });
          break;
        case "machine_probe":
          result = await crewRpc("crew.machine_probe", { name: a.name }, 60_000);
          break;
        default:
          throw new Error(`unknown tool: ${name}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (e: any) {
      const detail = e.stderr
        ? `${e.message}\nstderr: ${e.stderr}\nexit: ${e.exitCode}`
        : e.stack ?? e.message;
      return {
        content: [{ type: "text" as const, text: `error: ${detail}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Graceful shutdown on SIGTERM/SIGINT/SIGHUP: close the MCP transport so
  // the parent CC process sees a clean disconnect. Without this, kill-mcp.sh
  // or /reload-plugins leaves the transport half-open until the OS tears it
  // down. Wire-session cleanup (if any) is owned by the wire plugin, not
  // crew — this handler only covers MCP transport hygiene.
  let shuttingDown = false;
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[crew] ${sig} received — closing transport`);
    try {
      await mcp.close();
    } catch (e) {
      console.error(`[crew] transport close failed:`, e);
    }
    try {
      await rpcWriter?.stop();
    } catch (e) {
      console.error(`[crew] RPC writer stop failed:`, e);
    }
    // Small drain window for any in-flight wire ops
    await new Promise((r) => setTimeout(r, 100));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  const reconcileResult = await crewRpc("crew.reconcile", {});
  const report = typeof reconcileResult === "object" && reconcileResult !== null && "report" in reconcileResult
    ? String((reconcileResult as { report?: unknown }).report ?? "")
    : JSON.stringify(reconcileResult, null, 2);
  console.error(`[crew] boot reconcile:\n${report}`);
  console.error(`[crew] ready (caller=${CALLER_AGENT_ID}, terminal=${terminalName}, cc_session=${ccSessionId ?? "unknown"})`);
}
