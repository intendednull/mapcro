# Backlog

Ideas the operator wants kept but not built yet. Newest first. Each entry records when it was raised,
what it is, and what it depends on.

## The other dialogs don't hold the focus (2026-11-09, from the feedback form)

Share, Clone and the hero picker render inside the page and don't contain the keyboard: Tab
walks out of the dialog into the board behind it, which stays interactive (the known Share
focus-escape issue). `web/src/ui/modal.ts`, built for the feedback dialog, is the fix: render the
dialog through a `<Portal>`, call `useModal(() => scrimEl)`, and stop key presses at the dialog
so the board's window listeners (Escape's `leaveControl`, Space) don't act on them. The
feedback e2e spec's Tab, inert and focus-return checks can be copied.

## Feedback on phones (2026-11-09)

The phone board (`PhoneBoard`) has no Feedback button; the landing's footer link works there.
Add it to the phone top bar if phone users should reach it from a board.

## Alert when the feedback token stops working (2026-11-09)

A fine-grained token expires. When it does, every send is a 502 and `feedback_rejected
{reason=github_error}` rises, with `github issues refused` rows in `failures`. Nothing alerts on
it yet (observability spec §6); an alert on any `github_error` in a day would catch expiry.

## Vision for objectives, camps and troopers (2026-11-09)

Player's Vision (spec §6b) covers heroes only. The same feed (`CCitadelTeam.m_vecFOWEntities`,
docs/research/replay-vision.md) carries `m_bVisibleOnMap` for objectives by `m_eClass`: 5
guardian, 8 mid boss, 28 shrine, 29 walker, 30 base guardian, 31 patron; also 41 bridge buff,
43 rejuv/gold, 44 urn, 45 rift spawner, 92 rift cash-in. Classes 34–38 resolve to no entity
(probably camps, unconfirmed). A `seen` per objective key (like `Player.seen`) would let a team's
view hide an objective's health and state changes out of its sight. Troopers' entries weren't
probed.

## Vision leaves the rest of Player omniscient (2026-11-09): resolved, by design

Operator, 2026-11-09: "vision should only hide the hero on the map, everything else can stay
visible." So the behaviour below is intended. Keep it unless the operator asks again.


In a team's Vision only the enemy tokens on the map change. Still shown as SourceTV saw them:
the top bar's enemy health, ult, souls and respawn timers (`PlayerTopBar.tsx`); the events list
and its pings and jump rings (an enemy's death or ult where nobody on the team saw it; the jump
ring in `host.ts` `ring` follows the hero's true position); the trooper dots; objectives'
health. Some of that a player does know in game (the scoreboard has souls and respawns), so each
needs a call per item, not a blanket filter.

## Vision checked on one replay (2026-11-09)

`m_bVisibleOnMap`'s meaning was validated on 129738985 alone (build 6839). Worth re-checking on a
second standard 6v6 match and after patches: the first sighting near the laners' first contact,
almost every death seen, the FOW position matching the true one while visible. The spike's open
questions stand: hero 81's death while hidden for 2 s (stealth?), the spectator team's list, and
`m_nOwnerOnlyEntIndex`.

## The HUD's mid-boss timer circle and per-player Rejuvenator marks (2026-11-09)

Noticed by rejuv-icons while reading `citadel_hud_top_bar.vcss` for the Rejuvenator marks. Two
states the game draws that Player doesn't:
- `#RejuvenatorTimer.midboss_cooldown`: when no team holds one, the same centre circle shows
  greyed (`saturation: 0`, opacity 0.3) with `.midbossTimerLabel` (`{s:midboss_timer}`, 10 px,
  under it), the mid boss's respawn countdown. The timeline has the respawn (`camps` cleared
  pairs). `.midboss_available` hides it.
- Per player: `.HasRejuvenator .SoulsValueContainer { border-bottom: 3px solid gold }` and the
  `.Rejuvenator` / `.RebirthIcon` / `.RebirthAndRejuvenator` icons on a player's card
  (`citadel_hud_top_bar_player.vxml`). Who carries a pending revive isn't in the timeline yet.

## "0 revives" in the mid boss's label (2026-11-09)

`player/Camps.tsx` `rejuvLine` says "Archmother Rejuvenator: 0 revives, ends in …" if a
timeline's `left` reaches 0 before `ends_s`. The top bar drops its marks and timer then
(PlayerTopBar `RejuvTimer`), so the two disagree. 129738985 never reaches 0 early (both expire
at 180 s with 1 left). Only seen on a synthetic timeline. Whether the game ends the buff at 0 is
unconfirmed.

## Hover-label token parts are unused now (2026-11-09)

