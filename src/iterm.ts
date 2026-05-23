/**
 * iTerm2 AppleScript integration.
 *
 * Controls iTerm2 panes: split, write, close, open URLs.
 * All operations use osascript — no Python API dependency.
 *
 * Web browser panes use iTerm2's built-in browser plugin via dynamic profiles.
 * The profile JSON is written to ~/Library/Application Support/iTerm2/DynamicProfiles/
 * and iTerm2 picks it up automatically.
 */

import { writeFileSync, readFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";

/**
 * Run AppleScript and return trimmed stdout.
 */
async function osascript(script: string): Promise<string> {
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`osascript failed (exit ${exitCode}): ${stderr.trim()}`);
  }
  return stdout.trim();
}

/**
 * Get the iTerm2 session ID of the current (active/focused) session.
 */
export async function currentSessionId(): Promise<string> {
  return osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        return id
      end tell
    end tell
  `);
}

/**
 * Get the iTerm2 session ID for the session owning a specific TTY.
 * More reliable than ITERM_SESSION_ID env var which can go stale.
 */
export async function sessionIdForTty(ttyName: string): Promise<string | null> {
  const devTty = ttyName.startsWith("/dev/") ? ttyName : `/dev/${ttyName}`;
  try {
    const result = await osascript(`
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${devTty}" then
                return id of s
              end if
            end repeat
          end repeat
        end repeat
        return "NOT_FOUND"
      end tell
    `);
    return result === "NOT_FOUND" ? null : result;
  } catch (e) {
    console.error(`[crew] sessionIdForTty failed for ${devTty}:`, e);
    return null;
  }
}

/**
 * Split the current pane. Returns the new session's ID.
 */
export async function splitPane(
  direction: "horizontal" | "vertical",
): Promise<string> {
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        set newSession to split ${verb} with default profile
        tell newSession
          return id
        end tell
      end tell
    end tell
  `);
}

/**
 * Split a specific session. Returns the new session's ID.
 */
export async function splitSession(
  sessionId: string,
  direction: "horizontal" | "vertical",
): Promise<string> {
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s
                set newSession to split ${verb} with default profile
              end tell
              return id of newSession
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `);
}

/**
 * Write text to a specific iTerm2 session.
 */
export async function writeToSession(
  sessionId: string,
  text: string,
): Promise<void> {
  // Escape for AppleScript string
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s to write text "${escaped}"
              return
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `);
}

/**
 * Get the TTY device path for a specific iTerm2 session.
 */
export async function sessionTty(sessionId: string): Promise<string | null> {
  try {
    return await osascript(`
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if id of s is "${sessionId}" then
                return tty of s
              end if
            end repeat
          end repeat
        end repeat
      end tell
    `);
  } catch {
    return null;
  }
}

/**
 * Write an escape sequence directly to a session's TTY.
 * Unlike writeToSession (which types text as input), this writes raw bytes
 * to the terminal device — works even when the session is busy.
 */
export async function writeEscapeToSession(sessionId: string, escape: string): Promise<void> {
  const tty = await sessionTty(sessionId);
  if (!tty) return;
  const { writeFileSync } = await import("fs");
  writeFileSync(tty, escape);
}

/**
 * Close a specific iTerm2 session.
 * Throws if the session is not found or the close fails.
 */
export async function closeSession(sessionId: string): Promise<void> {
  const result = await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              close s
              return "closed"
            end if
          end repeat
        end repeat
      end repeat
      return "not_found"
    end tell
  `);
  if (result === "not_found") {
    throw new Error(`iTerm2 session not found: ${sessionId} — pane may have been closed manually or session ID is stale`);
  }
}

/**
 * Create a new tab in the current window. Returns the session ID.
 * Optionally uses a named profile (for themed backgrounds).
 */
export async function createItermTab(profileName?: string): Promise<string> {
  const profileClause = profileName
    ? `profile "${profileName.replace(/"/g, '\\"')}"`
    : `default profile`;
  return osascript(`
    tell application "iTerm2"
      tell current window
        set newTab to (create tab with ${profileClause})
        tell current session of newTab
          return id
        end tell
      end tell
    end tell
  `);
}

/**
 * Check if a session ID is still alive.
 */
export async function isSessionAlive(sessionId: string): Promise<boolean> {
  try {
    const result = await osascript(`
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if id of s is "${sessionId}" then
                return "alive"
              end if
            end repeat
          end repeat
        end repeat
        return "dead"
      end tell
    `);
    return result === "alive";
  } catch {
    return false;
  }
}

// --- Titles ---

/**
 * Set the name of a specific session (pane title).
 * For this to stick, disable "Allow session to set title" in
 * iTerm2 Preferences → Profiles → Terminal.
 */
