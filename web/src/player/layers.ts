// The open panels a follower mirrors (spec §8 "Follow mode"), as presence carries them: roster
// slots and deaths. The map layers are registry keys now (player/viewstate.ts). Pure.

import type { SlotRef } from "../gen/SlotRef";
import type { DeathRef } from "../gen/DeathRef";
import { slotKey } from "../match/save";

const wireTeam = (team: string) => (team === "amber" || team === "Amber" ? "Amber" : "Sapphire");

/** A roster slot key ("amber-0", match/save.ts `slotKey`) and presence's `SlotRef`. */
export const slotToWire = (key: string): SlotRef | undefined => {
  const m = /^(amber|sapphire)-(\d+)$/.exec(key);
  return m ? { team: wireTeam(m[1]!), slot: Number(m[2]) } : undefined;
};
export const slotFromWire = (s: SlotRef | null | undefined): string | undefined => (s ? slotKey(s.team, s.slot) : undefined);

/** A death: its slot key and match second (a skull's `SkullDeath`, an events row's death). */
export interface Death {
  slot: string;
  t: number;
}
export const deathToWire = (d: Death | undefined): DeathRef | undefined => {
  const s = d && slotToWire(d.slot);
  return s && { ...s, t: Math.max(0, Math.round(d.t)) };
};
export const deathFromWire = (d: DeathRef | null | undefined): Death | undefined => (d ? { slot: slotKey(d.team, d.slot), t: d.t } : undefined);
export const deathKey = (d: Death | undefined) => (d ? `${d.slot}@${d.t}` : "");
