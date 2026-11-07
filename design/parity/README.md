# parity: the in-game minimap and top bar, rebuilt from their sources

**Top bar:** `design/shared/topbar.{js,css}`, compared against `_art/reference/ingame-topbar.png`
by `topbar-compare`. The spec follows the minimap's, at the end of this file.

**One implementation, shared:** `design/shared/minimap.js` (renderer), `minimap.css` (styles,
all sizes relative) and `minimap-data.js` (derived coordinates). This collection and every
v1-board artboard use it. The renderer spec for the app is at the end of this file.

This collection checks the board's map rendering against the game's own minimap. It covers map
rendering only, with no app chrome. Once it matches, the v1-board map adopts it.

- `minimap-ingame-view`: the reconstruction, drawn at 2× Panorama px.
- `compare`: the same reconstruction with the operator's screenshot on top.
  - Tweaks set the overlay's opacity (0–100%), difference blend, scale and offset.
  - Until a screenshot exists, the board shows a placeholder. Drop images into
    `design/_art/reference/` (git-ignored), then re-run `extract_parity.py`. It writes
    `reference/reference.css`, and the first image becomes the overlay.

All art comes from `design/_art/parity/` (git-ignored), extracted from the local install (build
6860), with a manifest entry for each file. The decoded HUD sources are kept in
`_art/parity/source/` as evidence. Without `_art/`, the canvas drops the art stylesheets: the frame
is drawn as an SVG outline, the markers as CSS shapes, and the lanes still render.

The orientation follows the screenshot. The player is on the Hidden King, which the localisation
names as Team 1, Amber. Friendly is therefore at the bottom, so no rotation is needed.

## Elements and sources

| Element | Source | Values used |
|---|---|---|
| Container, frame | `hud.vcss`: `#minimap_container`, `#minimap_frame`; `hud.vxml` order: blur, frame, map | 400×400 frame. `compass_frame_psd`, masked by `compass_frame_mask_psd` (alpha), `background-size: contain` |
| Map | `hud.vcss` `#HudMinimapContainer` 105%; `hud_minimap.vcss` `#hud_minimap` | 360×360, centred in the frame |
| Terrain | `hud_minimap.vxml` `backgroundImage1`; `.backgroundImage1` | `minimap_midtown_mid_psd`, 100% × 100%, z −3, drawn as is |
| Lane lines | zipline paths `Lane1`, `Lane4`, `Lane6` from `citadel_zipline_path` `pathnodes`, drawn as Bezier curves | Friendly half in the lane wash, enemy half in `ColorEnemyObjective` `#DC4C2F` |
| Walker | `.boss_icon_t2` 64px; `boss_health_t2` + `boss_health_fill_t2` | Wash: enemy `#DC4C2F`; friendly yellow `#FFDF40`, blue `#2EC7E6`, purple lane `#6BB247` |
| Guardian | `.boss_icon_t1` 40px; `boss_health` + `boss_health_fill`; `info_super_trooper_spawn` with \|y\| < 5000 | Same washes |
| Patron | `.boss_icon_t3` 80px; `boss_health_final(+_fill)`, plus `_stage2(+_fill)` | Friendly is rotated 180° and washed `offWhite` `#FFEFD7` |
| Base guardian | `.boss_barracks_icon` 40px; `boss_health` | Outline only, matching the screenshot's state |
| Shrine | `.boss_buildingzip` 32px; t2 images | Wash as the patron's |
| Mid boss | `.mid_boss.midboss_spawned #Spawned` 64px; `super_neutral_marker_psd` | Full colour, z 4 |
| Camps | `.neutral` 24px; `neutral_small` / `medium` / `large` / `vault` by `subclass_name` | z 2 |
| Shops | `.tier1_shop` 36px; `minimap_shop_psd` at 50%, `img-shadow 8px black` | z 3 |
| Unstable Rift | `.capture_point` 32px; black disc, `minimap_icon_koth_png` at 70%, 2px `shardColor&50` border | West site only, as in the screenshot |
| Powerups | `.powerup_survival` / `.powerup_casting` 20px; `powerup_health` / `powerup_magic` svg | Wash `#D7FF9A` / `#E1A6FF` |
| Souls dealer | `.corrupted_item_shop` 16px; broker svg | Opacity 0.2, saturation 0 (closed) |
| Local player (green eye) | `.localplayer.friend` 15%, `#MainImage` 110%; `player_marker_self` + spec highlight | At the Amber spawn centroid |
| Location tag | `hud.vcss` `#minimap_location`, `.location_district`, `.location_building`; `citadel_main_english`: `map_district_amber`, `map_district_building_base` | −30°, `offBlack&ee`, 3×10 px padding, 13px. `block` font is VALVEPulp, so this uses the stack's own fallback, Noto Sans, condensed |

