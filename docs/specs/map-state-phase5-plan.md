# Map-state phase 5: the remaining rows and the marker baseline (plan)

Status: plan, 2026-11-18 (branch `map-state-p5`, off main `f09c0c1`). Nothing in it is built.
Spec: `docs/specs/map-state.md` (§4.2–§4.5 storage, §5 consistency, §6 rendering, §8 phase 5:
"The remaining rows, each a release behind its reader; the marker baseline."). The operator
approved phase 5; the open questions at the end are for the lead and the operator.

Measurements below were taken on the reference replay 129738985 (529 frames, every 5 s) and on
134623152 (510 frames), with the packing this plan proposes, by a throwaway script: counts and
bytes only. A real save's total is measured again by a test in release 3.

## 1. Scope

**In phase 5** (spec §6 "The rest", and what `MapState` holds that a scene still doesn't):

| Group | Features | Fields of `MapState` it fills in a scene |
|---|---|---|
| A, heroes and lanes | each team's sight, CC, movement, the lanes' colours, deaths | `HeroState.inSight` (as each team's sight), `cc`, `height`, `zipline`; `LaneState.edges`; `SceneFacts.deaths` |
| B, the marker baseline | camps, heals, crates and the Mid-Boss; powerups; objectives' health; the rift; the urn; the Rejuvenator | `MarkerState.camp`, `powerup`, `health`, `rift`, `site`; `SceneFacts.urn`, `rejuv` |

Objectives' health is not in §6's list, but `MarkerState.health` is empty in a scene and is
Player's under Health, so it is a remaining row; it goes in group B. The bars' Rejuvenator
pickup time and Mid-Boss respawn (TD-141) come with group B's rows.

**Not in phase 5** (open question Q4):

- **`lastSeen`.** Under the operator's rule a scene draws only the faded hero, never a last-seen
  marker, so no scene reads it. Not stored; a scene's `lastSeen()` stays `null`. The §9 property
  leaves it out with that reason.
- **Troopers and death recaps** (D8, D11: stored). Neither is in `MapState` yet (no producer,
  phase 3's work), and a recap needs a way to open it in a scene. Measured: troopers 0.3–1.2 KB a
  frame, recaps of the heroes dead at the frame up to 1.6 KB. They fit; they are a later pair of
  releases of their own.
- **Active effects** (the build's Effects popover). 3–36 KB a frame over twelve heroes (median 9
  KB on 129738985): over the save's budget on their own (§4.4, "effects first"). Not planned.

## 2. Rules every new row follows

- **Defaults are not stored** (§4.5). Each row's default is in its table line. A feature is
  captured when its `has_<feature>` flag is true and its rows are below the watermark (`rows`):
  then an absent key reads as the default. Otherwise the feature is not captured, and the legacy
  meaning applies.
- **One flag per feature** on `SceneState`, as `has_builds` and `has_heroes` are. Save sets a flag
  only when the timeline holds the feature (`featuresOf`) and the rows were stored. The metadata
  tier has no sight, CC, movement, lanes, camps, powerups, rifts, urn or Rejuvenator, so its
  scenes get none of those flags.
- **Times are seconds left at the frame** (§3), whole seconds, `-1` for none. The reader turns them
  back into match seconds as `frame + left`, where `frame` is the scene's `source.t` (never
  edited); every scene reader that subtracts t uses the same `frame`. Editing `Scene.clock` still
  changes only the bar's label.
- **A marker in a packed list is the FNV-1a 32-bit hash of its board marker key** (the key after
  `markerKey`, as `ObjectiveState.key` is). The reader hashes the board's markers and looks each
  entry up; an entry whose hash names no marker (the pack changed) is not drawn, as an
  `ObjectiveState` with an unknown key isn't today. Capture leaves out any two markers whose
  hashes collide (none do on the shipped map; a test holds it on `map/fallback-data.ts`). The
  hash is permanent once a release writes it, like every packing in §4.3.
- **Choices are `Int`s with permanent tables** in `mapstate/build.ts`: CC 1 Stunned, 2 Silenced,
  3 Disarmed (none is the default); a powerup's buff 0 casting, 1 gun, 2 movement, 3 survival,
  `-1` one this build doesn't know (drawn as a powerup without its buff).
- **Rows go live in order** (§4.3). Group A's rows come before group B's in the registry, so group
  A can be `Live` while group B is still `Ahead`.
- **What is derived stays derived** (§4.5): a skull's place is its dead hero's record (`pos`,
  where it stood: D4), a carried urn's place is its carrier's, a skull's opacity is its age, a
  lane shop's state is its guardian's. So a coach dragging a dead hero moves its skull, and
  dragging the carrier moves the urn.
- **Status wins** (§5): an `ObjectiveState` a coach set, or one an older save wrote, wins over the
  baseline; the baseline is the detail under it (a camp's timer shows only while it is down).

## 3. The rows

Bytes are the row's key and value as JSON, with its comma. "A scene" is one save's total for the
row. The caps they are counted against (§4.4): `max_more_bytes` 8,192 a record,
`max_more_ints` 1,280 a record, `max_tx_bytes` 65,536 a transaction, `max_ops_per_tx` 256,
`max_records` 5,000 a board.

### Group A: heroes and lanes

| # | Key | Record | Kind and bounds | Value | Bytes | Producer (Player) | A scene draws | An old scene draws |
|---|---|---|---|---|---|---|---|---|
| 16 | `has_sight` | scene | `Bool` | the heroes' `visible` is their enemies' sight | 17 a scene | `featuresOf(m).sight` | — | — |
| — | `visible` (typed, today's) | hero | `PlayerVisible` | in its enemies' sight at the frame | 0 more: it is written today, always `true` | `tenthPart(m, second).sight[i] === true` | Player's Vision logic: under a team's Vision an enemy not in its sight is faded where it stands; under All every hero is seen; Show last seen changes nothing (operator rule) | `visible: false` faded for every viewer (D5), as today |
| 17 | `has_cc` | scene | `Bool` | | 14 | `featuresOf(m).cc` | | |
| 18 | `cc` | hero | `Int { 0, 15 }` | 1 Stunned, 2 Silenced, 3 Disarmed; default none | ≤ 7 a hero | `tenthPart(m, second).cc[i]` | the token's CC under Crowd control, for a living hero drawn as seen (never on a faded one, as Player never puts live status on a ghost) | no CC |
| 19 | `has_movement` | scene | `Bool` | | 20 | `featuresOf(m).movement` | | |
| 20 | `height` | hero | `Int { 0, 15 }` | 1 above, 2 below street level; default 0 (drawn as `undefined` is) | ≤ 11 a hero | `secondPart(...).movement[i].height` | the token's ▲/▼ under Elevation & ziplines, living and seen | none |
| 21 | `zipline` | hero | `Bool` | riding one; default false | ≤ 15 a hero | `...movement[i].zipline` | the token's zipline ring, as above | none |
| 22 | `has_lanes` | scene | `Bool` | | 17 | `featuresOf(m).lanes` | | |
| 23 | `edges` | lane (`Wave`) | `Ints { len 2, 0, 1000 }` | `[amber, sapphire]` on `Wave.t`'s scale, rounded | 30 a lane (with `,"more":{}`), 81 a scene | `secondPart(...).lanes` | the zipline colours with their gap; the split stays `Wave.t` (D13, still draggable; Q7) | one split, no colours |
| 24 | `has_deaths` | scene | `Bool` | | 18 | any timeline | | |
| 25 | `deaths` | scene | `Ints { len 36, 0, 255 }` | per death in the frame's last 2.5 s: `[slot 0–11, tenths ago 0–25, seen 0/1]` | ≤ 15 measured (bound about 110) | `fromTimeline`'s `deaths` at the second | the skulls (`DeathSkulls`, mounted in a scene that has them) at the dead hero's place and the captured age; `shownDeaths` applies the view's sight; no recap opens (Q5) | no skulls |

Per scene, group A adds at most about 180 bytes over the twelve heroes (median 37–44), 81 over
the lanes, and about 110 of flags and deaths on `SceneState`. No list is added to a hero, so a
hero's `max_more_ints` is unchanged; the hero rows count inside its 8 KiB, which the build order's
trim already enforces (the trim counts them).

### Group B: the marker baseline

All on `SceneState`, all lists. "Entry" is one marker.

| # | Key | Kind and bounds | An entry | Default (not stored) | Measured a scene (median / p90 / max) | Producer | A scene draws | An old scene draws |
|---|---|---|---|---|---|---|---|---|
| 26, 27 | `has_camps`, `camps` | `Ints { len 600, -1, u32::MAX }` | `[hash, state 1 cleared / 2 not spawned yet, seconds left]`: every camp, heal, crate and the Mid-Boss | up | 387–816 / 1,152–1,322 / 2,786 bytes; up to 165 entries (the first two minutes) | `secondPart(...).camps` | each marker's state and timer, hovers as Player's; the scene bar's Mid-Boss respawn | the `ObjectiveState` statuses an older save wrote (down, no timer) |
| 28, 29 | `has_powerups`, `powerups` | `Ints { len 20, -1, u32::MAX }` | `[hash, state 0 up / 1 down / 2 none spawned yet, buff, next in, next buff]` | none: every site is stored | 44 | `secondPart(...).powerups` | the buff that is up, or the next one and when | the status (taken or not) |
| 30, 31 | `has_obj_health`, `obj_health` | `Ints { len 120, -1, u32::MAX }` | `[hash, percent, stage or -1]` | 100 %, no stage | 68–84 / 103 / 133 | `secondPart(...).health` (replay tier) | objectives' health under Health; the Patron's stage | none |
| 32, 33 | `has_rifts`, `rift` | `Ints { len 8, -1, u32::MAX }` | one: `[open 0/1, site, give-up in, amber %, sapphire %, captured -1/0/1, next opens in, next site]` | | 33 | `riftAt` over the koth markers | `RiftRings` and the capture, mounted in a scene that has it; the other site "elsewhere" | the status (the rift that was up) |
| 34–36 | `has_urn`, `urn`, `urn_at` | `Ints { len 8, -1, u32::MAX }`; `Pos` | `[state 0 none / 1 ground / 2 carried, team, slot, delivery site, walks back in, next in, next site]`; `urn_at` only on the ground | | 57 | `urnOf` | `UrnMark`, mounted in a scene that has it; carried, at its carrier's token; `shownUrn` applies the view's sight | the delivery point's status |
| 37, 38 | `has_rejuv`, `rejuv` | `Ints { len 8, -1, u32::MAX }` | per team holding one: `[team, revives left, ends in, since taken]` | none held | ≤ 12 | `secondPart(...).rejuv`, plus the pickup time (new in `RejuvNow`) | the Rejuvenator and its timer on the scene's bar (TD-141) | none |

`SceneState` with every row, measured: 836–1,275 bytes at the median, 1,587–1,738 at p90, 3,167
at most; with every list full and every flag set about 4.8 KB, under the 8 KiB. Its lists, all
full: 600 + 20 + 120 + 8 + 8 + 8 + 36 (deaths) = 800 integers, under the 1,280 (the registry
test holds it; 480 are left for troopers later).

### Against the save's budget

| | Records a save | Ops | Bytes |
|---|---|---|---|
| Today (§4.4) | 51–72 median, 96 p90, 181 at most | up to 189 | up to 47 KB |
| Group A live | the same | the same (rows ride on records already made) | + at most about 0.4 KB |
| Group B live | **− the `ObjectiveState`s the baseline replaces**: median 25–51, p90 72–82, up to 167 fewer | the same fewer | **− 4.5–9.1 KB median, up to 29.9 KB**, + the baseline's 0.4–3.2 KB |

The baseline is smaller than the records it replaces, so a save never drops it to fit. If a save
is over the transaction, it drops whole features in this order, clearing each one's flag, before
the build orders lose rows: deaths, movement, CC, the Rejuvenator, the urn, the rift, powerups,
objectives' health, lanes. Sight is never dropped (one flag). A test reaches each drop with a
synthetic frame; no real frame measured comes near.

## 4. The marker baseline

In the spec's terms (§4.4, D7): **the state of every camp, heal and crate at the frame is held as
`Ints` rows on the scene's `SceneState`, and an `ObjectiveState` exists only for a marker someone
edits and, as today, for an objective that is down.** Today's save writes an `ObjectiveState`
(`Destroyed`) for every camp, heal, crate and powerup that isn't up (`sitesAt`): up to 167 records
a save, which is what fills a board at about 60 replay scenes. This plan's baseline is group B:
camps (with heals, crates and the Mid-Boss), and the other per-marker detail the frame holds
(powerups, objectives' health, the rift, the urn's sites). Once it is live a save writes no
`ObjectiveState` for a site the baseline covers (camps, heals, crates, powerups, the rift's sites,
the urn's points); it still writes one for each objective that is down.

- **Reading:** a scene's marker shows the stored `status` when there is one, else the baseline's
  detail (`markerStates`: status ?? detail, the order Player's detail already follows). A scene
  without the baseline has no detail, so it draws exactly as today.
- **Editing** a marker makes its `ObjectiveState` as today (§5); its status then wins.
- **Retake** gives an old scene the baseline and leaves its `ObjectiveState`s alone: they agree at
  the scene's own moment, and the status still wins.
- **Where it lands:** its reader in release 2, its writer in release 3 (below).

## 5. The release sequence

Three releases. Each changes the schema sources, so each closes open tabs as `Outdated`. Store
numbers assume no other store step lands first; otherwise they move up together.

| | Rows | Store | Floor | Board files written | Rollback target |
|---|---|---|---|---|---|
| R1, reader A | group A `Ahead` | v15, additive, no SQL | 12 | as today (≤ 4) | v14 (prod `04545be`), v13, v12 |
| R2, writer A + reader B | group A `Live`, group B `Ahead` | v16, `NeedsReader { reader: 15 }`, no SQL | 15 | 5 when one holds a group A row | R1 only |
| R3, writer B | group B `Live` | v17, `NeedsReader { reader: 16 }`, no SQL | 16 | 6 when one holds a group B row | R2 only |

Four releases (each group's reader and writer apart) would make R2 smaller; Q9 asks. R2's writer
half is small by construction: R1 already holds group A's capture and Retake, dormant behind
`WRITTEN` and tested with a later build's `written`, as D2's reader did.

### R1: group A's reader (store v15)

- **Schema:** rows 16–25 `ahead(...)`; store step 14 → 15 additive (a v14 server still opens it).
  `Admit::DEPLOYED` refuses them from outside. `rows.lock` unchanged until the deploy.
- **Client, read:** `fromScene` decodes group A by the flags and the watermark (`CAPTURED` gains
  `deaths`; `FEATURES` gains `deaths`, which Player has whenever it has a timeline); the tokens
  draw CC, height and the zipline in a scene from `HeroState`; `DeathSkulls` mounts in a scene
  that has deaths; the lanes draw a scene's stored edges; the sight rule in `heroDraw` is reached
  with `has("sight")` true.
- **Client, write (dormant):** Save's and Retake's capture of group A (`written` a later build's in
  tests only). The hero rows get a codec of their own beside the build's (`HERO` gives them no-op
  lines, as it does `name`) and an `IS_BUILD: false` line each (§7).
- **Copies leave out rows this build doesn't write** (`addSceneOps`): keys of `Ahead` rows are
  dropped from every `more`, and the copy's watermark is lowered to this build's `WRITTEN` when it
  drops any, so the copy reads them as not captured. A no-op today; after a rollback it makes a
  copy of a newer build's scene whole instead of refused (below).
- **TD-108** (the file version picked by hand): fixed here if Q10 agrees, as the file version
  derived from a table of what each version first holds, since R2 and R3 each need a new version.
- **TD-140** (`previewAt` in `src`): moved into test support first, its trigger being "phase 5's
  first row".
- **Users see:** nothing. No scene holds a group A row; old scenes and Player draw as before (the
  DOM pins don't move).
- **Rolled back to v14:** nothing new is stored; every board is as it was.

### R2: group A's writer, group B's reader (store v16, floor 15)

- **Writer A:** rows 16–25 `row(...)`; store step `NeedsReader { reader: 15 }`; board files holding
  any of them say version 5. Save writes group A and `visible` as each hero's enemies' sight.
  Retake fills group A (§7). The scene's map controls show Vision, Crowd control and Elevation &
  ziplines when the scene holds them, as well as when the open match does.
- **Reader B:** rows 26–38 `ahead(...)`; `fromScene` decodes the baseline; `markerStates` reads
  status ?? detail in a scene; `RiftRings` and `UrnMark` mount in a scene that has them; a scene's
  marker hovers say what Player's say; the scene's bar draws the Rejuvenator and the Mid-Boss
  respawn from `MapState`, and Player's bar stops reading the timeline for them (TD-141). Group B's
  capture and Retake land dormant.
- **Users see:** a scene saved from a replay looks like Player at that second for heroes and lanes:
  under a team's Vision the enemies it can't see are faded (only faded, with or without Show last
  seen); under All nobody is. Tokens show CC and elevation and ziplines under their layers, the
  lanes show their colours, and the last 2.5 s of deaths show as skulls. Retake appears on every
  scene saved from the open match and adds all that to it. Marker detail is not stored yet.
- **Rolled back to R1:** every board loads, and R2's scenes draw the same (R1 reads group A).
  Refused from outside (`WrongField`): a pending save a reloaded tab resends (gone, as before), and
  R2's board files holding group A rows (version 5: "Newer file"). Copies (Duplicate, New scene) of
  R2's scenes are made on R1 without the group A rows and read them as not captured (R1's copy
  rule above): heroes there lose their per-team sight and CC in the copy, and keep `visible`, so an
  enemy unseen at the frame is faded for every viewer in the copy. Saves made on R1 are as before.
  v14 refuses to start (floor 15): restore `pre-v16` only if R1 can't run.

### R3: group B's writer (store v17, floor 16)

- **Writer B:** rows 26–38 `row(...)`; store step `NeedsReader { reader: 16 }`; files version 6. Save
  writes the baseline and stops writing the site `ObjectiveState`s it covers. Retake fills it.
- **Users see:** a saved scene's camps, heals, crates, powerups, rift, urn, objectives' health and
  Rejuvenator are Player's at that second, with their timers and hovers; the Mid-Boss's respawn
  shows on the scene's bar. Saves are smaller: median 25–51 fewer records (up to 167 in the first
  minutes), so a board holds about twice as many replay scenes before "Board full".
- **Rolled back to R2:** every board loads and R3's scenes draw the same (R2 reads the baseline).
  A copy made on R2 of an R3 scene drops the baseline, and R3 wrote no site `ObjectiveState`s, so
  in the copy every camp, heal, crate and powerup reads as up and the rift and urn as their
  defaults (off). Files version 6: "Newer file". v15 refuses to start.

### Every deploy

Back up the database first (`pre-v15`, `pre-v16`, `pre-v17`: `docs/deploy.md`). After it is live:
`just rows-lock` (R1 adds 10 rows to the lock, R2 adds 13), and set the justfile's `reader` to the
deployed commit, so the next release's `just reader-check` runs on it. Check the served client's
build id changed. Each release's section in `docs/deploy.md` gets its rollback lines above.

## 6. Retake, the pick, undo and TD-145

**None of the new hero rows is a build row** (`IS_BUILD: false` for `cc`, `height`, `zipline`; the
table doesn't compile without a line for each). They describe the slot at the frame (stunned
there, on a zipline, at that height), not what the hero bought. So:

- **A pick** in a scene that holds its heroes keeps them (`pickHeroOps` clears `BUILD_KEYS` only).
- **`holdsBuild`** ignores them.
- **Undo and redo** (`mapstate/undo.ts`, TD-145): its slot keys are `hero` and `BUILD_KEYS`, so the
  new rows are "every other op" and go as recorded. Scene and lane rows aren't on a hero record.
  R1 starts after TD-145 is on main (it touches `undo.ts` and `core/session.ts`; this plan touches
  neither), and adds a test that a step holding a hero's `cc` beside its build is decided with the
  build and sends the `cc` op as recorded.

**Retake with new rows** (`retakeOps`, D10). The rows Retake gives, each by a `SetIf` on an absent
value, as now:

- **Hero rows** (`cc`, `height`, `zipline`): for each slot whose hero is the match's (a re-picked
  slot is skipped, as for builds, and reads the defaults under the flag). They don't trigger
  TD-119's whole-slot write: that write (`Set hero` and the held build rows) goes only with build
  rows, as today, so a Retake that gives a hero only `cc` doesn't resend its build.
- **Sight:** `visible` is a typed field and is never absent. On a scene without `has_sight`, Retake
  sends `SetIf visible true → false` for each hero its enemies couldn't see, with `has_sight`, in
  one transaction (the scene's state group). A hero a coach had marked not seen stays not seen,
  now under the Vision logic; one marked back to in vision by hand can't be told from Save's `true`
  and takes the match's (Q8).
- **Lanes:** `edges` on each `Wave` the scene has.
- **The scene's rows** (flags, deaths, the baseline): on `SceneState`, last, as now; the watermark
  moves up from the value read.
- **Not given:** what the open timeline doesn't hold (no flag), and `has_heroes` (only a save sets
  it).

**Retake offered:** `canRetake` today is "the watermark is below what this build writes". Once R2
is live that is every scene saved from a match, including metadata-tier scenes, where a Retake
would only move the watermark. R2 makes it also ask whether the open timeline holds a feature the
scene lacks (TD-161).

TD-146 (a Retake landing after a pick takes the slot back to the match's hero) is unchanged by the
new rows, which ride outside the slot's hero and build.

## 7. Follow and view state

No new toggle, panel or filter: the layers (`layer.cc`, `layer.movement`, `layer.health`,
`layer.heals`, `layer.crates`), Vision (`vision.team`, `vision.last_seen`) and `recap.skull` are
rows already, and phase 4 carries them outside the match gate. So no new row in
`crates/engine/src/view_state.rs`, `web/test/view-state-ledger.ts` or
`web/e2e/follow-matrix.spec.ts`. What changes is that the keys now do something on a scene:

- R2: the follow matrix's scene column gets a scene that holds sight, CC and movement, and checks
  that a follower's Vision, Show last seen and the two layers follow there.
- `recap.skull` names a death by match second, and a scene's skull is at `frame − ago`; a skull's
  click opens nothing in a scene (Q5), so a follower's recap on a scene stays reset, as §7 says.
- No new signal goes into `viewstate.ts`, so the ledger is untouched; a release that adds one (Q5's
  recap, say) adds its ledger line.

## 8. Tests, per release

State and sync change in every release, so each follows §9 and the operator's rule: characterisation
first, mutation testing of the diff, adversarial review before the merge. Heavy runs go through
`tools/heavy.sh`, one at a time.

| | R1 | R2 | R3 |
|---|---|---|---|
| **Characterisation, first, on main's code** | the Save and Retake pins (`map-state-pins.test.ts`, `save-as-scene.json`); `canRetake` over every kind of scene; a copy's ops (`scene-copy.test.ts`); the DOM pins (`map-state-dom-pins`, `map-state-marker-pins`) | a saved scene's tokens and lanes at the moments in the walkthrough, under every Vision × Show last seen (the pins written on R1's code, which draws them as today) | a saved scene's markers, hovers and bar at those moments; a save's record count |
| **Rust** | each new row's bounds; the lock test; `max_more_ints` over the registry; `Admit` refuses each row in a transaction (a clear included) and a file at every version; a base and a log holding them load; the v14 server opens v15; the simulation with `Admit::READS` walks the new rows | the store step (floor 15; the v14 server refuses; R1 opens); file version 5 only when it holds a group A row (TD-108's table); `reader-check` on R1 | the same for v17 and version 6 |
| **The §9 property over the new rows** | `fromScene(capture(fromTimeline(t)))` equals `fromTimeline(t)` for group A, with R2's `written`, on both tiers and at every whole second of the synthetic match, through a table keyed by row (`{ [K in RowKey]-?: … }`), so a row without a projection doesn't compile. Height compared with `undefined` as 0; `lastSeen` left out (§1) | the same for group B with R3's `written`; and group A with this build's own `written` | group B with its own |
| **The operator's rule** | a scene holding sight, under every Vision with Show last seen on and off: an enemy the view can't see is `{ as: "faded" }`, everyone else seen, and under All nobody faded; a scene without it keeps the legacy fade for every viewer. It fails if `heroDraw` loses its `stored` branch (hidden), if the tokens pass `stored: false` (hidden or a ghost), if `fromScene` returns a `lastSeen` (a ghost), and if `CAPTURED.sight` is false again (faded under All) | the e2e row the phase 4 review asked for: a scene saved on 129738985 at a moment with an enemy out of sight, under each team's Vision with Show last seen on: the faded token, no ghost and no last-seen ping; toggling Show last seen changes nothing in the scene's DOM | |
| **Retake, pick, undo** | Retake's ops for group A (with R2's `written`): absent values only; a re-picked slot skipped; no whole-slot write without build rows; `visible` and `has_sight` in one transaction; a pick keeps `cc`; `decideStep` sends a hero's `cc` as recorded | Retake through two replicas and the server against a pick and against an undo (TD-119's and TD-145's sequences, with the new rows); `canRetake` asks the features | the same for the baseline |
| **Mutation testing** | by hand on the decoders, the capture, `CAPTURED`, the copy filter and `Admit`'s rows (`mutation-testing` skill); e2e mutants where the draw changes | the flips' gates, Retake, `canRetake`, the map controls; e2e mutants on the scene's tokens and lanes | the baseline's decoder, the hash, status ?? detail, the save's records |
| **The rollback check** | R1 stores nothing new: `just reader-check` on v14's commit | `reader-check` on R1; a copy of the local dev database written by R2, opened by R1's server: every board loads; R2's scenes draw the same on R1's client (hashes); a copy on R1 of an R2 scene is whole | the same, R3 on R2 |
| **The walkthrough on 129738985** (Chromium, counts and hashes only, no names) | Player and an old scene, a saved scene and a hand-made scene: identical on main and on R1 | save at a CC moment, on a zipline, above and below street level, at a death's second, with an enemy out of sight; each scene against Player at its second, under every Vision; Retake a scene saved on v14 | save at camps' first two minutes, a rift being captured, the urn on the ground and carried, a Rejuvenator held, the Mid-Boss down; each against Player; a board's record count after 20 saves on R2 and on R3 |

## 9. Open questions

| # | Question | Recommended answer | For |
|---|---|---|---|
| Q1 | Store `lastSeen` in a scene? | No: under the operator's rule no scene reads it, and leaving it out makes a ghost in a scene impossible rather than only unused. | lead |
| Q2 | Each team's sight: in the typed `visible` field with a `has_sight` flag, or a new hero row? | `visible`: one field for one fact, the existing "Mark not seen" edits it, 0 bytes more. The consequence, which follows D3: in a scene holding sight, "Mark not seen" means its enemies don't see it, so under Vision All the hero is not faded. A new `seen` row would keep Retake's "never overwrite" whole (Q8) at the cost of two fields for the fact. | operator |
| Q3 | Draw a scene's stored health as Player's arc under Health (phase 4 left it the lead's call)? | Yes, in R2: the row is stored since phase 2, and the scene then has every hero feature Player draws. | lead |
| Q4 | Troopers, death recaps and active effects (D8, D11) out of phase 5? | Yes: none is in `MapState` yet. Troopers and recaps fit (≤ 1.2 and 1.6 KB) and can be a later reader and writer pair once they have producers and a way to open a recap in a scene; effects (up to 36 KB a frame) don't fit a save. | operator |
| Q5 | Deaths in a scene: the skulls of the frame's last 2.5 s, static at their age, with no recap on click? | Yes, as Player draws them at that second (D9). A click opens nothing until recaps are stored (Q4). The alternative, no skulls in scenes, loses who just died. | operator |
| Q6 | Once the baseline is live, a save writes no `ObjectiveState` for the sites it covers? | Yes: it is D7's purpose (§4.4); up to 167 fewer records a save. The cost is R3 → R2 copies (§5). | lead |
| Q7 | A lane whose split a coach drags outside the stored gap? | Draw the colours only while the split is inside the gap (the gap is the match's; a split outside it is the coach's story). | operator |
| Q8 | Retake writes `visible: false` over Save's `true` for heroes the match says were unseen, which can't be told from a coach's "Mark in vision"? | Accept: it is what Retake means for a scene saved before sight, and the hero can be marked again. | lead |
| Q9 | Three releases (R2 holds A's writer and B's reader) or four? | Three, with R2's writer half small because R1 holds group A's capture dormant. Four if the reviewer of R2 wants it split. | lead |
| Q10 | Fix TD-108 (the board file's version by hand) in R1? | Yes: R2 and R3 each need a version, and a table of what each version first holds replaces a function and two tests per writer. | lead |
| Q11 | The marker hash (FNV-1a 32 over the board marker key) as the baseline's identity? | Yes: any key string, one integer an entry, collisions checked at capture. The alternative, an index into the pack's marker list, breaks when a pack adds or reorders markers. | lead |

## 10. Debt

Logged in `docs/tech-debt.md`: TD-161 (`canRetake` offers a Retake with nothing to give), TD-162
(the map controls' layers and Vision ask the open timeline, not the frame), TD-163 (`sitesAt` maps
rifts and powerups by the timeline's key, not `markerKey`). Phase 5 also meets TD-108 (fixed in R1,
Q10), TD-140 (R1) and TD-141 (R2), and changes nothing in TD-145, TD-146 or TD-100 (the baseline
stores the Patron's stage whatever Health says, so TD-100's fix can read it there).
