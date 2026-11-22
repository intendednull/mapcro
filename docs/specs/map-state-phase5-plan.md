# Map-state phase 5: the remaining rows and the marker baseline (plan)

Status: revised plan, 2026-11-21 (branch `map-state-p5`, off main `f09c0c1`). Incorporates all
operator decisions (Q1–Q7, Q10–Q11) and the phase 5 plan review's must-fixes. Nothing in it is
built yet; R1 starts once TD-145 lands on `main` and is merged into this branch.
Spec: `docs/specs/map-state.md` (§4.2–§4.5 storage, §5 consistency, §6 rendering, §8 phase 5:
"The remaining rows, each a release behind its reader; the marker baseline.").

Measurements below were taken on the reference replay 129738985 (529 frames, every 5 s) and on
134623152 (510 frames), with this plan's packing, by a throwaway script: counts and bytes only
(adjusted for the new `unseen` hero row). A real save's total is measured again by a test in R3.

## 1. Scope

**In phase 5** (spec §6 "The rest", and what `MapState` holds that a scene still doesn't):

| Group | Features | Fields of `MapState` it fills in a scene |
|---|---|---|
| A, heroes and lanes | each team's sight, CC, movement, the lanes' colours, death skulls | `HeroState.inSight` (as each team's sight), `cc`, `height`, `zipline`; `LaneState.edges`; `SceneFacts.deaths` |
| B, the marker baseline | camps, heals, crates and the Mid-Boss; powerups; objectives' health; the rift; the urn; the Rejuvenator | `MarkerState.camp`, `powerup`, `health`, `rift`, `site`, `shopClosed`; `SceneFacts.urn`, `rejuv` |

Also in phase 5:
- **Scene hero health arc (Q3):** draw a scene's stored hero `health` (already stored since phase 2
  on replay-tier saves) as Player's token arc under Health, turned on in **R2** (zero existing DOM
  pin impact: see §5 R2).
- **Scene bar timers (TD-141, partial):** the scene's top bar draws the Rejuvenator badges/timers
  and Mid-Boss respawn from `MapState`, and `PlayerTopBar` stops reading the timeline for them
  (R1 reader/wiring; active on scenes in R3).

**Not in phase 5** (decided, Q1 & Q4):

- **`lastSeen` (Q1).** Under the operator's rule a scene draws only the faded hero, never a
  last-seen marker, so no scene reads it. Not stored; a scene's `lastSeen()` stays `null`, making
  a ghost in a scene impossible rather than merely unused. The §9 property leaves it out with that
  reason.
- **Troopers and death recaps (Q4).** Neither is in `MapState` yet (no producer, phase 3's work),
  and a recap needs a way to open it in a scene. Measured: troopers 0.3–1.2 KB a frame, recaps of
  the heroes dead at the frame up to 1.6 KB. They fit (480 scene list ints remain in
  `max_more_ints`); they are a later pair of releases of their own.
- **Active effects (Q4).** The build's Effects popover measures 3–36 KB a frame over twelve heroes
  (median 9 KB on 129738985): over the save's budget on their own (§4.4). Not planned.

## 2. Rules every new row follows

- **Defaults are not stored** (§4.5). Each row's default is in its table line. A feature is
  captured when its `has_<feature>` flag is true and every row of the feature is below the
  watermark (`rows`): then an absent key reads as the default. Otherwise the feature is not
  captured, and the legacy meaning applies.
- **One flag per feature** on `SceneState`, as `has_builds` and `has_heroes` are. Save and Retake
  set a flag only when the timeline holds the feature (`featuresOf`, §6) and the rows were stored.
- **Times are seconds left at the frame** (§3), whole seconds, `-1` for none. The reader turns them
  back into match seconds as `frame + left` (or `frame - since` for `rejuv.taken`,
  `frame - tenthsAgo / 10` for `skulls`), where `frame` is `Scene.source.t` (never edited); every
  scene reader that subtracts `t` (`MarkerTips`, `TopBar` timers, `fromScene`) uses the same
  `frame`. Editing `Scene.clock` still changes only the bar's label.
- **Marker identity in packed lists (Q11):** the **FNV-1a 32-bit hash** of the UTF-8 bytes of the
  board marker key (the key after `markerKey`, as `ObjectiveState.key` is): offset basis
  `0x811c9dc5`, prime `0x01000193`, unsigned `0..=u32::MAX` (`-1` reserved for "none" in `rift`
  and `urn` site fields). The reader hashes the board's markers (cached in a `WeakMap` by marker
  list) and looks each entry up; an unknown hash (the pack changed) is ignored, as an
  `ObjectiveState` with an unknown key is today. Capture checks the board's markers for hash
  collisions and omits any colliding markers from packed lists (falling back to `ObjectiveState`
  for any non-up colliding marker so none is ever misrepresented as up). None collide on the
  shipped map (pinned by a unit test on `web/src/map/fallback-data.ts`). Permanent once R3 writes
  it (§4.3).
- **Over-length packed lists:** every Group B packed list (`camps` max 200 entries, `obj_health`
  max 40, `powerups` max 4) is sorted deterministically by marker key before packing. If a future
  pack/map ever produces more entries than the row's `len` holds (e.g. > 200 non-up camps/heals/
  crates/Mid-Boss), capture **omits the list and its `has_*` flag completely** — never truncating
  under a `true` flag (which would falsely draw omitted cleared markers as up) and never emitting
  an invalid op. On Save, because the flag is unset, Save falls back to writing `ObjectiveState`s
  for those markers while they fit `max_ops_per_tx` (leaving the feature uncaptured if not). On
  Retake / `canRetake`, an over-length feature at `scene.source.t` counts as unavailable for that
  frame so Retake is never offered as a no-op. If a future Deadlock patch grows past 200 camps,
  `camps.len` widens cleanly one release ahead of its writer (§4.3).
- **Choices are `Int`s with permanent tables** in `web/src/mapstate/build.ts`:
  - CC: `1` Stunned, `2` Silenced, `3` Disarmed (absent/0: none).
  - Powerup buff: `0` casting, `1` gun, `2` movement, `3` survival, `-1` unknown (drawn as a
    generic powerup without its buff).
  - Team: `0` amber, `1` sapphire, `-1` none.
  - Hero slot (`skulls`): `0..5` amber-0..5, `6..11` sapphire-0..5.
