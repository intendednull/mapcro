# What the map costs while a replay plays (trooper-draw, 2026-11-12)

Question (#39, operator): troopers stay individual dots; can drawing them get cheaper? Short
answer: the trooper dots are already cheap. The map's biggest per-frame waste was elsewhere,
in the powerup icons, which were rebuilt every frame. That is fixed in `map/MapView.tsx`.

## How it was measured

- A Playwright spec kept in `/tmp` only (not committed), run against the release build
  (`vite build`) and the e2e server with the dev pack. One page plays at 1x speed. Each window
  is 3 s (4 s for the profile).
- Chromium trace (`devtools.timeline` plus `invalidationTracking`): totals per phase on
  `CrRendererMain`, divided by frames drawn. JS is `ScriptDuration` from `Performance.getMetrics`.
- CPU throttle via `Emulation.setCPUThrottlingRate`. At 4x the main thread is at 100%.
- Matches: 134623152 at 1735 s (28:55; 27 troopers) and 129738985 at 2490 s (34 troopers).
- Each variant ran with troopers on and toggled off, alternating, in the same page. Two windows
  of each, median ± half the range.
- **Headless Chromium doesn't cap frames at 1x** (about 120 to 150 fps here). Use per-frame
  costs at 1x and fps only at 4x.
- The box is shared. At 4x, fps and per-frame costs move ±10–15% between runs, so a change under
  about 0.3 ms/frame is noise.

## Findings (ms per frame, 4x CPU, 134623152 @ 28:55 unless noted)

| variant | fps | JS | style | layout | prepaint | hittest | paint | layerize | invalidations/frame (troopers) |
|---|---|---|---|---|---|---|---|---|---|
| main (30d8667) | 28.6 ± 4.6 | 13.5 | 1.39 | 2.50 | 1.86 | 1.65 | 2.73 | 2.34 | 57 (13) |
| + powerup icon memo (shipped) | 36.1 ± 5.9 | 11.5 | 0.88 | 1.14 | 1.61 | 1.52 | 1.58 | 2.32 | 32 (13) |
| + troopers off | 31.2 ± 2.1 | 12.4 | 0.92 | 1.27 | 1.97 | 1.92 | 1.96 | 2.97 | 21 (0) |
| troopers on one `<canvas>` in a `foreignObject` (on main, 3 runs) | 23.8–28.2 | 12.5–14.2 | 1.5–1.7 | 2.2–3.1 | 1.9–2.3 | 1.8–2.0 | 2.5–3.5 | 2.9–3.4 | 0 |
| + troopers on one canvas under the overlay | 31.0 | 11.9 | 0.90 | 1.23 | 1.94 | 1.80 | 1.82 | 2.21 | 0 |
| + one `<path>` per team and kind | 29.2 | 13.3 | 0.87 | 1.48 | 2.01 | 1.94 | 2.25 | 3.01 | 2 |
| + no clip on the trooper layer | 29.6 | 13.3 | 0.97 | 1.46 | 2.05 | 1.93 | 2.15 | 2.63 | 13 |

Notes on the table:

- The table mixes runs. The "powerup icon memo" row and the main row are 8 windows each. The
  `foreignObject` row ran on main (3 runs, given as ranges). The rows below it are 2 windows each,
  measured on top of the memo. On main without the memo, the canvas under the overlay measured
  Layerize 2.54 → 3.19 against the DOM dots.
- At 1x, hiding the whole map halves Layerize and Paint (0.51 → 0.26 and 0.47 → 0.24 ms/frame).
  Hiding the icons (`.mm-objs`) alone cut layout from 0.43 to 0.15 ms/frame.
- Hiding the troopers, or the tokens, moved each phase by 0.05 ms/frame or less.

What the findings mean:

- **Most invalidations are troopers', but each one is cheap.** A cx/cy write restyles its circle
  ("Attribute"), relayouts it ("SVG changed") and re-clips it ("SVG resource invalidated").
- **Troopers on minus off is within noise** for every render phase (±0.3 ms/frame), on both
  matches.
- **Troopers' JS is about 1% of the main thread at 4x.** The profile counts all time under
  `troopers.ts` and `TrooperDots` code: 57 ms in 4.8 s (129738985), 34 ms in 5.3 s (134623152).
- **A canvas costs more than it saves.** A 2D canvas is a composited layer of its own, so the
  overlay painted over it is split off: Layerize rises by 0.1 to 0.7 ms/frame, more than the DOM
  dots cost. This holds even with no dots drawn, while the canvas exists.
- **One path per style doesn't look the same.** Overlapping dots, which a wave is made of, would
  paint their 0.85 fill once instead of twice, and every rim would show over the fills. It also
  saved nothing measurable.
- **The clip-path on the trooper layer costs nothing measurable.** Removing it changed nothing.
  The stencil clip stays.
- **The real waste: powerup icons rebuilt every frame.** `MarkerView`'s `body()` read `p.buff`.
  That is a getter over the match preview, which is new every frame, so each powerup's icon was
  rebuilt (removed and inserted) about 240 times a second. A memo over `p.buff` makes it rebuild
  only when the buff changes.
  - Measured effect: layout 2.5 → 1.1, paint 2.7 → 1.6, style 1.4 → 0.9 ms/frame; fps at 4x
    28.6 → 36.1.
  - late-perf's `markerStates.ts` (value-compared memos in Board) removes the same churn
    upstream. The memo here guards MapView whatever its caller passes.
- **Not the map (left for the top bar):** about 700 `class` writes a second during play, with
  "Invalidation set matched class @ `i.tb-disc`" and "Affected by :has() @ `div.main`"
  (`.main:has(> .scenes)`, `.stage:has(.tb-host)`).

## Checks

- `e2e/player-troopers.spec.ts`, "playing moves the dots and rebuilds none of the map's icons":
  a MutationObserver counts DOM work over 1 s of play. With the fix: 0 icon nodes added or
  removed. Without it: 480.
- The map's icon and trooper DOM was compared main against fix at 600, 1200, 1735 and 2400 s on
  134623152: identical (sha1 of `.mm-objs` and the trooper layer).
- The map screenshots differ by 23 to 2,108 px, the same as main against itself (30 to 577 px).
  That spread is timing, from eased tokens and pings.
