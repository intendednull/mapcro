// Module state a board sets that would outlive it (sessions.md §4.1): reset when a board
// unmounts, so the next one starts from the defaults. Each entry is in the module-state ledger
// (web/test/module-state-ledger.ts) as `reset-on-unmount`.

import { resetHover } from "../map/HoverLabel";
import { closeTips } from "../player/GameTooltip";
import { forgetEntered } from "../player/layer";
import { forgetMade } from "./state";

/**
 * The visit to `board` is over, or to every board (a session left): it was left in the page
 * other than by a tab switch (Back to the landing, a board carried into a session), or its link
 * is dead. Its next opening is a new visit, as on a fresh page (core/nav.ts): what was entered
 * and made before doesn't count (player/layer.ts `entered`, board/state.ts `madeBy`).
 */
export function resetVisit(board?: string) {
  forgetEntered(board);
  forgetMade(board);
}

export function resetBoardModules() {
  // The hover label's channels and a presenter's hover: keyed by roster slot and marker key,
  // which every board has.
  resetHover();
  // The one game tooltip open.
  closeTips();
}
