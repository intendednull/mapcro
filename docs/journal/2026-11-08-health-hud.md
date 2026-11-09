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
  - The first version followed the stylesheets: the disc pulsed red with a glow
    (`LowHealthFlash`) and the portrait was washed `colorEnemy` (`LowHealthPortraitFlash`). The
    operator didn't want the tint, the pulse or the glow, and expected the game's alternate
    "critical" portrait instead.
  - That portrait exists. Each hero record in heroes.vdata has `m_strIconHeroCardCritical`
    (`panorama/images/heroes/<hero>_card_critical_psd`, 280×380, transparent). It's a battered
    version of the hero card, and 44 heroes have one. The extractor exports it as
    `topbar/heroes/<id>_critical`, and Player swaps it in: 70.4 wide at the card's aspect,
    bottom on the disc's, under the same `hero_image_mask`.
  - No outline: the stylesheets define none for `.healthLow`.
  - `#CriticalIndicator` stays: an uppercase "Critical" at y 74 with a red glow and the
    `TagGroove1` wobble. Phones hide it because it covers the team total there. Reduced motion
    stops the wobble.
- **Extractor.**
  - `citadel_base_styles.vcss` joins the HUD sources (eleven now). The other stylesheets name
    `colorEnemy`, `offWhite` and the team colours, and only this file defines them.
  - Heroes gain `critical_blob`, the critical card.

## Surprises

- **Which image the badge shows isn't in the files.** `CitadelHeroImage` picks it in code, so
  the critical swap is inferred. Three things point to it:
  - the card exists for every hero;
  - `hero_image_mask_psd` is 280×380, the card's size, not the vertical's 120×200;
  - drawn this way, the critical card looks like the screenshot's portraits: a transparent bust
    whose head spills over the disc.

  The same evidence suggests the normal top-bar portrait is the card too (`m_strIconHeroCard`),
  not `m_strTopBarVertical`, which has a baked background. Moving to it would make the swap
  seamless and fix the portrait mismatch below. It's not done yet.

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
  - the low state, critical card and tag are on at 25%, and off at 31% and 55%, with Health
    off, and once dead;
  - there's no pulse or glow on the disc;
  - reduced motion stops the tag's wobble. A heroes-only synthetic pack supplies the two
    portraits.
- e2e `player.spec.ts` checks that the API summary has no bars.
- Eleven mutants were killed: never swap, always swap, the pack dropping `critical_blob`, fill
  constant, dead gate, API gate, threshold 0 and 40, low ignoring the gates, reduced-motion
  rule, Health toggle.
- Screenshots of 129738985 at 26:42 and 34:24, desktop and phone, plus a side-by-side with the
  screenshot, are in `/tmp/health-hud-shots/` (not committed).