- **Rows go live in order** (§4.3). Group A's rows (16–26) precede group B's (27–39) in the
  registry, so R2 makes group A `Live` (`WRITTEN = 27`) while group B stays `Ahead`.
- **What is derived stays derived** (§4.5): a skull's place is its dead hero's record (`last()`,
  where it stood: D4), a carried urn's place is its carrier's (`pos() ?? last()`), a skull's
  opacity is its captured age (`1 - (age / 2.5)^2`), and a lane shop's state is its nearest
  guardian's (`shopsClosed`, gated on the baseline so old scenes keep D5 and zero DOM pins move).
  Dragging a dead hero moves its skull; reviving a dead hero hides its skull; dragging the urn
  carrier moves the urn.
- **Status wins** (§5): an `ObjectiveState` a coach set, or one an older save wrote, wins over the
  baseline; the baseline is detail under it (a camp/mid-boss timer shows only while down; a powerup
  buff shows only while up; `RiftRings` doesn't draw on a rift the coach turned off).

## 3. The rows

Existing registry: rows **0–15** (16 rows, ending with `has_heroes` at index 15). Row keys are
globally unique across `ROWS` (`crates/schema/src/map_state.rs`).

Bytes below are the row's key, value and comma as JSON (`,"key":val`). Caps (§4.4):
`max_more_bytes` 8,192 a record, `max_more_ints` 1,280 a record, `max_tx_bytes` 65,536 a
transaction, `max_ops_per_tx` 256, `max_records` 5,000 a board.

### Group A: heroes and lanes (rows 16–26, 11 rows)

| # | Key | Record | Kind and bounds | Value (and default) | Bytes | Producer (Player) | A scene draws | An old scene draws |
|---|---|---|---|---|---|---|---|---|
| 16 | `has_sight` | scene | `Bool` | per-team sight is captured | 17 | `featuresOf(m).sight` | — | — |
| 17 | `unseen` | hero | `Bool` | `true`: enemy team cannot see this hero; default `false` (seen) | ≤ 14 a hero | `tenthPart(m, second).sight[i] !== true` | Player's Vision logic (D3, Q2): under All nobody faded; under a team's Vision an enemy with `!inSight` is faded where it stands; Show last seen changes nothing | `visible: false` faded for every viewer (D5) |
| 18 | `has_cc` | scene | `Bool` | | 14 | `featuresOf(m).cc` | — | — |
| 19 | `cc` | hero | `Int { 0, 15 }` | `1` Stunned, `2` Silenced, `3` Disarmed; default none | ≤ 7 a hero | `tenthPart(m, second).cc[i]` | the token's CC under Crowd control, for a living hero drawn as seen (never on a faded or dead one) | no CC |
| 20 | `has_movement` | scene | `Bool` | | 20 | `featuresOf(m).movement` | — | — |
| 21 | `height` | hero | `Int { 0, 15 }` | `1` above, `2` below street level; default `0` (`undefined`) | ≤ 11 a hero | `secondPart(...).movement[i].height` | the token's ▲/▼ under Elevation & ziplines, living and seen | none |
| 22 | `zipline` | hero | `Bool` | riding one; default `false` | ≤ 15 a hero | `...movement[i].zipline` | the token's zipline ring, living and seen | none |
| 23 | `has_lanes` | scene | `Bool` | | 17 | `featuresOf(m).lanes` | — | — |
| 24 | `edges` | lane (`Wave`) | `Ints { len: 2, 0, 1000 }` | `[amber, sapphire]` on `Wave.t`'s scale, rounded | ≤ 29 a lane (with `,"more":{}`), ≤ 87 a scene | `secondPart(...).lanes` | the zipline colours following `Wave.t` (Q7, below) | one split, no colours |
| 25 | `has_skulls` | scene | `Bool` | renamed from `has_deaths` (row 12 is hero `deaths`) | 18 | `featuresOf(m).skulls` (any timeline) | — | — |
| 26 | `skulls` | scene | `Ints { len: 36, 0, 255 }` | per death in the frame's last 2.5 s: `[slot 0–11, tenthsAgo 0–24, seen 0/1]` (default empty) | ≤ 15 measured (12 deaths ~107, bound ≤ 155) | `fromTimeline`'s `deaths` at the second | static skulls (`DeathSkulls`, Q5) at dead hero's `last()` and captured age; `shownDeaths` applies the view's sight; no recap on click | no skulls |

**Sight details (`unseen` vs typed `visible`, Q2):**
- Why a new `unseen: Bool` hero row instead of reusing typed `PlayerState.visible`:
  1. Legacy "Not seen" marks (`visible: false`, D5) keep their exact meaning in scenes without
     `has_sight`.
  2. Retake never overwrites a coach's manual mark: it writes `unseen: true` only via `SetIf` on
     absent `unseen`, leaving `visible` untouched.
  3. Rollback copies on R1 (dropping `Ahead` rows `has_sight` and `unseen`) keep every hero's
     `visible: true` intact instead of leaving match-unseen heroes faded for every viewer.
- **Reading in `fromScene` (`web/src/mapstate/scene.ts`):**
  - When `has("sight")` is `false` (no `has_sight` or `rows <= ROWS.unseen.index`): `inSight()` is
    `rec()?.visible ?? true` (exact legacy D5 rule).
  - When `has("sight")` is `true`: `inSight()` is `rec()?.more?.unseen !== true && rec()?.visible !== false`.
    On any fresh R2+ save `visible` is always `true`, so `inSight` is simply `!unseen`. On an old
    scene where a coach had set `visible: false` and later clicked Retake (adding `has_sight`),
    the hero stays not seen (now under per-team Vision logic) rather than having Retake silently
    erase the coach's manual mark.
- **Editing sight (`toggleSightOps` in `web/src/mapstate/edit.ts`, called by `TopBar.tsx`'s eye
  button and right-click menu):**
  - When `!has("sight")`: `[{ Set: { id, value: { PlayerVisible: !rec.visible } } }]` (unchanged).
  - When `has("sight")`:
    - Currently seen (`inSight() === true`, menu says **"Mark not seen"**):
      `[{ Set: { id, value: { More: { key: "unseen", value: true } } } }]`. Under Vision All the
      hero stays unfaded; under the enemy team's Vision the hero is faded (Q2).
    - Currently unseen (`inSight() === false`, menu says **"Mark in vision"**): in one transaction,
      clear `unseen` (`{ Set: { id, value: { More: { key: "unseen", value: null } } } }`) if
      `rec.more?.unseen !== undefined`, **and** set `{ Set: { id, value: { PlayerVisible: true } } }`
      if `rec.visible === false`. Both clear in one undo step, so a hero with `visible: false` from
      a pre-Retake mark cleanly returns to in vision.
- **Portrait dimming in `TopBar.tsx`:** when `has("sight")` is `true`, `<PortraitSlot unseen>` and
  the eye-off resting state follow `heroDraw` (`vision !== "all" && vision !== team && !h.inSight()`),
  matching `PlayerTopBar` and `Tokens` so Vision All never dims portraits. On old scenes
  (`!has("sight")`), `<PortraitSlot unseen>` stays `!h.inSight()`, leaving every DOM pin untouched.

**Dragged lane split math (Q7):**
- Save stores `Wave.t = Math.round((w.amber + w.sapphire) / 2)` and
  `Wave.more.edges = [Math.round(w.amber), Math.round(w.sapphire)]` (each clamped to `[0, 1000]`).
- When reading or dragging a lane that holds `edges = [a0, b0]` at effective split `split`
  (committed `Wave.t`, local `waveDrag.t`, or remote peer `remoteSmooth` drag), pure helper
  `shiftEdges(edges, split)` keeps the stored gap width `w = max(a0, b0) - min(a0, b0)` centred on
  `split`, clamped to `[0, 1000]`:
  ```ts
  const a0 = Math.min(edges.amber, edges.sapphire);
  const b0 = Math.max(edges.amber, edges.sapphire);
  const w = b0 - a0;
  return {
    amber: Math.max(0, Math.min(1000, split - Math.ceil(w / 2))),
    sapphire: Math.max(0, Math.min(1000, split + Math.floor(w / 2))),
  };
  ```
- Properties verified:
  - **Exact round-trip with no special case:** for every integer `0 <= a0 <= b0 <= 1000`, at
    `split = Math.round((a0 + b0) / 2)` (whether `w` is even or odd), `shiftEdges` returns
    `{ amber: a0, sapphire: b0 }` identically!
  - **Monotonic clamping:** `0 <= amber <= sapphire <= 1000` always holds; dragging all the way to
    `0` or `1000` smoothly pushes the near colour to zero instead of stalling at `w / 2`.
  - **Live drag & remote drag:** `Board.tsx` (`laneEdges`) applies `shiftEdges` over local and
    remote drag `t`, and `Layers.tsx` draws the raised dragged lane with `splitEdges` (not
    `splitAt`) when the lane holds `edges`, so the colours follow smoothly during the drag and on
    commit (`{ Set: { id, value: { WavePos: d.t } } }` alone — `more.edges` is never rewritten).

**Group A byte totals:** per hero at most 47 bytes (`unseen` 14 + `cc` 7 + `height` 11 + `zipline`
15), so at most 564 bytes across 12 heroes worst-case (measured ~60–110 B typical); lanes ≤ 87 B
(typical 81 B); `SceneState` flags + `skulls` ≤ 241 B worst-case (typical ~100 B). No `Ints` list
is added to a hero, so hero `max_more_ints` stays **792** (≤ 1,280); hero Group A rows are counted
inside `max_more_bytes` (8,192 B), which `captureBuild`'s `build_order` trim enforces.

### Group B: the marker baseline (rows 27–39, 13 rows)

All on `SceneState`. "Entry" is one marker.

| # | Key | Kind and bounds | An entry | Default (not stored) | Measured a scene (median / p90 / max) | Producer | A scene draws | An old scene draws |
|---|---|---|---|---|---|---|---|---|
| 27, 28 | `has_camps`, `camps` | `Bool`; `Ints { len: 600, -1, u32::MAX }` | `[hash, state 1 cleared / 2 unspawned, seconds left]`: camps, heals, crates, Mid-Boss (max 200 entries) | up | 387–816 / 1,152–1,322 / 2,786 B; up to 165 entries (first 2 min) | `secondPart(...).camps` | each marker's state & timer, hovers as Player's; scene bar's Mid-Boss respawn; lane shops close with guardian | the `ObjectiveState` statuses an older save wrote (down, no timer) |
| 29, 30 | `has_powerups`, `powerups` | `Bool`; `Ints { len: 20, -1, u32::MAX }` | `[hash, state 0 up / 1 down / 2 first-unspawned, buff, next in, next buff]` (max 4 entries) | none: every site stored | 44 B | `secondPart(...).powerups` | the buff that is up, or the next one and when | the status (taken or not) |
| 31, 32 | `has_obj_health`, `obj_health` | `Bool`; `Ints { len: 120, -1, u32::MAX }` | `[hash, percent 0–100, stage 1/2 or -1]` (max 40 entries) | 100 %, no stage | 68–84 / 103 / 133 B | `secondPart(...).health` | objectives' health under Health; the Patron's stage | none |
| 33, 34 | `has_rifts`, `rift` | `Bool`; `Ints { len: 8, -1, u32::MAX }` | one: `[open 0/1, site hash, give-up in, amber % or -1, sapphire % or -1, captured -1/0/1, next opens in, next site hash]` | — | 33 B | `riftAt` over `koth` markers | `RiftRings` & capture (mounted when `has("rifts")`); other site "elsewhere"; hover timers | the status (the rift that was up) |
| 35–37 | `has_urn`, `urn`, `urn_at` | `Bool`; `Ints { len: 8, -1, u32::MAX }`; `Pos` | `[state 0 none / 1 ground / 2 carried, team -1/0/1, slot -1/0–5, delivery hash, walks-back in (0 = returning, -1 = none), next in, next site hash]` (7 ints); `urn_at` only on ground | — | 57 B | `urnOf` | `UrnMark` (mounted when `has("urn")`); carried at carrier's token; `shownUrn` applies view's sight; hover timers | the delivery point's status |
| 38, 39 | `has_rejuv`, `rejuv` | `Bool`; `Ints { len: 8, -1, u32::MAX }` | per team holding one (max 2): `[team 0/1, revives left, ends in, since taken]` | none held | ≤ 12 B | `secondPart(...).rejuv` (with `RejuvNow.taken`) | Rejuvenator marks & timer on scene's bar (TD-141) | none |

**Registry totals (40 rows, indices 0–39):**
- `max_more_ints` per entity (cap 1,280):
  - `Entity::Hero`: `128 + 48 + 600 + 16 = 792` (unchanged)
  - `Entity::Lane`: `2` (`edges`)
  - `Entity::Marker`: `0`
  - `Entity::Scene`: `36 (skulls) + 600 (camps) + 20 (powerups) + 120 (obj_health) + 8 (rift) + 8 (urn) + 8 (rejuv) = 800` (480 left for troopers later)
- `SceneState` JSON bytes (cap `max_more_bytes = 8,192`): measured 836–1,275 B median, 1,587–1,738 B
  p90, 3,167 B max; worst-case real data with all lists full ~5.0 KB, well under 8 KiB.

### Against the save's budget

| | Records a save | Ops | Bytes |
|---|---|---|---|
| Today (v14, §4.4) | 51–72 median, 96 p90, 181 max | up to 189 | up to 47 KB |
| Group A live (R2) | the same | the same (rows ride on records already made) | + ~0.2 KB typical (≤ 0.9 KB worst-case) |
| Group B live (R3) | **− the `ObjectiveState`s the baseline replaces**: median 25–51, p90 72–82, up to 167 fewer | the same fewer | **− 4.5–9.1 KB median, up to 29.9 KB**, + the baseline's 0.4–3.2 KB |

The baseline is smaller than the records it replaces, so a save never drops `camps` to save bytes.
If a save exceeds `max_tx_bytes - TX_SLACK` (64,512 B), it drops whole optional features in this
order (clearing each flag, without replacing dropped baseline features with `ObjectiveState`s)
before trimming `build_order`: `skulls`, `movement`, `cc`, `rejuv`, `urn`, `rifts`, `powerups`,
`obj_health`, `lanes`, `sight`. A test exercises each drop on a synthetic frame; no real frame
comes near the cap.

## 4. The marker baseline and marker clicks

In the spec's terms (§4.4, D7, Q6): **the state of every camp, heal, crate and Mid-Boss at the
frame is held as `Ints` rows on `SceneState`, alongside powerups, objectives' health, the rift,
and the urn; an `ObjectiveState` exists only for a marker a coach edits and for destroyed lane/base
objectives.**

- **Save omission rule (R3, Q6):** Save omits `ObjectiveState` for any site whose covering baseline
  feature flag is actually set on that save's `SceneState`:
  - `has_camps` covers camps, heals, crates, and `mid_boss` (if `has_camps` is absent — metadata
    tier, R2, or over-length fallback — Save writes their `ObjectiveState`s as before).
  - `has_powerups` covers powerup sites; `has_rifts` covers `koth` sites; `has_urn` covers `urn`
    points.
  - Destroyed lane/base objectives (`guardian`, `walker`, `base_guardian`, `shrine`, `patron`) are
    never covered by the baseline and always get `ObjectiveState { status: "Destroyed" }`.
- **Reading (`web/src/player/markerStates.ts`):** in a scene (`!frame.player()`), `statusNow(k)`
  returns `m.status()` if stored (status wins, §5), else `m.site()` (rifts, urn points, powerups),
  else `m.camp()` (`alive → "Active"`, `cleared`/`unspawned → "Destroyed"`), else
  `frame.health() && m.health()?.stage === 2 ? "Stage2" : undefined`. Where `m.status()` overrides
  the baseline (e.g. a coach marks a cleared camp `"Active"`, or a buff-up powerup `"Destroyed"`,
  or turns an open rift `"Destroyed"`), timers (`campTip`), buff icons (`buffs`), and `RiftRings`
  respect the override and show no stale timer/buff/ring.
- **Marker clicks (`web/src/board/objectives.ts` & `Layers.tsx`, ships in R1):**
  - `isOn`, `nextPatron`, `toggleOps`, and `groupToggleOps` take an optional
    `shown: (key: string) => ObjectiveStatus | undefined` (wired from `Board.tsx`'s `markerStatus`,
    which already computes `status ?? baseline detail`; defaults to `(k) => cur.get(k)?.status`).
  - Clicking a baseline-cleared camp (no `ObjectiveState`, `shown(key) === "Destroyed"`) sees
    `isOn === false` and creates `ObjectiveState { status: "Active" }` on the first click instead
    of redundantly writing `"Destroyed"`.
  - Clicking a baseline-Stage-2 Patron advances to `"Destroyed"`, not `"Stage2"`.
  - Clicking a baseline-active rift or urn point turns it off (`"Destroyed"`); clicking the *other*
    rift turns the baseline-active one off (`Create ObjectiveState { status: "Destroyed" }`) and
    the clicked one on (`"Active"`) in one transaction.
  - In `groupToggleOps`, when `cur.get(key)` is absent, `set(key, status)` skips creating a record
    only when the marker's **effective** status (`shown(key)` with board default) already equals
    `status` — never skipping when the baseline differs from `status`.
- **Retake:** gives an old scene the baseline and leaves its existing `ObjectiveState`s alone: they
  agree at the scene's own moment, and status still wins.

## 5. The release sequence

Three releases. Each changes the schema sources, so each bumps the build id and closes open tabs as
`Outdated`. Store numbers assume no other store step lands first; otherwise they shift together.

| | Rows | Store | Floor | Board file `READS` / written | Rollback target |
|---|---|---|---|---|---|
| **R1: readers A + B** | groups A & B `Ahead` (rows 16–39) | v15, `Step::Additive`, no SQL | 12 | `READS = 4`; writes ≤ 4 (table lists 3–6) | v14 (prod), v13, v12 |
| **R2: writer A** | group A `Live` (16–26), group B `Ahead` (27–39) | v16, `NeedsReader { reader: 15 }`, no SQL | 15 | `READS = 5`; writes 5 when holding group A | R1 only |
| **R3: writer B** | group B `Live` (27–39) | v17, `NeedsReader { reader: 16 }`, no SQL | 16 | `READS = 6`; writes 6 when holding group B | R2 only |

### R1: both readers (store v15, additive, floor 12)

- **Schema:** append rows 16–26 (Group A) and 27–39 (Group B) as `ahead(...)` in
  `crates/schema/src/map_state.rs` (40 rows total). Store step 14 → 15 `Step::Additive`, no SQL,
  floor stays 12. `Admit::DEPLOYED` refuses rows 16–39 from outside (`WrongField`).
- **TD-108 (table-driven board-file version picker, Q10):** replace `holds_typed_field` /
  `holds_own_heroes` branching in `crates/schema/src/map_state.rs` and `crates/server/src/boardfile.rs`
  with one version table listing versions **3, 4, 5, and 6** upfront:
  - v3: gated typed fields (`LONG_SCENE_NAME`, `CALLOUT_SIDE`)
  - v4: `has_heroes` (row 15)
  - v5: any Group A row (rows 16–26)
  - v6: any Group B row (rows 27–39)
  Each table entry carries its `live` boolean derived from the schema constants / `ROWS[i].status == Status::Live`, so `boardfile::READS` is derived automatically (`4` in R1, `5` in R2, `6` in R3) and `file_version` picks the highest matching version (default 2). `head.rows` continues to write `written_rows()` (`16` in R1, `27` in R2, `40` in R3).
- **TD-140:** move `previewAt` (`web/src/mapstate/frame.ts`) and test-only `MatchPreview` fields
  into `web/test/support/`; keep `PlayerHero` as its own type in `shown.ts`.
- **TD-163:** fix `sitesAt` (`web/src/match/timeline.ts`) to resolve rift and powerup keys via
  `markerKey` (matching `riftAt`, `secondPart`, and capture B), instead of `known.has(key)`.
- **Client, read & render (both A and B):**
  - `FEATURES` (`web/src/mapstate/state.ts`) gains `"skulls"` and `"obj_health"`; `SceneRecords`
    gains `frame` (`Scene.source.t`) and `markers`.
  - `fromScene` decodes all of Group A (`sight`/`unseen`, `cc`, `movement`, `lanes` with
    `shiftEdges`, `skulls`) and Group B (`camps`, `powerups`, `obj_health`, `rifts`, `urn`,
    `rejuv`, plus `shopClosed` when `has("camps")`).
  - `Tokens.tsx` draws CC, height and zipline in a scene from `HeroState` for living, seen heroes
    (scene health arc stays off until R2 so existing v14 scenes don't change on R1!).
  - `TopBar.tsx` dims portraits by `heroDraw` when `has("sight")`, routes sight edits through
    `toggleSightOps`, and renders `RejuvBadge`/`RejuvTimer`/`RespawnTimer` from `MapState`.
  - **TD-141 (bar timers):** move `RejuvBadge`/`RejuvTimer`/`RespawnTimer` into `TopBarParts.tsx`,
    add `taken: number` to `RejuvNow`, and switch `PlayerTopBar` to read `RejuvNow.taken` and the
    Mid-Boss's `marker(...).camp()` from `MapState` (no timeline read for them).
  - `Board.tsx` / `Layers.tsx` / `MapView.tsx`: lanes follow dragged split with `shiftEdges` (both
    committed and live/remote drag); `markerStates` reads `status ?? baseline detail` with status
    winning; `RiftRings`, `UrnMark`, and `DeathSkulls` (no recap on click in a scene, Q5) mount in
    a scene when their feature is captured; `MarkerTips` uses `frameT` (`Scene.source.t`) in a
    scene; `web/src/board/objectives.ts` clicks read `status ?? baseline detail` (§4).
- **Client, write (dormant for both A and B):** Save's and Retake's capture for both Group A and
  Group B land behind `WRITTEN` (16 in R1), tested with synthetic `written = 27` and `written = 40`.
- **Copy filter (`addSceneOps`, `web/src/board/scenes.ts`):** strips `Ahead` keys (`index >= written`)
  from every record's `more` and lowers `SceneState.more.rows` to `Math.min(old, written)` when any
  key is dropped or `old > written`, so copies made after a rollback are whole instead of refused.
- **Users see:** nothing. No scene holds rows 16–39; old scenes, v14 scenes, and Player draw
  byte-for-byte as before (zero DOM pins move).
- **Rolled back to v14:** nothing new is stored; every board opens and runs unchanged on v14.

### R2: writer A (store v16, `NeedsReader { reader: 15 }`, floor 15)

- **Schema & server:** flip Group A rows **16–26** to `row(...)` (`Status::Live`); Group B rows
  **27–39** stay `ahead(...)`. Store step 15 → 16 `Step::NeedsReader { reader: 15 }`, no SQL,
  floor 15. `boardfile::READS` automatically becomes **5**; files holding Group A write version 5.
- **Client:**
  - `WRITTEN` is now **27**. Save and Retake write Group A (`has_sight`/`unseen`, `has_cc`/`cc`,
    `has_movement`/`height`/`zipline`, `has_lanes`/`edges`, `has_skulls`/`skulls`).
  - **Scene hero health arc (Q3):** `Tokens.tsx` draws `tok-health` for scenes holding `health`
    when `shown().health && alive() && visible()`. **DOM pin impact: zero** — both
    `map-state-dom-pins.spec.ts` and `map-state-marker-pins.spec.ts` scene fixtures predate
    `SceneState` (`has("health") === false`).
  - **TD-161 (`canRetake`):** uses the per-feature tier table (§6) so Retake is offered only when
    the open timeline supplies a writable feature the scene lacks.
  - **TD-162 (`MapControls`):** `Health bars & arcs`, `Crowd control`, `Elevation & ziplines`,
    `Vision` select, `VisionMark`, and `useVisionKeys` (`1`/`2`/`3`) activate when **either** the
    open timeline **or** `mapState().has(...)` holds the feature (for Health: `health` or
    `obj_health`).
  - **Copy materialization rule for dropped Group B baseline (R3 → R2 rollback safety):**
    When `addSceneOps` drops Group B rows (`index >= written`) from a copied scene's `SceneState`
    (reachable after an R3 → R2 rollback), it decodes the source scene's dropped Group B baseline
    against the board's `markers` and materializes an `ObjectiveState` for every marker that has no
    `ObjectiveState` in the source scene and differs from the board's default:
    - `has_camps` dropped: `camp.state !== "alive"` (camp, heal, crate, Mid-Boss) → `Destroyed`
    - `has_powerups` dropped: `powerup.state === "down"` → `Destroyed`
    - `has_rifts` dropped: `rift.state === "active"` → `Active`
    - `has_urn` dropped: `urn.delivery === key` → `Active`
    - `has_obj_health` dropped: `health.stage === 2` (Patron) → `Stage2`
    - **Budget:** at most ~171 materialized `ObjectiveState` records (~24 KB, matching pre-R3 Save),
      appended to `rest` before `states`. `addSceneOps` already counts all created records against
      `max_records` (`full: true` → "Board full", nothing sent) and chunks via `chunkByBytes` when
      `> 256` ops or `> 63 KiB`, keeping `SceneState` last.
- **Users see:** saved replay scenes match Player at that second for heroes and lanes: per-team
  Vision fades unseen enemies (never under All; no ghost under Show last seen), "Mark not seen"
  sets enemy sight, tokens show health arcs (under Health), CC, elevation, and ziplines, lanes show
  colours that follow a dragged split, and deaths in the last 2.5 s show as static skulls. Retake
  updates older scenes saved from the open match. Marker baseline is not stored yet.
- **Rolled back to R1:** every board loads and R2's scenes draw identically (R1 reads Group A).
  Version-5 board files say "Newer file" on R1 (`READS = 4`). Copies on R1 of R2 scenes drop Group A
  rows and lower `rows` to `16` — because R2 kept `visible: true` on saved heroes, copied heroes do
  **not** become faded for every viewer (manual `visible: false` marks from old scenes stay intact).
  Editing sight on an R2 scene with `has_sight` on R1 is refused (`WrongField`, since `unseen` is
  `Ahead` on R1). v14 refuses to start (floor 15).

### R3: writer B (store v17, `NeedsReader { reader: 16 }`, floor 16)

- **Schema & server:** flip Group B rows **27–39** to `row(...)` (`Status::Live`). All 40 rows are
  now `Live`. Store step 16 → 17 `Step::NeedsReader { reader: 16 }`, no SQL, floor 16.
  `boardfile::READS` automatically becomes **6**; files holding Group B write version 6.
- **Client:** `WRITTEN` is now **40**. Save writes Group B baseline and omits `ObjectiveState`s for
  covered sites (§4, Q6). Retake writes Group B baseline.
- **Users see:** saved scenes show camps, heals, crates, powerups, rift capture rings, urn,
  objectives' health, Patron stage, marker hover timers, Rejuvenator badges/timers, Mid-Boss
  respawn on the scene bar, and closed lane shops. Saves shrink by 25–51 records median (up to 167
  early game), roughly doubling how many replay scenes fit before "Board full".
- **Rolled back to R2:** every board loads and R3's scenes draw identically (R2 reads Group B).
  Copies on R2 of R3 scenes drop Group B from `SceneState`, lower `rows` to `27`, and materialize
  non-up/active/stage-2 markers as `ObjectiveState`s (R2's copy rule above), so camps, heals,
  crates, powerups, rifts, urn points, and Patron stage never silently reset to default in the copy
  (only timers, health %, rift capture %, urn position, and Rejuvenator are lost in the copy).
  Version-6 board files say "Newer file" on R2 (`READS = 5`). R1 (v15) refuses to start (floor 16).

### Every deploy

Back up SQLite first (`pre-v15`, `pre-v16`, `pre-v17`: `docs/deploy.md`). After each deploy is
live:
- **R1:** run `just rows-lock` on the deployed commit (locks 40 rows: adds rows 16–39) and commit
  `crates/schema/rows.lock`; set `justfile` `reader` to the deployed R1 commit.
- **R2:** `just rows-lock` (unchanged: 40 rows); set `justfile` `reader` to the deployed R2 commit
  (so R3's `just reader-check` validates against R2).
- **R3:** `just rows-lock` (unchanged: 40 rows); set `justfile` `reader` to the deployed R3 commit.
- Verify the served client's build id changed, and record each release's rollback notes in
  `docs/deploy.md`.

## 6. Retake, re-picked slots, undo and TD-145

### One rule for re-picked slots

**Group A hero rows (`unseen`, `cc`, `height`, `zipline`) are slot-at-the-frame facts** (like
`pos`, `alive`, `souls`, `ult_cooldown`, `respawn`, `visible`), **not** build rows. One rule holds
across all four modules with zero contradiction:

| Module | Build rows (`IS_BUILD: true`) | Group A hero rows (`IS_BUILD: false`: `unseen`, `cc`, `height`, `zipline`) |
|---|---|---|
| `IS_BUILD` / `holdsBuild` (`mapstate/build.ts`, `buildView.ts`) | `true`; defines whether a hero holds a build | `false`; ignored by `holdsBuild` |
| `pickHeroOps` (`mapstate/edit.ts`) | cleared when picking another hero in a `has_heroes` scene | **kept** on pick (as `pos`, `alive`, `souls`, `visible` are) |
| `retakeOps` (`match/save.ts`) | skipped for a re-picked slot (`have.hero !== p.hero_id`); triggers TD-119's whole-slot write (`Set hero` + `BUILD_KEYS`) | **filled for every matched slot** (re-picked or not) by `SetIf` on absent; never triggers `Set hero` |
| `decideStep` (`mapstate/undo.ts`, TD-145) | inside `slotKeys` (`["hero", ...BUILD_KEYS]`): holds or falls together with `hero` | **outside `slotKeys`**: sent as recorded, so undoing a Retake cleanly reverts Group A rows alongside `SceneState`'s `has_*` flags even after a re-pick |

TD-146 is unchanged (Group A rows ride outside `hero` and `BUILD_KEYS`, so a Retake that only gives
Group A never races a pick at all).

### Per-feature tier rule for Save, `canRetake` (TD-161) and `retakeOps`

One table maps every feature to its `featuresOf(tl)` predicate and its highest row index, used
identically by Save, `canRetake`, and `retakeOps`:

| Feature | Rows (highest index) | Supplied by tier(s) | Exact `featuresOf(tl)` predicate |
|---|---|---|---|
| `builds` | `has_builds`..`max_health` (14) | replay & metadata | always `true` (pre-v10 scenes lacking K/D/A/max_health check `rows < 15`) |
| `sight` | `has_sight`, `unseen` (17) | replay (fmt ≥ 4) | `hasVision(tl)` (`tl.players.some(p => (p.seen?.length ?? 0) > 0)`) |
| `cc` | `has_cc`, `cc` (19) | replay (fmt ≥ 7) | `replay && tl.players.some(p => !!p.cc?.length)` |
| `movement` | `has_movement`, `height`, `zipline` (22) | replay (fmt ≥ 7) | `replay && tl.players.some(p => !!(p.height?.length || p.zipline?.length))` |
| `lanes` | `has_lanes`, `edges` (24) | replay | `!!tl.zips?.length` |
| `skulls` | `has_skulls`, `skulls` (26) | replay & metadata | `true` (both tiers have `deaths` and positions) |
| `camps` | `has_camps`, `camps` (28) | replay | `!!(tl.camps?.length || tl.heals?.length || tl.crates?.length)` (and ≤ 200 non-up entries at `t`) |
| `powerups` | `has_powerups`, `powerups` (30) | replay (fmt ≥ 2) | `!!tl.powerups?.some(p => !!p.spawns?.length)` (and ≤ 4 entries) |
| `obj_health` | `has_obj_health`, `obj_health` (32) | replay | `replay && !!tl.objective_health?.length` (and ≤ 40 entries) |
| `rifts` | `has_rifts`, `rift` (34) | replay | `!!tl.rifts` |
| `urn` | `has_urn`, `urn`, `urn_at` (37) | replay | `!!tl.urn` |
| `rejuv` | `has_rejuv`, `rejuv` (39) | replay (fmt ≥ 3) | `!!tl.rejuv` |

- `retakesFrom(scene.source.tier, tl)` still requires a replay timeline for a scene saved from a
  replay (`holdsHealth`). A metadata-saved scene can be retaken from metadata (getting `skulls` on
  R2, nothing more on R3) or from an upgraded replay (getting replay Group A + Group B; hero
  `health` stays governed by `holdsHealth(scene.source.tier)`).
- `canRetake` returns `true` iff `retakesFrom` holds and there exists at least one feature whose
  highest row index `< written` where `featuresOf(tl)` is `true` (and fits its list cap at
  `scene.source.t`) and the scene does not yet hold it (or `!c.builds || c.rows < 15`). Result:
  never offers a no-op Retake, and never writes a `has_*` flag for an absent tier feature.
- `has_heroes` is never written by Retake (only Save sets it).

### Retake atomicity for Group A (and `SceneState`)

- Every Retake write uses `SetIf` on an absent value (and for `rows`, `SetIf` on the read value,
  moving up only; for a lane missing a `Wave` record on a metadata-upgraded scene, `Create Wave`
  with `{ t, more: { edges } }`).
- **All Group A ops (hero `unseen`/`cc`/`height`/`zipline`, lane `edges`, and `SceneState` Group A
  flags + `skulls`) plus `SceneState`'s Group B rows and watermark bump go in ONE indivisible
  scene-state group**, emitted **last** (after any per-hero build groups if the scene also lacked
  builds):
  - **Worst-case op count:** `12 × 4 (heroes) + 3 (lanes) + 7 (SceneState A + rows) = 58` ops in
    R2; `+ 13 (SceneState B) = 71` ops in R3 — ≤ **28%** of `max_ops_per_tx = 256`.
  - **Worst-case byte size:** `6.7 KB (heroes) + 0.45 KB (lanes) + 1.1 KB (SceneState A) = 8.3 KB`
    in R2; `+ 7.3 KB (SceneState B) = 15.6 KB` in R3 — ≤ **24%** of `max_tx_bytes = 65,536`
    (typical ~3–5.5 KB).
- Because `chunkByBytes` never splits a group, Group A's data and its `has_*` flags always commit
  atomically in one transaction (so a partial Retake never leaves `has_sight` set without `unseen`
  or vice versa). For any scene that already holds builds (all v14 scenes), the entire Retake is
  one single transaction (one undo step). If an earlier build transaction fails, `TopBar.tsx` stops
  before sending the scene-state transaction.

## 7. Follow and view state

No new toggle, panel or filter: the layers (`layer.cc`, `layer.movement`, `layer.health`,
`layer.heals`, `layer.crates`), Vision (`vision.team`, `vision.last_seen`) and `recap.skull` are
rows already, carried outside the match gate since phase 4. No new row in
`crates/engine/src/view_state.rs`, `web/test/view-state-ledger.ts`, or `viewstate.ts`.

- **R2:** `web/e2e/follow-matrix.spec.ts`'s scene column gains a scene holding sight, CC, movement,
  and health, verifying that a follower mirrors Vision, Show last seen, and the layers there.
- **Skulls (Q5):** a skull click opens nothing in a scene, so `recap.skull` stays reset on a scene.

## 8. Tests, per release

State and sync change in every release, so each follows spec §9: characterisation first, mutation
testing of the diff, adversarial review before merge. Heavy runs go through
`/storage/projects/mapcro/tools/heavy.sh`, one at a time.

| | R1 (readers A + B) | R2 (writer A) | R3 (writer B) |
|---|---|---|---|
| **Characterisation, first** | Save/Retake pins (`map-state-pins.test.ts`, `save-as-scene.json`); `canRetake` over every scene/tier; `addSceneOps` copy ops (`scene-copy.test.ts`); `objectives.ts` clicks; DOM pins (`map-state-dom-pins`, `map-state-marker-pins`) | saved scene's tokens (health arc, sight, CC, movement), lanes (dragged split), skulls under every Vision × Show last seen (pinned on R1 first) | saved scene's markers, hovers, scene bar timers; save's record count |
| **Rust** | all 24 new rows' bounds & unique keys; `rows.lock`; `max_more_ints` (Hero 792, Scene 800, Lane 2); `Admit::DEPLOYED` refuses every row 16–39 (clear included) in txs and files; stored base/log holding them loads; v14 opens v15; TD-108 version table (v2–v6) & `READS = 4`; simulation with `Admit::READS` walks all 40 rows | store v16 (floor 15; v14 refuses; R1 opens); `READS = 5`, file v5 iff holding Group A (and no Group B); `reader-check` on R1 | store v17 (floor 16; R1 refuses; R2 opens); `READS = 6`, file v6 iff holding Group B; `reader-check` on R2 |
| **The §9 property** | `fromScene(capture(fromTimeline(t))) === fromTimeline(t)` for **both** Group A (with synthetic `written = 27`) and Group B (`written = 40`), on both tiers at every whole second, via an exhaustive table keyed by `RowKey` (`{ [K in RowKey]-?: … }`). `lastSeen` omitted (Q1); `height` `undefined` as 0; FNV-1a zero collisions on `FALLBACK`; over-length (> 200 camps) omits `has_camps` cleanly | Group A with this build's `WRITTEN` (27); Group B with `written = 40`; `shiftEdges` exact round-trip + dragged clamp `[0, 1000]` | Group B with this build's `WRITTEN` (40); Save omits covered `ObjectiveState`s and keeps destroyed objectives |
| **Sight & operator's rule** | scene with `has_sight`/`unseen`: under All nobody faded; under enemy Vision unseen hero `{ as: "faded" }` (never hidden, never ghost); toggling Show last seen changes nothing; legacy scene without `has_sight` keeps D5; `toggleSightOps` edits `unseen` (and clears `visible: false` on "Mark in vision") | e2e on 129738985 at an unseen-enemy moment under every Vision × Show last seen (faded token, no ghost, Show last seen is DOM no-op); "Mark not seen" under Vision All vs enemy Vision (Q2); scene token health arc (Q3) + `MapControls` without open match (TD-162) | |
| **Marker clicks & baseline** | `objectives.ts`: single click & group toggle on baseline-cleared camp, baseline-Stage-2 Patron, baseline-active rift/urn; status wins over baseline timers/buffs/rings; TD-163 `sitesAt` + capture B with remapped `markerKey` | R2 copy materialization test: copying an R3 scene (`written = 40`) on R2 (`written = 27`) drops Group B, lowers `rows`, materializes non-up/active/stage-2 `ObjectiveState`s without duplicating existing ones, respects `max_records` & `chunkByBytes` | e2e clicking a baseline-cleared camp marks it up in one click |
| **Retake, pick, undo** | dormant Retake for A (`written = 27`) and B (`written = 40`): atomic Group A + `SceneState` tx (≤ 58/71 ops, ≤ 8.3/15.6 KB); `SetIf` on absent only; re-picked slot skipped for builds & filled for Group A without `Set hero`; `pickHeroOps` keeps `unseen`/`cc`/`height`/`zipline`; `decideStep` sends Group A ops as recorded alongside build/pick undo; per-feature `canRetake` never offers no-op | Retake through two real replicas + server racing pick and undo (TD-119 + TD-145 sequences with Group A rows); `canRetake` on replay vs metadata scenes | same for Group B baseline |
| **Mutation testing** | decoders (A & B), capture (A & B), `shiftEdges`, `toggleSightOps`, `objectives.ts` `shown`, `CAPTURED`, copy filter, TD-108 table, `Admit` | R2 flips, `canRetake`, `MapControls` (TD-162), R2 copy materialization, health arc gate; e2e mutants on tokens & lanes | R3 flips, Save `ObjectiveState` omission, e2e mutants on markers & scene bar |
| **Rollback check** | R1 stores nothing new: `just reader-check` on v14 | `reader-check` on R1; dev DB written by R2 opened by R1: boards load, R2 scenes draw identically on R1, copies on R1 drop A & keep `visible: true` | `reader-check` on R2; dev DB written by R3 opened by R2: boards load, R3 scenes draw identically on R2, copies on R2 materialize baseline `ObjectiveState`s |
| **Walkthrough on 129738985** (Chromium, counts/hashes only) | Player, old scene, v14 saved scene, hand-made scene: identical on main and R1 | save at CC, zipline, above/below street, death second, unseen enemy, low health; compare with Player under every Vision; drag lane split & confirm colours follow; Retake a v14 scene | save at camps' first 2 min, rift capture, urn ground & carried, Rejuvenator held, Mid-Boss down; compare with Player; board record count after 20 saves on R2 vs R3 |

## 9. Resolved decisions

All open questions from the first draft are closed:

| # | Question | Decision | Decided by |
|---|---|---|---|
| Q1 | Store `lastSeen` in a scene? | **No.** Never read under D3/operator rule; leaving it out makes a ghost in a scene impossible. | operator (default) |
| Q2 | Sight & "Mark not seen" in a scene holding `has_sight`? | **"Mark not seen" means enemies can't see the hero** (unfaded under All, faded under enemy Vision). Stored in a new hero row `unseen: Bool` (row 17), not typed `visible`, keeping legacy D5, Retake non-overwrite, and R2 → R1 rollback copies clean. | operator + lead |
| Q3 | Draw a scene's stored hero health as Player's arc under Health? | **Yes, in R2** (zero existing DOM pin impact). | operator (default) |
| Q4 | Troopers, death recaps, and active effects out of phase 5? | **Yes.** Troopers and recaps wait for a later pair of releases; active effects don't fit. | operator |
| Q5 | Deaths in a scene? | **Static skulls of the last 2.5 s, no recap on click** (row renamed `has_skulls`/`skulls`). | operator |
| Q6 | Save stops writing `ObjectiveState`s for baseline-covered sites in R3? | **Yes**, per captured feature flag; R2's copy rule materializes them on R3 → R2 rollback copies. | operator (default) |
| Q7 | Dragged lane split? | **Lane colours follow the dragged split:** stored gap width stays centred on `split`, clamped to `[0, 1000]` (`shiftEdges`). Overrides draft plan. | operator |
| Q8 | Retake overwriting manual "Mark in vision" on `visible`? | **Eliminated** by new `unseen: Bool` row (Retake uses `SetIf` on absent `unseen` and never touches `visible`). | lead |
| Q9 | Release structure? | **Three releases:** R1 = both readers (A + B `Ahead`), R2 = Writer A (+ baseline copy materialization), R3 = Writer B. | lead |
| Q10 | Fix TD-108 (board-file version picker) in R1? | **Yes**, table-driven listing versions 3, 4, 5, and 6 upfront. | operator (default) |
| Q11 | Marker hash in packed baseline lists? | **FNV-1a 32-bit** over UTF-8 board marker key (`markerKey`), collision-checked at capture. | operator (default) |

## 10. Debt

Tracked in `docs/tech-debt.md`:
- **Fixed in R1:** TD-108 (table-driven board-file version picker), TD-140 (`previewAt` moved to
  test support), TD-141 (Rejuvenator pickup time and Mid-Boss respawn moved onto `MapState`; hero
  level & merging the two top bars stay open for phase 7), TD-163 (`sitesAt` + capture B map rifts
  and powerups via `markerKey`).
- **Fixed in R2:** TD-161 (`canRetake` per-feature tier check), TD-162 (`MapControls`, `VisionMark`,
  and `useVisionKeys` check `mapState().has(...)` for Health, CC, movement, and Vision).
- **Unchanged:** TD-145 (landing on `main` before R1; Group A hero rows stay outside `slotKeys`),
  TD-146, TD-100 (`obj_health` stores Patron stage regardless of Health so TD-100's fix reads it
  there).
