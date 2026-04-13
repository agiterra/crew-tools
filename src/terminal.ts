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

  /** Set the tab/workspace name (may be a no-op on some backends). */
  setTabName(sessionId: string, name: string): Promise<void>;

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
