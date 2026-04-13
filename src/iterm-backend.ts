/**
 * iTerm2 backend — wraps iterm.ts functions into the TerminalBackend interface.
 */

import type { TerminalBackend, PaneProfile } from "./terminal.js";
import * as iterm from "./iterm.js";

export class ItermBackend implements TerminalBackend {
  readonly name = "iterm" as const;

  currentSessionId(): Promise<string> {
    return iterm.currentSessionId();
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

  async flashSession(sessionId: string): Promise<void> {
    // Bounce the dock icon via OSC 1337 RequestAttention
    await iterm.writeEscapeToSession(sessionId, "\x1b]1337;RequestAttention=fireworks\x07");
  }

  async notifySession(sessionId: string, title: string, body?: string): Promise<void> {
    // macOS notification banner via OSC 9
    const msg = body ? `${title}: ${body}` : title;
    await iterm.writeEscapeToSession(sessionId, `\x1b]9;${msg}\x07`);
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
