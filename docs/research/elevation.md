# Elevation: can the board show a hero's height?

**Date:** 2026-11-09 · **Scope:** study and mock only; nothing ships from it. One standard 6v6
replay, 129738985 (2,641 s; 28,443 alive hero-seconds).
· **Ask:** the operator, 2026-11-09: "would it be possible to show elevation? not sure about the
UX on it, but the info would be nice"
· **Tools:** two throwaway examples, `elev_probe.rs` and `elev_timeline.rs`, plus Python over
their CSVs. They are not committed: the CSVs hold entity indices, and the plots are drawn over
the pack's minimap art.
· **Mock:** [`elevation-mock.svg`](elevation-mock.svg).

## Verdict: feasible and cheap, because the game already classifies height

**Each team's minimap feed carries a height state per hero.** The feed is `CCitadelTeam`'s
`m_vecFOWEntities`, which we already read for vision (docs/research/replay-vision.md), and the
field is `m_eHeight`. It takes three values:

| `m_eHeight` | Share of samples | z (absolute), p5 / p50 / p95 | z above the local street, p5 / p50 / p95 | On a zip | Grounded |
|---|---|---|---|---|---|
| 0: level | 74% | 128 / 376 / 1,287 | −40 / +24 / +558 | 11.3% | 71% |
| 1: above | 17% | 391 / 790 / 1,554 | −32 / +270 / +906 | 0.1% | 40% |
| 2: below | 9% | −824 / −32 / +384 | −1,056 / −32 / +96 | 0% | 87% |

(The 1 Hz samples are from each hero's own team's feed, which always sees them. "Street" is
the modal grounded z per 512-unit cell; see below.)

What the data shows about the field:

- **It belongs to the hero, not to the viewer.** When both teams can see a hero, the two feeds
  agree on all 26,449 checked seconds. They differ only while one team can't see the hero: the
  enemy feed then freezes height, as it freezes position. So read it from the hero's own team's
  feed.
- **"Below" is clean.**
  - Every sample with z < 0 is "below".
  - 42% of "below" samples are at z ≥ 0 (up to about 384): ramps and shallow cellars that z
    alone would miss.
  - Plotted, the "below" points trace the corridors of `minimap_midtown_mid_tunnels` and its
    octagonal mid-boss pit.
- **"Above" is broad and flickers.**
  - It covers rooftops and ledges, but also jumps: only 40% of "above" samples are grounded.
  - Raw "above" runs last a median of 1 s.
  - Held for 2 s, the median run is 4 s (p90 13 s); held for 3 s it is 6 s (p90 17 s).

We don't need a ground model. The rest of this doc is the evidence for that, and the costs.

## 1. Raw heights

The hero origin z comes from the pawn's `CBodyComponent.m_skeletonInstance.m_vecOrigin` with
its cell, as `parse.rs` already decodes for x/y. Below are 1.84 M tick samples of living
heroes after the game clock starts.

| Percentile | 0 | 1 | 5 | 10 | 25 | 50 | 75 | 90 | 95 | 99 | max |
|---|---|---|---|---|---|---|---|---|---|---|---|
| z | −896 | −448 | −14 | 128 | 256 | 376 | 558 | 1,024 | 1,312 | 1,954 | 2,557 |

**There are no clean bands in absolute z.** About 65% of samples sit in a broad street hump
between 128 and 512, with a long tail up to 2,557 and about 8% below 0.

The street itself spans a wide range. Troopers, who walk the lanes at street level, go from z
120 to 2,493 (median 517). Lane 4's p99 is 2,449, and the middle of each lane runs on raised
ground of about 1,000. So the same absolute z can be a rooftop in one place and the street in
another. Only "below 0 means underground" holds everywhere.

**Per-second noise is small; airborne time is large.**

- **Precision:** z is exact to a fraction of a unit. In fully grounded seconds, the
  within-second range is 0 at p50, 47 at p90 and 85 at p95. That range is real movement on
  stairs and slopes, not noise.
- **Airborne:** heroes are off the ground (`m_hGroundEntity` invalid) 32% of ticks, from jumps,
  dashes and slides. Over all seconds, the within-second range is 27 at p50, 227 at p90 and 595
  at p99.
