/**
 * Per-lane output dir (LANE_OUT).
 *
 * Host lanes on one machine run as ONE uid (`_ephemeral`) and share one HOME. Briefs told
 * every lane to write its HANDOFF and RESULT files to `~/out`, so two lanes replaced each
 * other's files: 2026-11-14 23:11Z eng-4600-5805-trial wrote `~/out/HANDOFF.md` over the
 * file of eng-4608-5849-seller7, which then committed the wrong HANDOFF (Baguette 892838).
 *
 * The spawn exports `LANE_OUT=$HOME/lanes/<agent-id>/out` and creates it mode 700, so a
 * brief can say "write to $LANE_OUT" and each lane has its own path. A caller- or
 * .env-provided LANE_OUT wins (same precedence as CLAUDE_CONFIG_DIR).
 *
 * LIMIT: this stops lanes replacing each other's files. It does NOT stop one lane reading
 * another's: they share a uid, so mode 700 does not separate them. Only a uid per lane does.
 */
export function buildLaneOutSetup(agentId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId)) {
    throw new Error(`buildLaneOutSetup: unsafe agent id '${agentId}'`);
  }
  return (
    `if [ -z "\${LANE_OUT:-}" ]; then export LANE_OUT="$HOME/lanes/${agentId}/out"; fi; ` +
    `mkdir -p -m 700 "$LANE_OUT" || { echo "[crew] cannot create LANE_OUT $LANE_OUT" >&2; exit 95; }`
  );
}
