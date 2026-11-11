# Plan: view state that followers get by default (2026-11-11)

Status: steps 0–4 built on branch `view-state` (2026-11-11), with the operator's decisions
below; step 5 declined (decision 5); steps 6 and 7 open. "Built" at the end says what differs
from this design.

## Problem

Each time Player gains a view feature (a map layer, a panel, a filter), the follower doesn't see
the presenter's state until someone reports it, and then it is wired by hand: a new presence
field in `wire.rs`, a bounds clause in `is_valid`, an encoder and decoder in TypeScript, an
"own / theirs" signal pair in `host.ts`, a line in `forget()`, a line in the effect that sends
presence, and a test. Commit c50d9bb did this for seven layers and four panels in one go. Three
more are already known and unshared.

Nothing in the code asks "what does following do with this?" when state is added. The default is
"nothing", and it is silent.

## Inventory: view state today

"View state" here is what decides what one browser draws that isn't the document.

### Shared with followers

| State | Where it lives | On the wire | Stopping the follow | Follower's own change |
|---|---|---|---|---|
| Scene | Board.tsx `sceneId` | `scene` | keeps | stops |
| Viewport, side | Board.tsx `view`, `viewpoint` | `view` | keeps | stops |
| Hover label | map/HoverLabel.tsx | `hover` | clears | follower's own hover wins |
| Open comment | Board.tsx `openComment` | `focus` | n/a (drawn as theirs) | n/a |
| Mode, match, time, playing, speed | host.ts `mode`, `matchId`, `playback` | `playback.*` | keeps | stops |
| Jump pin and ring | host.ts `pin`, `heardJump` | `playback.jump` | keeps | stops (a seek) |
| Vision, Show last seen | host.ts `ownVision`, `ownLastSeen`, `theirVision` | `playback.vision` | own comes back | stops, keeps the presenter's pair with the change |
| Map layers ×7 | **registry** (was `ownLayers`, `theirLayers`) | `layers` bits 0–6 | own come back | stops, keeps the presenter's layers with the change |
| Death recap on the map | host.ts `skullRecap` | `playback.skull_recap` | keeps | local until the presenter's next panel change |
| Events-list recap (last opened) | host.ts `eventRecaps` | `playback.event_recap` | keeps | local |
| One hero's build | host.ts `openBuild` | `playback.inspect` | keeps | local |
| All builds / Tab held | **registry** `builds.all` (was `allBuilds`), host.ts `tabHeld` | `playback.all_builds` | keeps | local |

### Each browser's own on purpose

Player names (**registry** `names`: for recording without them), the tool, the ink colour, the
Comments toggle (per board on the device), the jump lead.

### Not shared (docs/backlog.md "Follow: what a follower still doesn't share")

| State | Where | Note |
|---|---|---|
| Effects or Build order open in a hero's build | `<details>` in ActiveEffects.tsx, BuildOrder.tsx (DOM state) | two values and "none" |
| Events filters | Events.tsx `on` | changes what the follower's list and pings show |
| Events search | Events.tsx `query` | text on the wire: needs a length and character bound |
| Events list scroll (following Now) | Events.tsx `follow` | |
| Teleporter pair's line | Camps.tsx `TeleporterLink` | derived from the *local* hover only; `hover` is already on the wire, so this needs no new key, only reading the shown hover |
| Sidebar tab (Events / Notes) | Board.tsx `sideTab` | |
| Map layers popover open | `<details class="map-layers">` | probably never wanted |

The full list, signal by signal, is `web/test/view-state-ledger.ts` (80 signals and 6
disclosures, each with a class and a reason). It is checked against the source by a test, so it
stays an inventory rather than a snapshot.

### How it travels

`Session.setPresence(patch)` merges a patch into one `Presence` object and sends the whole object
at most every 60 ms (`PRESENCE_MS`). The server checks `Presence::is_valid`, stores it per peer and
relays it in 20 ms batches. A follower's effect in Board.tsx reads the followed peer's state and
calls `player.mirrorLayers`, `player.mirror` and so on. Every change, including a cursor move,
resends everything.

