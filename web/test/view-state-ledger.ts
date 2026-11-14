// Every signal and disclosure in Player and the board that is not a view-state registry key
// (crates/engine/src/view_state.rs), with what following does with it and why. The guard in
// view-state.test.ts fails when a `createSignal` or `<details>` in the scanned files is not
// listed here, so new state can't be added without saying whether followers get it.
//
// A new piece of "what you see" belongs in the registry, not here: add a row there and hold the
// value in the store (src/player/viewstate.ts). List it here only when it isn't view state, or
// when it is deliberately each browser's own.
//
//   registry  a <details> whose open state is a registry key, passed in as a prop.
//   wired     view state a follower mirrors through hand-written code (names the presence
//             field): the board's scene, viewport and hover, and the playback and jump, left
//             outside the registry (operator 2026-11-11; plan steps 5, and §3 for the clock).
//   unshared  view state a follower doesn't get today (docs/backlog.md "Follow: what a follower
//             still doesn't share"); each needs the operator's yes before it is shared.
//   personal  each browser's own on purpose.
//   local     not view state: data, plumbing, a gesture in progress, a dialog.

export type Policy = "registry" | "wired" | "unshared" | "personal" | "local";
type Entries = Record<string, [Policy, string]>;

/** `createSignal`s, by file (under web/src) and the getter's name. */
export const SIGNALS: Record<string, Entries> = {
  "player/host.ts": {
    matches: ["local", "the board's attached matches"],
    mode: ["wired", "playback.player"],
    held: ["local", "the playback kept while in Sandbox"],
    tabHeld: ["wired", "playback.all_builds: sent as builds.all's value while held"],
    pingable: ["local", "the events shown under the list's filters and search (registry keys events.*), from Events.tsx"],
    pings: ["local", "event pings in flight, from playback"],
    lead: ["personal", "the jump lead: a follower gets where the jump landed"],
    matchId: ["wired", "playback.match_id"],
    tl: ["local", "data"],
    status: ["local", "data"],
    job: ["local", "data"],
    problem: ["local", "data"],
    sent: ["local", "this tab's upload"],
    playback: ["wired", "playback.t, playing, speed"],
    now: ["local", "the frame clock"],
    highlight: ["local", "the jump ring, from playback.jump"],
    opener: ["local", "the replay prompt"],
    armed: ["local", "the replay prompt"],
    prompted: ["local", "the replay prompt"],
    pin: ["wired", "playback.jump"],
    heardJump: ["local", "a follower's side of playback.jump"],
  },
  "player/viewstate.ts": {
    own: ["local", "the registry store's cells"],
    theirs: ["local", "the registry store's cells"],
    heard: ["local", "the registry store's cells: whether one shows a presenter's value"],
  },
  "player/Events.tsx": {
    picked: ["local", "rows ticked to save as scenes"],
    follow: ["unshared", "the list's scroll: following Now or not"],
  },
  "player/Player.tsx": {
    picking: ["local", "a dialog"],
    why: ["local", "a disclosure in the replay notice"],
    fresh: ["local", "the replay notice"],
  },
  "player/ReplaysFolder.tsx": { state: ["local", "this device's folder"], now: ["local", "a clock"], note: ["local", "a message"] },
  "player/ReplayPrompt.tsx": { picking: ["local", "a dialog"] },
  "player/ReplayPicker.tsx": {
    list: ["local", "data"],
    missing: ["local", "data"],
    now: ["local", "a clock"],
    shown: ["local", "paging"],
    heroes: ["local", "data"],
    data: ["local", "data"],
  },
  "player/ReplayHelp.tsx": { dragged: ["local", "a file dragged over"] },
  "player/Urn.tsx": { el: ["local", "an element"] },
  "player/GameTooltip.tsx": {
    openId: ["local", "the one game tooltip open: under your pointer or finger"],
    at: ["local", "the tooltip's position"],
  },
  "map/HoverLabel.tsx": {
    version: ["local", "plumbing"],
    token: ["wired", "hover"],
    marker: ["wired", "hover (the teleporter pair's line reads the local one only: unshared)"],
    handle: ["wired", "hover"],
    unit: ["wired", "hover (a rift trooper, sent as marker:<key>)"],
    remote: ["local", "a follower's side of hover"],
  },
  "board/Board.tsx": {
    wideHeader: ["local", "the window is over 1440 px: the header shows 5 avatars, else 3 (spec §4b)"],
    renameAsked: ["local", "Rename from Your boards: open the title editor once the board can take it"],
    slow: ["local", "loading"],
    me: ["local", "name and colour: presence says who you are"],
    joined: ["local", "the join card"],
    viewpoint: ["wired", "view.side"],
    sceneId: ["wired", "scene"],
    sideTab: ["personal", "the sidebar tab, Events or Notes: layout (operator 2026-11-11)"],
    tool: ["personal", "your tool"],
    ink: ["personal", "your colour"],
    toast: ["local", "a message"],
    overlay: ["local", "an element"],
    dialog: ["local", "a dialog"],
    seenProblems: ["local", "messages"],
    justCloned: ["local", "a message"],
    view: ["wired", "view"],
    following: ["wired", "following"],
    followedNow: ["wired", "following: the presenter's presence, or the last seen while they reconnect"],
    recheck: ["local", "a timer: looks for a reconnecting presenter again"],
    followJoin: ["local", "the join a followed peer id is from"],
    focused: ["local", "a flash on a hero you clicked in the top bar"],
    selection: ["local", "your selection: presence shows it as yours (focus, drag_group)"],
    openComment: ["wired", "focus"],
    allOpen: ["personal", "the Comments toggle, per board on this device"],
    objSelection: ["local", "your selection: presence shows it as yours (picked)"],
    spaceHeld: ["local", "a key held"],
    waveDrag: ["local", "a gesture in progress"],
    heroPick: ["local", "a dialog"],
    phone: ["local", "the layout"],
    landscape: ["local", "the layout: the orientation, which picks the docked panel"],
    phoneEdit: ["personal", "your editing tools and gestures"],
    phoneSheet: ["personal", "the phone's open sheet (Events, Map layers, More): layout, like sideTab"],
    lastBuild: ["personal", "the build the landscape dock's Build tab reopens: layout, like phoneSheet"],
    noteDraft: ["local", "text being typed"],
    sceneDrawer: ["local", "the phone's drawer"],
    mapPx: ["local", "the layout"],
  },
};

/** `<details>` elements (their open state lives in the DOM), by file and class. */
export const DISCLOSURES: Record<string, Entries> = {
  "player/DeathRecap.tsx": { "death-recap": ["registry", "recap.skull and recap.event: open is a prop from the host"] },
  "player/BuildOrder.tsx": { "tb-effects tb-order": ["registry", "builds.popover (the inspected build's): open is a prop from the host"] },
  "player/ActiveEffects.tsx": { "tb-effects": ["registry", "builds.popover (the inspected build's): open is a prop from the host"] },
  "player/ReplayHelp.tsx": { "replay-help": ["local", "help"] },
  "player/Player.tsx": { "pl-source": ["local", "the replay source"], "map-layers": ["personal", "the Map layers popover being open: layout (operator 2026-11-11)"] },
};

/** The files the guard reads: Player, the board's root and the map's hover. A new file under
 * player/ is covered without a change here. */
export const SCANNED = { dirs: ["player"], files: ["board/Board.tsx", "map/HoverLabel.tsx"] };
