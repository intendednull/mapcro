import type { MatchEvent, Timeline } from "../match/timeline";

/** Death rows are sampled on integer seconds; lethal hits use deciseconds. */
export function recapFor(timeline: Timeline, event: MatchEvent) {
  if (event.kind !== "death") return undefined;
  const player = timeline.players.find(p => p.team === event.team && p.slot === event.slot);
  return player?.recaps?.find(r => Math.ceil(r.t / 10) === event.t);
}
export const CC_LABELS: Record<number, string> = {
  13: "Immobilized", 14: "Disarmed", 15: "Muted", 17: "Silenced", 20: "Stunned",
  59: "Dash disabled", 68: "Shooting disabled", 81: "Asleep", 129: "Cubed",
};
