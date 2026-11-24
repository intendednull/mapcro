# Doorman doorway indicators — technical & release spec (Player + Scenes)

Status: Stage 1 technical spec, 2026-11-24.
Ground-truth probe: [doorman-doors.md](../research/doorman-doors.md) (standard 6v6 replay `142815246`, build `6865`).
Visual & Scene UX design: [doorman-doors-design.md](doorman-doors-design.md) (Gemini 4 Argon, `279a809`).

---

## 1. Summary & Lead Architectural Amendments

Show The Doorman's (`hero_id: 69`) placed doorways as little doors on the minimap in **both Player and Scenes**, using Valve's already-extracted `icons/doorman_doorway_psd` (`137×137`, present in all deployed packs `6860-*` through `6864-upgrades` — zero pack re-extraction needed) plus the matching fallback SVG door when running without a pack.

Three lead engineering amendments to [doorman-doors-design.md](doorman-doors-design.md) are locked here and authoritative for implementation:

1. **Sequential `Doorway.id: u16` (not raw Source 2 entity index):** `crates/replay/src/derive.rs` assigns each door spawn a dense monotonic `id: u16` (`0..doors.len()`) in spawn order and rewrites `partner` to the partner's sequential `id`. Raw Source 2 entity indices can theoretically recycle in a long match; dense sequential IDs guarantee uniqueness and let `Timeline::validate` enforce symmetric partner invariants.
2. **Scene door dragging uses local preview + commit on drop (zero `Presence` wire change):** `DragPreview.id` (`crates/engine/src/wire.rs:567`) is a `RecordId` (32-char hex) and cannot hold a synthetic `"door:0"` identifier. Dragging a door in a Scene renders smoothly locally (badge + connecting link arc) while peers see the editor's live cursor glide; pointer release commits one atomic `Set More { key: "doors", ... }` transaction.
3. **Exact two-release SQLite schema ladder (`v18` Reader → `v19` Writer):** Following Phase 5's `store.rs` pattern (`PHASE5_READER = 15`, `PHASE5_WRITER_A = 16`, `PHASE5_WRITER_B = 17`), Release 1 bumps `SCHEMA_VERSION` from `17` to **`DOORS_READER = 18`** (`Step::Additive`, `compat_floor` stays `16`) so Release 2 can set **`DOORS_WRITER = 19`** (`Step::NeedsReader { reader: DOORS_READER }`, `compat_floor = 18`).

---

## 2. Operator Confirmation (Approved 2026-11-24: `"go with lean"`)

1. **`timeline::FORMAT` bump (`10 → 11`) — APPROVED:**
   - **Adopted (`FORMAT = 11`):** Matches formats `1..=10`; cached server timelines inside Valve's 3-week window auto-refetch once on open so recent Doorman matches immediately display doors. Because `crates/server/src/replays.rs` `check_client_timeline` rejects `format < FORMAT` with `"Update the mapcro app"`, pair Release 1 with cutting `desktop-v0.2.5` (CI `desktop.yml`) so desktop app users get the update cleanly.
   - *(Rejected alternative: keeping `FORMAT = 10` with optional `doors`.)*
2. **Little-door tinting — APPROVED:**
   - **Adopted (Argon §1.3):** team-tinted rim + link arc (`--amber` / `--sapphire`) with crisp off-white little door glyph (`#FFEFD7` / pack white) on `#0b1714` disc, avoiding the Amber/Sapphire color collision of Valve's 3D `m_ColorStart` gold / `m_ColorEnd` blue.

---

## 3. Replay Parser & Timeline (`crates/replay`)

### 3.1 `crates/replay/src/timeline.rs`

Add to `Timeline`:

```rust
/// Replay tier: The Doorman's placed doorways (`CCitadel_DoorwayPortal`), one entry per spawn.
/// Empty when Doorman placed no doors or on timelines from before this layer.
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub doors: Vec<Doorway>,
```

And define:

