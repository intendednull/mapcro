// Every piece of module-level state under web/src (a signal, store, `let`, Map, Set or array made
// at the top of a module), with what happens to it when a board unmounts (sessions.md §4.1). A
// module outlives every board the page mounts, so state kept there crosses from one board to the
// next unless it is reset or harmless by construction. The guard in module-state.test.ts fails
// when one isn't listed here, or when an entry names state that's gone.
//
//   reset-on-unmount  the board's cleanup resets it (src/board/reset.ts); module-state.test.ts
//                     checks each against its default.
//   owner-cleared     what sets it clears it as it goes (a component's own cleanup, a modal as it
//                     closes, a key of an element that dies with it).
//   keyed-by-board    kept per board id: another board never reads it.
//   immutable-cache   data that never changes once loaded, keyed by where it came from (a pack, a
//                     file, the WASM module): sharing it is the point.
//   device            this device's, on every board by design (the app's replay folder).
//   page              this page load's, on purpose: the reason says why.
//   constant          never written after it's made.

export type Policy = "reset-on-unmount" | "owner-cleared" | "keyed-by-board" | "immutable-cache" | "device" | "page" | "constant";
type Entries = Record<string, [Policy, string]>;

/** By file (under web/src) and name. */
export const MODULE_STATE: Record<string, Entries> = {
  "map/HoverLabel.tsx": {
    resolvers: ["owner-cleared", "each hoverable thing unregisters itself on cleanup (registerHover's returned function)"],
    version: ["page", "a change counter for the resolvers: only ever moves on"],
    token: ["reset-on-unmount", "keyed by roster slot, which every board has (tokens also clear their own)"],
    marker: ["reset-on-unmount", "keyed by marker key, which every board has (Camps clears its own)"],
    unit: ["reset-on-unmount", "a rift trooper's key (Player's dots clear their own)"],
    handle: ["reset-on-unmount", "a wave's handle (the handle clears its own)"],
    remote: ["reset-on-unmount", "the presenter's hover; Board's cleanup cleared it already"],
  },
  "player/GameTooltip.tsx": {
    openId: ["reset-on-unmount", "the one game tooltip open (each tooltip also closes itself on cleanup)"],
  },
  "player/handoff.ts": { pending: ["keyed-by-board", "takeHandoff(board) gives it only to the board it was made for"] },
  "player/ReplaysFolder.tsx": { store: ["device", "the app's replay folder: the same on every board"] },
  "player/ReplayPicker.tsx": {
    appSource: ["device", "the Windows app's replay source, asked once"],
    art: ["immutable-cache", "the asset pack's art, loaded once"],
  },
  "player/troopers.ts": {
    cache: ["immutable-cache", "a WeakMap keyed by the timeline object: goes with it"],
    pairCache: ["immutable-cache", "a WeakMap keyed by the timeline object: goes with it"],
  },
  "player/api.ts": { MODE_CODES: ["constant", "the codes of a mode with no board"] },
  "match/tooltips.ts": { cache: ["immutable-cache", "tooltip data by pack and file"] },
  "match/builds.ts": { INDEX: ["immutable-cache", "a per-array index cache keyed by immutable timeline arrays (WeakMap; holds nothing past the timeline)"] },
  "match/stats.ts": { loaded: ["immutable-cache", "stat tables by pack and file"] },
  "board/state.ts": { wasm: ["immutable-cache", "the WASM module's init, once a page; every replica is the session's own"] },
  "board/fade.ts": { fades: ["owner-cleared", "a WeakMap keyed by element: goes with it"] },
  "map/MapView.tsx": {
    styleEl: ["page", "the art's CSS in <head>: the art is the page's (App loads it once), and each map sets it again"],
    stencils: ["page", "an id counter: only ever moves on, so every map's clip ids are its own"],
  },
  "ui/modal.ts": {
    open: ["owner-cleared", "each modal leaves the stack on cleanup (the unmount spec checks no body child stays inert)"],
    made: ["owner-cleared", "given back as the last modal closes"],
  },
  "core/seat.ts": { page: ["page", "this page's seat (sessions.md §6.1): the same across every board the page opens, by design"] },
  "core/nav.ts": { href: ["page", "the address"] },
  "core/feedback.ts": {
    enabled: ["page", "whether the server has the feedback form on, asked once a page"],
    asked: ["page", "whether the server has the feedback form on, asked once a page"],
  },
  "core/keys.ts": { TEXT_TYPES: ["constant", "input types that take text"] },
};