Positions come from map entities through `left = (x+R)/2R`, `top = (R−y)/2R`, with `R = 10752`.
On the render, every objective, camp and shop lands on a street.

## Checked against the screenshot

`_art/reference/ingame-hidden-king-base.png` (924×1001) is now the compare overlay. It's aligned
by fitting the frame's outer edge to the badge in the image: scale 92.4% of the 1000 px stage
(1:1 natural size), offset −10, −115. The reconstruction includes the container's
`ui-scale: 105%`. With that applied, the badge widths match to the pixel.

Corrected against the screenshot:
- Base guardians are lane-tinted, filled diamonds, one per lane at the pair's midpoint. The first
  pass had grey outlines for each entity of the pair.
- The souls dealer isn't drawn, because it isn't visible while closed.
- The local player's arrow points up.
- The location tag sits about 85 Panorama px higher than the layout maths put it.

## Where it still differs (most visible first)

1. **No live world behind the HUD.** The game blurs the 3D scene behind the translucent frame
   (`world-blur: ingameHudBlur`). A flat gradient stands in for it, so the frame reads flatter
   and cooler than in game.
2. **The tag font.** VALVEPulp is proprietary. Its Noto Sans fallback is wider and rounder, and
   "BASE" is set in caps at full size where Pulp uses smaller caps-only glyphs.
3. **Base guardians sit 10–15 px off.** The HUD seems to place each pair's single marker on
   one entity, or on a point other than the midpoint.
4. **The enemy patron arch sits about 10 px high,** and the friendly arch slightly low. Either
   the arch's anchor isn't the patron's origin, or the 180° rotation pivots differently.
5. **The lane-line stroke.** The lines are canvas-drawn, so there's no source for them. 1.5 px
   at 85% opacity, split at the centre line, matches the screenshot to the eye.
6. **The local player marker.** Its facing comes from code, and the green cone isn't drawn.
7. **Wash maths.** `wash-color` is approximated as image × colour. The tints match within a
   few levels in the difference view; the cream patron reads slightly brighter.

## Renderer spec (for the app)

Everything below is what `design/shared/minimap.js` and `minimap.css` do. All numbers come from
the HUD sources unless marked *chosen*.

### Coordinates

- **Map square:** the `minimap_midtown_mid` texture fills it exactly, at 100% × 100%. Call its
  side 1000 units.
- **World to map:** `mx = (x + 10752) / 21504 × 1000`, `my = (10752 − y) / 21504 × 1000`.
  - Map y grows downward, and Amber (team 2) sits at the bottom.
  - `R = 10752` is deadlock-api's constant. Checked against the screenshot, every objective,
    camp and shop lands on its street.
- **One HUD px** is 1000/360 = 2.778 units. The game's `#hud_minimap` is 360 px.
- **Frame:** `#minimap_frame` is 400 px and the map is 360 px, centred. With frame side `F`, the
  map square has side `0.9F`, offset `0.05F` on each side. In game, `#minimap_container` adds
  `ui-scale: 105%`; parity applies it, and the board doesn't need to.

### Layer order, bottom to top

| # | Layer | Source / notes |
|---|---|---|
| 0 | World behind the HUD | In game, a gaussian(2,2,2) blur of the live scene; here a flat backdrop |
| 1 | Frame | `compass_frame_psd`, opacity-masked by `compass_frame_mask_psd` alpha, `contain` in the frame box |
| 2 | Terrain | `minimap_midtown_mid_psd`, drawn as is; z −3. The board's "Map darkness" tweak is `brightness(1 − shade)` on this layer only |
| 3 | Lane lines | z −1, drawn in code (below) |
| 4 | Powerups, Unstable Rift | z 0 |
| 5 | Neutral camps | z 2 |
| 6 | Shops | z 3 |
| 7 | Mid boss | z 4 |
| 8 | Objectives: guardian, walker, base guardian, shrine, patron | z 15 |
| 9 | Local player marker | z 18; parity only |
| 10 | Board layers | Arrows, then ink and callouts, then drag ghosts, then hero tokens, then cursors and name tags |

