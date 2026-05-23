/**
 * cmux WorkspaceControl capability — wraps `cmux rename-workspace`.
 * Constructor-injected with a CLI invoker and a JSON-returning CLI invoker
 * for tree introspection (used to map sessionId → workspace ref).
 */

import type { WorkspaceControlCapability } from "../capabilities/workspace-control.js";

export type CmuxCli = (...args: string[]) => Promise<string>;
export type CmuxJsonCli = (...args: string[]) => Promise<any>;

export class CmuxWorkspaceControl implements WorkspaceControlCapability {
  constructor(
    private readonly cli: CmuxCli,
    private readonly jsonCli: CmuxJsonCli,
  ) {}

  async rename(sessionId: string, name: string): Promise<void> {
    try {
      // Find which workspace this surface belongs to.
      const tree = await this.jsonCli("tree");
      for (const win of tree.windows ?? []) {
        for (const ws of win.workspaces ?? []) {
          for (const pane of ws.panes ?? []) {
            for (const surface of pane.surfaces ?? []) {
              if (surface.ref === sessionId) {
                await this.cli("rename-workspace", "--workspace", ws.ref, name);
                return;
              }
            }
          }
        }
      }
    } catch {
      // Non-fatal — rename is decorative.
    }
  }
}
