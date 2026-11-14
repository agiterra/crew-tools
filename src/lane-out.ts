/**
 * Per-lane output dir (LANE_OUT).
 *
 * Host lanes on one machine run as ONE uid (`_ephemeral`) and share one HOME. Briefs told
 * every lane to write its HANDOFF and RESULT files to `~/out`, so two lanes replaced each
 * other's files: 2026-11-14 23:11Z eng-4600-5805-trial wrote `~/out/HANDOFF.md` over the
 * file of eng-4608-5849-seller7, which then committed the wrong HANDOFF (Baguette 892838).
 *
 * The spawn exports `LANE_OUT=$HOME/lanes/<agent-id>/out` so a brief can say "write to
 * $LANE_OUT" and each lane has its own path. A caller- or .env-provided LANE_OUT wins (same
 * precedence as CLAUDE_CONFIG_DIR).
 *
 * The dir is group `agiterra` (LANE_OUT_GROUP overrides), mode 2770: the EM seat (uid
 * baguette, in agiterra) reads every HANDOFF/RESULT/FV file by path, so mode 700 under the
 * lane uid would lock it out (Baguette 892858). setgid keeps new files in the group; the lane
 * umask (022) makes them group-readable. A failed chgrp warns and falls back to mode 700 (macOS refuses
 * setgid on a dir whose group the caller is not in): a host without the group (a pod) still
 * gets a private per-lane path.
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
    `mkdir -p "$LANE_OUT" || { echo "[crew] cannot create LANE_OUT $LANE_OUT" >&2; exit 95; }; ` +
    `if chgrp "\${LANE_OUT_GROUP:-agiterra}" "$LANE_OUT" 2>/dev/null; then _lo_mode=2770; else ` +
    `echo "[crew] LANE_OUT $LANE_OUT: chgrp \${LANE_OUT_GROUP:-agiterra} failed; mode 700, only the lane uid can read it" >&2; _lo_mode=700; fi; ` +
    `chmod "$_lo_mode" "$LANE_OUT" || { echo "[crew] cannot chmod LANE_OUT $LANE_OUT" >&2; exit 95; }; unset _lo_mode`
  );
}
