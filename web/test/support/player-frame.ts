// The frame as `previewAt` defines it, from Player's clocks (mapstate/state.ts `fromTimeline`):
// what the clocks are checked against (frame-clocks.test.ts). The renderers read `MapState`.

import type { Accessor } from "solid-js";
import { type Shown, previewAt } from "../../src/mapstate/frame";
import { type PlayerState, type StateSource, fromTimeline } from "../../src/mapstate/state";
import type { MatchPreview } from "../../src/match/preview";
import { type PlayerAt, type Timeline, positionAt, respawnAt } from "../../src/match/timeline";

const EMPTY = (): MatchPreview => ({ players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map(), rifts: new Map(), powerups: new Map() });

export interface FrameSource extends StateSource {
  shown: Accessor<Shown>;
  /** Whether this moment continues the last in playback (`MatchPreview.fade`). */
  fade: Accessor<boolean>;
}

/** Player's frame under the viewer's choices, new each frame. Empty with no timeline. Call inside
 * a component or root. */
export function playerFrame(src: FrameSource, state: PlayerState = fromTimeline(src)): Accessor<MatchPreview> {
  return () => {
    const m = src.tl();
    const [s, d] = [state.second(), state.tenth()];
    return m && s && d ? previewAt(m, src.t(), src.markers(), src.shown(), src.fade(), s, d) : EMPTY();
  };
}

/** `playersAt(m, t)` from the samples of t's second (`playersAt(m, Math.floor(t))`): a hero's
 * samples are the second's; its place and its respawn time are counted from t. The top bar's
 * heroes are this (`HeroState`'s fields, player/barSlot.ts). */
export function heroesAt(m: Timeline, t: number, samples: PlayerAt[]): PlayerAt[] {
  return samples.map((x, i) => ({ ...x, pos: positionAt(m.players[i]!, t), respawn: respawnAt(m.players[i]!, t) }));
}
