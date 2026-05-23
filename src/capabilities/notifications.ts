/**
 * Notifications capability — attention-getting operations that surface
 * events to the operator outside the pane content itself.
 *
 * Backends that register this capability MUST have a real native
 * implementation. cmux fires native OS notifications and tab-ring flashes;
 * iTerm2 uses OSC 9 (macOS notification banner) for `notify` and OSC 1337
 * RequestAttention (dock bounce) for `flash`. A backend that can only
 * approximate via `setBadge` should NOT register this capability — leave
 * it absent and let the caller decide whether to fall back.
 */
export interface NotificationsCapability {
  /**
   * Send a rich notification tied to a session. The operator typically sees
   * this as an OS-level banner (cmux: native; iTerm2: OSC 9 → macOS).
   *
   * Returns void; never throws on transient backend errors — notifications
   * are decorative. Hard failures (auth, plugin gone) should bubble up.
   */
  notify(sessionId: string, title: string, body?: string): Promise<void>;

  /**
   * Flash / request attention on the tab containing this session. cmux
   * triggers the tab notification ring; iTerm2 bounces the dock icon.
   */
  flash(sessionId: string): Promise<void>;
}
