# Backlog

Ideas the operator wants kept but not built yet. Newest first. Each entry records when it was raised,
what it is, and what it depends on.

## The dev-warnings e2e picks Vite's port the old way (2026-11-09, from web-test-ports)

web/e2e/solid-dev-warnings.spec.ts listens on 0, closes, and starts Vite on that port with
`--port` (no `--strictPort`), then polls `${base}/healthz`. If the port is taken in between, Vite
quietly moves to the next free one, so `base` and the server's `PUBLIC_ORIGIN` name a port that is
not Vite's: the poll times out ("vite never came up") or reaches someone else's server. The
mapcro-server half of that spec now starts on a port of its own (web/test/support/server.ts);
Vite's half could pass `--strictPort` (fail rather than move) and retry on a fresh port, or start
Vite through its JS API and use the address it actually bound.

## Check the API's item ids against a demo (2026-11-09, from match-data-v7)

Format 7 reads the metadata's `items[]` into `items` and `abilities` (spec §6a) on the guess that
`item_id` is the demo's CUtlStringToken and that an entry carrying `upgrade_info` is an ability.
No untrimmed metadata payload is cached locally and the fixture is trimmed, so neither is
checked. One untrimmed response for a match we have the demo of (129738985) settles both; a
wrong guess means re-fetching the summary-tier matches cached since.

## The modifier token lists go stale with patches (2026-11-09, from match-data-v7)

`crates/replay/src/modifiers.rs` (the icon-shown modifiers and the CC modifiers) is generated from
boon-data's catalog for client 6860 by `tools/modifier-tokens/gen.py`. A modifier a later patch
adds isn't stored as an effect, and it can't be recovered without a re-parse. Regenerate per
patch, or have the worker read the list from the pack once the extractor reads
`modifiers.vdata` and `abilities.vdata` (the names-and-icons task).

## Format 7 costs 3.4 s of parse time (2026-11-09, from match-data-v7)

On 129738985 the worker went from 8.7 s to 12.1 s (release, `nice -n 10`, load 8–9). Most of it isn't
the new reads (`HeroTracker::tick` is ~7% of the profile): it's decoding the ~570 ability and
item classes, plus every per-tick walk over all entities (`urn_tick`, `heal_tick`, `buff_tick`,
`vision_tick`) now walking those entities too. Indexing each class's entities once per tick
would win most of it back.

## Casts without a cooldown end, and allies' CC (2026-11-09, from match-data-v7)

On 129738985, 120 of 2227 casts have no `cooldown_end` (the ability entity's cooldown didn't move
within 1.5 s: charge abilities with charges left, or items bought that second). Separately, CC
sources are inferred from enemy applications only, so Viscous's cube on a teammate (8 of 18
cube intervals attributed) has no source. Both are worth a look before cooldowns or CC are shown.

## Under Vision, a death ping marks a death the skull hides (2026-11-09, from death-skull)

Death skulls (spec §6b) follow Vision: in a team's view an enemy's death it didn't see draws no
skull. The event pings stay omniscient by the operator's call ("Vision leaves the rest of Player
omniscient", below), so while playing, that same unseen death still gets its team-coloured ping
ring on the spot, the very cue the skull withholds. Worth asking the operator whether death pings
(and the jump ring) should take the skull's rule (`player/skulls.ts` `deathSeen`) in a team's
view; the events list could stay as it is.

## A malformed feedback `match` gets the generic 400 (2026-11-09, from feedback-match)

`POST /api/feedback` refuses a `match` whose fields are the wrong JSON type (a numeric id, a
negative or fractional `t_s`, a missing `tier`) at deserialisation, so the answer is the generic
"expected a title and a description" rather than "the match details aren't valid", which only
well-typed but invalid values get. Only a client other than ours can send those shapes; parsing
`match` as a raw value and checking it by hand would give one message for both.

## clippy: `unwrap()` in packs.rs (2026-11-09, from feedback-match)

`cargo clippy -p mapcro-server --all-targets` warns `clippy::unwrap_used` at
crates/server/src/packs.rs:188 (`p.0.parse().unwrap()` in `newest_first`). Already on main; an
`expect` with a reason would quiet it.

## Why one tough crate took 300 s to come back (2026-11-09, from heavy-crates)

