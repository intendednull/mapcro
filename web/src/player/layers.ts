// The map layers a follower mirrors (spec §8 "Follow mode"): every "Map layers" toggle but
// Player names, which stays each browser's own (it's for recording without them). Presence
// carries them as one byte, `Presence.layers` (crates/engine/src/wire.rs `LAYER_*`). Pure.

import type { SlotRef } from "../gen/SlotRef";
import type { DeathRef } from "../gen/DeathRef";
import { slotKey } from "../match/save";

export interface MapLayers {
  troopers: boolean;
  health: boolean;
  pings: boolean;
  cc: boolean;
  movement: boolean;
  heals: boolean;
  crates: boolean;
}

/** Bit order: wire.rs `LAYER_TROOPERS` (bit 0) to `LAYER_CRATES` (bit 6). Append only. */
const BITS: readonly (keyof MapLayers)[] = ["troopers", "health", "pings", "cc", "movement", "heals", "crates"];

export function layersToWire(l: MapLayers): number {
  return BITS.reduce((n, k, i) => (l[k] ? n | (1 << i) : n), 0);
}

/** A presenter's layers; absent (an older presenter): `undefined`, and the follower keeps its own. */
export function layersFromWire(n: number | null | undefined): MapLayers | undefined {
  if (n == null) return undefined;
  return Object.fromEntries(BITS.map((k, i) => [k, (n & (1 << i)) !== 0])) as unknown as MapLayers;
}

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
