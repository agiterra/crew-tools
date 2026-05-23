/**
 * SidebarLog capability — append-only workspace-level log entries that show
 * up in the terminal's sidebar UI. Used to surface agent lifecycle events
 * (attached, closed, error) where the operator can see them at a glance
 * without opening the pane.
 *
 * cmux registers this with a native sidebar log. iTerm2 has no equivalent
 * and does not register the capability; callers branch on absence.
 */

export type SidebarLogLevel = "info" | "progress" | "success" | "warning" | "error";

export interface SidebarLogCapability {
  /**
   * Append a workspace-level log entry. Failures are non-fatal — logging is
   * decorative. The capability swallows transport errors internally so
   * callers can fire-and-forget.
   */
  append(
    sessionId: string,
    message: string,
    opts?: { level?: SidebarLogLevel; source?: string },
  ): Promise<void>;
}