```rust
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Doorway {
    /// Dense sequential spawn index (`0..doors.len()`), independent of Source 2 entity slot reuse.
    pub id: u16,
    /// `"amber"` or `"sapphire"`.
    pub team: String,
    /// World X coordinate, rounded to integer world units.
    pub x: i32,
    /// World Y coordinate, rounded to integer world units.
    pub y: i32,
    /// Spawn time in tenths of a second (`floor(t_spawn * 10)`).
    pub start_ds: u32,
    /// Tenth of a second when linked (`None` if never linked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_ds: Option<u32>,
    /// Deletion (or match-end) time in tenths of a second (`ceil(t_end * 10)`).
    pub end_ds: u32,
    /// Partner `Doorway::id` once linked (`None` if never linked).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partner: Option<u16>,
    /// Enemy FOW visibility intervals `[start_ds, end_ds)` in tenths of a second.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seen: Vec<[u32; 2]>,
}
```

### 3.2 Validation bounds (`timeline::validate`)

Add `doors_ok(&t.doors, t.duration_s)`:
- `doors.len() <= MAX_LIST` (256; a 60-min match has at most ~160 door placements).
- Every `d` at index `i`:
  - `d.id as usize == i`.
  - `d.team == "amber" || d.team == "sapphire"`.
  - `d.x.abs() <= 32768 && d.y.abs() <= 32768`.
  - `d.start_ds <= d.end_ds && d.end_ds <= (duration_s + 1) * 10` (strictly `< end_ds` when emitted by `derive.rs`, allowing `<=` if clamped at `duration_s` on a final-tick spawn).
  - `d.link_ds.is_some() == d.partner.is_some()`.
  - If `let (Some(link), Some(pid)) = (d.link_ds, d.partner)`:
    - `d.start_ds <= link && link <= d.end_ds`.
    - `pid as usize != i` and `let Some(p) = doors.get(pid as usize)`.
    - Symmetric link invariants: `p.partner == Some(d.id)`, `p.team == d.team`, `p.link_ds == Some(link)`, `p.end_ds == d.end_ds`.
  - `seen_ok(&d.seen, duration_s)` (same monotonic non-overlapping `[a, b)` tenths check as `Player::seen`).

### 3.3 Demo parsing (`crates/replay/src/parse.rs`)

- Add constant `const DOORWAY: &str = "CCitadel_DoorwayPortal";` and include `DOORWAY` in `classes`.
- Resolve field keys once in `Keys`:
  - `doorway: Body::of(ctx, DOORWAY)` (world position).
  - `doorway_team: field(DOORWAY, "m_iTeamNum")`.
  - `doorway_link: field(DOORWAY, "m_hLinkedDoorway")`.
  - `doorway_create: field(DOORWAY, "m_flCreateTime")`.
- Track live `CCitadel_DoorwayPortal` entities across ticks (`active_doors: HashMap<i32, usize>` mapping live entity index → sequential spawn index in `raw_doors: Vec<DoorObs>`):
  - **On spawn / entity creation (or first appearance with a new `m_flCreateTime` / handle):** allocate next `seq_id = raw_doors.len()`, record `team` (`2 => "amber"`, `3 => "sapphire"`), initial `(x, y)` via `Body::of`, `start_s = game`, `create_time = m_flCreateTime`, `link_s = None`, `partner_seq = None`, `end_s = None`, and insert `entity_index -> seq_id`.
  - **On update / tick check:** if `m_hLinkedDoorway != 0x00FFFFFF`, extract `partner_ent = handle & 0x3FFF` (same handle index mask as `parse.rs` / `doorman_door_probe.rs`), resolve `partner_seq` via `active_doors.get(&partner_ent)`, and on first link record `link_s = Some(game)` and `partner_seq = Some(p_seq)` on both doors (handling same-tick spawn+link order regardless of iteration order!).
  - **On deletion (entity absent from live `DOORWAY` entities at tick `game`):** set `end_s = Some(game)`, clear enemy FOW state for `seq_id`, and remove from `active_doors`.
  - **In `vision_tick`:**
    - CRITICAL Stage 0 gotcha (`docs/research/doorman-doors.md` §3): `m_eClass == 88` is shared with other entities! Match `CCitadelTeam.m_vecFOWEntities` entries strictly by live entity index in `active_doors` (`active_doors.get(&ent_idx)`), NEVER by `m_eClass == 88` alone.
    - Only record enemy-team observer flips (`observer_team != door.team`) into `door_vision: Vec<DoorVisionObs { seq_id, t, visible }>` (own team is always visible).
