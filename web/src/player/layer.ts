// Player's live annotation layer, kept by the board (spec §6b; ops in ./live.ts). Independent of
// what's mounted: it follows the mode and the match, not a component's life (review 2026-11-08,
// findings 1, 5, 8, 11).

import { createEffect, on, onCleanup } from "solid-js";
import type { BoardState } from "../board/state";
import type { RecordId } from "../gen/RecordId";
import { clearAnnotationsOps, ensureLiveOps } from "./live";
import type { PlayerHost } from "./host";

/** Wait this long after entering for others' presence before deciding we're alone. */
const SETTLE_MS = 1500;

/**
 * The live layer of the open match: made (or restored) whenever an editor is in Player with a
 * match, and cleared of stale ink when someone enters Player with nobody else in it. Returns
 * the layer's scene id for the open match (undefined: no annotating here).
 */
export function liveLayer(state: BoardState, h: PlayerHost, board: string, inPlayer: () => boolean): () => RecordId | undefined {
  const match = () => {
    const id = h.matchId();
    return id ? Number(id) : undefined;
  };
  createEffect(() => {
    const m = match();
    // Only from a current copy: a fresh one may start from an older snapshot, and would make a
    // layer someone already made (refused `IdTaken`, shown as Conflict; backlog 2026-11-11).
    if (!inPlayer() || m === undefined || !state.canEdit() || !state.current() || state.roster().length !== 12) return;
    const ops = ensureLiveOps(state.records as never, board, m, state.roster());
    if (ops.length) state.ensure(ops);
  });
  const alone = () => !state.peerList().some((x) => x.peer !== state.myPeer() && x.state?.playback?.player);
  // Only the first entry into a match's Player in this session clears stale ink: coming back
  // to it (Back, Play from here) keeps what's there.
  const entered = new Set<number>();
  createEffect(
    on([inPlayer, match], ([inside, m]) => {
      if (!inside || m === undefined || entered.has(m)) return;
      entered.add(m);
      const timer = setTimeout(() => {
        if (!inPlayer() || match() !== m || !state.canEdit() || !alone()) return;
        // Alone in Player: last session's ink goes, and so do other matches' layers (each would
        // hold a scene slot for good). Not what this tab drew meanwhile: drawing straight away,
        // the first stroke can land before the settle ends (e2e flake, 2026-11-08).
        const live = state.liveScene(m);
        const stale = (kind: string, scene: RecordId) => state.inScene(kind, scene).filter(([id]) => !state.madeHere(id));
        const ops = live ? clearAnnotationsOps(stale as never, live) : [];
        for (const other of state.liveScenes().filter((x) => x.match !== m)) ops.push({ Delete: { id: other.id } });
        if (ops.length) state.editSilent(ops);
      }, SETTLE_MS);
      onCleanup(() => clearTimeout(timer));
    }),
  );
  return () => state.liveScene(match());
}
