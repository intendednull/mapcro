// The bridge powerups' buffs (replay tier, spec §6b): their names, what they give, and their
// minimap look, all from the game's files (exploration round 7). Pure.

export interface BuffInfo {
  /** The game's name: citadel_main_english.txt `<buff>_powerup_pickup` ("Gun"). */
  name: string;
  /** What it gives: misc.vdata `<buff>_powerup_pickup.m_sModifer.m_vecModifierValues`, short. */
  gives: string;
  /** The pack image (map/pack.ts IMAGE_BLOBS): hud_minimap.vcss `.map_button.powerup_<class>`. */
  img: string;
  /** That class's `wash-color`. */
  wash: string;
}

/**
 * - gun: `.powerup_gun`, powerup_weapon.vsvg, #FFCC80; MODIFIER_VALUE_FIRE_RATE and
 *   AMMO_CLIP_SIZE_PERCENT.
 * - survival: `.powerup_survival`, powerup_health.vsvg, #D7FF9A; HEALTH_MAX and
 *   HEALTH_REGEN_PER_SECOND.
 * - casting: `.powerup_casting`, powerup_magic.vsvg, #E1A6FF; TECH_POWER (spirit) and
 *   COOLDOWN_REDUCTION_PERCENTAGE.
 * - movement: `.powerup_movement`, powerup_movement.vsvg, #99FFDD; STAMINA, SPRINT_SPEED_BONUS,
 *   ZIP_LINE_SPEED_PERCENTAGE and STAMINA_REGEN_PER_SECOND_PERCENTAGE.
 * The values grow with the match (m_valueMin at 5 min to m_valueMax at 40); they're left out.
 */
export const BUFFS: Record<string, BuffInfo> = {
  gun: { name: "Gun", gives: "+fire rate, +ammo", img: "powerup-gun", wash: "#FFCC80" },
  survival: { name: "Survival", gives: "+health, +regen", img: "powerup-survival", wash: "#D7FF9A" },
  casting: { name: "Casting", gives: "+spirit, +cooldowns", img: "powerup-casting", wash: "#E1A6FF" },
  movement: { name: "Movement", gives: "+stamina, +speed", img: "powerup-movement", wash: "#99FFDD" },
};

export const buffInfo = (b: string | null | undefined): BuffInfo | undefined => (b ? BUFFS[b] : undefined);

/** "Gun buff (+fire rate, +ammo)"; a buff we don't know by its own name. */
export function buffLabel(b: string | null | undefined): string | undefined {
  if (!b) return undefined;
  const i = buffInfo(b);
  return i ? `${i.name} buff (${i.gives})` : `${b} buff`;
}