- At match end, any door still open in `active_doors` gets `end_s = Some(duration_s as f32)`.

### 3.4 Derivation (`crates/replay/src/derive.rs`)

- Convert `raw_doors` + `door_vision` into `Vec<Doorway>`:
  - Convert times to tenths (`start_ds = (start_s.max(0.0) * 10.0).floor() as u32`, clamped to `duration_s * 10`; `end_ds = (end_s.max(start_s) * 10.0).ceil() as u32`, clamped to `duration_s * 10`, with `end_ds = end_ds.max(start_ds + 1)` if `start_ds < duration_s * 10`).
  - Drop degenerate zero-duration spawns (`start_ds >= end_ds`) unless paired; if either end of a pair is dropped or asymmetric (e.g. truncated demo), clear the dangling `partner`/`link_ds` so `validate()` invariants always hold.
  - Ensure linked pairs share identical `link_ds` (`max(a.link_ds, b.link_ds)`) and `end_ds` (`max(a.end_ds, b.end_ds)`), and `start_ds <= link_ds < end_ds`.
  - Collapse `door_vision` flips per `seq_id` into `[a, b)` tenth-second `seen` intervals using the same `SEEN_MERGE_DS` smoothing/clamping logic as `Player::seen`, clamped inside `[start_ds, end_ds)`.
  - Re-index sequentially (`0..out.len()`) and remap `partner` IDs if any degenerate entries were filtered out.

---

## 4. Two-Release Schema & Storage Plan (`crates/schema`, `crates/server`)

### 4.1 Release 1 — Player + Scene Reader (`Status::Ahead`, store `v18` floor `16`)

1. **`crates/schema/src/map_state.rs`:**
   - Append rows `40` and `41` as `Status::Ahead`:
     ```rust
     // Doorman doorways (docs/specs/doorman-doors.md): reader in store v18; writer in store v19.
     ahead("has_doors", Entity::Scene, Kind::Bool),
     ahead("doors", Entity::Scene, Kind::Ints { len: 24, min: -16384, max: 16384 }),
     ```
   - Append version `7` to `FILE_VERSIONS`:
     ```rust
     FileVersion { version: 7, live: rows_live(40, 41), rows: 42, holds: holds_v7 },
     ```
     where `holds_v7(r)` checks `has_any(r, 40..=41)`. While `40..=41` are `Ahead`, `reads_file_version()` stays **`6`** and `written_rows()` stays **`40`**.
   - Update `map_state.rs` unit tests (`ints_of(Entity::Scene) == 824`, `FILE_VERSIONS` list includes `(7, false, 42)`, `Admit::READS` accepts `40..=41` while `Admit::WRITES` refuses them).
   - Run `just ts` to regenerate `web/src/gen/rows.ts` (rows `40..=41` marked `ahead: true`, so `WRITTEN` stays `40`).
2. **`crates/server/src/store.rs`:**
   - Add `const DOORS_READER: i64 = 18;`, set `SCHEMA_VERSION = DOORS_READER`, and add `f if f + 1 == DOORS_READER => Step::Additive` in `step()`. `compat_floor(18)` stays **`16`** (live prod `v17` opens `v18` cleanly on rollback!).
   - Add migration test verifying `v17 -> v18` keeps `compat_floor = 16`.
