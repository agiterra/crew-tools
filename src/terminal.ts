/**
 * Terminal backend abstraction.
 *
 * Defines a common interface for terminal multiplexers (iTerm2, cmux, etc.)
 * so the orchestrator and MCP server are terminal-agnostic.
 */

/**
 * Profile info for creating themed panes.
 * iTerm2 uses dynamic profiles with background images.
 * cmux ignores background images (uses sidebar metadata instead).
 */
export interface PaneProfile {
  paneName: string;
  backgroundImage?: string;
  blend?: number;
  mode?: number;
  /** Per-pane badge color (iTerm2 only — cmux ignores). */
  badgeColor?: { r: number; g: number; b: number; a?: number };
}

/**
 * Common interface for terminal backends.
 * Both iTerm2 and cmux implement this.
 */
export interface TerminalBackend {
  /** Human-readable backend name (for logs/errors). */
  readonly name: string;

  // --- Identity ---

  /** Get the session/surface ID of the current (focused) terminal. */
  currentSessionId(): Promise<string>;

  /** Resolve a TTY device path to a session/surface ID. */
  sessionIdForTty(ttyName: string): Promise<string | null>;

  // --- Pane operations ---

  /** Split the current pane. Returns the new session/surface ID. */
  splitPane(direction: "horizontal" | "vertical"): Promise<string>;

  /** Split a specific session/surface. Returns the new session/surface ID. */
  splitSession(
    sessionId: string,
    direction: "horizontal" | "vertical",
  ): Promise<string>;

  /** Write/send text to a specific session/surface. */
  writeToSession(sessionId: string, text: string): Promise<void>;

  /**
   * Attach a GNU screen session to a terminal pane and commit the command.
   *
   * Both backends must commit the attach with a newline/enter. iTerm2's
   * writeToSession auto-appends a newline via AppleScript's `write text`;
   * cmux's `send` does not. Without this abstraction, callers had to know
   * the backend-specific newline convention, which silently broke cmux
   * (pane sits at unsubmitted `screen -x …` until a human hits enter).
   *
   * mode: "r" = reattach (default), "x" = multi-display (use when the
   *       session may already be attached elsewhere).
   */
  attachScreen(
    sessionId: string,
    screenName: string,
    mode?: "r" | "x",
  ): Promise<void>;

  /** Close a session/surface. */
  closeSession(sessionId: string): Promise<void>;

  /** Check if a session/surface ID is still alive. */
  isSessionAlive(sessionId: string): Promise<boolean>;

  // --- Tab/workspace operations ---

  /**
   * Create a new tab/workspace. Returns the session/surface ID.
   * On iTerm2, an optional dynamic profile name can be passed so the
   * auto-created initial pane uses that themed profile. cmux ignores it.
   */
  createTab(profileName?: string): Promise<string>;

  // --- Metadata ---

  /** Set the title/name of a session/surface. */
  setSessionName(sessionId: string, name: string): Promise<void>;

  /** Set a badge/status overlay on a session/surface. */
  setBadge(sessionId: string, text: string): Promise<void>;

  // --- Themed pane creation ---

  /**
   * Write a pane profile (iTerm2-specific: dynamic profile with background image).
   * Returns the profile name to use when splitting.
   * cmux returns a dummy value — profile is not used.
   */
  writePaneProfile(profile: PaneProfile): string;

  /** Write the empty/default pane profile. Returns the profile name. */
  writeEmptyPaneProfile(): string;

  /**
   * Apply a named profile to an existing session.
   * iTerm2: writes OSC 1337 SetProfile= to the session's TTY.
   * cmux: no-op (cmux has no equivalent dynamic-profile concept).
   */
  setProfile(sessionId: string, profileName: string): Promise<void>;

  /**
   * Split the current pane using a named profile. Returns new session ID.
   * On cmux, profile is ignored — just does a normal split.
   */
  splitPaneWithProfile(
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string>;

  /**
   * Split a specific session using a named profile. Returns new session ID.
   * On cmux, profile is ignored — just does a normal split.
   */
  splitSessionWithProfile(
    sessionId: string,
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string>;

  // --- Notifications & polish ---

  /**
   * Flash/highlight the tab containing a session.
   * cmux: triggers the notification ring on the tab.
   * iTerm2: no-op (no equivalent).
   */
  flashSession(sessionId: string): Promise<void>;

  /**
   * Send a rich notification tied to a session.
   * cmux: native notification with title/body.
   * iTerm2: falls back to setBadge with the title.
   */
  notifySession(sessionId: string, title: string, body?: string): Promise<void>;

  /**
   * Rename the workspace/tab container.
   * cmux: renames the workspace.
   * iTerm2: no-op (tab naming is limited).
   */
  renameWorkspace(sessionId: string, name: string): Promise<void>;

  // --- Browser ---

  /** Split the current pane with a web browser. Returns new session ID. */
  splitWebBrowser(
    url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string>;

  /** Split a specific session with a web browser. Returns new session ID. */
  splitSessionWebBrowser(
    sessionId: string,
    url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string>;

  // --- Sidebar log (optional, cmux-only today) ---

  /**
   * Append a workspace-level log entry to the sidebar. Used to surface
   * agent lifecycle events (attached, closed, error) where the operator
   * can see them at a glance without opening the pane.
   *
   * Optional: iTerm2 has no equivalent and leaves this undefined. The
   * orchestrator checks for presence before calling. Failures are
   * non-fatal — logging is decorative.
   *
   * level: cmux levels are "info" | "progress" | "success" | "warning" | "error".
   */
  logWorkspace?(
    sessionId: string,
    message: string,
    opts?: { level?: "info" | "progress" | "success" | "warning" | "error"; source?: string },
  ): Promise<void>;

  // --- Caller-workspace split (optional, cmux-only today) ---

  /**
   * Split a caller's surface in the caller's workspace, returning the new
   * surface ref. Used when launching a headless agent that should
   * immediately become visible as a sibling pane next to the caller.
   *
   * Optional: backends that have no equivalent (iTerm2 — agents are
   * launched detached in screen sessions and attached separately) MUST
   * leave this undefined. The orchestrator checks for presence before
   * calling. Returning null signals best-effort failure (caller-side
   * split unavailable; agent stays headless).
   */
  splitFromCallerForAgent?(
    callerSurfaceId: string,
    direction: "right" | "down",
  ): Promise<string | null>;
}

/** Supported terminal backend types. */
export type TerminalType = "iterm" | "cmux";

/**
 * Detect which terminal the process is running in.
 * Returns "cmux" if CMUX_SURFACE_ID is set, otherwise "iterm".
 */
export function detectTerminal(): TerminalType {
  if (process.env.CMUX_SURFACE_ID) return "cmux";
  return "iterm";
}

/**
 * Create a terminal backend instance.
 * Auto-detects the terminal if no type is specified.
 * Override with CREW_TERMINAL env var.
 */
export async function createBackend(
  type?: TerminalType,
): Promise<TerminalBackend> {
  const resolved = type ?? (process.env.CREW_TERMINAL as TerminalType | undefined) ?? detectTerminal();

  if (resolved === "cmux") {
    const { CmuxBackend } = await import("./cmux.js");
    return new CmuxBackend();
  }

  const { ItermBackend } = await import("./iterm-backend.js");
  return new ItermBackend();
}
