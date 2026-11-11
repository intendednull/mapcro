import type { MatchEvent, Timeline, TimelinePlayer } from "../match/timeline";

/** Death rows are sampled on integer seconds; lethal hits use deciseconds. */
export function recapFor(timeline: Timeline, event: MatchEvent) {
  if (event.kind !== "death") return undefined;
  return recapOf(timeline.players.find(p => p.team === event.team && p.slot === event.slot), event.t);
}

/** A player's recap of the death at second `death` (its `deaths` entry, a skull's `t`). */
export function recapOf(player: Pick<TimelinePlayer, "recaps"> | undefined, death: number) {
  return player?.recaps?.find(r => Math.ceil(r.t / 10) === death);
}
export const CC_LABELS: Record<number, string> = {
  13: "Immobilized", 14: "Disarmed", 15: "Muted", 17: "Silenced", 20: "Stunned",
  59: "Dash disabled", 68: "Shooting disabled", 81: "Asleep", 129: "Cubed",
};
