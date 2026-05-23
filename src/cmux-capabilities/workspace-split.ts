/**
 * cmux WorkspaceSplit capability — wraps `cmux new-split`. Constructor-
 * injected with a CLI invoker and a surface resolver (for strict pre-check
 * to avoid orphan surfaces in the focused workspace when the caller's ref
 * is stale).
 */

import type { WorkspaceSplitCapability } from "../capabilities/workspace-split.js";

export type CmuxCli = (...args: string[]) => Promise<string>;
export type SurfaceResolver = (
  input: string,
) => Promise<{ ref: string; ws: string | null; id: string | null } | null>;

export class CmuxWorkspaceSplit implements WorkspaceSplitCapability {
  constructor(
    private readonly cli: CmuxCli,
    private readonly resolveSurface: SurfaceResolver,
  ) {}

  async splitFromCaller(
    callerSurfaceId: string,
    direction: "right" | "down",
  ): Promise<string | null> {
    // Strict resolve: placement next to caller only makes sense if caller's
    // surface actually exists. Unlike per-surface ops on possibly-stale refs
    // (which surfaceArgs lets through so cmux returns "Surface not found"),
    // cmux new-split silently ignores an unknown --surface and creates an
    // orphan surface in the focused workspace. Fail fast instead.
    const resolved = await this.resolveSurface(callerSurfaceId);
    if (!resolved) return null;
    try {
      const cmuxDir = direction === "right" ? "right" : "down";
      const args = resolved.ws
        ? ["--surface", resolved.ref, "--workspace", resolved.ws]
        : ["--surface", resolved.ref];
      const output = await this.cli("new-split", cmuxDir, ...args);
      const match = output.match(/surface:\d+/);
      return match ? match[0] : null;
    } catch {
      return null;
    }
  }
}