3. **Web client (Release 1 — Reader + Player Renderer + Dormant Scene Reader):**
   - `web/src/map/pack.ts`: register `"doorman-door": "icons/doorman_doorway_psd"`.
   - `web/src/match/timeline.ts`: add `TimelineDoor` + `Timeline.doors?: TimelineDoor[]` + pure `doorsAt(tl, ds)` helper.
   - `web/src/mapstate/state.ts`: append `"doors"` to `FEATURES`, add `DoorNow` to `SceneFacts.doors`, populate `featuresOf(m).doors = !!m.doors?.length`, wire `fromTimeline` on `tenthPart`.
   - `web/src/mapstate/frame.ts`: add `doors: DoorNow[]` to `TenthPart` (`tenthPart(tl, t)` using `ds = Math.floor(t * 10) + 0.5`).
   - `web/src/mapstate/codec.ts`: add `MAX_DOORS = 4`, `DOOR_STRIDE = 6`, `encodeDoors` / `decodeDoors` with full defensive checks (stride 6, bounds, partner symmetry & same-team check, graceful fallback to unpaired) + round-trip unit tests.
   - `web/src/mapstate/build.ts`: add `doors?: boolean; doorsData?: number[]` to `SceneCapture` / `CapturedSnapshot`, gated behind `ROWS.doors.index < written` (`WRITTEN = 40` keeps writer dormant in Release 1, testable with synthetic `written = 42`).
   - `web/src/mapstate/scene.ts`: read `has_doors` + `doors` in `fromScene` (`has("doors")`, `scene().doors()`), so Release 1 ALREADY renders any v19 board's doors cleanly on rollback!
   - `web/src/mapstate/shown.ts`: add `shownDoors(ms, vision, stored)` implementing Player (`seen`/`hidden`) and Scene D3 (`seen`/`faded`).
   - `web/src/player/Doors.tsx` (new) + `web/src/styles/minimap.css`: render `<DoormanDoors />` in `Board.tsx` right before `<Layers />` (after `<TrooperDots />`, below `<Tokens />` and coach annotations), clipped to `--mm-stencil-view`, with Argon's badge (`DOOR_R = 14`, `DOOR_GLYPH = 21`), `DOOR_FB` fallback SVG, team rim, unpaired dashed state, curved dashed link arc, hover pair highlight, and `visionFade`.
   - `web/src/player/Camps.tsx` (`MarkerTips`): check visible doors in `near(at)` right after `urn()`, returning `door:<id>` (`"Doorway"`).
   - **No `view_state.rs` change** (doors are always-on when present, preserving bit 7 of `Presence.layers`).
4. **Post-deploy Release 1 lock step:**
   - Verify prod (`healthz`, store `v18` floor `16`, real Doorman replay `142815246` live in Player!).
   - Commit updated `crates/schema/rows.lock` (42 rows) and bump `justfile` `reader` to the deployed Release 1 SHA.
   - If `FORMAT` bumped to `11`: tag `desktop-v0.2.5` once Release 1 is live.

### 4.2 Release 2 — Scene Writer & Manual Placement (`Status::Live`, store `v19` floor `18`, `.mapcro` v7)

1. **`crates/schema/src/map_state.rs`:**
   - Flip rows `40` (`has_doors`) and `41` (`doors`) from `ahead(...)` to `row(...)` (`Status::Live`).
   - `FILE_VERSIONS` entry `7` (`rows: 42`) becomes `live: true` automatically → `boardfile::READS = 7`, `written_rows() = 42`.
   - Run `just ts` (`WRITTEN` becomes `42`).
2. **`crates/server/src/store.rs` & `boardfile.rs`:**
   - Add `const DOORS_WRITER: i64 = 19;`, set `SCHEMA_VERSION = DOORS_WRITER`, and `f if f + 1 == DOORS_WRITER => Step::NeedsReader { reader: DOORS_READER }` (`compat_floor = 18`).
   - Add `boardfile.rs` v7 export/import + older-reader tests: boards with doors export `version: 7, rows: 42` (`Newer` on Release 1 `READS = 6`); boards without doors stay `version <= 6` and import cleanly on Release 1.
