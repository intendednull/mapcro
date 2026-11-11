# Plan: in-game stat panels and item/ability tooltips (2026-11-10, draft)

Goal: the replay's Tab columns show what the game's Tab screen shows on hover: the Weapon /
Vitality / Spirit stat panels with their investment ladders, and the item and ability tooltips.
Built from the game's own data and art, extracted into the pack; no hand-drawn art.

## Reference

Screenshots (game art and a Steam name, so outside the repo):
`~/.local/share/mapcro-lead/reference/game/`.

| File | Shows |
| --- | --- |
| `tab-scoreboard-2230.png` | the Tab scoreboard, 12 columns, mid-game (resists like "12% 10%") |
| `topbar-ingame.png`, `topbar-strip-{1,2,critical}.jpg` | the top bar, incl. the critical card |
| `hidden-king-base.png`, `minimap-hidden-king.jpg` | the minimap |
| `stats-weapon.png` | hovering the weapon bar: WEAPON STATS (gun name, range tags, DPS, falloff, 12 stats, melee) + Weapon Investment ladder |
| `stats-vitality.png` | VITALITY STATS (max health, regen, bullet/spirit/melee resist, movement) + Vitality Investment ladder |
| `stats-spirit.png` | SPIRIT STATS (cooldown, duration, range, lifesteal, charges) + SPIRIT POWER IMPACT (per-ability scaling rows with ability icons) + Spirit Investment ladder |
| `item-djinns-mark.png` | an ability tooltip: description with inline icons and highlighted terms, cooldown, property cards (spirit-scaled value "×0.35"), detail rows, the three upgrade-tier cards (1/2/5) |
| `item-infuser.png`, `item-escalating-exposure.png`, `item-slowing-bullets.png` | item tooltips: category-coloured textured backgrounds, "Owned", stat list, Active/Passive block with cooldown, property cards, "Upgrades from/to", build-popularity line |

The screenshots are a sandbox match on the operator's account, so they double as **known-good
values**: Mirage, level 0, these exact items → 1470 max HP, 0% bullet / 33% spirit resist,
176 spirit power, 28 bullet damage, 91% weapon damage, 120% clip size. Any calculator is tested
against them before it's shown.

## What we need, by part

### 1. Item and ability tooltips (mostly static game data: build first)

Data (extend `crates/extract`, `abilities.rs`; all from files it already reads or their siblings):
- Descriptions: the `<name>_desc` / active / passive localisation strings, with the game's
  markup kept as structure (highlight spans, `{s:Prop}` value substitutions, inline icon tokens).
  Render with our own small formatter, never as raw HTML.
- Properties: `m_mapAbilityProperties` per record (value, unit, stat label key, icon class,
  spirit/weapon scaling such as "×0.35"), and the tooltip layout the game uses
  (`m_vecTooltipSectionInfo` / important-property cards), so we show the same properties in the
  same blocks rather than guessing.
- Cooldown, duration, charges; active vs passive (this also closes the "active-item designation"
  backlog item, from game data rather than cast absence).
- Ability upgrade tiers (the 1/2/5 cards), `Upgrades from / to` (components exist; add the reverse
  index).
- Skip: "Purchased late game in 64% of matches" (Valve's own stats, not in the files).

Art (extend the allow-list in `allow.rs`, one file at a time, as for the top bar):
- The tooltip layouts and styles from `panorama/layout` / `panorama/styles` (the item/ability
  tooltip files): sizes, colours, fonts, which we port as we did the top bar.
- The textured category backgrounds (weapon orange, vitality green, spirit purple, ability dark)
  and the torn-paper frame, the stat icons (spirit-damage heart, lifesteal, cooldown clock, range,
  "Owned" check), and the "ACTIVE" badge. Locate exact paths with a bounded listing of the VPK's
  `panorama/images/` directory tree (not the Steam dirs).

UI: hover (desktop) / tap (touch) on an item or ability in the Tab column opens the tooltip,
anchored like the game's. Values at the replay moment only where recorded (cooldown left,
charges); the rest is the item's own static values.

### 2. Stat panels (calculated values: needs a decision)

- Investment ladders: the per-category tier table (souls breakpoints 800 → 28.8K and the bonus at
  each, e.g. weapon +9% → +115%, spirit +7 → +100) from `generic_data.vdata`; the bar fill and
  the current row come from souls spent per category. The souls spent is recorded (items
  timeline), so this part is **recorded + static data**, no formulas beyond the ladder lookup.
- The stats themselves (max HP aside, which is recorded) are not in the replay (resist audit,
  `docs/research/scoreboard-values.md`). They need a calculator: hero base stats and level scaling
  from `heroes.vdata` (`m_mapStartingStats`, level-up bonuses), item and ability modifiers from
  `abilities.vdata`, the investment bonus, and the game's stacking rules (boon's `hero_stats`
  implements this). Same open question as resists: **show calculated values, labelled?**
- Build matching: the replay records its game build (129738985 is 6839, our pack is 6860). Item
  stats change between patches, so a calculated panel needs the pack for that build, or a clear
  "current patch values" label.
- The weapon card (gun name, "Medium Range / Heavy Hitter" tags, falloff, DPS) is static hero data
  plus calculation; the gun picture is a render that may not exist as a flat image, so we drop it
  if it isn't in the files.

### 3. Order

1. Extraction: descriptions, properties, tooltip sections, cooldowns, active flag, upgrade tiers;
   pack schema 5. Plus the tooltip art and layout files.
2. Item/ability tooltip UI in the Tab column, ported from the game's layout and styles.
3. Investment ladders (recorded souls + tier table).
4. Only after the operator's decision: the stat calculator, tested against the screenshots'
   values first, then build-matched packs.

## Decisions for the operator

- Show calculated stats (resists, stat panels), marked as calculated? Without this, part 2 is the
  ladders only.
- Build-matched packs (one per game patch a replay was played on) vs one current pack with a
  "current patch" note.
- Hover-only, or also pin a tooltip open (useful when reviewing)?
