// The open panels a follower mirrors (spec §8 "Follow mode"), as presence carries them: roster
// slots and deaths. The map layers are registry keys now (player/viewstate.ts). Pure.

import type { SlotRef } from "../gen/SlotRef";
import type { DeathRef } from "../gen/DeathRef";
import type { HeroPanel } from "../gen/HeroPanel";
import type { PanelPlace } from "../gen/PanelPlace";
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

/** Where a panel sits in the board pane (wire.rs `PanelPlace`; player/panelPlace.ts): from the
 * pane's nearer edge on each axis, in `PLACE_SCALE`ths of its width and height. */
export interface Place {
  x: number;
  y: number;
  right: boolean;
  bottom: boolean;
}
/** wire.rs `PLACE_SCALE`. */
export const PLACE_SCALE = 10_000;
const unit = (n: unknown): number | undefined => (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= PLACE_SCALE ? n : undefined);
/** A place as presence carries it (the edges left out when left and top). */
export const placeToWire = (p: Place | undefined): PanelPlace | undefined => {
  if (!p) return undefined;
  const x = unit(Math.round(p.x));
  const y = unit(Math.round(p.y));
  if (x === undefined || y === undefined) return undefined;
  return { x, y, ...(p.right ? { right: true } : {}), ...(p.bottom ? { bottom: true } : {}) };
};
/** A place presence carried; anything that isn't one (a newer client's) is none. */
export const placeFromWire = (w: unknown): Place | undefined => {
  if (!w || typeof w !== "object") return undefined;
  const o = w as Record<string, unknown>;
  const x = unit(o.x);
  const y = unit(o.y);
  return x === undefined || y === undefined ? undefined : { x, y, right: o.right === true, bottom: o.bottom === true };
};

/** A hero panel open from the map (#37): its slot key, and where it was put (none: where it
 * opened). */
export interface HeroPanelOpen {
  slot: string;
  at?: Place | undefined;
}
/** The open hero panels as presence carries them, within wire.rs `is_valid`'s bounds: back to
 * front, each slot once (its first), slots under `MAX_SLOT`, at most `max` (the front ones). */
export const heroPanelsToWire = (list: HeroPanelOpen[], max: number): HeroPanel[] => {
  const out: HeroPanel[] = [];
  for (const h of list) {
    const s = slotToWire(h.slot);
    if (!s || s.slot >= MAX_SLOT || out.some((o) => o.team === s.team && o.slot === s.slot)) continue;
    const at = placeToWire(h.at);
    out.push(at ? { ...s, at } : s);
  }
  return out.slice(-max);
};
/** The open hero panels presence carried; what isn't one is left out. Not a list (left out by
 * an older client): none, and the store treats it as nothing heard (viewstate.ts). */
export const heroPanelsFromWire = (w: unknown, max: number): HeroPanelOpen[] => {
  if (!Array.isArray(w)) return [];
  const out: HeroPanelOpen[] = [];
  for (const h of w as unknown[]) {
    if (!h || typeof h !== "object") continue;
    const o = h as Record<string, unknown>;
    if ((o.team !== "Amber" && o.team !== "Sapphire") || typeof o.slot !== "number" || !Number.isInteger(o.slot) || o.slot < 0 || o.slot >= MAX_SLOT) continue;
    const slot = slotKey(o.team, o.slot);
    if (out.some((x) => x.slot === slot)) continue;
    const at = placeFromWire(o.at);
    out.push(at ? { slot, at } : { slot });
  }
  return out.slice(-max);
};
/** wire.rs `MAX_SLOT`. */
const MAX_SLOT = 16;
