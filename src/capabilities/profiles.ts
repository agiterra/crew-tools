/**
 * Profiles capability — themed dynamic profiles for a terminal session.
 * Backgrounds, blends, modes, and badge-color overlays. iTerm2's native
 * dynamic-profile system.
 *
 * iTerm2 registers this. cmux does not (cmux uses sidebar metadata for
 * the same UX; the dynamic-profile-with-background-image concept doesn't
 * apply). Per-pane decorations on cmux should be expressed through the
 * `BadgeColors` capability and operator-side cmux themes, not through
 * dynamic profiles.
 */

export interface PaneProfileSpec {
  paneName: string;
  backgroundImage?: string;
  blend?: number;
  mode?: number;
  badgeColor?: { r: number; g: number; b: number; a?: number };
}

export interface ProfilesCapability {
  /**
   * Write a pane profile to disk and return the profile name for use with
   * setProfile / splitPaneWithProfile / splitSessionWithProfile.
   */
  writePane(profile: PaneProfileSpec): string;

  /**
   * Write the empty/default pane profile and return its name. Used when
   * a pane should look default but still go through the dynamic-profile
   * mechanism for consistency with themed siblings.
   */
  writeEmpty(): string;

  /**
   * Apply a named profile to an existing session (iTerm2: OSC 1337
   * SetProfile=).
   */
  setProfile(sessionId: string, profileName: string): Promise<void>;

  /**
   * Split the current pane using a named profile. Returns the new session
   * ID. The current pane is implicit (uses iTerm2's "current session of
   * current tab").
   */
  splitPaneWithProfile(
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string>;

  /**
   * Split a specific session using a named profile. Returns the new session
   * ID.
   */
  splitSessionWithProfile(
    sessionId: string,
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string>;
}
