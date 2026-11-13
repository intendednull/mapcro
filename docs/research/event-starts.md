# Event starts: what each event's `t` marks, and where the start is

Player's events list jumps to `t` less the lead. For some kinds `t` is the **end** of what
happened: an objective's destruction, a Mid-Boss kill, a rift captured, a souls swing that has
already moved 5000. Clicking those lands after the fight. This doc asks, for every kind in
`EVENT_KINDS` (`crates/replay/src/timeline.rs`), what `t` is, whether the timeline can give the
**start**, and what it takes to use it.

Measured on the two cached format-10 timelines: **129738985** (2,640 s, 295 events) and
**134623152** (2,547 s, 305 events). Both standard 6v6. Numbers only: no names, no account ids.
The implementation is client-side (`web/src/player/events.ts` `eventStart`), so nothing here
needs a FORMAT bump.

## Result

| kind | n (m1 / m2) | what `t` is | start | t − start, min / med / p90 / max (m1; m2) | reliable |
|---|---|---|---|---|---|
| `death` | 74 / 92 | the death second (the pawn's `m_lifeState`) | none: keep `t` | — | **no** |
| `objective` | 19 / 22 | the second its health read 0 (`destroyed_s`) | first health row after the last ≥ 20 s quiet gap | 1 / 12 / 22 / 27 (18 events); 3 / 11 / 37 / 43 (21) | yes |
| `mid_boss` | 2 / 1 | the kill second | first health drop after its last 100 % | 15 and 35; 25 | yes |
| `rift_up` | 5 / 5 | the announcement (`start_s`) | `t` (it already starts) | 0; 0 | yes |
| `rift_capture` | 5 / 4 | the second the team's scoring rose (the capture completed) | first capture row with that team's progress > 0 | 13 / 18 / 43 / 43; 13 / 15.8 / 18.5 / 18.5 | yes |
| `powerup_spawn` | 16 / 15 | the spawn second | `t` | 0; 0 | yes |
| `powerup_taken` | 16 / 14 | the take second | `t` | 0; 0 | yes |
| `souls_swing` | 14 / 15 | the second the 60 s move reached 5000 | the lead's turning point in the window, on a 5 s mean | 17 / 52 / 60 / 60; 29 / 50 / 60 / 60 | yes, as a lower bound (4 of 14 and 4 of 15 clamp at 60 s) |
| `ult` | 114 / 110 | the cast second (the `ImportantAbilityUsed` message, else the cooldown start) | `t` | 0; 0 | yes |
| `urn_pickup` | 11 / 11 | the pickup second | `t` | 0; 0 | yes |
| `urn_drop` | 4 / 5 | the drop second | `t` | 0; 0 | yes |
| `urn_delivered` | 7 / 6 | the delivery second | `t` | 0; 0 | yes |
| `rejuv_taken` | 2 / 1 | the `RejuvStatus` second (= `taken_s`) | `t` | 0; 0 | yes |
| `rejuv_revive` | 4 / 3 | the revive second | `t` | 0; 0 | yes |
| `rejuv_expired` | 2 / 1 | the expiry second (= `ends_s`) | `t` | 0; 0 | yes |

"n" counts the events in that match's list. The `objective` counts include one patron event per
match, which has no start (below), so 18 and 21 have one. Apart from the death (no start by
design) and the patron, every event in both matches has a usable signal.

## Death: keep `t`

`t` is the death second. The start would be when the damage that killed the hero began. The
timeline has three candidate signals and none is that:

- **The recap** (`players[].recaps`) is one per death: `t` is the lethal hit in tenths (the event's
  `t` is its floor, 0–1 s later), and `damage` is `[src, ability, damage]` **summed over the 10 s
  before**. There are no per-hit times, so the first damage second is not in the timeline at all.
  All 74 and 92 deaths have a recap within 1 s.
- **`health`** (percent per second): the last second at 100 % before the death exists for 64 of 74
  (m1) and 74 of 92 (m2); t − start is min 1, med 13.5/18, p90 32/48, max 53/59. But "last full
  health" is not the fight's start: chip damage and regeneration move it, and 10 and 18 deaths
  never see 100 % in the minute before.
- **`cc`**: the first hard-CC row in the recap's 10 s window exists for only 43 of 74 and 34 of 92
  deaths (t − start 0.8–11 s and 1.6–12 s, median about 6). CC is not damage, and most deaths
  have none.

So a death keeps `t`; the lead (default 5 s, up to 60) is the pre-roll. A real start needs the
parser: keep the earliest hit's second in each `Recap` (a `first_s`), which is a FORMAT bump. It
would buy at most 10 s before the death — the window's own length — which the lead already
covers, so this doc recommends not doing it.

## Objective: the last push, from health gaps

`t` is `destroyed_s`: the second the site's health read 0. The timeline's `objective_health` is
`[second, percent]` where the percent changed by at least a point (a base-guardian pair is the
mean of its members).

**The first drop from 100 % is not the start.** It runs for most of the match: t − first-drop is
min 9, med 467, p90 1078, max 1327 (m1) and min 5, med 315, p90 1015, max 1431 (m2). Nor is the
last time at 100 %: med 1622 and 1509. Objectives are chipped all game.

**The rule:** the first health row after the last gap of at least **20 s** between rows at or
before `destroyed_s`. That is the last time the objective stood still before the push that killed
it. Measured: m1 min 1, med 12, p90 22, max 27 (18 events); m2 min 3, med 11, p90 37, max 43 (21).
No real objective's start is more than 60 s before `t`; the final push lasts 1–43 s (median
11–12).

Edge cases, and how the rule handles them:

