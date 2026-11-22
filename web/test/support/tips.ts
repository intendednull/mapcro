// A marker's hover from a `MatchPreview` fixture, for the tests of what the hover says: the frame's
// facts for that marker (player/Camps.tsx `tipFacts` reads them from `MapState`).

import type { Marker } from "../../src/map/model";
import type { MatchPreview } from "./player-frame";
import { type TipFacts, markerTip } from "../../src/player/Camps";

export const factsOf = (pv: MatchPreview, key: string): TipFacts => ({
  down: pv.down.has(key), camp: pv.camps.get(key), health: pv.health?.get(key)?.pct, rift: pv.rifts?.get(key), powerup: pv.powerups?.get(key), urn: pv.urn,
});

/** What the marker says over `pv`; `undefined`: a frame that holds nothing (a scene). */
export const tipOf = (m: Pick<Marker, "key" | "kind">, pv: MatchPreview | undefined, t: number) => markerTip(m, pv ? factsOf(pv, m.key) : { down: false }, t);
