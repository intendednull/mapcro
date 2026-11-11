import type { BuildRecord } from "../map/pack";
import type { MatchEvent, Timeline, TimelinePlayer } from "../match/timeline";

/** Death rows are sampled on integer seconds; lethal hits use deciseconds. */
export function recapFor(timeline: Timeline, event: MatchEvent) {
  if (event.kind !== "death") return undefined;
  return recapOf(timeline.players.find(p => p.team === event.team && p.slot === event.slot), event.t);
}

/** How long before a sampled death its lethal hit can be: deaths are read once a second, so the
 * hit is up to a second (and a tick) earlier (129738985: a hit at 520.0 s, its death at 521). A
 * hero can't die twice in that span. */
const DEATH_LAG_S = 1.5;

/** A player's recap of the death at second `death` (its `deaths` entry, a skull's `t`): the
 * latest lethal hit in the second and a half up to it. */
export function recapOf(player: Pick<TimelinePlayer, "recaps"> | undefined, death: number) {
  let best: NonNullable<TimelinePlayer["recaps"]>[number] | undefined;
  for (const r of player?.recaps ?? []) if (r.t / 10 <= death && r.t / 10 > death - DEATH_LAG_S && (!best || r.t > best.t)) best = r;
  return best;
}
export const CC_LABELS: Record<number, string> = {
  13: "Immobilized", 14: "Disarmed", 15: "Muted", 17: "Silenced", 20: "Stunned",
  59: "Dash disabled", 68: "Shooting disabled", 81: "Asleep", 129: "Cubed",
};

/** A recap row's `src` past the heroes: `NPC_SRC + kind`, the attacker's class from message 300
 * (crates/replay timeline.rs `NPC_SRC`, `NPC_KINDS`). 255: not a hero, kind not known. */
export const NPC_SRC = 256;
/** The game's names for each kind (citadel_main: `Citadel_AttackerClass_CLASS_TROOPER*`,
 * `Citadel_Hud_KillFeed*` Guardian, Walker, Base Guardians, Sentry Turret; `Objective_MidBoss`;
 * `Citadel_AttackerClass_CLASS_BOSS_TIER_3` The Patron; `_CLASS_TROOPER_NEUTRAL` Haunt;
 * `neutral_sinners`), in the order of crates/replay timeline.rs `NPC_KINDS`. */
export const NPC_KINDS = ["Trooper", "Medic Trooper", "Melee Trooper", "Guardian", "Walker", "Base Guardians", "The Patron", "Mid-Boss", "Haunt", "Sinner's Sacrifice", "Sentry Turret"] as const;

/** Who a recap row's damage came from: a hero by name, an NPC by the game's name for its class,
 * else "World / other". */
export function recapSource(src: number, timeline: Pick<Timeline, "players">, heroName: (id: number) => string | undefined): string {
  const player = src < NPC_SRC ? timeline.players[src] : undefined;
  if (player) return heroName(player.hero_id) ?? "Hero";
  return NPC_KINDS[src - NPC_SRC] ?? "World / other";
}

/** A recap row's ability as a tag: its name; an engine-internal one (no localised name, e.g.
 * "citadel_weapon_bull_set") its parent's, else "Weapon" or "Ability"; none (a trooper's shot,
 * a hit with no ability) nothing for an NPC, "Other damage" otherwise. */
export function recapAbility(id: number, record: (id: number) => BuildRecord | undefined, npc: boolean): string | undefined {
  if (!id) return npc ? undefined : "Other damage";
  const r = record(id);
  if (!r) return "Unknown ability";
  if (r.label_from !== "internal") return r.label;
  const parent = r.ability ? record(r.ability) : undefined;
  if (parent && parent.label_from !== "internal") return parent.label;
  return /weapon|gun|shoot|bullet/i.test(r.name) ? "Weapon" : /melee/i.test(r.name) ? "Melee" : "Ability";
}