A sample frame (JSON built by hand from typical values, not captured from the wire): 307 bytes
in Sandbox, 447 in Player, 584 with three panels open; a full laser trail takes it to about
1,450. Of the 447, view state is about 53 bytes (layers 11, vision 42); panels add 136.

## Design

### 1. One registry, in Rust, generated into TypeScript

`crates/engine/src/view_state.rs` holds `VIEW_STATE`, one row per key:

| Column | Values | Means |
|---|---|---|
| `key` | `layer.troopers`, `builds.all`, `names` | stable name; never renamed once shipped |
| `sync` | `Shared` / `Personal` | a follower mirrors it / each browser's own, with the reason in `note` |
| `wire` | `Bit { field, mask }`, `Flag { field }`, `None` | where presence carries it; the bit lives only here |
| `unfollow` | `Restore` / `Keep` | own value comes back / stays as the presenter left it |
| `on_override` | `Stop` / `Local` | a follower's own change stops following (and keeps what it saw) / is its own until the presenter's next change |

`just ts` writes it to `web/src/gen/viewState.ts`, the way `limits.ts` is written from
`LIMITS`; `cargo test` fails when the generated file is stale. This replaces the hand-copied bit
order in `layers.ts` (TD-21).

The operator's third policy, "presenter-only" (sent and drawn as the presenter's, never replacing
the follower's own: cursor, laser, ping, selection), is `Outside::Person` in the same file: a list
of the presence fields that are not registry keys, each with a class. `Outside::Wired` marks view
state still mirrored by hand, which is the migration list.

### 2. One store on the client, built from the registry

`web/src/player/viewstate.ts`: `createViewState(first, onOwn)` makes, for every key, your own
value and (while following) the presenter's. The rest is read from the row:

- `get(k)`: what the screen shows (theirs if present, else own).
- `set(k, v)`: your own choice. For a `Stop` key, every `Stop` key in the same wire field keeps
  what the screen shows with this one change.
- `bits(field)` / `mirrorBits(field, n)` / `mirrorFlag(k, v)`: the wire, both ways. Unknown bits
  are ignored; an absent field leaves the follower on its own.
- `forget()`: `Restore` keys show your own again; `Keep` keys stay.
- `onOwn(k, v)`: only your own values are remembered in the browser, never a presenter's.

Adding a boolean key is then: one registry row, `just ts`, one first value in `host.ts`, and
`get`/`set` in the component. No new signal pair, no `forget` line, no codec, no bit to copy.

### 3. Value kinds (not in the tracer; needed from step 2)

The tracer's values are booleans. The remaining state needs four more kinds, each with one
validator in Rust (called from `Presence::is_valid`) and one codec in TypeScript:

| Kind | For | Bound |
|---|---|---|
| `Choice(n)` | Vision team, Effects / Build order / none | `< n` |
| `Slot` | the build open | `slot < MAX_SLOT` |
| `Death` | recaps | slot, `t <= 86_400` |
| `Text { max }` | events search | bytes, no control characters |

A set of small choices (the events filters) is bits. Keep the list this short: a kind that needs
its own apply logic (the playback clock, the jump) stays outside the registry, classified
`Outside::Core`.

### 4. Wire shape and payload

- **Existing fields stay where they are.** Registry rows point at `layers` and
  `playback.all_builds` as shipped. No wire migration.
- **New boolean keys take the next free bit** of the field for their group (a field is the group
  that a `Stop` change keeps together). `layers` has one bit left; widen it to `u32` when needed
  (JSON numbers, so no format change).
