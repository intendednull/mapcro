# Backlog

Ideas the operator wants kept but not built yet. Newest first. Each entry records when it was raised,
what it is, and what it depends on.

## Parse replays in the browser (2026-11-08)

Build the replay parser to WebAssembly and parse an uploaded `.dem` in the user's browser, then send
the small timeline instead of a 500 MB upload. That removes our upload bandwidth and parse CPU for
uploads. A browser-parsed timeline is untrusted, so it applies only to the board that sent it,
never the shared per-match cache. Open questions: does boon build for wasm32 (it mmaps the file
today), and are the time and memory acceptable for a 500 MB demo on a phone. Also weigh
deadlock-api's `/v1/matches/demo/query` (they parse; 200 req/h per IP), though they're at capacity.
Notes: `docs/research/browser-side-replays.md`. Deferred by the operator in favour of moving the
deadlock-api calls to the browser first.

## A settings page (2026-11-08)

As display preferences pile up, give them one home. Today they sit on Player's transport bar:
Troopers, Health, Pings, and the per-viewer Names toggle ("anonymous mode" for content creators).
A settings page or panel would hold the per-viewer ones, stored in the browser and never synced,
and could later hold board-wide ones for the owner. Decide which stay as quick toggles on the bar.

## "Resume a scene" (2026-11-08)

- **Playback is in progress**, as Player (spec §6b): it plays an imported match on the map, with
  annotation over it kept only by saving a scene (operator, decided).
- **Resume a scene:** start playback from a saved scene's moment, to show "here's what you should have
  done" (the scene, edited) next to "here's what you actually did" (the match playing on from that point).
  Enabled by Player's saved scenes storing their source (match id, t, tier); the action itself isn't
  built.
- **Open question:** resuming inside the game client itself, rather than in mapcro's playback, would
  need a way to load game state into Deadlock. No public mechanism for that is known.

## Board download and upload (2026-11-08)

Export and import a board as a file. The spec already plans a versioned `.mapcro.json` that goes through
the same migrations (spec §6).

## Data and storage decisions (deferred by the operator, 2026-11-08)

- **Idle boards:** whether to expire boards nobody has opened, for example after 180 days.
- **Backups:** a nightly off-box snapshot of the server database; the provider is undecided.
- **Cached match timelines:** whether to keep them forever. They're small, and they're the only copy
  once a replay expires.

## Older maps (2026-11-08)

Replays from before build 6712 are refused as "Old map". Supporting them needs the 16384 coordinate
correction (`docs/research/replay-parsing-exploration.md`) plus asset packs from that era.

## Replay timeline format versions (2026-11-08)

Cached replay timelines carry no format version. When the worker's output changes (the 2026-11-08
lane data change replaced `waves` with `zips` and `camps`), older caches keep loading in the old shape
and miss the new layers until re-parsed. Fix: stamp a format version in the timeline. A stale CDN
timeline is re-fetched and re-parsed. A stale upload is served as is, with the "Upload replay file"
upgrade offered, since the server deletes uploaded demos after parsing. This matters once the replay
tier is in production, which it isn't yet.

## Server

- Presence relay is O(n²) in bytes per room (perf report finding 4). It's fine at our scale.
- Base frames aren't chunked. A board over 8 MiB of JSON falls back to paged catch-up.
- **Rebase fan-out isn't bounded** (sync review 2026-11-08, finding 4): each stale hello clones the
  doc and builds its own JSON frame, and the outbox weight doesn't count it. 64 devices returning
  to an 8 MB board after a compaction could exceed the service's 256M memory. The fix is to serialize
  once per (doc, seq), splice in `decided_below`, and count it.
