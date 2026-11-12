// Module state a board sets that would outlive it (sessions.md §4.1): reset when a board
// unmounts, so the next one starts from the defaults. Each entry is in the module-state ledger
// (web/test/module-state-ledger.ts) as `reset-on-unmount`.

import { resetHover } from "../map/HoverLabel";
import { closeTips } from "../player/GameTooltip";

export function resetBoardModules() {
  // The hover label's channels and a presenter's hover: keyed by roster slot and marker key,
  // which every board has.
  resetHover();
  // The one game tooltip open.
  closeTips();
}