- **Defaults are left out**, as the panels are now (`skip_serializing_if`).
- **Sending view state separately from cursors: not yet.** View state is roughly 50–190 of a
  447–584 byte Player frame, so moving it to its own on-change frame saves at most a third, and
  costs a second relay path in `room.rs` (per-peer storage, the join snapshot, the catch-up for a
  peer that fell behind). The larger saving is splitting everything slow (name, colour, scene,
  playback, view state) from everything fast (cursor, laser, drag, ink), which would take a
  cursor frame to well under 100 bytes. That is a presence-protocol change of its own and should
  be decided from production numbers, which we don't have for presence bytes. The registry makes
  it mechanical later, because it lists exactly which fields are slow.

### 5. Old and new clients

`mapcro_schema::BUILD_ID` hashes the engine's sources, so a registry change changes the build id
and the server closes a tab from another build as `Outdated` (it reloads). Two browser clients
with different registries therefore don't share a room. A client that sends no build (tools, the
soak) is covered by the existing rules, which the registry keeps: every field is
`#[serde(default)]`, absent means "the follower keeps its own", unknown bits are ignored, bits
are appended and never reused. Not checked: whether the desktop app can hold an older web client
against a newer server; if it loads the site, it is the same case as a browser.

### 6. The guard

Four checks, all in the ordinary test runs (`just test`, `just web-test`):

1. **Presence fields are classified** (`view_state.rs`, `every_presence_field_is_classified`). A
   fully populated `Presence` is built without `..Default::default()`, so a new field doesn't
   compile until it is set there; then the test fails unless the field is a registry row's wire
   field or an `OUTSIDE` entry with a class.
2. **Rows are well formed** (`rows_are_well_formed`): unique keys, one bit each, no bit taken
   twice, shared keys have a wire field, personal ones a reason. The shipped layer bits are
   pinned (`the_layer_bits_are_the_ones_shipped`).
3. **Every key follows its row** (`web/test/view-state.test.ts`): for each registry key the test
   is generated from the row: a follower shows the presenter's value and sends what it shows;
   stopping restores or keeps; an own change stops-and-keeps or is local; a personal key is never
   sent or overwritten. A new row is tested without writing a test.
4. **No state without a policy** (same file): the test reads every `.ts`/`.tsx` under
   `web/src/player/`, plus `board/Board.tsx` and `map/HoverLabel.tsx`, and fails on any
   `createSignal` or `<details>` that isn't in `web/test/view-state-ledger.ts` with a class
   (`wired`, `unshared`, `personal`, `local`) and a reason. It also fails on a ledger entry whose
   signal is gone, and if a migrated key comes back as a signal of its own in `host.ts`. The
   failure message says where to declare it.

What the guard cannot see: state in a `createStore` or a module-level `let`; DOM state other than
`<details>` (scroll position, focus); a memo that reads your own value where it should read the
shown one (the teleporter line is this case); files outside the scanned set. And a ledger line
can say `local` when it shouldn't; the ledger diff is what a reviewer reads.

## Migration, in small steps

Each step keeps behaviour and must pass `e2e/player-follow*.spec.ts` unchanged, except where a
step says it changes behaviour.

0. **Done (tracer):** registry, generated TS, store, the seven layers, `builds.all`, `names`, the
   four guards. `layers.ts` lost its bit table.
1. **Done.** **The store stops the follow.** `createViewState` takes `onStop`; `set` on a `Stop` key calls
   it. Remove Player.tsx's `mine()` wrapper around each layer toggle. After this a new `Stop` key
   cannot forget to stop.
2. **Done.** **Value kinds, then Vision.** Generalise the store from boolean to the kinds in §3. Move
   `vision.team` (`Choice(3)`) and `vision.last_seen` in; delete `ownVision`, `ownLastSeen`,
   `theirVision`. Wire stays `playback.vision`.
3. **Done.** **Panels.** `skull_recap`, `event_recap`, `inspect` as `Death`/`Slot` keys, `Keep` + `Local`.
   Two things move into the store with them: the "apply only when the group changed" dedupe
   (`heardPanels`: today any panel change re-applies all four, which is why `builds.all` still
   goes through `mirrorPanels`), and "reset on another match" as a row attribute.