### Markers: size (width = height, in map units), images, tint

| Marker | Units | Layers, bottom to top | Tint |
|---|---|---|---|
| Guardian (t1) | 111.1 (40 px) | `boss_health` + `boss_health_fill` | Objective tint |
| Walker (t2) | 177.8 (64 px) | `boss_health_t2` + `boss_health_fill_t2` | Objective tint |
| Base guardian | 111.1 (40 px) | `boss_health` + `boss_health_fill`; one per team and lane, at the midpoint of the entity pair | Objective tint |
| Shrine | 88.9 (32 px) | `boss_health_t2` + `boss_health_fill_t2` | Team-only tint |
| Patron (t3) | 222.2 (80 px) | `boss_health_final` + `_final_fill`, rotated 180° when friendly; then `_final_stage2` + `_stage2_fill`, not rotated | Team-only tint |
| Mid boss | 177.8 (64 px) | `super_neutral_marker` (the spawned state), untinted | — |
| Camp | 66.7 (24 px) | `neutral_small` / `medium` / `large` / `vault` by `subclass_name` weak / medium / strong / vaults | — |
| Shop | 100 (36 px) | `minimap_shop` at 50% (25% inset), shadow 8 px black | — |
| Unstable Rift | 88.9 (32 px) | Black disc; `minimap_icon_koth_png` at 70%; 2 px border `#99FFD6` at 0x50 alpha. Only the active site is drawn | — |
| Powerup | 55.6 (20 px) | `powerup_health` / `powerup_magic` svg | `#D7FF9A` / `#E1A6FF` |
| Local player | 150 (15% of map) | `player_marker_self` at 110%, then the spec highlight; rotation = facing − 90° | — |

**Wash.** Panorama `wash-color` is implemented as image × tint (multiply), masked by the
image's own alpha.

**Tints by viewpoint.** "Friendly" means the viewer's team.

| | Amber viewpoint | Sapphire viewpoint | Neutral |
|---|---|---|---|
| Friendly guardian, walker, base guardian | Lane colour: west/yellow `#FFDF40`, mid/blue `#2EC7E6`, east/purple lane `#6BB247` | Same lane colours | — |
| Friendly patron, shrine | offWhite `#FFEFD7` | offWhite | — |
| Enemy objectives | `#DC4C2F` (ColorEnemyObjective) | `#DC4C2F` | — |
| All objectives | — | — | Amber `#E7B659`, Sapphire `#5B79E6` (ColorTeam1/2) |
| Lane lines, friendly half / enemy half | lane colour / `#DC4C2F` | lane colour / `#DC4C2F` | Amber half `#E7B659` / Sapphire half `#5B79E6` |
| Patron rotated 180° | Amber's | Sapphire's | Amber's (team1 rule) |

**Viewpoint rotation.** For the Sapphire viewpoint, the terrain, lanes and marker positions turn
180° about the map centre, so Sapphire sits at the bottom. Every marker is then counter-rotated
180°, so icons stay upright. Board layers aren't rotated: their positions are mapped to
`(1000 − x, 1000 − y)`, and text stays upright.

**Lane lines.** These are drawn in code; the game uses a `UICanvas`.
- **Source:** the `citadel_zipline_path` entities `Lane1`, `Lane4` and `Lane6`. Each one's
  `pathnodes` holds nine floats per node: position, in-tangent and out-tangent, all local to the
  entity origin.
- **Curves:** world point `P = origin + p`. Each segment is a cubic Bezier
  `P_i → (P_i + out_i) → (P_{i+1} + in_{i+1}) → P_{i+1}`, mapped to map units.
- **Lane identity:** each path takes the lane of the nearest Amber walker (yellow, blue or
  purple).
