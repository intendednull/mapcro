// A single compact hard-CC label. State indices come from crates/replay/src/timeline.rs
// CC_STATES: pawn-mask truth, independent of uncertain source attribution.
import type { TimelinePlayer } from "../match/timeline";

export type CrowdControl = "Stunned" | "Silenced" | "Disarmed";
const STATES: ReadonlyArray<readonly [number, CrowdControl]> = [[20, "Stunned"], [17, "Silenced"], [14, "Disarmed"]];

/** Half-open decisecond intervals, queried at playback time. No retained or inferred state. */
export function crowdControlAt(p: Pick<TimelinePlayer, "cc">, t: number): CrowdControl | undefined {
  const ds = t * 10;
  for (const [state, label] of STATES)
    if (p.cc?.some(([from, to, active]) => active === state && from <= ds && ds < to)) return label;
  return undefined;
}
