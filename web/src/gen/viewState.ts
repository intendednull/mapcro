// Generated from crates/engine/src/view_state.rs `VIEW_STATE` by `just ts`. Do not edit.

/** Every view-state key: who sees it, where presence carries it (`field`, with `mask` for
 * one bit of an integer), what stopping a follow does, and what a follower's own change does. */
export const VIEW_STATE = {
  "layer.troopers": { sync: "shared", field: "layers", mask: 1, unfollow: "restore", override: "stop" },
  "layer.health": { sync: "shared", field: "layers", mask: 2, unfollow: "restore", override: "stop" },
  "layer.pings": { sync: "shared", field: "layers", mask: 4, unfollow: "restore", override: "stop" },
  "layer.cc": { sync: "shared", field: "layers", mask: 8, unfollow: "restore", override: "stop" },
  "layer.movement": { sync: "shared", field: "layers", mask: 16, unfollow: "restore", override: "stop" },
  "layer.heals": { sync: "shared", field: "layers", mask: 32, unfollow: "restore", override: "stop" },
  "layer.crates": { sync: "shared", field: "layers", mask: 64, unfollow: "restore", override: "stop" },
  "builds.all": { sync: "shared", field: "playback.all_builds", mask: null, unfollow: "keep", override: "local" },
  "names": { sync: "personal", field: null, mask: null, unfollow: "keep", override: "local" },
} as const;

export type ViewKey = keyof typeof VIEW_STATE;