- **Stroke** *(chosen; no source)*: 4.17 units (1.5 px), opacity 0.85, round caps.
- **Colour split:** clipped at the map's centre line `my = 500`, where world `y = 0`. The Amber
  half and Sapphire half take their colours from the table above.

**Zoom.** For a view rectangle `(x, y, w)`:
- the map square scales by `1000/w` and shifts by `(−x, −y)`;
- markers stay at their unzoomed size (`scale: w/1000`), as in game;
- the view is clipped by the frame mask, scaled to 111.1% of the map box.

**Fallback.** Without `_art/parity/parity.css`, the frame becomes an SVG outline and markers
become CSS shapes in the same tints. The lanes are unchanged.

**Data provenance.**
- Objectives: `npc_boss_tier2` / `tier3`, `npc_barrack_boss`, `info_super_trooper_spawn` with
  |y| < 5000, `destroyable_building` (shrines), and `info_neutral_trooper_spawn` with
  `npc_super_neutral` (mid boss).
- `info_neutral_trooper_camp`, `citadel_shop_prop_dynamic`, `info_koth_spawn_location`,
  `citadel_item_powerup_spawner`, and the `info_team_spawn` centroid.
- All from `maps/dl_midtown/entities/default_ents.vents_c`.

## Top bar spec (for the app)

**Sources:**
- Layouts `citadel_hud_top_bar.vxml`, `_player.vxml`, `_team.vxml` and `hero_badge.vxml`.
- Styles `citadel_hud_top_bar.vcss`, `hero_badge.vcss` and `citadel_base_styles.vcss`.
- The decoded copies are in `_art/topbar/source/`; nothing from them is committed verbatim.

**Units:** sizes are in Panorama px, and one px = bar width / 1260. The screenshot matches the
classic `#TeamsContainer` at 1260 px, not the 1400 px `showNewTopbar` variant, at 1:1.

### Layout

