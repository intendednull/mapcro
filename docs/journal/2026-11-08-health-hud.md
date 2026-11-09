# 2026-11-08: The top bar's health, drawn as the HUD draws it

The operator sent an in-game screenshot of the top bar and asked: "see how the health looks?
let's try to match that." Then: "just the health tho, that top bar has other modded info." And:
"could be cool to include the low health version of the portraits too." Spec §6b holds the
design.

## What it was

- Health was a thin horizontal bar under each top-bar portrait (`.pl-hp` in `app.css`): 56 × 6
  units at y 66, filled left to right in the team colour, red at 30% or under. A dead hero kept
  an empty red bar.
- The game draws a slanted vertical card beside the portrait instead. The parity work had
  already copied that card into `topbar.css` (`.tb-health`, from `design/shared/topbar.js`), and
  the extractor already pulled its art (`healthbar_backer_vert_mask.vsvg`, `_border.vsvg`). Only
  Player never drew it, and `pack.ts` never put the art on it.

## What changed

- **The bar.** Player draws the HUD's `#HealthBar`, `#HealthBar_Contents`, `#HealthBar_Fill` and
  `#HealthBar_Border` from `citadel_hud_top_bar.vcss`:
  - 16 × 50, vertical-align middle with margin-bottom 14 px in the 120 px `.HeroContents`, so its
    top is at 28;
  - friendly: margin-left 10 px, −10°, offWhite fill; enemy: margin-right 4 px, +7°, `#FF5656`;
  - a `#000000de` back and the fill, both masked by `panorama/images/hud/healthbar/
    healthbar_backer_vert_mask.vsvg`, with the fill cut to the health from the bottom; the
    border masked by `…_border.vsvg` in offBlack.
  - Without a pack, a clip-path of the mask's own outline draws the same card.
  - A dead hero has no bar (`.Dead #HealthBar{visibility: collapse}`).
- **Low health.** At 30% or under, alive, with Health on, the portrait takes `.healthLow`:
  - the disc pulses (hero_badge.vcss `LowHealthFlash`, #b02727 to #ff3c3c, 0.7 s, 20 px glow);
  - the portrait is washed `colorEnemy` (#FF410D) at `&50` to `&00` (`LowHealthPortraitFlash`).
    A layer masked by the portrait image itself does it, so only the hero's pixels tint;
  - `#CriticalIndicator`: an uppercase "Critical" at y 74 with a red glow and the `TagGroove1`
    wobble. Phones hide it because it covers the team total there.
  - Reduced motion stops the animations and keeps the state.
- **Extractor.** `citadel_base_styles.vcss` joins the HUD sources (eleven now). The other
  stylesheets name `colorEnemy`, `offWhite` and the team colours, and only this file defines
  them.

## Surprises

- **`colorEnemy` isn't `ColorEnemy`.** `hud_minimap.vcss` defines its own `ColorEnemy: #ff410d`.
  The `colorEnemy` the low-health wash uses is in the base styles, and it happens to be the
  same, `#FF410D`. The extractor was extended to confirm it.
- **The threshold isn't in the files.** `.healthLow` is set from code. 30% is ours, the same as
  the map tokens' red arc.
- **The CSS offset matches the screenshot, the portrait doesn't.** Measured on the screenshot,
  the bar sits 10 px in from the slot's edge with its top near y 28, as the stylesheet says. But
  the game's portrait is a ~67 px team-coloured circle with only the head spilling over the top.
  Ours (`.tb-img`) is a 70 × 117 bust masked by `hero_image_mask_psd`, on a grey disc. So our bar
  overlaps the bust where the game's stands mostly outside the circle. hero_badge.vcss does give
  the disc the team colour (`.team1 CitadelHeroBadge.TopBar .HeroImageBackground`). This was
  left alone as out of scope. It's the next thing to fix if the match should be closer.

## Validation

- e2e `player-health.spec.ts` checks:
  - the fill's height follows the health at 10 s and 45 s;
  - there's no bar once dead, and the respawn state shows;
  - the low state is on at 25%, off at 31% and 55%, off with Health off, and off once dead;
  - reduced motion stops the pulse.
- e2e `player.spec.ts` checks that the API summary has no bars.
- Eight mutants were killed: fill constant, dead gate, API gate, threshold 0 and 40, low
  ignoring the gates, reduced-motion rule, Health toggle.
- Screenshots of 129738985 at 26:42 and 34:24, desktop and phone, plus a side-by-side with the
  screenshot, are in `/tmp/health-hud-shots/` (not committed).
