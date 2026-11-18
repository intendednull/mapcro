# Player alternative: the blend (player-alt-blend), 2026-11-18

A design take for the operator to compare; nothing merges. The operator liked the Deck
(`player-alt-opus`) and the Shuttle Deck (`player-alt-astra`), found the first a little too
condensed and the second's spacing odd, and asked for a middle ground.

**The take.** The Deck's parts at the Shuttle Deck's sizes. The timeline lane runs across the whole
bar. Under it sit the source, then Back, Play and Forward, then the clock, speed and Save scene.

| Desktop | Deck | Shuttle Deck | Blend |
| --- | --- | --- | --- |
| Play | 44 px | 56 px | 56 px |
| Back, Forward | 40 px | 44 px | 44 px |
| Speed − and + | 32 px | 44 px | 40 px |
| Bar height at 1440 | 58 px | 173 px | 133 px |

Touch keys stay at 44 px or more, as in the Deck.

**Tiers, by dock width.** From 800 px: two rows. Under 800: the source and Save scene take a third
row. Under 480 (800 to 820 px windows): the keys are centred on their own row, then the clock and
speed, then the source (its id only) and Save scene.

**Found on the way.**
- At 800 to 820 px windows the tools row overflowed the stage. The stage has `overflow: hidden`
  but still scrolled sideways (193 px at 800), carrying the map and the bar under the left panel.
  Main does this too. Docks under 680 px now wrap the tools.
- The timeline arrives after the match summary, so the bar grew under the tools at 1280×768. It
  now reserves its full height while loading.

**Tests.** The `transport review` block carries the Shuttle Deck's stage containment check and
asserts the desktop key sizes. No assertion was relaxed.

**Trade-offs.** The bar is taller than the Deck's, so the map is smaller on short windows. An empty
Player keeps the reserved height. Desktop speed keys are 40 px, so the narrow tier fits its row.
