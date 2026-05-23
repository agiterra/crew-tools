/**
 * iTerm2 backend — wraps iterm.ts functions into the TerminalBackend interface.
 */

import type { TerminalBackend, PaneProfile } from "./terminal.js";
import type { CapabilityMap, CapabilityRegistry } from "./capabilities/types.js";
import * as iterm from "./iterm.js";
import { ItermNotifications } from "./iterm-capabilities/notifications.js";

export class ItermBackend implements TerminalBackend {
  readonly name = "iterm" as const;

  private readonly _capabilities: CapabilityRegistry = {
    notifications: new ItermNotifications(iterm.writeEscapeToSession),
  };

  capability<K extends keyof CapabilityMap>(name: K): CapabilityMap[K] | null {
    return (this._capabilities[name] as CapabilityMap[K] | undefined) ?? null;
  }

  currentSessionId(): Promise<string> {
    return iterm.currentSessionId();
  }

  async currentTabId(): Promise<string | null> {
    // iTerm2 tabs are not first-class — the closest stable identifier for
    // "the tab the operator is looking at" is the id of the first session
    // in the current tab, which matches what we store in
    // tabs.iterm_session_id at crew tab creation time.
    try {
      return await iterm.currentTabFirstSessionId();
    } catch {
      return null;
    }
  }

  sessionIdForTty(ttyName: string): Promise<string | null> {
    return iterm.sessionIdForTty(ttyName);
  }

  splitPane(direction: "horizontal" | "vertical"): Promise<string> {
    return iterm.splitPane(direction);
  }

  splitSession(
    sessionId: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    return iterm.splitSession(sessionId, direction);
  }

  writeToSession(sessionId: string, text: string): Promise<void> {
    return iterm.writeToSession(sessionId, text);
  }

  attachScreen(
    sessionId: string,
    screenName: string,
    mode: "r" | "x" = "r",
  ): Promise<void> {
    // AppleScript's `write text` auto-appends a newline, so the attach
    // command commits without an explicit trailing \n.
    return iterm.writeToSession(sessionId, `screen -${mode} ${screenName}`);
  }

  closeSession(sessionId: string): Promise<void> {
    return iterm.closeSession(sessionId);
  }

  isSessionAlive(sessionId: string): Promise<boolean> {
    return iterm.isSessionAlive(sessionId);
  }

  createTab(profileName?: string): Promise<string> {
    return iterm.createItermTab(profileName);
  }

  setSessionName(sessionId: string, name: string): Promise<void> {
    return iterm.setSessionName(sessionId, name);
  }

  setBadge(sessionId: string, text: string): Promise<void> {
    return iterm.setBadge(sessionId, text);
  }

  writePaneProfile(profile: PaneProfile): string {
    if (!profile.backgroundImage) {
      iterm.writeEmptyPaneProfile();
      return "Crew Empty Pane";
    }
    return iterm.writePaneProfile(profile.paneName, profile.backgroundImage, {
      blend: profile.blend,
      mode: profile.mode,
      badgeColor: profile.badgeColor,
    });
  }

  writeEmptyPaneProfile(): string {
    iterm.writeEmptyPaneProfile();
    return "Crew Empty Pane";
  }

  async setProfile(sessionId: string, profileName: string): Promise<void> {
    // OSC 1337 SetProfile= switches the session to a named (dynamic) profile.
    await iterm.writeEscapeToSession(sessionId, `\x1b]1337;SetProfile=${profileName}\x07`);
  }

  splitPaneWithProfile(
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    return iterm.splitPaneWithProfile(direction, profileName);
  }

  splitSessionWithProfile(
    sessionId: string,
    direction: "horizontal" | "vertical",
    profileName: string,
  ): Promise<string> {
    return iterm.splitSessionWithProfile(sessionId, direction, profileName);
  }

  /**
   * @deprecated Phase 1 shim. Use `capability("notifications")?.flash(sessionId)`.
   * Removed in v3.0.0.
   */
  async flashSession(sessionId: string): Promise<void> {
    await this.capability("notifications")?.flash(sessionId);
  }

  /**
   * @deprecated Phase 1 shim. Use `capability("notifications")?.notify(...)`.
   * Removed in v3.0.0.
   */
  async notifySession(sessionId: string, title: string, body?: string): Promise<void> {
    await this.capability("notifications")?.notify(sessionId, title, body);
  }

  async renameWorkspace(_sessionId: string, _name: string): Promise<void> {
    // iTerm2 tab naming is limited — see setTabName
  }

  splitWebBrowser(
    url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    return iterm.splitWebBrowser(url, direction);
  }

  splitSessionWebBrowser(
    sessionId: string,
    url: string,
    direction: "horizontal" | "vertical",
  ): Promise<string> {
    return iterm.splitSessionWebBrowser(sessionId, url, direction);
  }
}
