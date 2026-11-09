# 2026-11-08: Top-bar portraits drawn as the game's hero badge

The operator: "match how it looks in game." The health-hud entry left this open. Our top-bar
portraits were tall busts from different art than the game's. So the low-health critical card was
framed smaller than the normal portrait, and the health bar overlapped the bust where the game's
stands beside a circle. Spec §6b, Top-bar portraits, holds the design.

## What the game does

`citadel_hud_top_bar_player.vxml` puts a `CitadelHeroBadge.TopBar` in `#HeroImageArea`, and
`hero_badge.vcss` lays it out:

- The badge is 88 × 120. `.HeroImageContainer` is 80% of that (70.4), at the badge's top.
- `#HeroImage` is a `CitadelHeroImage scaling="contain"` under the opacity mask
  `hero_image_mask_psd`. The mask is 280×380, open above and a half-disc below.
- `.HeroImageBackground` is a circle the container's width, at its bottom. It's grey by default,
  and `team1Color` / `team2Color` in the top bar.
- Dead: `#HeroImage` saturation 0, brightness 0.2, on an `offBlack&ee` disc.

Which image `CitadelHeroImage` shows is set in code. The mask's size says it's the hero card
(`m_strIconHeroCard`, 280×380), not the 120×200 vertical with its baked background.

## What changed

- **Extractor.** Heroes gain `card_blob`: `m_strIconHeroCard`, exported as
  `topbar/heroes/<id>_card`. All 44 playable heroes have one.
- **`board/HeroBadge.tsx`**, used by both Player's bar and the board's own:
  - With a card: the card in a 70.4 × 95.5 frame at the badge's top, under the mask, on a
    team-coloured disc from y 25.1 to 95.5.
  - Low health puts the critical card in the same element and frame, so only the image changes.
  - Dead uses the badge's own dead rules. The respawn countdown, and the board's pick ring,
    follow the disc.
  - On a pack with cards, an empty board slot takes the same frame and team colour, so it lines
    up with its neighbours.
- **Fallback.** A hero without a card (any pack from before today, production's included) keeps
  the old vertical bust on the grey disc at y 15, and the critical card in its own frame there.
- **Unchanged:** the health bar's placement from `citadel_hud_top_bar.vcss`, souls, the Critical
  tag, ult rings, the Names row, and the board's vision eye.

## Surprises

- **`.card` is taken.** The first build named the badge's class `card`, and the app's
  landing-page `.card` rule (min-width 168 px) turned each team's six badges into one wide
  panel. It's `card-badge` now.
- **Where the badge sits isn't certain from the files.** `.HeroIconContainer` is vertical-align
  bottom in a 100 px `#HeroImageArea`, which would put the 120 px badge's top at −20 and the disc
  at 5–75. Two things put its top at 0, with the disc at 25–95.5, instead:
  - `.SoulsValueContainer`'s margin-top 76 plus padding-top 20 is 96, so the souls box shows from
    under the disc's bottom exactly.
  - In the operator's screenshot the circle's centre is at y 58–60 (about 1.33 screenshot px per
    unit, measured from the slot pitch, the health bar's top at 28 and the souls box).

  `#HeroBadge` has `ignore-parent-flow`, which may be why.
- **Three cards are 240×320** (Venator, Graves, Silver). They draw at their own aspect in the same
  frame, 1.6 units short at the top.
- **No fade out of vision.** The game's stylesheets have no unseen state for a top-bar hero. The
  faded enemy in the screenshot comes from the operator's mods. Player doesn't fade one. The
  board's dimmed "not seen" portrait belongs to its own vision toggle, so it stays.

## Validation

- e2e `player-health.spec.ts`. The synthetic pack has cards for heroes 1–3 and none for 4–6, plus
  the mask. It checks:
  - the card vs the vertical fallback, by `data-art`, URL and `card-art`;
  - the team disc colours, and the card's aspect, width and bottom on the disc's;
  - no initials through the card;
  - the critical swap, in an unchanged box, and in the fallback in its own box;
  - the dead filter and disc, and the respawn countdown over the disc.
- Mutations: 12 killed. Never card, never swap, critical out of the frame, frame height, disc
  position, disc team colour, initials, dead image, dead disc, respawn position, pack dropping
  `card_blob`, and every hero carded. One survived, an equivalent: a second class whose rule the
  card frame overrides. Two extractor mutations were killed by the fixture test: the card not
  exported, and the field misnamed.
- `real_install` (ignored, real game files) passes with the card check.
- Regression: topbar, playtest, player, names, visible, urn-respawn, hero-unique, pack and
  replay specs, 30 passed.
- Shots of 129738985 at 39:49 (a critical hero on each side and two dead) and 15:50, desktop
  and phone, the old pack's fallback, the board bar, and a side-by-side with the screenshot are
  in `/tmp/hero-badge-shots/` (not committed).