On 129738985, 231 of 232 tough crate breaks are back 180 s later; `tough_crate:neutral:lane1:18`
(-6033, -3520), broken at 815.9 s, was back at 1115.9 s. The timeline keeps the real back time,
so Player is right; only a break the recording ends inside is assumed back on 180 s. Worth a look
on a second replay: a hero standing on the spot, or a longer timer for some spots.

## Wooden crates and item containers (2026-11-09, from heavy-crates)

Their breaks are as observable as the tough crates' (the entity goes inactive; the subclass
token tells them apart). 591 more icons and about 8 times the Heavy boxes' timeline bytes, so a
toggle of their own at least. Not asked for; the audit's candidates list has the row.

## heal_probe is slow on the breakable props (2026-11-09, from heavy-crates)

`crates/replay/examples/heal_probe.rs` formats every field of every entity on every tick, so on
`CCitadel_BreakableProp` (709 entities) it runs at about real time (30 min for 129738985).
Comparing raw field values and formatting only the changes would make it a seconds-long probe.

## Clippy: collapsible_if in derive.rs's buffs (2026-11-09, from heavy-crates)

`cargo clippy -p mapcro-replay --all-targets` warns `collapsible_if` at
crates/replay/src/derive.rs:751 (`} else if !b.active && up { if let Some(l) = out.last_mut()`),
in the powerup code, not touched by heavy-crates. Likely one of the "two more errors in the lib"
in the clippy entry below.

## Mark in-game pauses on the scrubber (2026-11-09, from replay-pauses)

Since format 6 the replay timeline leaves pauses out: its clock holds through them, as the game's
does, so playback runs straight over a pause with no sign of it. deadlock-api's metadata lists
them (`match_pauses[]`: `game_time_s`, `pause_duration_s`, `player_slot`, one zero-length row
for the pause call and one for its length; 134570618 has four, 296 s in all), and the replay's
rules carry `m_bGamePaused`, `m_nPauseStartTick` and `m_iPauseTeam`. A tick on the scrubber, or a
"Paused (Sapphire), 1:57" event, would explain a sudden jump in positions. Needs a timeline field
or an event kind (a format bump) and a summary-tier counterpart.

## Does the API tier's path drift come from pauses? (2026-11-09, from replay-pauses)

docs/research/match-replay.md found deadlock-api's per-player path index drifting up to 59
samples from the death times in 130816395, which paused for 29 s at 538 s. If the API's paths
sample through a pause (the replay's own clock bug before format 6), each pause adds its length
of drift. `reanchored` in matches.rs re-anchors paths to deaths, which hides it between deaths.
Checking where the drift starts against `match_pauses` on a few paused matches would tell; if it
fits, cutting each pause's samples from the paths would fix the summary tier's clock.

## "Presenter left" has no test that the follower's own Vision comes back (2026-11-09, from follow-vision)

When a followed presenter leaves, Board.tsx now calls `player.forget()` (as stopping does), so
the follower's own Vision returns. The player-vision e2e covers stopping by hand, not the
presenter closing their tab; a step that closes the presenter's page mid-follow would pin it.

## Player puts the match's name before a typed slot name (2026-11-09, from scene-names)

In Scenes a name typed into a slot (portrait menu, Rename…) wins over the open match's in-game
name. Player does the opposite on the tokens: Tokens.tsx `label` reads `pv()?.name ||
slot().name`, and PlayerTopBar's `tb-name` shows only the match's name while the portrait title
shows the typed one. So a renamed slot reads "Captain" in Scenes, "Coach" under Player's portrait
and on its token, and "Captain" in Player's portrait title. Needs a call on which wins in Player;
then one helper (`slotName` in board/roster.ts) for both.

## A scene saved from another match shows no names (2026-11-09, from scene-names)

Scenes take names from the open match's timeline (`player.tl()`); a scene whose `source.match_id`
is a different match than the one open shows the slot labels (K1…) rather than the wrong
players' names. Showing its own match's names would mean loading that match's timeline (or
carrying the names on the scene). Rare: a board with several matches, switching between them.

## The hero picker and "taken" labels don't use the match's names (2026-11-09, from scene-names)

