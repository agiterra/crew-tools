/**
 * iTerm2 Profiles capability — wraps the dynamic-profile lifecycle: writing
 * pane profile JSON to disk, applying a profile via OSC 1337, and creating
 * panes seeded with a named profile.
 *
 * The transport surface is pure iterm.ts module functions (osascript +
 * filesystem writes). Constructor-injected with the iterm module so the
 * capability is unit-testable in isolation: mock the module, run
 * writePane(), assert what got written.
 */

import type {
  PaneProfileSpec,
  ProfilesCapability,
} from "../capabilities/profiles.js";

export interface ItermProfilesDeps {
  writePaneProfile: (
    paneName: string,
    backgroundImage: string,
    opts: {
      blend?: number;
      mode?: number;
      badgeColor?: { r: number; g: number; b: number; a?: number };
    },
  ) => string;
  writeEmptyPaneProfile: () => void;
  writeEscapeToSession: (sessionId: string, escape: string) => Promise<void>;
  splitPaneWithProfile: (
    direction: "horizontal" | "vertical",
    profileName: string,
  ) => Promise<string>;
  splitSessionWithProfile: (
    sessionId: string,
    direction: "horizontal" | "vertical",
    profileName: string,
  ) => Promise<string>;
}

export class ItermProfiles implements ProfilesCapability {
  constructor(private readonly deps: ItermProfilesDeps) {}

  writePane(profile: PaneProfileSpec): string {
    if (!profile.backgroundImage) {
      this.deps.writeEmptyPaneProfile();
      return "Crew Empty Pane";
    }
    return this.deps.writePaneProfile(profile.paneName, profile.backgroundImage, {
      blend: profile.blend,
      mode: profile.mode,
      badgeColor: profile.badgeColor,
    });
  }

  writeEmpty(): string {
    this.deps.writeEmptyPaneProfile();
    return "Crew Empty Pane";
  }

  async setProfile(sessionId: string, profileName: string): Promise<void> {
    // OSC 1337 SetProfile= switches the session to a named (dynamic) profile.
    await this.deps.writeEscapeToSession(
      sessionId,
      `\x1b]1337;SetProfile=${profileName}\x07`,
    );
  }

  splitPaneWithProfile(
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    return this.deps.splitPaneWithProfile(direction, profileName);
  }

  splitSessionWithProfile(
    sessionId: string,
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    return this.deps.splitSessionWithProfile(sessionId, direction, profileName);
  }
}
