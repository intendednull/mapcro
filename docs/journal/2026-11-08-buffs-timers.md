# 2026-11-08: Bridge buff types, objective timers, one hover label

Four operator requests in one piece of work: "Can we see what kind of bridge buff spawned? And
use the right icons?"; "Can we get timers on the other objectives as well? … When you hover over
them, like camps"; hover info as an instant label rather than the browser's delayed alt-text;
and, while following, seeing the presenter's hover. Spec §6b and §8 hold the design;
exploration round 7 holds the fields.

## What changed

- **Worker, format 2.** Each powerup site's spawns with their buff and pick-up
  (`Powerup.spawns`), the buff on powerup events, and when each rift's cash-in opened
  (`Rift.live_s`). All optional: older timelines load, and `FORMAT` 2 re-parses cached ones.
- **Player.** A powerup that's up is drawn with its buff's own minimap icon; the events say
  which buff. Rifts, buffs, camps, the mid boss and the urn's points say when they're back on
  hover, from the replay's own times.
- **One hover label** for tokens and markers, Player and Sandbox (`map/HoverLabel.tsx`): what's
  hovered is a reference (marker key, roster slot), and each thing registers how to place and
  word itself. That made the follow mirror small: presence carries the reference, and the
  follower words it from its own state.

## Surprises

- **The spawner doesn't know what it spawns.** The type lives on a second entity, the
  `CCitadel_Pickup_Modifier` the spawner re-arms, as a string token. The same class carries the
  statues' 30 permanent drops, so the filter is the four tokens, checked by a test against the
  names in misc.vdata.
- **Some buffs live a fifth of a second.** The 5:00 west buff was taken 0.11 s after it spawned.
  The existing 1 Hz powerup samples never saw it; reading the pickup every tick does, and the
  availability now comes from that.
- **`m_tNextDropTime` lies across a pause.** It read 4:29 before this match's pause, then jumped
  to 5:00 at 4:29. The observed spawns are on the vdata's 300 s grid; the field isn't used.
- **No rift schedule anywhere.** Announcements come 226–329 s after a capture; the cash-in opens
  exactly 80.09 s after each announcement. The label counts to the replay's own opening.
- **The hero's buff isn't in `ActiveModifiers` under its vdata names.** The pickup is enough.
- **The wave handle sits on the rifts.** The default wave split is the map's centre line, where
  both rifts are, and its handle is drawn over the tokens too. It now labels only when no marker
  is under the pointer.

## Costs absorbed

- The presence field changes `BUILD_ID`. Tabs reload once after a deploy; the live dev view
  needs its server restarted to match the rebuilt WASM.
