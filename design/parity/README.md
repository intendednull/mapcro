# parity: the in-game minimap, rebuilt from its sources

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
