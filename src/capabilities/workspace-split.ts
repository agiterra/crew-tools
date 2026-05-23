/**
 * WorkspaceSplit capability — split the caller's surface in-place to create
 * a sibling pane in the caller's workspace. Used by spawn flows that want a
 * new agent to land next to the caller's surface rather than in a fresh tab.
 *
 * cmux registers this via `cmux new-split`. iTerm2 does not (agents are
 * launched into detached screen sessions and attached separately, which has
 * no notion of "split from caller's session").
 */
export interface WorkspaceSplitCapability {
  /**
   * Split the caller's surface and return the new surface's ref. Returns
   * null if the caller's surface can't be resolved or the split fails —
   * the caller treats null as "best-effort failed; agent stays headless."
   */
  splitFromCaller(
    callerSurfaceId: string,
    direction: "right" | "down",
  ): Promise<string | null>;
}
