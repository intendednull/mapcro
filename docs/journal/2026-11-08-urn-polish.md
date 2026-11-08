# 2026-11-08: Older timelines upgrade themselves, and the urn stands out

Two follow-ups to the urn and respawn work (journal 2026-11-08-urn-respawn). Spec §6a (Format
stamp) and §6b (The Soul Urn) hold the design.

## What changed

- **Format versions, acted on** (backlog "Replay timeline format versions", resolved).
  - The worker's `mapcro_replay::timeline::FORMAT` is the one number; the server reads a cached
    timeline's `format` against it (a missing stamp is 0).
  - A stale fetched timeline, inside Valve's three weeks, is fetched and parsed again when an
    editor opens the match. The old one is served at once; the new job's status shows instead of
    `done`, so Player watches it ("Updating replay…") and swaps the new one in place.
  - Once a match, whatever comes of it. Past three weeks, or for an upload, the old one stays;
    a stale upload's status says `stale`, and Player offers "Upload replay file" with a hint on
    the chip.
- **The urn, found at a glance.** The lead couldn't spot it at the default zoom.
  - About an objective marker's size on the ground: a cyan ring that glows, on a dark disc,
    over a dark halo. Dropped: a dashed ring in the dropper's colour. Carried: smaller, a solid
    ring in the carrier's colour.
  - The open delivery point is lit with the game's own pulse art (`soul_jar_marker_return_pulse`,
    already in every pack), a brass ring and a wave that `prefers-reduced-motion` drops. Sandbox
    points light the same way.
  - A drifting urn glides between its recorded places.

## Surprises

- **`job_state` put a cached timeline before work under way.** A refetch would have read `done`
  throughout, so the client never watched it. Work under way now comes first, and a failed
  refetch still reads `done`, since its old timeline is there.
- **The "once a match" guard needs to be at the enqueue.** A first check before reading the file
  is only a shortcut: a mutation that drops it passes every test, and one that drops the guard
  at the enqueue fails the refetch-failure test. A parse failure is the case that shows it,
  since a salts 404 is already remembered for 6 h by the match's negative cache.
- **Every e2e synthetic timeline was a "stale upload".** They carried no `format`, so after the
  change Player offered "Upload replay file" on their full replays and two specs failed. They
  now carry `format: 1`.
- **The urn's drift is the game's** (operator): the urn moves on its own after a while. The
  worker records it as more `ground` places with no team, so nothing infers a carrier from it.
- **The Patron explains the early respawns** (operator: killing the first Patron stage reduces
  respawn timers). On 129738985 Sapphire's Patron reached 0 at 2575 s. The hero that came back
  20 s early (died 2557 s) and the one whose timer dropped 20 s (died 2575 s) were both
  Sapphire's dead then; Sapphire's next death (2581 s) and the Amber hero dead at the time waited
  the full 85 s. The countdown already uses the next second seen alive, so nothing changes.

## Checks

- Server: 4 new integration tests (`crates/server/tests/replays.rs`). A format-0 CDN timeline
  in the window is fetched once and replaced; a failed refetch keeps the old one, untried
  again; past three weeks it isn't fetched; a stale upload is served, says `stale`, isn't
  fetched, and a new upload clears it. All 31 replay tests pass.
- Web: a unit test for the drift glide; `player-format-refresh.spec.ts` (the swap in place, and
  the stale upload's offer); the urn spec checks the size, the lit point (ring and wave), reduced
  motion and the dropped ring; `tools.spec.ts` checks Sandbox's lit point.
- Real-replay shots (129738985, parsed by the current worker): `/tmp/urn-polish-shots/desk-
  {605,612,640,1700,1855,2450}.png`, `phone-{605,640}.png`, and `compare-strip.png` (top row
  before, bottom after, at 10:05, 10:40, 30:55 and 40:50). Looked at one by one, the urn and
  the open point are found at once in each; before, the urn was a speck.

## Open

- "Once a match" is in memory: a restart allows one more refetch per stale match.
- Production's 129738985 (parsed 2026-11-08, format 0; the match started 2026-11-02, so inside
  the window until 2026-11-23) upgrades on an editor's next open if its cache is the CDN's.
  Whether it is the CDN's or an upload's wasn't checked from here; if it's an upload, the chip
  offers "Upload replay file".