- **Teams:** the friendly team (the viewer's) is on the left and the enemy on the right. Each team
  block is 528 px wide: six 88 px columns, flowing left to right.
- **Each column, measured from the bar's top:**

| Element | Geometry | Style |
|---|---|---|
| Portrait | 70.4 px disc (`#424640` to `#252722`) at y 15–85. The hero's `m_strTopBarVertical` image (120×200) sits in a 70.4 × 117.3 box, bottom-aligned to the disc's bottom, opacity-masked by `hero_image_mask` | The bust spills above the rim |
| Souls box | Top at y 76 (behind the portrait), padding 20 / 5 / 0 / 5, radius 0 0 3 3 | Team colour; text 15 px bold (numericOracle); shadow 2 2 0 `#00000050` |
| Ult indicator | 22 px circle at y 125, centred | See below |

- **Team colours:**
  - Amber `#D4860B`, with `#201500` text.
  - Sapphire `#4D75C3`, with `#FFFFFF` text.
- **Clock:** centred, 8 px from the top.
  - Box: `#00000090`, radius 5, padding 5.
  - Label: 80 × 20, 14 px, offWhite at 0x90 alpha.
- **Team totals:**
  - Placement: a 300 px block centred 45 px from the top, holding two 145 px boxes.
  - Fill: team colour, masked by `dust_01` for the rough edge.
  - Label: 22 px bold.
  - Team icon: `icon_team1` / `icon_team2`, 30 × 26, beside the label: right of it for the
    friendly box, left of it for the enemy box.
- **Souls format:**
  - Under 1,000: the integer.
  - From 1,000 to 9,999: one decimal plus a smaller "k" (`.demote`, 12 px).
  - From 10,000 (team totals): an integer plus "k".
  - The value is truncated, not rounded: 44,830 shows as "44k", as in the screenshot.
- **Team totals are sums** of `PlayerState.souls`, never stored.
- **Dead:**
  - The portrait goes grayscale at 0.1 brightness.
  - The souls box and the ult indicator drop to 30% opacity.
  - The health bar is hidden.
  - The respawn timer comes from code, and the board has no field for it, so it isn't drawn.

### Art keys (`_art/topbar/`, from `pak01_dir.vpk`)

`topbar.css` sets each image on a selector; there are no `url()`s in custom properties.

| Key / selector | Entry | Used for |
|---|---|---|
| `.hero-vertical[data-hero=<key>]` | `panorama/images/heroes/<m_strTopBarVertical>_psd` (120×200), `<key>` = heroes.vdata key without `hero_` | Portrait |
| `.tb-img` mask | `hero_badges/hero_image_mask_psd` (280×380) | Bust mask, 100% × 100% of the portrait box, bottom-aligned |
| `.tb-ult.ready .tb-ult-icon` | `hud/top_bar/icon_ultimate.vsvg` | Ready eye |
| `.tb-ult.cooldown .tb-ult-icon` | `hud/top_bar/icon_ultimate_off.vsvg` | Cooldown glyph |
| `.tb-score-bg` mask | `masks/dust_01_psd` | Rough edge of the totals |
| `.tb-score.<team> .tb-team-icon` | `hud/core/icon_team1_psd` / `icon_team2_psd` | Team emblem |
| `.tb-health-back`, `.tb-health-fill` mask; `.tb-health-border` mask | `hud/healthbar/healthbar_backer_vert_mask.vsvg`, `…_border.vsvg` | Health bars (parity only) |

The map tokens and roster chips use the minimap portraits instead: `.hero-mm[data-hero=<key>]`
in `_art/art.css`, from `panorama/images/heroes/<m_strMinimapImage>_psd`.

### Ult indicator geometry

- **Ready:** the 22 px circle shows `icon_ultimate` at full opacity, with a black glow (0 0 4 px,
  spread 3).
- **Cooldown:**
  - Disc: offBlack, black glow (0 0 8 px, spread 3).
  - Elapsed arc: a conic gradient in the team colour, from `left`% to 100%, clockwise from
    12 o'clock.
  - Icon: `icon_ultimate_off`, inset 2 px, at 60% opacity.
  - Remaining wedge: `#000000a0` from 0 to `left`%, inset 2 px.
  - Here `left` = `ult_cooldown`.
- **Edit affordance:** dragging around the ring maps the angle to a percentage (0° = 0%,
  clockwise), scrolling steps by 5%, and a click sets 0 (ready).

### What the indicators mean

- **The round icon under the souls box is `.UltimateStatus`.**
  - **Eye:** `icon_ultimate`, the ready state (`UltimateCooldownReady`).
  - **Greyed glyph:** `icon_ultimate_off` at 60% opacity, on an offBlack disc with a
    team-colour background. That's the unlocked, cooling-down state.
  - **Not unlocked:** the whole indicator is hidden.
- **The slanted pale card is the friendly `#HealthBar`:** 16 × 50, −10°, offWhite fill whose
  height is the health fraction.
- **The red bars are the enemy health bars:** +7°, `#FF5656`. Both show only when the game
  marks health as visible (`HealthVisible`).
- **The "k"** is the `.demote` span that code adds to the souls text (`html="true"`). The format
  rules above are inferred from the screenshot and the sources.

### Ult cooldown on the board (`PlayerState.ult_cooldown`)

- **0** shows the ready eye.
- **1–100** shows the cooldown state, plus two layers the stylesheet doesn't have:
  - a dark wedge for the share of cooldown left, clockwise from 12 o'clock;
  - a team-colour arc for the elapsed share.

  The game itself only switches between the two icons. The screenshot's cooldown icons do show a
  partial team-colour ring, and the arc reproduces it.
- **null** (untracked) is hidden, which matches the game's locked state. On the editable board
  it shows as a faint dashed empty ring, so it can be clicked.

### Health

The board doesn't track health, so it draws no health bars. Only this parity reconstruction draws
them, from fixed sample values.

### Top bar: where it still differs (most visible first)

1. **Clock box:** about 6 px lower and darker than in game, where `world-blur` lightens what's
   behind it.
2. **Score boxes:** about 4 px taller, and the `dust_01` edge is softer.
3. **Fonts:** VALVEOracle, VALVEPulp and Gulim aren't available, so the numbers use the
   stacks' Noto Sans fallback.
4. **Health bars** use plain fills where the game composes two textures, so the enemy bar's dark
   backing reads slightly differently.
5. **Kill-streak glow, voice bar and local-player coin highlight** are state-driven and aren't
   drawn.
