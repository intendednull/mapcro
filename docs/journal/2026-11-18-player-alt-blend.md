# Player's transport: the blend, as shipped (2026-11-18)

The operator picked the blend of the Deck (`player-alt-opus`) and the Shuttle Deck
(`player-alt-astra`) on 2026-11-18, then asked for Play in the middle with the skip and speed keys
around it. Branch `player-blend-build` took it from prototype to release. Spec: §6b, The transport.

**The bar.** The timeline lane runs across the whole bar. Under it: the source at the left, the keys
in the middle, the clock and Save scene at the right. The keys are one cluster mirrored around Play:
speed −, Back 10 s, Play, Forward 10 s, speed +. Play's centre is the bar's centre at every size,
because the columns beside it are equal. The current speed is a tag on Play's foot.

| Keys | Desktop | Touch |
| --- | --- | --- |
| Play | 56 px | 48 px (44 on a turned phone) |
| Back, Forward | 44 px | 44 px |
| Speed − and + | 40 px | 44 px |

**Tiers, by dock width (desktop).**

| Dock | Bar | Layout |
| --- | --- | --- |
| 840 px and up | 133 px | lane; source, keys, clock and Save scene |
| 480 to 839 px | 187 px | lane; keys; source, then clock and Save scene |
| under 480 px | 235 px | lane; keys; source and clock; Save scene |
| under 250 px (windows under 800) | 235 px | as above, the keys scaled to fit |

**Touch.**

- Phone upright: the clock and lane, then the speed list and Events, Play, Map layers and More. No
  skip keys, and speed stays a list (feedback #58). 103 px tall.
- Phone on its side: one row, the clock and lane, the keys, the tabs. 53 px tall. Below 700 px wide, the clock shows elapsed time only (`--clock-w: 44px`) to give the scrubber more room (operator lean, 2026-11-24).
- Tablet upright: as a phone upright, with the whole cluster.
- Tablet on its side: two rows, so the lane keeps at least 40% of the width.
- The tool rail (Laser, Edit) needs the width, so Play goes back beside the lane there.

**Found and fixed on the way.**

- The tools row overflowed the stage at 800 to 820 px, and the stage scrolled sideways to a focused
  control, carrying the map and the bar under the left panel (TD-121). The tools wrap and the stage
  clips.
- With no match, the prototype put the source at the bar's right end, and its Load button went under
  the right panel.
- The source opened over the lane and any notice. It now opens from the bar's top edge, over the map.
- Resume's word pushed the cluster off an 800 px window's dock. Play stays a disc there.
- The save toast sat on the taller bar. It now clears the dock.
- A scene's row cut off Back to replay at 800 px. It wraps.
- Review of the release: Sandbox kept the transport's height, a scene opened on a phone or tablet
  lost the touch layout, and windows 650 px tall or less cut controls off. Sandbox now has the scene's
  row alone, touch has one layout for both, and a window 720 px tall or less has smaller keys
  (Play 44 px, Back and Forward 36, speed 32).

**Cost.** The bar is taller than the old one, so the map is smaller on short windows (`--u` is 1.3 px
against 1.5 at 1440×900). An empty Player keeps the reserved height, so nothing jumps when a match
arrives.

**Open.** TD-155: a plain Tab is the all-builds hold in Player, so the keyboard reaches the keys with
Shift+Tab only.
