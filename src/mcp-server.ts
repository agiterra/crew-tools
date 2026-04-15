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

  // Self-stamp: if we can identify the current agent (via STY) and we have a
  // session ID, update the agent's cc_session_id immediately. Without this,
  // existing agent records keep null cc_session_id forever — agent_register
  // is never automatically called on restart.
  const sty = process.env.STY;
  const screenName = sty ? sty.split(".").slice(1).join(".") : undefined;
  const myAgent = screenName ? orchestrator.store.getAgentByScreen(screenName) : null;

  if (ccSessionId && myAgent) {
    orchestrator.store.updateAgentCcSession(myAgent.screen_name, ccSessionId);
    console.error(`[crew] self-stamped ${myAgent.id} cc_session_id=${ccSessionId.slice(0, 8)}\u2026`);
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
          orchestrator.store.setPaneItermId(myAgent.pane, sessionId);
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
          orchestrator.store.setPaneItermId(candidates[0].name, sessionId);
          myPane = orchestrator.store.getPane(candidates[0].name) ?? undefined;
          console.error(`[crew] self-stamped pane '${candidates[0].name}' iterm_id=${sessionId} (matched via tab='${tabName}')`);
        } else if (candidates.length > 1) {
          console.error(`[crew] cannot auto-bind: tab '${tabName}' has ${candidates.length} unbound panes — call agent_register with caller_session_id`);
        }
      }

      // Bind agent to pane if mismatched.
      if (myPane && myAgent.pane !== myPane.name) {
        orchestrator.store.updateAgentPane(myAgent.id, myPane.name);
        console.error(`[crew] self-stamped agent '${myAgent.id}' pane='${myPane.name}'`);
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
        "- To kill an agent: agent_stop (screen dies, pane stays). Then pane_close if you want the pane gone too.\n" +
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
              "For Wire-using agents include AGENT_PRIVATE_KEY: orchestrator generates the keypair, pre-registers the public key on Wire (sponsoring-agent register flow), and passes the base64 PKCS8 private key here.",
          },
          prompt: { type: "string", description: "Initial prompt — passed as positional arg to the runtime command." },
          runtime: { type: "string", description: "Runtime: claude-code, codex, etc. Default: claude-code" },
          project_dir: { type: "string", description: "Working directory for the spawned process" },
          extra_flags: { type: "string", description: "Additional CLI flags appended to the runtime command" },
          badge: { type: "string", description: "Badge text shown in pane top-right when attached (e.g. 'ENG-2998 Mochi')" },
        },
        required: ["env"],
      },
    },
    {
      name: "agent_badge",
      description: "Update an agent's badge text. The badge appears in the top-right of the pane when the agent is attached. Color is determined by the pane's theme.",
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
      name: "agent_stop",
      description: "Stop an agent (kills the screen session). The pane stays open — use pane_close separately if you want the pane gone too.",
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
      description: "List all agents with status, pane, and runtime",
      inputSchema: { type: "object" as const, properties: {} },
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
      description: "Send keystrokes to an agent's screen session. Works whether the agent is attached to a pane or running headless.",
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
      name: "tab_create",
      description: "Create a named tab (a container for panes). Optionally set a theme for auto-naming panes.",
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
      description: "Set a badge/status on a pane (overlay text in corner for iTerm2, sidebar status for cmux)",
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
  ];

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const a = (args ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;

      switch (name) {
        case "agent_launch": {
          result = await orchestrator.launchAgent({
            env: a.env as Record<string, string>,
            runtime: a.runtime as string | undefined,
            projectDir: a.project_dir as string | undefined,
            extraFlags: a.extra_flags as string | undefined,
            prompt: a.prompt as string | undefined,
            badge: a.badge as string | undefined,
          });
          break;
        }
        case "agent_register":
          result = await orchestrator.registerAgent({
            id: a.id as string,
            displayName: a.name as string,
            runtime: a.runtime as string | undefined,
            callerSessionId: await callerSession(),
            ccSessionId: (a.cc_session_id as string | undefined) ?? ccSessionId ?? undefined,
          });
          break;
        case "agent_badge":
          await orchestrator.setAgentBadge(a.id as string, a.text as string);
          result = { badge_set: a.id, text: a.text };
          break;
        case "agent_interrupt":
          result = await orchestrator.interruptAgent(a.id as string, !!a.background, a.cc_session_id as string | undefined);
          break;
        case "agent_stop":
          await orchestrator.stopAgent(a.id as string, a.cc_session_id as string | undefined);
          result = { stopped: a.id, cc_session_id: a.cc_session_id };
          break;
        case "agent_list":
          result = orchestrator.listAgents();
          break;
        case "agent_attach":
          await orchestrator.attachAgent(a.id as string, a.pane as string);
          result = { attached: a.id, pane: a.pane };
          break;
        case "agent_detach":
          await orchestrator.detachAgent(a.id as string);
          result = { detached: a.id };
          break;
        case "agent_move":
          await orchestrator.moveAgent(a.id as string, a.pane as string);
          result = { moved: a.id, pane: a.pane };
          break;
        case "agent_swap":
          await orchestrator.swapAgents(a.id_a as string, a.id_b as string);
          result = { swapped: [a.id_a, a.id_b] };
          break;
        case "agent_send":
          await orchestrator.sendToAgent(a.id as string, a.text as string, a.cc_session_id as string | undefined);
          result = { sent: true };
          break;
        case "agent_read":
          result = { output: await orchestrator.readAgent(a.id as string, a.cc_session_id as string | undefined) };
          break;
        case "tab_create":
          result = await orchestrator.createTab(a.name as string, a.theme as string | undefined);
          break;
        case "tab_list":
          result = orchestrator.listTabs();
          break;
        case "tab_destroy":
          orchestrator.deleteTab(a.name as string);
          result = { destroyed: a.name };
          break;
        case "pane_register": {
          const sessionId = await callerSession();
          if (!sessionId) throw new Error(`cannot detect terminal session — are you running in ${terminalName}?`);
          if (!orchestrator.store.getTab(a.tab as string)) {
            orchestrator.createTab(a.tab as string);
          }
          result = await orchestrator.registerPane(a.tab as string, a.name as string | undefined, sessionId);
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
          result = await orchestrator.createPane(
            targetTab,
            a.name as string | undefined,
            a.position as string | undefined,
            relTo,
          );
          break;
        }
        case "pane_send":
          await orchestrator.sendToPane(a.pane as string, a.text as string);
          result = { sent: true, pane: a.pane };
          break;
        case "pane_badge":
          await orchestrator.setBadge(a.pane as string, a.text as string);
          result = { badge_set: a.pane, text: a.text };
          break;
        case "pane_notify":
          await orchestrator.notifyPane(a.pane as string, a.title as string, a.body as string | undefined);
          result = { notified: a.pane, title: a.title };
          break;
        case "pane_list":
          result = orchestrator.listPanes(a.tab as string | undefined);
          break;
        case "pane_close":
          await orchestrator.closePane(a.name as string, await callerSession());
          result = { closed: a.name };
          break;
        case "url_open":
          result = await orchestrator.openUrl({
            tab: a.tab as string,
            pane: a.pane as string | undefined,
            url: a.url as string,
            position: a.position as string | undefined,
            relativeTo: (a.relative_to as string) ?? await callerSession(),
          });
          break;
        case "theme_update": {
          const updates: { blend?: number; mode?: number; images?: Record<string, string> } = {};
          if (a.blend !== undefined) updates.blend = a.blend as number;
          if (a.mode !== undefined) updates.mode = a.mode as number;
          if (a.images) updates.images = a.images as Record<string, string>;
          result = await orchestrator.updateThemeAndRebuild(a.theme as string, updates);
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
          result = { report: await orchestrator.reconcile() };
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
    // Small drain window for any in-flight wire ops
    await new Promise((r) => setTimeout(r, 100));
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGHUP", () => void shutdown("SIGHUP"));

  const report = await orchestrator.reconcile();
  console.error(`[crew] boot reconcile:\n${report}`);
  console.error(`[crew] ready (caller=${CALLER_AGENT_ID}, terminal=${terminalName}, cc_session=${ccSessionId ?? "unknown"})`);
}