Left by portrait-menu: with the tokens' eye and skull buttons gone (kill and vision moved to the
top-bar portrait's right-click menu), nothing calls `hoverToken` with a `part` any more.
`map/HoverLabel.tsx` still carries the `part` field, its doc comment naming `vis` and `life`, and
`fromPresence` still accepts those two from peers (an older client may still send them for one
deploy). Once no client in the field sends parts, drop `part` from `HoverRef`, the resolver's
argument and the `data-part` attribute. Cleanup only; no behaviour change.

## Camp selection rings oversized on the fallback map (2026-11-09)

Noticed by board-ux while checking the selection-in-your-colour shots
(`web/e2e/selection-colour.spec.ts`, `shots/selection-colour-objectives.png`). On the fallback map
(no pack), a camp's `.mk` box is about 2.5x its drawn triangle or square. So the picked ring
(`.mk.picked::after`, `inset: -14%` of the box) circles far past the icon, and neighbouring camps'
rings overlap. With pack art the icon fills the box. Fix: size the fallback camp glyph to its box,
or size the ring from the glyph. Not checked against every real-art camp tier.

## Top-bar hover rings don't wear the viewer's colour (2026-11-09)

`--me` (my presence colour) is set on the map box only (`Board.tsx` mapBox), so the hover ring on a
top-bar portrait (`.tb-focus:hover`) and the roster chip's outline fall back to `--accent`. Moving
`--me` to the board's root (the `.app.board-app` and `.phone` divs) would colour them too.
Cosmetic.

## Rift capture rings under the hero tokens (2026-11-09)

Noticed by rejuv-rift while checking 129738985's screenshots: on a contested rift (12:20 to 12:59)
the heroes stand on the point, and `player/Rift.tsx`'s rings are drawn over their tokens
(Board.tsx puts `RiftRings` after `Layers`, beside `UrnMark`), so a ring crosses a portrait. It may
read better drawn under the tokens, or with radii that clear a token on the point. Screenshots of
that rift come from `e2e/shots-rejuv-rift.spec.ts` (set `MAPCRO_SHOT_REPLAY` to a format-3 parse).

## A hidden marker's silence has no test of its own (2026-11-09)

Since labels became timers-only (2026-11-09), `e2e/hover-hidden.spec.ts` hovers walkers in Sandbox,
which say nothing whether hidden or not. So `MarkerTips`' `p.hidden(m.key)` check
(player/Camps.tsx) is no longer pinned. A Player test that hides a timed marker (a cleared camp) and
expects no label would pin it.

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

## The canvas fills the centre area (2026-11-09)

Operator: "can we make the canvas the entire center area? more space to draw … seemless". Today the
drawable area is the map's square box plus a notes margin of a quarter map each side
(`MARGIN`, web/src/map/transform.ts); the host clips at the square. Backlogged as too big for now,
because it moves the clip from `.mapbox` to `.mapfit`, and the clamps `clampToBoard`, `clampShift`,
`clampView` and `MAX_W` all have to widen. The follow view (centre plus zoom) then has to look right on
a follower whose centre area has a different shape. The dashed edge of the margin is gone already
(2026-11-09), so the canvas reads as one.

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

## Replay timeline format versions (2026-11-08): resolved

Resolved 2026-11-08 (spec §6a, Format stamp; journal 2026-11-08-urn-polish): the server reads the
stamp (`mapcro_replay::timeline::FORMAT`). A stale fetched timeline inside Valve's three weeks is
fetched and parsed again once on open, served meanwhile and swapped in place; past them it stays.
A stale upload stays, and Player offers "Upload replay file". Open: "once a match" is kept in
memory, so a restart allows one more refetch per match.

## Server

- **A burst of 26 `ws_closes{reason=protocol}` in one minute on prod** (2026-11-09 08:14 UTC; `just
  stats series ws_closes`). It wasn't near a deploy (07:32 and 09:44 UTC) and there were none
  before or after. It looks like one client in a reconnect loop that sends something the server
  rejects as a protocol error: maybe a tab still on the pre-07:32 client against the new
  Presence (`hover`), or a malformed op. Check what the server logs on a protocol close (room.rs /
  wire.rs `is_valid`), whether a close for protocol makes the client retry at once, and whether an
  old-build client can trip it. Not a data-loss path: a rejected frame is never applied.

- Presence relay is O(n²) in bytes per room (perf report finding 4). It's fine at our scale.
- Base frames aren't chunked. A board over 8 MiB of JSON falls back to paged catch-up.
- **Rebase fan-out isn't bounded** (sync review 2026-11-08, finding 4): each stale hello clones the
  doc and builds its own JSON frame, and the outbox weight doesn't count it. 64 devices returning
  to an 8 MB board after a compaction could exceed the service's 256M memory. The fix is to serialize
  once per (doc, seq), splice in `decided_below`, and count it.
