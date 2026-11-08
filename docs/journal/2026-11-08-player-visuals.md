# 2026-11-08: Player's visuals: pings, objective fills, troopers, the laser, event clicks

A fresh implementer took the handoff's items 1 and 3, the health open questions and a laser
bug, and then two operator changes that arrived mid-way: objective health as the icon's own
fill, and the events list marking the wrong row on a click. The spec is §6b (and §6a Health,
§4's laser row). The commits are dcbe28a, 0a44871, 2ca6dbb, 72ab32f, e559ff8 and 073d97d.

## What changed

- **Event pings** (2ca6dbb, 073d97d). The host watches its own clock: each continuous forward
  step while playing pings the listed events it crossed. "Listed" means the events list's
  filtered and searched set, which the list hands the host (`setPingable`). A counter of
  breaks (`jumped()`: seek, a new timeline, a mode switch, a presenter's jump a follower adopts)
  is what tells a seek from a step; a step's size isn't. A cap on it, first set at two
  seconds' worth of match time, dropped real pings when the shared box stalled a frame: the
  suite's flake had one ring missing and its neighbours there. Only five seconds of wall time
  without a frame (a tab back from the background) counts as a break now.
  - A follower learns of a presenter's jump by where their playback should be now against
    where it says it is (over 1 s plus a quarter of the speed off). Its own drift corrections
    are a run, and a high-water mark stops a small step back from pinging twice.
  - The first ring (r 15, white, 2 px) vanished in a real teamfight among the tokens. The ring
    is now team-coloured over a dark halo, r 20, scaling 0.5→1.45 once.
- **Objective fills** (0a44871). The pack already has the HUD's own fill art
  (`boss_health_fill*`), drawn over the `boss_health*` frames. Clipping the fill layer's box
  linearly read 67% as nearly full, because the diamonds sit in the middle 44% of their image
  (opaque rows 0.28–0.72). The clip now runs over the shape's own rows (`SPAN` in MapView, each
  layer's `data-span`; the e2e reads the same to measure "fraction of the shape"). A friendly
  patron's shield is drawn rotated, so its clip runs from its own top. The patron's stage 2
  shows in Player now: the status callback maps it from `pv.health`.
- **The event click** (72ab32f). This reproduced the lead's hypothesis exactly: with a 5 s
  lead and events 5 s apart, the follow mark landed on the previous event (the spec's first
  run marked 0:25 for a click on 0:35). A jump pins its event in the host; the list honours the
  pin until playback passes the next listed event, and any other seek unpins it.
- **The laser** (dcbe28a). One `Timed[]` trail for every gesture; a new press appended to the
  fading one. Points now carry a gesture number. Presence carries `laser_starts` (indices,
  bounded in `is_valid` with a unit test; a new BUILD_ID, so the WASM was rebuilt) and the
  board renders one `LaserTrail` per run via `Index`.
- **Troopers** (e559ff8). See the profile below. The look is matched by eye; see the open
  questions.

## Measurements

- 8× on 129738985 at 41:30, the replay's busiest trooper minute (47 on screen, at most 68 in
  the whole match, 53 on average over that minute; the handoff's "100+" doesn't happen in this
  replay). The presenter and a follower ran in one headless Chromium with software rendering,
  and the 1-minute load was 5–7. Main-thread time per frame came from Chromium's
  `Performance.getMetrics` (TaskDuration over frames):
  - Before: troopers on 12.6 ms, off 8.9 ms.
  - The cost was each circle's CSS `opacity`, which makes SVG paint it through its own group
    buffer. With `fill-opacity`: on 9.4–10.8 ms, off 9.0–10.2 ms, i.e. the same within noise,
    for presenter and follower alike.
  - The remaining ~9.5 ms is the board's own repaint under software rendering. The script share
    is about 4 ms. Moving the overlay to its own compositor layer (`will-change`) didn't change
    it, so it was reverted. On a GPU this should be well lower, but that's unmeasured here.
- `perf-replay.spec.ts` reproduces this (`MAPCRO_SHOT_REPLAY`, optional `MAPCRO_PERF_FROM`,
  `MAPCRO_PERF_PROFILE` for the hottest functions).

## Gotchas found

- `opacity` on many small SVG elements is expensive. Use `fill-opacity`/`stroke-opacity`.
- A `For` over objects made fresh each frame re-creates every element each frame. Use `Index`.
- `git commit -- <paths>` commits the working-tree files whole, ignoring a partial index. With
  hunks from several features in one file, stage built blobs (`git hash-object -w` +
  `update-index --cacheinfo`), typecheck a `checkout-index` copy, then `git commit` with no
  pathspec after checking `git diff --cached --name-only`.
- Each `recordPings` in the pings spec used to add an observer, and two observers double-logged.
  It installs one now.

## Open questions

- The trooper markers' in-game look. The files don't say: `hud_minimap.vcss` gives
  `.map_button.npc` only a position transition, and `npc_marker_{friend,enemy,neutral}_psd`
  are flat 32 px red, green and grey squares that look like placeholders. A screenshot of the
  in-game minimap with troopers has been asked for. Today they're 5-map-unit team dots with a
  dark rim.
- Should ults ping? Every listed event pings, and ults are 114 of 269 events on 129738985.
  Filtering Ults off in the list stops them.
- The jump's pin isn't shared: a follower's list marks by its own clock.