3. **Web client (Release 2 — Save/Retake + Manual Scene UX):**
   - `web/src/match/save.ts`:
     - Add `"doors"` to `Phase5Feature`, `PHASE5_FEATURES` (`firstRow: "has_doors", lastRow: "doors"`), and `DROP_ORDER` (alongside `"rejuv"` / `"urn"`).
     - In `captureFrameData`, read `ten!.doors` when `feat.doors && ROWS.doors.index < written`, encode via `encodeDoors`, wire into `Save scene` and `retakeOps` (including `max_more_bytes` budgeting).
     - `New scene` / `Duplicate` inherit `SceneState.more` (`has_doors`, `doors`) automatically.
   - `web/src/mapstate/edit.ts`:
     - Pure atomic op builders (`placeDoorwayOps`, `linkSecondDoorOps`, `moveDoorOps`, `unlinkDoorOps`, `toggleDoorSightOps`, `removeDoorwayOps`, `clearTeamDoorsOps`), creating `SceneState` with `has_doors: true` on a fresh blank board when absent, enforcing team replacement (1 pair per team, max 4 doors total) and FOW lockstep on `toggleDoorSightOps`.
   - `web/src/player/Doors.tsx`, `web/src/board/Layers.tsx`, `web/src/board/TopBar.tsx`, `web/src/board/Board.tsx`:
     - Entry point A: Doorman (`hero_id === 69`) `hero-menu` (`Place doorway`, `Clear doorways`).
     - Entry point B: empty-map `map-menu` in `Select` tool (`Place doorway` when one team has Doorman; `Place King doorway` / `Place Archmother doorway` otherwise).
     - Two-step placement (`placingDoor` state: Step 1 armed → Step 2 Door 1 + live dashed link preview → click/tap P2 to link, click P1 or `Enter` for unpaired, `Escape`/right-click/tool switch to cancel).
     - Direct manipulation: `Select` (`Q`) 1-finger/mouse drag with local live preview + commit on drop; `Arrow` (`A`) snap-from door; `Erase` (`D`) click/scrub + hover-`D` delete; `door-menu` right-click/long-press (`Link second door` / `Unlink door` / `Mark not seen`↔`Mark in vision` / `Remove doorway`); `44×44 CSS px` `.pl-hit` touch targets; zero vertical chrome added to phone `.p-top`/`.p-bar`.
4. **Release 2 Deploy & Rollback Gate:**
   - Full Stage C gate: `just clippy`, `just test` (including `reader-check` vs Release 1 SHA), `just web-test`, Chromium Playwright E2E + Firefox Android touch E2E, NixOS VM test, **live `v19 → v18` rollback check** (verifying Release 1 renders a v19 board's doors pixel-identically and preserves `schema_version=19, compat_floor=18`), mandatory online `/var/lib/mapcro/mapcro.sqlite.pre-v19` backup before deploy!

---

## 5. Verification Plan

- **Stage 2 (Release 1):**
  - Rust unit & integration tests: `Doorway` validation bounds & malformed-input rejection (`timeline.rs`), real-demo derivation test (`142815246` produces 24 doors = 10 linked pairs + 4 unpaired with exact link/end parity and enemy FOW intervals), `map_state.rs` row 40–41 `Ahead` + `FILE_VERSIONS` v7 dormant checks, `store.rs` `v17 → v18` floor `16` check, `reader-check` vs deployed `c94cdac`.
  - Web unit tests: `doorsAt`, `encodeDoors`/`decodeDoors` round-trip & fuzz/malformed-input defense, `shownDoors` (All/own/enemy Vision in Player & Scene D3), `labels.test.ts` (§4b check), synthetic `written = 42` Save/Retake tests.
  - Playwright E2E (Chromium + Firefox Android): Player rendering with pack icon & fallback SVG, unpaired Door 1 vs linked pair + link arc + hover highlight, enemy Vision `visionFade` hide/show, Scene rendering from synthetic `SceneState.more.doors` (verifying Release 1 rollback reader!).
  - Independent adversarial review (Antigravity/agy) + targeted manual mutation check.
- **Stage 3 (Release 2):**
  - Rust `boardfile.rs` v7 / older-reader matrix tests + `store.rs` `v18 → v19` floor `18` + `reader-check` vs Release 1 SHA.
  - Web unit tests: all `edit.ts` op builders (blank board `SceneState` creation, team replacement, lockstep sight toggle, undo/redo atomicity, `max_tx_bytes` drop order).
  - Playwright E2E (Chromium + Firefox Android `--touch`): `Save scene` & `Retake` preserving doors at unpaired and linked timestamps, `.mapcro` v7 export + TD-162 matchless import, manual placement via both Doorman `hero-menu` and empty-map `map-menu`, 2-step link & unpaired commit, live drag + undo/redo, `door-menu` link/unlink/sight/remove, `Erase` tool, multi-user WebSocket sync, and phone `390×844` / `615×344` touch ergonomics with zero header/bar overflow.
  - Independent adversarial review (Antigravity/agy) + targeted manual mutation check + live `v19 → v18` rollback test.
