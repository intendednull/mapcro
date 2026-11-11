// Generated from crates/engine/src/view_state.rs `VIEW_STATE` by `just ts`. Do not edit.

/** Every view-state key: who sees it, its kind (`options` and how presence `wires` each, for
 * a choice), where presence carries it (`field`, with `mask` for one bit of an integer; `omit`:
 * left out when the default), what stopping a follow does, what a follower's own change does,
 * the group a presenter's change applies as, and whether another match resets it. */
export const VIEW_STATE = {
  "layer.troopers": { sync: "shared", kind: "bool", field: "layers", mask: 1, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.health": { sync: "shared", kind: "bool", field: "layers", mask: 2, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.pings": { sync: "shared", kind: "bool", field: "layers", mask: 4, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.cc": { sync: "shared", kind: "bool", field: "layers", mask: 8, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.movement": { sync: "shared", kind: "bool", field: "layers", mask: 16, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.heals": { sync: "shared", kind: "bool", field: "layers", mask: 32, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "layer.crates": { sync: "shared", kind: "bool", field: "layers", mask: 64, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "builds.all": { sync: "shared", kind: "bool", field: "playback.all_builds", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "names": { sync: "personal", kind: "bool", field: null, mask: null, omit: false, unfollow: "keep", override: "local", group: null, reset: false },
  "vision.team": { sync: "shared", kind: "choice", options: ["all", "amber", "sapphire"], wires: [null, "Amber", "Sapphire"], field: "playback.vision.team", mask: null, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "vision.last_seen": { sync: "shared", kind: "bool", field: "playback.vision.last_seen", mask: null, omit: false, unfollow: "restore", override: "stop", group: null, reset: false },
  "recap.skull": { sync: "shared", kind: "death", field: "playback.skull_recap", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "recap.event": { sync: "shared", kind: "deaths", field: "playback.event_recap", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "builds.inspect": { sync: "shared", kind: "slot", field: "playback.inspect", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "builds.popover": { sync: "shared", kind: "choice", options: ["none", "effects", "order"], wires: [null, "effects", "order"], field: "playback.build_popover", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "recap.skull.place": { sync: "shared", kind: "place", scale: 10000, field: "playback.skull_place", mask: null, omit: true, unfollow: "keep", override: "local", group: "panels", reset: true },
  "heroes.panels": { sync: "shared", kind: "heroes", max: 12, scale: 10000, field: "playback.hero_panels", mask: null, omit: false, unfollow: "keep", override: "local", group: "panels", reset: true },
  "events.filter.death": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 1, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.ult": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 2, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.objective": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 4, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.mid_boss": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 8, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.rift": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 16, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.powerup": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 32, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.urn": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 64, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.souls": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 128, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.filter.purchase": { sync: "shared", kind: "bool", field: "playback.event_filters", mask: 256, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
  "events.search": { sync: "shared", kind: "text", max: 64, field: "playback.event_search", mask: null, omit: true, unfollow: "keep", override: "local", group: "events", reset: false },
} as const;

export type ViewKey = keyof typeof VIEW_STATE;