4. **Done** for the popover, filters and search (decision 3); list follow and the teleporter
   line not done. **The unshared ones, one row each, after the operator says which:** the build popover
   (`Choice(3)`; lifts `<details>` state into the store), events filters (bits), search (`Text`),
   list follow (flag), sidebar tab. The teleporter line needs no key: derive it from the shown
   hover.
5. **Declined (decision 5).** **Board-level state** (`scene`, `view`, `hover`): leave as `Outside::Wired` unless a change
   there is planned anyway. It is the oldest and best-tested follow code and gains least.
6. **Split `host.ts`** (TD-10) once steps 2–3 have taken the mirroring out of it.
7. **Transport** (§4), if presence bytes turn out to matter.

## Built (steps 1–4, 2026-11-11)

Behaviour was pinned first: `web/e2e/follow-matrix.spec.ts`, a row per key (31 keys and
scenarios: playback, mode, match, jump, Vision, Last seen, scene, viewport, side, hover, the seven
layers, both recaps, inspect, All builds, Tab held, names, and the state that wasn't shared),
each checked on following, live, after the follower's own change (with what Vision and Crowd
control keep), Stop following, the presenter leaving, a late joiner and a server restart. All
passed against the code before the change; after it, rows changed only where a decision did.

- **Step 1:** `createViewState(first, { onOwn, onStop })`; `set` on a `stop` key calls
  `onStop`, which Board wires to `stopFollowing`. Player.tsx's `mine()` wrappers are gone.
- **Decision 2:** a `stop` change adopts every presenter value on screen as the follower's own
  (and remembers it), then stops. Board's `stopFollowing(why)` does the same for the board's
  own stops (a pan, a scrub, a flip, a scene), through `forget("keep")`; the Stop button and
  the presenter leaving are `forget("restore")`.
- **Steps 2–3:** kinds `Bool`, `Choice` (each option with how presence carries it: Vision's
  team is `Team` as serde writes it, `Amber`), `Slot`, `Death`, `Deaths` and `Text { max }`.
  `Deaths` is a fifth kind not in §3: the events list keeps several recaps open and presence
  carries the last, and its apply rule (close the presenter's previous, keep the follower's own)
  had to live somewhere; it is in the store, once. Wire places are `Bit { omit_zero }` (the
  layers byte is always sent, the filters left out at zero), `Value` (always sent: Vision, so
  "All" is told from an older client) and `Optional` (left out at the default). A `group`
  column says which `local` keys apply together (`panels`, `events`): the dedupe moved into the
  store, per group, as the risk below advised. `reset_on_match` is a column. Vision, both
  recaps and inspect moved in; `host.ts` lost `ownVision`, `ownLastSeen`, `theirVision`,
  `skullRecap`, `eventRecaps`, `openBuild`, `mirrorPanels` and `heardPanels`.
- **Step 4 (decision 3):** `builds.popover` (`Choice`, `playback.build_popover`), nine
  `events.filter.*` bits (`playback.event_filters`, a bit per chip in `EVENT_GROUPS` order) and
  `events.search` (`Text { max: 64 }`, `playback.event_search`, checked in `is_valid`; the client
  clips). The sidebar tab and the Map layers popover are `personal` in the ledger.