HeroPicker's heading (`who`) and Board's `takenBy` ("Hidden King Player 1 has this hero") use the
slot's typed name only, so on a match board they say "K 1" / "Player 1" where the top bar now
says the player's name. Passing Board's `matchName` through would fix both.

## A blank scene on a match board doesn't take the match's heroes (2026-11-09, from scene-names)

The roster's heroes are board state; Save as scene sets them to the match's ("Roster → match
heroes"), but a board opened from a match keeps an empty (or random) roster until then, so its
first scene shows K1…A6 discs. Left as is on purpose: a display-only hero fallback would disagree
with the picker, `takenBy` and every other reader of `slot.hero`. A possible follow-up: when a
match is attached and every slot is empty, offer (or do, once, as the owner) the same
"Roster → match heroes" transaction.

## Unplayable heroes can't be picked any more (2026-11-09, from scene-names)

The side roster's `<select>` listed every hero in the pack, unplayable ones (schema 3: no top-bar
portrait, e.g. work-in-progress heroes) included; the portrait's picker lists playable heroes
only, and the side roster is gone. Probably right; noted in case someone wanted a WIP hero.

## A clone made while an upload is still parsing doesn't get it (2026-11-09, from clone-replay)

Clone carries the board's matches and each uploaded timeline already cached
(`carry_to_clone`, replays.rs). An upload still queued or parsing has no timeline yet, so the clone
opens that match at the fetched or summary tier, and someone has to upload the file again there.
A fix would record the clone against the job and link the result to it when it lands.

## An e2e spec that uploads over 6 times fails without saying why (2026-11-09, from vision-fade)

Each Player e2e test opens its synthetic match by uploading a `.dem`, and the server allows one
client 6 uploads an hour (`REPLAY_PER_CLIENT_PER_HOUR`, replays.rs). The 7th test in a spec then
times out polling the replay inbox, with nothing on the page or in the error saying the limit
was hit. player-vision.spec.ts now raises the limit for its server; a shared default in
e2e/server.ts, or the helper reporting the refusal, would spare the next spec the hunt.

## Clippy fails on crates/replay/src/parse.rs (2026-11-09, from shop-state)

`cargo clippy -p mapcro-replay --tests -- -D warnings` (rust 1.99) stops on
`clippy::chunks_exact_to_as_chunks` at parse.rs:658 (`key.chunks_exact(4)`), and on two more
errors in the lib. Not touched by shop-state. `as_chunks::<4>()` is the suggested fix.

## The pack's sapphire shop keys name the wrong lane (2026-11-09, from shop-state)

The extractor keys a shop by the lump's `LaneNum`, which the map mirrors on Sapphire's side:
`shop:sapphire:lane1:1` is the shop beside the lane 6 guardian, and `shop:sapphire:lane6:1` the
lane 1 one (docs/research/map-objectives-audit.md, "Shops"). Nothing reads a shop's lane today:
Player pairs shops with guardians by place. A key fix would rekey the shops, so a board that
refers to one by key would need a migration.

## How many Sinner's Sacrifice machines are left (2026-11-09, from the map objectives audit)

Three Sinner's Sacrifice camps hold more than one machine: the bell tower has 3, and the theater
balcony and the slums garage roof have 2 each. The camp timer only says up or cleared. Each
machine is its own networked `CNPC_Neutral_SinnersSacrifice` the whole match
(docs/research/map-objectives-audit.md), so a partial clear could show on hover ("1 of 3 left").
That changes the timeline (`timeline::FORMAT`).

## A follower doesn't see the presenter's teleporter pair (2026-11-09, from map-layers)

Hovering a teleporter draws the line to its pair from this browser's own hover only
(`player/Camps.tsx` `TeleporterLink` reads `localHover()`). The presenter's hover reaches a
follower (spec §8) and its label shows, but a teleporter has no label, so the follower sees
nothing. `TeleporterLink` could take the remote hover too, as `HoverLabels` does.

## The extractor's real-install test writes a fixed path in /tmp (2026-11-09, from map-layers)

`crates/extract/tests/extract.rs` `real_install` removes and rewrites `/tmp/mapcro-extract2-real`.
Two agents running it at once (the box is shared) clobber each other's pack mid-run. A temp dir
of its own, or one under `CARGO_TARGET_TMPDIR`, would keep runs apart.

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
