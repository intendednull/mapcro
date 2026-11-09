# Replay vision: which heroes each team could see

**Date:** 2026-11-09 · **Scope:** read-only spike. One 6v6 replay, 129738985 (build 6839, 2,640 s).
· **Tool:** `crates/replay/examples/vision_probe.rs` (5 s per parse; 16 s with `--names`)
· **Output:** `/tmp/vision-spike/` (not committed: it holds entity indices).

## Verdict: feasible

**Each team's own minimap feed is in the demo.** Every `CCitadelTeam` entity (teams 2 and 3,
and spectator team 1) carries `m_vecFOWEntities`, a `CUtlVectorEmbeddedNetworkVar<STeamFOWEntity>`
of about 120 entries, updated every tick. An entry's fields are:

| Field | Meaning (observed) |
|---|---|
| `m_eClass` | 1 = hero pawn; others below |
| `m_nEntIndex`, `m_nTeam` | the tracked entity and its team |
| `m_bVisibleOnMap` | **this team sees it now** |
| `m_nPositionX/Y` (uint8) | minimap position; frozen at the last-seen spot while hidden |
| `m_nTickHidden` (GameTick_t) | when it was last hidden |
| `m_nHealthPercent`, `m_eHeight`, `m_iLane`, `m_bBackdoorProtectionActive`, `m_nOwnerOnlyEntIndex`, `m_strCSSClass` | not probed |

boon 0.19 already reads this as `replay_inputs::EnemyMinimap`. That reader also resolves Steam
ids through the controllers, so the probe reads the fields itself.

## Evidence that `m_bVisibleOnMap` means "the enemy team sees this hero"

- **Opening:** no hero is visible to the enemy until 18.2 s, when laners first close to within
  about 2,400 units. Over the first 30 s, 13% of hero-seconds are visible.
- **Distance to the nearest living enemy hero** (28.7k hero-seconds):
  - under 1,000 units: 85% visible
  - 1,500–2,000: 48%
  - 2,500–10,000: about 15% (troopers, objectives and wards also give vision)
  - over 10,000: 5.5%
- **Deaths:** 77 of 79 victims were visible at the death tick, and 78 of 79 within the 64 ticks
  before it. The exception (hero 81) was hidden for 2 s, with enemies 130–434 units away:
  probably stealth or a damage-over-time kill. Not checked.
- **`CCitadelPlayerPawn.m_tLastPlayerRevealTime` agrees, independently:**
  - when the reveal is less than 0.1 s old, the flag is set 99.3% of the time;
  - at 0.5–2 s old, 29%;
  - at 10 s or older, 13%.

  So that field (timers-audit gap 9) is the pawn-side "last revealed to the enemy" time.
- **The FOW position matches the true position while visible:**
  `fow = 0.011858 · world + 127`, about 84 units per step, with residuals at p99 under 0.6 of a
  step. While hidden, the FOW position stays put in 98% of seconds, but the true position moves
  in 90% of them.

**The current timeline shows everything.** `parse.rs` samples every pawn's true position each
second whether or not anyone sees it. SourceTV is omniscient, so the filter has to come from
this flag.

**Other `m_eClass` ids carry their own flag:**
- 5 trooper boss (guardian), 8 mid boss, 28 shrine, 29 walker, 30 base guardian, 31 patron;
- 10 shop, 12 minimap marker, 41 bridge buff, 43 rejuv and gold, 44 urn, 45 rift spawner,
  54 urn return, 57 teleporter, 92 rift cash-in, 121 Nurse leech;
- 34–38 resolve to no entity: probably neutral camps. Unverified.

## Size

The match has 3,000 visible intervals across the 12 heroes. As deciseconds `[start, end]` per
player, that is 38.5 KB of JSON (16 KB gzipped). Merging gaps under 0.5 s cuts it to 2,053
intervals, 26.6 KB (11 KB gzipped). That is about 2% of this match's 1.49 MB timeline. Half of
the hidden gaps are under 1 s, so merging also removes flicker.

## Sketch

- **Timeline:** `Player.seen: Vec<[u32; 2]>`, the decisecond intervals during which the enemy team
  saw this hero. Optional later: `last_seen` comes free from the freeze, and objectives can get
  the same `seen` keyed by site.
- **Player UI:** a top-bar toggle, `Vision: All | Amber | Sapphire`.
  - In a team's view, an enemy hero outside `seen` is hidden or ghosted at its last-seen spot,
    with "seen 12 s ago". Allies always show.
  - Camps and objectives can follow once classes 34–38 are confirmed.

## Open questions

- Classes 34–38: camps? Their `m_nEntIndex` resolves to no decoded entity.
- Whether troopers in an entry give vision, and what `m_nOwnerOnlyEntIndex` and the
  spectator team's list are for.
- Hero 81's hidden death: stealth?
- This is one replay. Check a second 6v6 match, and re-check after patches.

## Rerun

```
/tmp/mapcro-scripts/gate.sh 1800 || exit 3
nix develop -c nice -n 10 cargo run -p mapcro-replay --release --example vision_probe -- \
  <a 6v6 replay .dem> /tmp/vision-spike [--names]
```
