# Backlog

Ideas the operator wants kept but not built yet. Newest first. Each entry records when it was raised,
what it is, and what it depends on.

## Playback mode, and "resume a scene" (2026-11-08)

- **Playback:** a player component, or mode, that plays an imported match through on the map, so the team
  can annotate it as it runs without saving scenes. Ink, arrows, comments and pings stay live over the
  playback.
- **Resume a scene:** start playback from a saved scene's moment, to show "here's what you should have
  done" (the scene, edited) next to "here's what you actually did" (the match playing on from that point).
- **Depends on:**
  - scenes remembering their source match and time; today imported scenes are frozen copies named
    "Match <id> @ mm:ss"
  - the replay or metadata timeline being available at view time; it's cached on the server
  - a playback clock shared by followers, with presence carrying the playback position
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

## Server

- Presence relay is O(n²) in bytes per room (perf report finding 4). It's fine at our scale.
- Base frames aren't chunked. A board over 8 MiB of JSON falls back to paged catch-up.
