// Generated from crates/engine/src/view_state.rs `VIEW_STATE` by `just ts`. Do not edit.

/** Every view-state key: the room whose presence carries it (a board's, or a session's own),
 * who sees it, its kind (`options` and how presence `wires` each, for
 * a choice), where presence carries it (`field`, with `mask` for one bit of an integer; `omit`:
 * left out when the default), what stopping a follow does, what a follower's own change does,
 * the group a presenter's change applies as, and whether another match resets it. */
export const VIEW_STATE = {
  "layer.troopers": { room: "board", sync: "shared", kind: "bool", field: "layers", mask: 1, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.health": { room: "board", sync: "shared", kind: "bool", field: "layers", mask: 2, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.pings": { room: "board", sync: "shared", kind: "bool", field: "layers", mask: 4, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.cc": { room: "board", sync: "shared", kind: "bool", field: "layers", mask: 8, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.movement": { room: "board", sync: "shared", kind: "bool", field: "layers", mask: 16, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.heals": { room: "board", sync: "shared", kind: "bool", field: "layers", mask: 32, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.crates": { room: "board", sync: "shared", kind: "bool", field: "layers", mask: 64, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "builds.all": { room: "board", sync: "shared", kind: "bool", field: "playback.all_builds", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "names": { room: "board", sync: "personal", kind: "bool", field: null, mask: null, omit: false, unfollow: "keep", override: "local", group: null, reset: false },
  "vision.team": { room: "board", sync: "shared", kind: "choice", options: ["all", "amber", "sapphire"], wires: [null, "Amber", "Sapphire"], field: "playback.vision.team", mask: null, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "vision.last_seen": { room: "board", sync: "shared", kind: "bool", field: "playback.vision.last_seen", mask: null, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "recap.skull": { room: "board", sync: "shared", kind: "death", field: "playback.skull_recap", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "recap.event": { room: "board", sync: "shared", kind: "deaths", field: "playback.event_recap", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "builds.inspect": { room: "board", sync: "shared", kind: "slot", field: "playback.inspect", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "builds.popover": { room: "board", sync: "shared", kind: "choice", options: ["none", "effects", "order"], wires: [null, "effects", "order"], field: "playback.build_popover", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "recap.skull.place": { room: "board", sync: "shared", kind: "place", scale: 10000, field: "playback.skull_place", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "heroes.panels": { room: "board", sync: "shared", kind: "heroes", max: 12, scale: 10000, field: "playback.hero_panels", mask: null, omit: false, unfollow: "keep", override: "local", group: "panels", reset: true },
  "events.filter.death": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 1, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.ult": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 2, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.objective": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 4, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.mid_boss": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 8, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.rift": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 16, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.powerup": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 32, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.urn": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 64, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.souls": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 128, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.purchase": { room: "board", sync: "shared", kind: "bool", field: "playback.event_filters", mask: 256, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.search": { room: "board", sync: "shared", kind: "text", max: 64, field: "playback.event_search", mask: null, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.search.names": { room: "board", sync: "shared", kind: "choice", options: ["own", "on", "off"], wires: [null, "on", "off"], field: "playback.event_search_names", mask: null, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "session.tab": { room: "session", sync: "shared", kind: "id", field: "tab", mask: null, omit: false, unfollow: "keep", override: "stop", group: null, reset: false },
} as const;

export type ViewKey = keyof typeof VIEW_STATE;