- **Multiple pushes:** the last quiet gap wins, so the start is the final push, not the first chip
  damage. Example: `walker:amber:lane1:1` in 129738985 drops 89→79 at 1835–1849, 78→77 at
  1916–1923, then 74→0 at 2095–2117; the start is 2095 (22 s before the death).
- **Healing / regeneration:** health does go back up, sometimes by 20–30 points in one second
  (e.g. `walker:amber:lane1:1` 59→87 at 1418/1419; two walkers at once). 12 and 13 upward moves
  per match. The rule keys on *time gaps*, not on direction, so a heal inside a push is just
  another row; a heal after a lull makes the next row the start of the next push.
- **A long final push:** the rule starts at the push's first row, however long. The only > 60 s
  case is the patron (below).
- **The patron:** an `objective` event whose key starts with `patron:` is the match ending, not a
  destruction: the parse stops at the winner's tick, and `derive.rs` adds the loser's patron at
  `duration_s` when it wasn't seen at 0. Its health also restarts between stages (m1:
  100→0 at 2575, then 100 at 2588). It keeps `t`; there is no push to start at.
- **No health rows** (the metadata tier, or an old timeline): keeps `t`.

## Mid-Boss: the last full health

`t` is the kill second. Its `objective_health` track goes 100 → 0 over 15 s (m1 first kill), 35 s
(m1 second) and 25 s (m2), and it regenerates to full between attempts: in 134623152 it dips to
99 % at 2114 and is back at 100 % at 2121, and the real attempt starts at 2251. **The rule:** the
first drop after the last row at 100 % before the kill. A one-shot kill (no drop before the kill
second) starts at the kill second. No track (metadata) keeps `t`.

## Rift capture: when the cash-in began

`t` is when the team's scoring first rose, i.e. after the capture completed. The rift's cash-in
opened at `live_s`; the event's `t` is 13–43 s later. `rifts[].capture` is `[tenths, amber %,
sapphire %]` from `live_s`, so **the start is the first row where the capturing team's progress is
above 0** — when they started cashing in. In these nine captures the progress never resets to 0
before 100; if it does, the first rise is the start of the contest, not necessarily of the
successful one. Without `capture` rows (format 2), `live_s` is the start; without a rift or a team,
`t`.

## Souls swing: the lead's turning point

`t` is the second the Amber-minus-Sapphire lead had moved 5000 within the last 60 s (and still
held 10 s later), so it is the **end** of the move. The move is spread across the window, so the
start is the **turning point**: the last minimum of the lead on the way up, the last maximum on
the way down, within `[t-60, t]`.

The raw lead is noisy: each player's souls samples land on their own seconds, so it jumps by
thousands between neighbours. Average it over ±2 s before looking for the turn. Measured: m1
17/52/60/60, m2 29/50/60/60. In 4 of 14 and 4 of 15 the turning point is the window's first
second: the lead was already moving at `t-60`, so the true turn is earlier and `t-60` is the
earliest the parser's window can say. The start is therefore **a lower bound**, never after the
turn; it is at most 60 s before `t`.

Edge cases: a swing that reverses (the extremum is the turn); a gradual drift with no turn in the
window (clamped); the first two minutes are skipped by the parser, so no event is near them.

## The other kinds already start at `t`

- **`rift_up`:** `t` is `start_s`, the announcement. The cash-in opens at `live_s`, **80–81 s
  later** in both matches. The marker is up from `start_s` (`sitesAt`), so `t` is the start of the
  event as the list names it; jumping to the opening would be a change of `t`, not a start.
- **`ult`:** `t` is the cast second: the `ImportantAbilityUsed` message's second, or the second
  the ult cooldown started when no message was seen (2 of 114 and 2 of 110 have no message within
  2 s).
- **`powerup_spawn` / `powerup_taken`:** the spawn and take seconds; every event matches a
  `powerups[].spawns` `t` or `taken_s` (0 mismatches).
- **`urn_pickup` / `urn_drop` / `urn_delivered`:** the state-change seconds, matching `urn.at`'s
  `carried`, `ground` and `none` rows.
- **`rejuv_taken` / `rejuv_expired`:** `taken_s` and `ends_s` exactly. **`rejuv_revive`:** the
  message second (the revive count can drop 3 s earlier, e.g. 1927 vs 1930 in 129738985).
- **Team fights / multi-kills:** `EVENT_KINDS` has no such kind; deaths are one per hero, so there
  is no cluster whose first death could be a start.

## What it would take to go further

Only the death needs the parser: `Recap` would carry the first hit's second (or per-hit times),
which means a FORMAT bump and re-parsing cached timelines. The value is small (≤ 10 s, inside the
lead's range), so the proposal is to keep `t` and not bump. Everything else above is derived from
fields the timeline already has, so it needs no format change and works on every format-10
timeline in the cache; older timelines without `objective_health`, `rifts[].capture` or `souls`
fall back to `t`.

## Implementation

`web/src/player/events.ts`:

- `soulsLead(tl, t)` — the lead, as `souls_swings` reads it.
- `swingStart`, `objectiveStart`, `midBossStart`, `riftCaptureStart` — the four rules.
- `eventStart(tl, e)` — the kind's start, else `e.t`.
- `jumpAt(t, lead)` and `jumpTarget(tl, e, lead)` — the target; Player's click, ↑ ↓ step and scene
  save use `jumpTarget`, and a row carries `data-start` when its start is before `t`.

The client copies the parser's 60 s window (`SWING_WINDOW_S` vs `timeline.rs`'s `SWING_WINDOW`);
if the parser changes it, a swing's start drifts with no test failing. Logged as TD-58. The 20 s
objective quiet gap is the client's own heuristic, not a parser constant.

Tests: `web/test/event-starts.test.ts` (the rules, the edge cases, the jump target);
`just web-test` passes.