- **Sampling:** a 1 Hz sample (the second's first tick) agrees with the second's majority band
  82% of the time.

So any height display needs a minimum hold of about 2 s, whichever source it uses.

**Two more pawn fields are free:**

- **`m_eZipLineLaneColor`** is non-zero exactly while the hero rides a zipline, carrying the
  lane's colour. That is 8.4% of ticks and 8.1% of alive seconds after a 2 s hold, with a median
  ride of 6 s. It's an "on a zip" flag the timeline doesn't have yet. Today `zips` is only rope
  ownership.
- **`m_nLastEnteredTunnelID`** and **`m_nTargetDetailLayer`** are 0 for every hero, all match.
  They are no use here.

## 2. Height relative to the local ground

We tried three cheap ground models before finding `m_eHeight`:

| Ground model | Coverage of hero-seconds | Verdict |
|---|---|---|
| Trooper z per 512-unit cell (median) | 59.5% (320 cells) | Too sparse: troopers stay in the lanes, but heroes spend 40% of their time in the jungle, on rooftops and underground. |
| Grounded, non-zipping hero z per 512-unit cell (the modal 64-unit bin, from the same match) | 98.7% (823 cells) | Works. Classified relative to it, the shares are street 83.8%, raised 2.4%, below 5.6% and zip 8.1% (held 2 s). But it estimates the ground from the very heroes it classifies, the 512-unit cells blur ramps and stairs, and it needs a threshold per class. |
| Nav mesh / pack map data | n/a | The pack doesn't export the nav mesh; parsing Source 2 nav data is a project of its own. Not needed. |

`m_eHeight` beats all three. It's the game's own classification, with no threshold or grid to
tune, it costs one more field per feed entry in the reader `vision_tick` already has, and it
catches the shallow underground areas that z < 0 misses.

**Underground: use `m_eHeight == 2`, not the tunnel entities.**

- The 77 `CCitadelTunnelNode` / 100 `CCitadelTunnelTrigger` belong to the *other* layer,
  `minimap_midtown_rat_tunnels`. Plotted over that layer's art, the nodes appear to line up with its thin
  corridors:
  - 53 are inner nodes and 24 are exits (`m_bIsExit`);
  - they form a graph (`m_hConnection1..3`, `m_nTunnelID` 0 or 2);
  - they sit at z −100, 100 and 400, near street height.
- Heroes came within 150 units (3D) of a tunnel entity on only 0.4% of ticks, and
  `m_nLastEnteredTunnelID` never left 0. So either no one used the rat tunnels in this match,
  or that field doesn't show it. One replay can't tell which.
- The z < 0 / "below" traces are the *mid* tunnels layer (`minimap_midtown_mid_tunnels`): the
  mid-boss pit and the cellars around it.
- **Open:** whether a hero in a rat tunnel reads as "below". A replay where someone uses them
  would settle it.

## 3. Cost

**Timeline size**, measured by adding each candidate to this replay's real timeline. The base is
1,530,491 bytes raw, 566,370 with zstd-3 (the store's level, though without its dictionary) and
573,690 gzipped.

| Candidate field per player | Raw | zstd-3 | gzip |
|---|---|---|---|
| `z`: absolute z per second, `Vec<Option<i32>>` like `x` | +134 KB (+8.8%) | +42 KB (+7.5%) | +36 KB (+6.3%) |
| z quantised to 16 units | +101 KB (+6.6%) | +27 KB (+4.8%) | +23 KB (+3.9%) |
| My 4-way band (street, raised, below, zip) as a string, one char per second, held 2 s | +32 KB (+2.1%) | +4 KB (+0.7%) | +3 KB (+0.5%) |
| **`height`: `m_eHeight` held 2 s, `[second, level]` at each change (1,844 entries)** | **+16 KB (+1.05%)** | **+6.4 KB (+1.1%)** | n/a |
| The same held 3 s (1,183 entries) | +10 KB (+0.68%) | +4.4 KB (+0.8%) | n/a |
| A zip flag as `[start, end]` rides (est. about 300 rides) | about +4 KB | about +1 KB | n/a |

The recommended shape is `Player.height: Vec<[u32; 2]>`, a `[second, level]` pair wherever the
held level changes. It would carry `#[serde(default, skip_serializing_if = "Vec::is_empty")]`,
like `seen` and `respawn`, so older timelines still load. It costs about 1% of the timeline.

**FORMAT 5 → 6.** That makes each cached timeline re-parse once, as every layer since format 1
has done. The parse cost is unchanged in practice: the feed is already walked every tick for
`seen`, so this adds one key lookup per hero entry.

**Privacy: none.** Height is the hero's own in-world state, the same kind of data as `x`/`y`. It
comes from the feed entry's class, entity index and height, with no controller and no Steam id.
The zip flag is a pawn field.

## 4. UX options

Today's conventions:

- the hero token is a team-ringed portrait with the health arc around it;
- the "unseen" eye badge sits top-right and the skull badge bottom-centre;
- the hover label reads "Name, Hero · Seen 0:12 ago". It holds plain labels only, shown only
  when useful;
- layer toggles (Heals) default off when they would clutter.

**Option A: hover label only (subtle).** Append "· High ground", "· Underground" or
"· On zipline" while the held level isn't level ground. Nothing changes on the map until someone
hovers. Zero clutter, but you have to know to look.

**Option B: a corner badge, plus the hover label (recommended).**

- **High ground:** a ▲ badge top-left, mirroring the eye badge's size and style.
- **Underground:** a ▼ badge, with the token's team ring dashed and the token slightly dimmed,
  so it reads as "under the street" even at a glance.
- **Zipline:** no badge, because the hero already moves along a drawn rope. The hover label
  says "On zipline".
- **Text:** the hover label carries the words, as in option A.

At any moment, about 1 of the 12 heroes is underground and about 2 are "above". After the 2 s
hold, "below" runs a median of 6 s and "above" 4 s, so badges change about as often as
positions do, not every tick. That's little enough to show by default without a toggle.

**Option C: an underground view (rich).**

- **Floor switch:** a floor switch for the map, with surface and tunnels. Viewing tunnels swaps
  the terrain to `minimap_midtown_mid_tunnels`, dims surface heroes and keeps "below" heroes at
  full strength. Viewing the surface does the reverse.
- **Already reserved:** `Presence.floor` (`surface | tunnels | rat`) is already in the wire
  format for this (crates/engine/src/wire.rs), and a follower would mirror the floor.
- **Cost:** it's the "Underground layer" row of docs/research/map-objectives-audit.md, a medium
  amount of work: the terrain swap, its control, and the tunnel art's alignment, which is
  unchecked.
- **Fit:** it builds on B rather than replacing it.

**Rejected:**

- **A drop-shadow offset or numeric height:** absolute z isn't meaningful to a coach, because
  the street varies from 120 to 2,500, and a continuous cue would flicker with the 32% of
  airborne time.
- **A layer toggle for elevation alone:** B's badges are rare enough not to need one.

**Recommendation: B.** It shows the information everywhere at a glance and keeps the words in
the hover. It needs one compact timeline field and no ground model. C can follow if the operator
wants to coach tunnel rotations specifically.

Mock of B: [`elevation-mock.svg`](elevation-mock.svg). It's schematic, with no game art.

## Decisions for the operator

1. **Option B, or A first?** B is recommended.
2. **What counts as "high ground"?** The game's "above" includes long jumps and ledge-hops.
   Showing it after **2 s** gives about 15% of alive time with a median run of 4 s. After
   **3 s** it's about 14% with a median of 6 s, and fewer blips. Or show only "below" and
   zips, and skip "above"? Below is the cleaner and arguably more useful signal: sewer
   rotations are hidden on the street map.
3. **Add the zip ride flag too?** It's about +1 KB and fits the same FORMAT bump.
4. **Option C (tunnel floor switch) later?** If so, it should be its own backlog item.

## How the numbers were made

- **Probe:** `elev_probe` walks the replay with boon 0.19 and writes CSVs:
  - the class set: pawns, troopers, tunnel nodes and triggers, zip nodes, `CCitadelTeam` and
    the game rules;
  - every living pawn every tick: `x, y, z`, ground handle, zip lane colour, tunnel id and
    detail layer;
  - once a second: troopers and every `m_vecFOWEntities` entry's class, entity index,
    `m_eHeight` and visibility;
  - the static entities once.
- **Timeline:** `elev_timeline` writes the current timeline JSON (`observe` then `derive`).
- **Size:** Python joined the two by hero id and second, added each candidate field, and
  measured raw, gzip -9 and the `zstd` CLI.
- **Hold:** a level counts once it has been sampled for 2 (or 3) consecutive seconds.
- **Caveat:** one replay only. The `m_eHeight` semantics (0/1/2) are inferred from the
  correlations above, not from game code.