export async function setSessionName(sessionId: string, name: string): Promise<void> {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s to set name to "${escaped}"
              return
            end if
          end repeat
        end repeat
      end repeat
    end tell
  `);
}

/**
 * Set the name of the tab containing a specific session.
 *
 * KNOWN LIMITATION: iTerm2 3.6.9 does not expose a writable `name` property
 * on tabs in its AppleScript dictionary. Escape sequences (ESC ] 1) work but
 * require "Allow Title Setting" enabled in the profile, and Claude Code
 * constantly overwrites session titles which derive the tab title.
 * This function is currently a no-op. See agiterra/crew-tools#tab-title.
 */
export async function setTabName(_sessionId: string, _name: string): Promise<void> {
  // No-op — see docstring above.
}

// --- Badges ---

/**
 * Set the iTerm2 badge on a specific session via OSC 1337 SetBadgeFormat.
 * Badges appear in the top-right of the pane.
 *
 * Note: AppleScript-based badge setting does not work — iTerm2's AppleScript
 * interface exposes `badge` and `user.crew_badge` properties but setting
 * them doesn't cause the badge to render. The OSC escape sequence written
 * to the session's TTY is the only reliable method.
 */
export async function setBadge(sessionId: string, text: string): Promise<void> {
  // Find the TTY for this session
  const tty = await osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              return tty of s
            end if
          end repeat
        end repeat
      end repeat
      return "NOT_FOUND"
    end tell
  `);
  if (tty === "NOT_FOUND" || !tty) {
    throw new Error(`iTerm2 session not found: ${sessionId}`);
  }

  // OSC 1337 ; SetBadgeFormat=<base64> BEL
  const b64 = Buffer.from(text).toString("base64");
  const sequence = `\x1b]1337;SetBadgeFormat=${b64}\x07`;
  writeFileSync(tty, sequence);
}

// --- Background Images ---

/**
 * Write a per-pane dynamic profile with a background image.
 * Returns the profile name to use when splitting.
 * Background images MUST be set at pane creation time via the profile —
 * iTerm2 can't change a session's profile after creation.
 *
 * Delete-before-write ensures iTerm2 re-reads the profile when a pane
 * name is recycled (same filename, possibly different content).
 */
export function writePaneProfile(
  paneName: string,
  backgroundImage: string,
  opts?: {
    blend?: number;
    mode?: number;
    badgeColor?: { r: number; g: number; b: number; a?: number };
  },
): string {
  const profileName = `Crew ${paneName}`;
  const guid = `crew-pane-${paneName.toLowerCase().replace(/[^a-z0-9]/g, "-")}`;
  const profileFile = join(DYNAMIC_PROFILES_DIR, `crew-pane-${paneName}.json`);
  mkdirSync(DYNAMIC_PROFILES_DIR, { recursive: true });

  // Delete first to force iTerm2 to re-read (prevents stale cache on name reuse)
  try { unlinkSync(profileFile); } catch {}

  const profileEntry: Record<string, any> = {
    Name: profileName,
    Guid: guid,
    "Custom Command": "Yes",
    Command: "zsh -c 'printf \"\\n  \\033[2m☐ Available — no agent attached\\033[0m\\n\\n\" && exec zsh -l'",
    "Silence Bell": true,
    "Background Image Location": backgroundImage,
    "Blend": opts?.blend ?? 0.5,
    "Background Image Mode": opts?.mode ?? 2,
    // Per-image badge color (from theme.badgeColors[paneName] or defaultBadgeColor)
    // falling back to a neutral warm amber that reads well on most dark backgrounds.
    "Badge Color": {
      "Red Component": opts?.badgeColor?.r ?? 1,
      "Green Component": opts?.badgeColor?.g ?? 0.75,
      "Blue Component": opts?.badgeColor?.b ?? 0.25,
      "Alpha Component": opts?.badgeColor?.a ?? 0.85,
      "Color Space": "sRGB",
    },
  };

  const profile = { Profiles: [profileEntry] };
  writeFileSync(profileFile, JSON.stringify(profile, null, 2));
  return profileName;
}

// --- Dynamic Profiles ---

const DYNAMIC_PROFILES_DIR = join(
  process.env.HOME ?? "/tmp",
  "Library/Application Support/iTerm2/DynamicProfiles",
);
const BROWSER_PROFILE_FILE = join(DYNAMIC_PROFILES_DIR, "crew-web-browser.json");
const BROWSER_PROFILE_NAME = "Pane Web Browser";
const EMPTY_PANE_PROFILE_FILE = join(DYNAMIC_PROFILES_DIR, "crew-empty-pane.json");
const EMPTY_PANE_PROFILE_NAME = "Crew Empty Pane";

/**
 * Write the "Crew Empty Pane" dynamic profile.
 * Optionally includes a background image with blend for readability.
 */
