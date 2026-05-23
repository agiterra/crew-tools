/**
 * cmux Profiles capability — wraps cmux's surface.set_background RPC.
 *
 * cmux has no on-disk dynamic-profile concept like iTerm2; instead it
 * accepts per-surface background images via RPC. The capability emulates
 * the "write profile, then apply by name" shape by maintaining an
 * in-memory map from synthetic profile names to PaneProfileSpec objects.
 * setProfile / split-with-profile look up the spec by name and fire the RPC.
 *
 * Constructor-injected with the backend operations the capability needs
 * (splitPane / splitSession base ops + an applyToSurface callback that
 * does the PTY-wait + RPC dance).
 */

import type {
  PaneProfileSpec,
  ProfilesCapability,
} from "../capabilities/profiles.js";

export interface CmuxProfilesDeps {
  splitPane: (direction: "horizontal" | "vertical") => Promise<string>;
  splitSession: (
    sessionId: string,
    direction: "horizontal" | "vertical",
  ) => Promise<string>;
  /**
   * Apply a PaneProfileSpec's background to a session via cmux RPC.
   * Implementations should wait for PTY + log+swallow failures.
   * Called when no profile is present in the map, the cap silently no-ops.
   */
  applyToSurface: (sessionId: string, profile: PaneProfileSpec) => Promise<void>;
}

export class CmuxProfiles implements ProfilesCapability {
  private readonly profileStore = new Map<string, PaneProfileSpec>();
  private profileSeq = 0;

  constructor(private readonly deps: CmuxProfilesDeps) {}

  writePane(profile: PaneProfileSpec): string {
    const name = `cmux-profile-${this.profileSeq++}-${profile.paneName}`;
    this.profileStore.set(name, profile);
    return name;
  }

  writeEmpty(): string {
    // Empty profile means "no background" — represented as a name with no
    // entry in the store, so setProfile lookup misses and no-ops.
    return "cmux-empty";
  }

  async setProfile(sessionId: string, profileName: string): Promise<void> {
    const profile = this.profileStore.get(profileName);
    if (!profile) return;
    await this.deps.applyToSurface(sessionId, profile);
  }

  async splitPaneWithProfile(
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    const sessionId = await this.deps.splitPane(direction);
    await this.setProfile(sessionId, profileName);
    return sessionId;
  }

  async splitSessionWithProfile(
    sessionId: string,
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    const newSessionId = await this.deps.splitSession(sessionId, direction);
    await this.setProfile(newSessionId, profileName);
    return newSessionId;
  }
}
