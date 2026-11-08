# 2026-11-08: Respawn timers and the Soul Urn

The operator asked for two things: "We're missing the death timers, the player respawn timers.
We should be able to parse that." And: "We're also missing the urn objective." Spec §6a and §6b
hold the design. Exploration rounds 5 and 6 hold the field-level findings. This entry records
what doing it taught us.

## What changed

- **Respawns, both tiers.**
  - The timeline gives each player `respawn: [[died_s, back_s], …]`.
  - Replay: the second the hero is next seen alive, else the pawn's `m_flRespawnTime`.
  - Metadata: `death_duration_s`, which deadlock-api had all along.
  - Player shows the seconds left over a dead hero's darkened top-bar portrait, as the HUD does.
- **The urn, replay tier.**
  - The worker reads the idol and its two return triggers every tick. It writes the spawns, the
    state where it changes and three new event kinds.
  - Player draws the urn on the ground, or on its carrier in the carrier's colour. It lights the
    open delivery point and gives the next spawn on hover, through the camps' tooltip.
  - The urn events get their own filter and pings.
- **Assets.** The extractor maps `citadel_trigger_idol_return` to kind `urn`, and the built-in
  map gains the two sites. The urn's art (`soul_jar_marker*`) was already in every pack.
- **Sandbox.** The urn points toggle like the rifts: off by default, one open at a time. The
  rifts' rule became `offByDefault(kind)` in `map/model.ts`.
- **Format stamp.** Worker timelines carry `format: 1`. Nothing reads the stamp yet.

## Surprises

- **The controller's `m_flRespawnTime` is always 0.** The pawn's is the real one. Round 2 had
  noted the pawn field, so the census paid off.
- **Respawn: seen, not just the timer.** Once in the last two minutes of 129738985 a hero came
  back 20 s before its timer said, with no change in the timer. Another time the timer itself
  dropped 20 s, so only its last value is right. Taking the second the hero is seen alive is
  exact whenever the recording shows it, and the timer covers the end. The
  unit test keeps a case where the two disagree, so a mutation that prefers the timer fails.
  - **Explained later the same day:** killing a Patron's first stage shortens respawn timers
    (operator). Sapphire's Patron fell to its second stage at 2575 s, and both heroes were
    Sapphire's dead at that moment (journal 2026-11-08-urn-polish; exploration round 5).
- **The urn drifts on its own.** One urn moved 700 units with nobody holding it (28:13–28:28).
  The urn moves on its own after a while (operator); the drift is expected. Player draws it on
  the ground there, with no carrier, gliding between places (journal 2026-11-08-urn-polish).
- **Nothing names the urn's carrier.** boon reads it from the modifier table, but that needs the
  ability catalog. The nearest living hero of the carrying team, at the pick-up tick, matched
  every later drop and delivery, at 30–570 units.
- **`.map .ground` hides any SVG element with class `ground`** (the terrain's fallback). The
  urn's `ground` state class vanished on the map, and only an e2e that measured the drawn urn
  against its site caught it. The state classes are now `urn-ground` and `urn-carried`.
- **The metadata paths show a death one sample late,** so a respawn at `died + duration` would
  count down to 0 a second before the hero reappears. The metadata tier adds 1 so the two meet.
  30 of 42 respawns landed exactly, and the rest are within 2 s on re-anchored paths.

## Checks

- Parse of 129738985 (5.4 s): 7 urn spawns, from 10:00 every 300 s, alternating sides, and 22
  urn events. All 74 deaths have a respawn; seven heroes are still dead when the game ends, and
  their respawns come from the timer.
- Screenshots: `/tmp/urn-respawn-shots/real-{605,640,980,1220,1600,1855,2150,2450,2560}.png`
  show countdowns over dead portraits, the urn falling over the west point, carried with an
  Amber ring, dropped with the dropper's ring, the open point lit, and the tooltips.
- Mutations: 11 web pieces and 9 Rust pieces reverted one at a time. Each one failed its test.

## Open

- The map shows nothing for a dead hero. A ghost token with a countdown at its last spot would
  match the board's K label, but Player hides dead heroes on purpose (§6b). Left for the lead.
- Stale cached replay timelines aren't re-parsed: the stamp exists, but the server doesn't act on
  it (backlog: "Replay timeline format versions"). Done the same day: journal
  2026-11-08-urn-polish.