export function writeEmptyPaneProfile(): void {
  mkdirSync(DYNAMIC_PROFILES_DIR, { recursive: true });
  const profile = {
    Name: EMPTY_PANE_PROFILE_NAME,
    Guid: "crew-empty-pane-001",
    "Custom Command": "Yes",
    Command: "zsh -c 'printf \"\\n  \\033[2m☐ Available — no agent attached\\033[0m\\n\\n\" && exec zsh -l'",
    "Silence Bell": true,
  };
  writeFileSync(
    EMPTY_PANE_PROFILE_FILE,
    JSON.stringify({ Profiles: [profile] }, null, 2),
  );
}

/**
 * Re-touch a Crew pane profile file on disk so iTerm2's DynamicProfiles
 * watcher re-reads it. Used when AppleScript split fails with
 * "No profile named ..." — usually a transient iTerm2 watcher miss.
 */
function nudgeCrewProfile(profileName: string): void {
  if (!profileName.startsWith("Crew ")) return;
  const paneName = profileName.slice("Crew ".length);
  const file = join(DYNAMIC_PROFILES_DIR, `crew-pane-${paneName}.json`);
  try {
    const contents = readFileSync(file);
    writeFileSync(file, contents);
  } catch {
    // File missing or unreadable — nothing to nudge.
  }
}

/**
 * Run an iTerm2 AppleScript split. If it fails with "No profile named <X>",
 * re-touch the profile file to nudge iTerm2's watcher and retry up to 3x
 * with exponential backoff (300/600/900ms).
 */
async function splitWithRetry(
  profileName: string,
  runScript: () => Promise<string>,
): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await runScript();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("No profile named")) throw e;
      lastErr = e;
      console.error(
        `[crew] iTerm2 didn't register profile '${profileName}' (attempt ${attempt}/3) — nudging watcher and retrying`,
      );
      nudgeCrewProfile(profileName);
      await new Promise((r) => setTimeout(r, 300 * attempt));
    }
  }
  throw lastErr;
}

/**
 * Split the current pane using a named profile. Returns the new session's ID.
 */
export async function splitPaneWithProfile(
  direction: "horizontal" | "vertical",
  profileName: string,
): Promise<string> {
  const escaped = profileName.replace(/"/g, '\\"');
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return splitWithRetry(profileName, () => osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        set newSession to split ${verb} with profile "${escaped}"
        tell newSession
          return id
        end tell
      end tell
    end tell
  `));
}

/**
 * Split a specific session using a named profile. Returns the new session's ID.
 */
export async function splitSessionWithProfile(
  sessionId: string,
  direction: "horizontal" | "vertical",
  profileName: string,
): Promise<string> {
  const escaped = profileName.replace(/"/g, '\\"');
  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return splitWithRetry(profileName, () => osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s
                set newSession to split ${verb} with profile "${escaped}"
              end tell
              return id of newSession
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `));
}

/**
 * Write a dynamic profile for the web browser pane with the given URL.
 * iTerm2 monitors the DynamicProfiles directory and picks up changes immediately.
 */
function writeBrowserProfile(url: string): void {
  mkdirSync(DYNAMIC_PROFILES_DIR, { recursive: true });
  // Delete first to force iTerm2 to re-read (prevents stale cache)
  try { unlinkSync(BROWSER_PROFILE_FILE); } catch {}
  const profile = {
    Profiles: [
      {
        Name: BROWSER_PROFILE_NAME,
        Guid: "crew-web-browser-001",
        "Custom Command": "Browser",
        "Initial URL": url,
      },
    ],
  };
  writeFileSync(BROWSER_PROFILE_FILE, JSON.stringify(profile, null, 2));
}

/**
 * Split the current pane with an iTerm2 web browser showing the given URL.
 * Returns the new session's ID.
 */
export async function splitWebBrowser(
  url: string,
  direction: "horizontal" | "vertical" = "horizontal",
): Promise<string> {
  // Write the dynamic profile with the target URL
  writeBrowserProfile(url);

  // Small delay for iTerm2 to pick up the profile
  await new Promise((r) => setTimeout(r, 500));

  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      tell current session of current tab of current window
        set newSession to split ${verb} with profile "${BROWSER_PROFILE_NAME}"
        tell newSession
          return id
        end tell
      end tell
    end tell
  `);
}

/**
 * Split a specific session with an iTerm2 web browser.
 */
export async function splitSessionWebBrowser(
  sessionId: string,
  url: string,
  direction: "horizontal" | "vertical" = "horizontal",
): Promise<string> {
  writeBrowserProfile(url);
  await new Promise((r) => setTimeout(r, 500));

  const verb = direction === "horizontal" ? "horizontally" : "vertically";
  return osascript(`
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if id of s is "${sessionId}" then
              tell s
                set newSession to split ${verb} with profile "${BROWSER_PROFILE_NAME}"
              end tell
              return id of newSession
            end if
          end repeat
        end repeat
      end repeat
      error "session not found: ${sessionId}"
    end tell
  `);
}