- **Decision 4:** `presence_bytes` histogram (ws.rs, every valid frame) in `stats summary`.
- **Mutation run** (store, registry, wiring): 51 mutants. The store's 31 and the Rust
  registry's and wire's 10 are all killed by assertions in `view-state.test.ts` and the engine
  tests; of 10 in the wiring (Board, host, PlayerTopBar, a policy flipped in the generated
  registry), 9 are killed by the follow matrix or the unit tests. Five survived the first pass
  and each gained a test (forget not clearing the group dedupe, a repeat remembered, the events
  recap sending its first, the popover's group, a build reopening with its popover); `stops()`
  had no caller and went. One named equivalent: the host clipping the search, which the store
  clips again on the wire.
- `playback.jump` is `Outside::Core` now (its apply logic stays outside, §3); `Outside::Wired`
  is the board's scene, floor, viewport and hover, by decision 5.

## What the tracer proves

- The registry can describe both shipped policies (layers: `Restore` + `Stop`; All builds:
  `Keep` + `Local`) and a personal key, on the wire fields already deployed, with no protocol
  change.
- `host.ts` lost the layers' own/theirs pair and the names signal, and `layers.ts` its bit
  table and codec. `host.ts` did not get shorter (994 lines, +6): the per-key first values and
  the accessor names Player already uses took the place of what left. The store is 81 lines,
  once, for every future boolean key.
- The guards fail when tried (2026-11-11): a new `createSignal` in `host.ts` fails "every
  createSignal is in the ledger"; removing `hover` from `OUTSIDE` fails with "presence field
  `hover` must be exactly one of…"; a new field on `Presence` doesn't compile in the test until
  it is set; and three faults put into the store (a `forget` that does nothing, `Keep` treated
  as `Restore`, a `Stop` change that doesn't keep the presenter's other values) each fail the
  per-key tests.
- The follow e2e specs pass unchanged.

It does not prove the non-boolean kinds, or that step 3's group dedupe fits the store cleanly.

## Risks

- **Two mechanisms until step 3.** Vision and three panels are still hand-wired beside the
  store. Stopping here for long leaves the code harder to read than before (TD-29).
- **The value kinds could grow** into a small type system. Hold the line at §3's list.
- **The ledger is friction.** Every new signal in Player needs a line. That is the point, but
  agents may write `local` by reflex. The reason string and the reviewer are the only check.
- **The scan is a regex** (TD-30). It is exact about what it counts (it fails on a
  `createSignal` it can't name) but blind to the cases listed under the guard.
- **Panel semantics in step 3.** Per-key dedupe would change "the presenter's next change wins"
  from "any panel" to "that panel". Keep it per group unless the operator wants otherwise.

## Decisions for the operator

1. **Adopt the rule?** "New view state is a registry row; anything else in Player gets a ledger
   line." If yes, a line in AGENTS.md's working rules (added on this branch) and briefs that touch
   Player cite it.
2. **What does a follower keep when its own change stops the follow?** Today only the same
   group: toggling a layer while following keeps the presenter's layers but the map goes back to
   the follower's own Vision. Spec §8 reads as "you keep what you were seeing with that one
   change", which would mean all of it. One line in the store either way; changing it is a
   behaviour change, so it wasn't made.
3. **Which unshared state should followers get?** Effects / Build order is small and seems
   clearly wanted. Events filters and search change what the follower's list shows. Sidebar tab
   and the Map layers popover are probably "no", and can be recorded as `personal`.
4. **Split presence into slow and fast frames now, or wait for numbers?** Recommended: wait, and
   add presence bytes to the server's stats first.
5. **Move scene / viewport / hover into the registry (step 5)?** Recommended: no.


## Operator decisions (2026-11-11)

All five as the lead recommended:

1. **Adopt the rule.** New view state is a registry row (sync policy, wire field, restore, override); anything else in Player gets a ledger line. The guards fail the build otherwise.
2. **When a follower's own change stops the follow, they keep everything they were seeing, plus that one change.** Nothing snaps back (today Vision reverts; that changes).
3. **Share** which of Effects / Build order is open in the hero panel, and the Events list's filters and search. **Keep personal:** the sidebar tab and whether the Map layers popover is open.
4. **Don't split presence into slow/fast frames yet.** Measure presence bytes in the server stats first.
5. **Don't move scene, viewport and hover onto the registry.**

Operator: this changes state management, so be extra vigilant about regressions: pin today's
behaviour with tests before changing it, and review adversarially before merging.
