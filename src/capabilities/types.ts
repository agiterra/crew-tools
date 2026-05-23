/**
 * Capability registry — typed map of optional terminal features.
 *
 * Each capability is an interface in this folder (or a sibling folder like
 * `cmux-only/`) describing a named cluster of operations that some backends
 * implement and others don't. Backends register the capabilities they
 * implement; callers query via `terminal.capability("name")` and get back
 * either an implementation or `null`.
 *
 * Principle: **absence beats degraded behavior when the fallback changes
 * user-visible state.** A capability advertises the semantic operation, not
 * a clever approximation. Callers that want a fallback write
 * `capability("X")?.op(...) ?? core.fallbackOp(...)` so the product decision
 * is visible at the call site, not hidden in the backend.
 *
 * See `docs` or [[plan-terminal-capabilities-split]] (Fondant vault) for the
 * design rationale and the cmux/iterm migration plan.
 */

import type { NotificationsCapability } from "./notifications.js";

/**
 * The canonical registry of capability names → implementation types.
 *
 * Adding a new capability:
 *  1. Define its interface in `src/capabilities/<name>.ts`.
 *  2. Add the mapping here: `"<name>": <Name>Capability`.
 *  3. Implement it in backends that have native support
 *     (`src/cmux/capabilities/<name>.ts`, `src/iterm/capabilities/<name>.ts`).
 *  4. Register the implementation via the backend's `registerCapabilities()`.
 */
export interface CapabilityMap {
  notifications: NotificationsCapability;
}

/**
 * Internal capability registry used by backend implementations to map names
 * to instances. Not exported — backends compose this via `registerCapabilities`.
 */
export type CapabilityRegistry = {
  [K in keyof CapabilityMap]?: CapabilityMap[K];
};
