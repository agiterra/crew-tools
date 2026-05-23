/**
 * WorkspaceControl capability — operations that manipulate the
 * workspace/tab container surrounding a session.
 *
 * cmux registers this with its native workspace API. iTerm2 does not
 * (iTerm2 tab naming is limited; callers branch on absence).
 */
export interface WorkspaceControlCapability {
  /** Rename the workspace containing the given session. */
  rename(sessionId: string, name: string): Promise<void>;
}
