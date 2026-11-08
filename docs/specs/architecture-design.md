**Date:** 2026-11-06
**Status:** draft for the operator's review. No code exists yet.
**Research:** [sync and collab boards](../research/sync-and-collab-boards.md) · [Deadlock assets and extraction](../research/deadlock-assets-and-extraction.md)

# mapcro: architecture and state

mapcro is a shared Deadlock minimap for macro coaching. People place the 12 heroes, toggle
objectives, draw rotations, add callouts and notes, and step through scenarios. A board is shared
by link, either to watch or to edit live. It works offline and saves locally. A small server on
the operator's infra relays edits and stores shared boards. Game art comes only from the user's
install of whoever runs the server, extracted once and served to everyone.

The design goal is reliability: an edit the UI calls *saved* is never lost, every client converges
on the same board, and a bad client cannot corrupt a board for anyone else.

## 1. What changes from the prototype

| Prototype | mapcro | Why |
|---|---|---|
| One JSON blob, replaced wholesale on every change; undo = whole-state clones | A board is a set of typed **records** changed by small **ops** | Ops can be merged, validated, replayed, synced and undone per user |
| Players are array indices 0–11, objectives keyed by API ids | Every record has a stable random id. Heroes are referenced by game `hero_id`, objectives by semantic keys (§12) | Survives reorders, concurrent edits and game updates |
| Positions in 0–1 minimap space of build 6851 | Positions in **world units** (game coordinates); the asset pack supplies the world→minimap transform | A minimap texture or crop change no longer moves every token |
| Hard-coded guard: build 6851 only | Boards record the build they were made on; any asset pack renders them, with placeholders for missing entities | Game updates degrade gracefully instead of breaking boards |
| Coordinates and hero list from deadlock-api.com, art from the install, embedded in the HTML | The server operator extracts everything from the install once; the server serves versioned packs | One source of truth; users never extract |
| View state (viewpoint, floor) mixed into the saved scenario | Board state, per-user view state and presence are three separate stores | Viewers can look at Sapphire's side without flipping it for everyone |

## 2. The document model

A **board** holds one or more **scenes**: ordered frames such as "8:00 mid push" and "8:40 rotate
east". This replaces the prototype's named snapshots with something you can step through while
coaching. The roster belongs to the board; positions belong to each scene.

Board-level records:

- `board_meta`: title, the game build it was made on, schema version
- `roster_slot` (exactly 12: two teams of six): name, hero id
- `scene`: name, fractional order index, so that concurrent reorders don't collide

Each scene owns:

- `player_state` (one per roster slot): position, alive, placed
- `objective_state`: semantic objective key → `active | destroyed | hidden` (absent = game default)
- `arrow`: from and to, optional waypoints, team colour, style
- `callout`: position, text
- `stroke`: freehand ink as a list of world points (capped), colour, width
- `note`: the scene's free text

Records are flat, typed and validated by one schema module shared by client and server. Kinds are
discriminated unions (enums, not strings). Invariants the schema enforces: exactly 12 roster slots and one
player state per slot per scene, finite coordinates inside map bounds, text length caps, record count caps per scene,
and known enum values. Invalid states are unrepresentable in the types, and the server rejects ops
that would produce them.

**Ops** are intent-level and per field: `create(record)`, `set(id, field, value)`, `delete(id)`,
grouped into atomic **transactions** (one drag, one paste, one "reset scene"). Every transaction
carries `(clientId, clientSeq)` so that resending is idempotent.

## 3. Sync and conflict model

**Server-authoritative ops with per-field last-writer-wins. This is not a CRDT.** The server holds
each open board in memory and applies transactions one at a time. For each, it validates, assigns
the next board sequence number, makes it durable, then acknowledges and broadcasts it. The order the
server picks is the truth. Clients apply their own transactions optimistically and **rebase** any
that are still pending on top of each server broadcast. Because ops are per-field intents, a rebase
is a re-apply. A pending op whose target was deleted becomes a no-op, and the client tells the user.

This is the shape tldraw sync and Figma use. It fits mapcro better than Yjs or Automerge because:

- **Validation is the security boundary.** View-only links and schema invariants are enforced on
  typed ops the server understands. A CRDT relay can drop writes from view links, but an edit link
  can still write any shape into a Yjs doc, and rejecting a Yjs update after the fact breaks the
  causal chain for that client.
- **Migrations stay simple.** Typed records with a schema version migrate with plain functions. CRDT
  documents carry history in the old shape.
- **The document is small and structured.** It has hundreds of records, not a long text, so per-field
  LWW loses nothing meaningful. Two people dragging the same hero is a real conflict, and the last
  one to drop wins, visibly.
- **We already have a server**, and one process can own each room, so we don't need a CRDT's
  serverless convergence.

**Rejected alternatives.**

- **Yjs + Hocuspocus** came second. It would give presence, per-user undo and offline support out of
  the box. It lost on three counts: rejecting a bad update needs a staging document plus a forced
  resync, migrating while old clients are connected is an open problem, and garbage collection never
  fully reclaims space.
- **tldraw sync** is the closest design, but its licence forbids production use without a key, so
  we study it and don't use its code.

Details are in the [sync research](../research/sync-and-collab-boards.md).

**Plain text is the exception.** Concurrent typing in one note under field LWW would drop one
person's words. The note field therefore uses text splice ops `(pos, deleteCount, insert)`, which the
server transforms against concurrent splices: single-server OT for plain text, the same small
algorithm ShareDB's text type uses. Callout text stays LWW because it is a short label. *(Open:
whether notes are collaborative enough to justify this. See Q2.)*

## 4. Interaction rule: the map is the interface

**Decision (operator, 2026-11-06).** Changes are made directly on the map, and separate controls
are avoided wherever possible:

- Drag a token to move it.
- Click an objective to cycle its state.
- Drag to draw an arrow.
- Double-click to drop a callout and edit it in place.
- A contextual menu on a token covers dead or alive, hero and unplace.

The chrome is the scene strip, presence and Share. This suits the op model: each gesture is one
transaction and one undo step.

**Tools (operator, 2026-11-06):** a small tool picker changes what the cursor does on the map:

| Tool | What it does | Result |
|---|---|---|
| Move | the default: drag tokens and callouts, click objectives | ops |
| Draw | freehand ink in a palette colour | a `stroke` record |
| Arrow | drag out a rotation arrow | an `arrow` record |
| Callout | click to place a label, typed in place | a `callout` record |
| Laser | drawing that fades: the trail holds briefly, then fades away. Everyone gets it, viewers included (operator, 2026-11-06) | presence only, never stored |
| Erase | click or scrub over ink, arrows and callouts | deletes |
| Clear ink | a button: removes every stroke on this scene, as one undoable step | one transaction of deletes |

The map is still the surface for every tool; the picker only chooses the gesture.

## 4a. Client state

```
confirmed  = board state at server seq N      (server-replicated)
pending    = [tx…] not yet acknowledged       (persisted in IndexedDB)
board view = fold(pending, confirmed)         (what renders)
local view = selection, tool, zoom, viewpoint, floor, current scene   (never synced)
presence   = other users' cursors and drag previews                   (ephemeral)
```

- **A drag is a preview, then one op.** While dragging, the position travels through presence, so
  others watch the hero move live. Dropping it commits one transaction. The op log stays clean, undo
  takes one step, and an interrupted drag leaves no half-state.
- **Pending ops are persisted before they are sent.** A tab crash or closed laptop keeps them, and
  they flush on the next connect.
- **Save status is honest:** *Saved* (no pending), *Syncing (n)*, *Offline: n changes kept on this
  device*, and *Rejected* with the reason.
- **A new device starts from the board, not its history.** A client with no stored copy builds its
  replica from the board as the server holds it now (`confirmed` at some seq N, nothing pending,
  no undo history) and replays only what came after N (§5). It never pays for history it didn't
  see: a fresh client on a 33k-entry board used to replay all of it, ~0.7 ms an entry in the
  browser.

## 5. Offline and reconnect

1. Connect. The socket's first frame is `auth { board, token, known_seq }`. The server answers
   `ready { role, base? }`, sending a base document only to a client that has none. Then the
   engine's `hello { client, last_seq, pending_from }`, where `pending_from` is the client's oldest
   unacknowledged cseq.
   - **A fresh join gets the board as it is.** `base` is `{ doc, seq }`: the room's current
     document and the log length it's at, read together in the room's one step that handles the
     join, so they can't disagree. The client builds its replica at `seq` and says hello from it.
     Whatever was logged between the join and the hello arrives as ordinary catch-up (point 2),
     behind any rejections and ahead of live entries, so the FIFO order is unchanged and the engine
     didn't change at all: the base only moves where the client's `last_seq` starts. The Quint
     model checks it (`freshReload` in `model/sync.qnt`: a new identity starting from a snapshot
     at any k up to the log length). `model/snapshotSkew.qnt` shows the one way to get it wrong,
     a base labelled one entry later than it is, failing `confirmedIsLogPrefix`.
   - **One snapshot serves a burst of joiners.** The room keeps the last snapshot it sent, as
     JSON, counted in its memory weight (§9), and reuses it at the position it was taken at while
     it's at most 256 entries behind; those joiners catch up the difference.
   - **Size.** A base is one frame, and while it's sent it costs its size several times over (the
     JSON, the frame, the socket's buffer). Base frames being sent are capped server-wide at
     32 MiB, so joiners past that wait their turn. A board whose document is over 8 MiB as JSON,
     which takes thousands of large strokes, isn't sent as a snapshot: its fresh clients get the
     stored base and page through the history as before. Outbound frames have no server-side cap.
     Browsers accept a frame of any size; a client built on tungstenite needs `max_message_size`
     above 8 MiB (its default is 64 MiB).
   - **A client with a copy (`known_seq` set) gets catch-up if the server still keeps the
     entries after its `last_seq`, and a rebase if they've been compacted away (§9).** The hello is
     answered, after the client's rejections as always, with
     `Rebase { doc, seq, decided_below }`: the board now, its log position, and the client's
     oldest transaction the server hasn't decided. The client adopts the board and drops every
     pending transaction below `decided_below`. Each of those is either in the board (applied, its
     ack long gone) or was refused, and that rejection came just before. The rest stay pending on
     top, and the server takes them as it would after any reconnect: they were resent with the
     hello. Undo history is kept, as across a reconnect; undo is evaluated by the server (§7).
     - The model checks it: `compact` raises a floor, a hello from below it must get a rebase, and
       one from above may. All seven properties hold. `model/rebaseKeepsDecided.qnt`, a client that
       adopts the board but keeps its decided work pending, fails `acksInOrder`: those transactions
       are never acked.
     - A rebase is the whole board in one frame, so it goes outside the outbox's byte cap, under
       the server-wide cap on big frames in flight.
2. The server answers the hello first with any of the client's rejections from `pending_from` on,
   so a rejection lost in a disconnect is heard before any later ack. (Found while designing the
   engine and confirmed by the model's `acksInOrder` property.) Then it sends the ops after
   `last_seq`, or a snapshot if they're already compacted. Only then
   does it mark the connection **live**, meaning it may now receive broadcasts. The connection is a
   typestate on the server, `Connecting → Live`, and only `Live` connections get broadcasts.
   - **Catch-up is streamed, not queued.** The authority answers a hello with a catch-up *range*
     in the connection's outbox, between the rejections and the first live broadcast. The socket
     reads that range from storage a page (about 64 KiB) at a time and sends each page before
     reading the next. Every entry in the range was durable before the range was queued, so
     storage has all of it, and a history of any length goes out at the client's pace. The room
     doesn't hold the log at all (§9); the engine's authority is the model's server minus its log,
     which the host keeps durably and appends on each `Effect::Logged`. Live entries
     wait behind the range in the outbox, so the client still hears rejections, then catch-up,
     then live traffic, the order `LIVE_AFTER_HELLO` and `REJECT_BEFORE_CATCHUP` model. The
     outbox (4096 frames, 4 MiB) bounds only how far behind *live* traffic a client may fall before it is
     dropped. Before this, a board past 4096 ops dropped every fresh client (security review
     2026-11-07, H-A).
   Without this, an op applied between the reconnect and the `hello` reaches the client before its
   catch-up does, so the client sees ops out of order and some of them twice. The model found this
   ([journal](../journal/2026-11-06-quint-sync-model.md)).
3. The client rebases pending transactions and resends them. The server deduplicates by
   `(clientId, clientSeq)`, so a transaction whose ack was lost is never applied twice.
4. Defense in depth: the client requires every entry's seq to be exactly `lastSeq + 1`. It ignores
   duplicates, and on a gap it drops the connection and reconnects. A gap is a bug, so it's also
   reported.
5. Reconnect uses exponential backoff with jitter. A heartbeat detects dead sockets in about 10 s.

Long offline sessions are fine for positional edits (LWW). If a transaction is rejected on
reconnect, or if the board's schema moved past a migration the client can't apply, that
transaction is not discarded. The client keeps the unsynced work as a **local copy of the board**
("Your offline changes couldn't be merged and were saved as *Board (offline copy)*"). **Nothing the
user did is ever silently dropped.**

## 6. Local saves

**A local board is the same engine with the authority running in the browser.** The authority code
that runs on the server (validate, sequence, apply) also runs client-side, against IndexedDB. Local
and shared boards therefore follow one code path and one set of tests.

- Local boards live in IndexedDB and need no server and no network.
- **Share** uploads a local board's snapshot to create a server room, then mints links.
- **Make a copy** turns any viewable board into a local one.
- **Export / import** a versioned `.mapcro.json` file, using the same schema and migrations. This is
  the durable, portable save, independent of browser storage.
- The app asks for `navigator.storage.persist()` so the browser doesn't evict local boards.

## 6a. Match import

**Decision (operator, 2026-11-07):** a scene can come from a real match. The research is
[match replay](../research/match-replay.md); this is its v1 path.

- **Source:** deadlock-api.com's match metadata, through our server only. Browsers never call it,
  so the CSP keeps `connect-src 'self'`. We hold no Steam account.
- **Server:** `GET /api/matches/{id}` derives a compact timeline and caches it as
  `DATA_DIR/matches/<id>.json` (matches don't change). The timeline has, for each player, team,
  slot and hero, world x/y at each game second, health, deaths and souls samples. It also has
  objectives as board keys with their destroy times, mid boss kills, start time and duration.
  - **Path clock drift** (research §1.2) is re-anchored on deaths, and the timeline counts the
    players that needed it.
  - **Objective mapping**, checked on two matches against the attackers' positions at each
    destruction:
    - Valve's objective lanes 1, 3 and 4 are our `lane1`, `lane4` and `lane6`.
    - Shield generator 1 is the east shrine and 2 the west, for both teams.
    - `Titan` is the patron, and lobby team 0 is Amber.
- **Browser:** the strip's **From match** opens a panel with the id, a scrubber (mm:ss, play,
  ±10 s) and the credit line "Match data: deadlock-api.com". Scrubbing is a local preview, never
  synced: heroes at their positions, the dead hidden, and objectives down as at that moment.
  **Save as scene** is one transaction:
  - It adds a frozen scene, "Match <id> @ mm:ss", with clock t, players, alive and souls (the
    nearest sample at or before t), and objective states.
  - If the board's heroes differ from the match's, the same transaction sets the roster to the
    match's ("Roster → match heroes"). One undo reverts all of it.
- **Not in the metadata tier:** ults, lane waves, rifts, powerups and z. A match older than the
  pack is drawn on it with an "Older map" label.
- The mid boss's respawn time isn't in the match data. The preview shows it down from a kill
  until the next kill.

### Tiers: the replay is the rich one (operator, 2026-11-07)

One panel, two tiers. When a replay timeline exists for the board and match, it's used;
otherwise the metadata timeline is. A small label names the tier in use ("Replay" or
"Metadata"). `GET /api/boards/{board}/matches/{id}` (any link to the board) makes the choice:
the board's own upload first, then a timeline fetched from Valve's CDN, then the metadata (v1,
above). The old `GET /api/matches/{id}` still serves the metadata alone.

- **Where a replay comes from,** uploads first:
  - **Upload:** an editor picks a `.dem` from the game's replays folder.
    `POST /api/boards/{board}/replays/{id}/upload`, raw bytes, with upload progress.
  - **Fetch:** `POST /api/boards/{board}/replays/{id}/fetch` asks deadlock-api's salts endpoint
    for the match's cluster and replay salt, then downloads
    `http://replay{cluster}.valve.net/1422450/{id}_{salt}.dem.bz2` (zstd since 2026-07-20; the
    magic decides).
- **Job state:** `GET /api/boards/{board}/replays/{id}` answers `none`, `uploading`,
  `fetching`, `queued`, `parsing`, `done` or `failed` with a short reason (`old_map`,
  `not_a_replay`, `too_large`, `timeout`, `parse_failed`, `no_replay`, `upstream_down`,
  `upstream_limited`). The panel polls it and shows labels only; a job that finishes swaps the
  replay timeline in, keeping the scrubber where it was.
- **Current map only:** a demo whose header's `game_directory` names a content build before 6712,
  or whose objectives don't sit on the current map's sites, fails as `old_map` ("Old map"). The
  header's `build_num` and `map_name` say nothing about the map (exploration §1). Pre-6712 demos
  also decode 16,384 units low on every axis; neither that correction nor old-era packs are
  built.
- **What the replay timeline adds** (`crates/replay/src/timeline.rs`, the metadata timeline's
  shape plus fields; 1 Hz, about 140 KB for a 15-minute match):
  - Positions with the exact life state (the pawn's `m_lifeState` and health), deaths, souls
    (net worth, when it changes; the demo updates it about as rarely as the metadata does), and
    in-game names where the demo has them.
  - **Ult cooldown** left in percent at each second, which is `PlayerState.ult_cooldown`. A
    cooldown that reads 0/0 in the recording (it does, for tens of seconds around full packets)
    holds the last one seen.
  - **Rifts:** the `rift:` key that is up at t, from the spawner's position or the live
    cash-in's.
  - **Powerups:** available or taken per `powerup:` key at each second.
  - **Lane waves:** for each lane and second, where Amber's front (its furthest trooper along
    the lane) and Sapphire's meet, as `Wave.t`, the board's own projection onto the lane curve
    (ported from `web/src/map/lanes.ts`, with a shared golden test). One front alone gives its
    own position.
  - **PVS gaps:** a demo records only entities near players. Waves and powerups with nothing in
    the recording hold their last value, and the timeline lists those seconds as stale ("Waves
    held"). An objective counts as destroyed only when its health is seen to fall and nothing
    on its site is seen alive after.
- **The game clock:** `(tick + server_start_tick − paused ticks) × tick interval −
  m_flGameStartTime`, until the game rules name a winner. Checked against the metadata of match
  122134063: deaths and objectives within a second, the same 890 s duration. The exploration's
  formula, without `server_start_tick`, ran 48 s early.
- **Save as scene** also writes each player's ult cooldown, the rift that's up (rifts default
  off), taken powerups (they default available) and a `Wave` per lane.
- **Preview while scrubbing:** ult rings beside each hero in the panel, the rift and powerup
  states on the map, and the lane splits; local only, like the rest of the preview.

### The replay worker: isolation and limits

Parsing untrusted files happens in a separate process on a shared production box, never in the
board server (`MemoryMax=256M`; a 480 MB demo's pages alone exceed it).

- **`mapcro-replay`** (`crates/replay`, boon 0.19.0 pinned, MIT) runs as its own systemd service
  in the same NixOS module, as its own user. It has no network (`PrivateNetwork`,
  `RestrictAddressFamilies=none`, `IPAddressDeny=any`), sees nothing of `/var/lib` but its
  queue, can't see other processes, and has a full systemd sandbox (no capabilities, a system
  call filter, `MemoryDenyWriteExecute`, `LimitFSIZE` at the demo cap).
- **Caps:** `MemoryMax=1G` with no swap, `CPUQuota=100%` (one core) at a low CPU weight and
  idle I/O, one job at a time, each in a child process under a 300 s wall clock. A child killed
  at the memory cap fails its job as `too_large` (`OOMPolicy=continue`), one killed by SIGBUS
  (the mapped demo changed under it) as `corrupt`; the worker carries on.
- **Measured** on this machine, release build: the current-map demo (97 MB, 15 min) parses in
  0.9 s with 11 MB anonymous memory plus 98 MB of the memory-mapped demo; a 478 MB demo in 4.6 s
  with 19 MB anonymous plus 470 MB mapped. Mapped pages are clean and reclaimable, so the 1G
  cap leaves room for the largest demos and a decompression.
- **The queue** is `/var/lib/mapcro-replay` (`REPLAY_DIR`), group `mapcro-replay`, which the
  board server's user joins. Neither side can write where the other writes (security review
  2026-11-08, M1/M2):
  - `inbox/` (2750, the server's): complete, magic-checked files, written as `.<job>.part`
    with O_EXCL|O_NOFOLLOW and renamed in. The worker can only read it (and its unit mounts it
    read-only).
  - `outbox/` (2770, the worker's): `<job>.parsing` while it works, then `<job>.json` or
    `<job>.failed` (a reason code). The server reads results without following links and
    removes them.
  - `work/` (0700, the worker's alone): a decompressed demo, a result being written.

  A job is `<match id>-<scope>`, where the scope is `cdn` or 16 hex digits of the board id's
  hash. The worker deletes its decompressed copy as soon as the parse ends; the server deletes
  the original when it collects the result, within a second, either way. A worker that crashed
  mid-job fails it on restart. The board server never parses: its health check doesn't depend
  on the worker, so a crashed worker can't fail a deploy.
- **The board server's side** (`crates/server/src/replays.rs`): it collects results every
  second, only for jobs it queued itself (a result for any other job is dropped, so a worker
  can't publish a timeline nobody asked for, nor one under the shared `cdn` scope for an
  upload), checks each against the timeline's shape and size, and caches it as
  `DATA_DIR/replays/<job>.json`. It drops jobs still queued after an hour (`timeout`) and
  partial transfers, and keeps the cache under 1 GiB by dropping the oldest timelines.

## 6b. Player

**Decision (operator, 2026-11-08):** a board with a match opens in **Player**, which replaces the
import panel. Two entry points: the landing page's **Open match** (a match id, or a replay upload)
makes a board with that match attached and lands in Player; **New board** is today's sandbox.

- **The board's matches.** The server keeps the matches a board has opened, newest first, at most
  20, beside the board rather than in its document (`DATA_DIR/attached/<hash of the board id>.json`):
  `GET /api/boards/{board}/matches` (any link) lists them, `PUT /api/boards/{board}/matches/{id}`
  (owner or edit link) attaches one. A board with one opens in Player on its newest.
- **Player draws only the timeline at t; Sandbox only the scene's records.** The map shows the match
  at playback time t: heroes interpolated between 1 Hz samples and hidden while dead, objectives,
  and from a replay rifts, powerups and lane splits; ult rings sit in Player's roster. No scene
  state (alive, seen, placed, objective, rift or wave records) shows through in Player, and none of
  Player's shows through in Sandbox. Switching modes, scenes or matches leaves nothing behind
  (operator report 2026-11-08: heroes drawn dark where the scene had them dead).
- **Lane splits** on the replay tier are a 5 s median of the seconds a front was seen (raw fronts
  jump ~1,100 units a second as waves die and spawn; exploration round 2).
- **The transport:** play and pause, speed (0.5×, 1×, 2×, 4×, 8×), a scrubber with a tick per
  event, ±10 s, and the match clock. "Waves held" while a lane's split is held through a gap.
- **Events** (both tiers, each with what it has; `Event` in `crates/replay/src/timeline.rs`):
  deaths (who; the killer and the place when the data has them, else where the hero was last
  seen), objectives, mid boss kills, rifts up and captured, powerups up and taken (replay only, on
  seconds the spawner is in the recording), ult casts (replay only: a rise of the hero's ult
  cooldown, named by the game's `ImportantAbilityUsed` message, which covers every important
  ability, so it alone isn't an ult), and souls swings (the Amber-minus-Sapphire lead
  moving 5,000 within a minute and holding ten seconds on; none in the first two minutes, when
  starting souls arrive player by player). The sidebar lists them with their tier, searchable by
  hero, player name, type, team and time, with filter chips by type. **Jump** pauses at the event
  less a lead (5 s, adjustable) and pulses a ring where it happened. **Save scenes** makes one
  scene per ticked event at its jump time, "<event> @ mm:ss", in one transaction (one undo).
- **Following** carries Player: presence's `playback` holds the mode, the match, t, playing and
  speed, sent on every change and every 2 s while playing. A follower adopts them, keeping its own
  clock while it is within 0.75 s of the presenter's. Changing your own playback, mode or match
  stops following, as changing the view does.
- **Annotation over playback (operator, 2026-11-08, decided):** you can annotate a live player,
  but to keep it you save it as a scene. Draw, arrows, comments, the laser and pings work in
  Player as ephemeral layers, cleared when the scene is saved or you leave Player.
- **Save scene** at t makes a normal sandbox scene: everything the timeline gives (positions,
  deaths, souls, objectives, and from a replay ults, the rift that's up, taken powerups and lane
  splits), plus the ephemeral annotations turned into strokes, arrows and comments. The scene
  stores its source (match id, t, tier), so a later "resume from here" can open Player at that
  moment.

## 7. Per-user undo

Undo covers only your own transactions, in the order you made them. Each history entry records the
fields it changed, with their before and after values:

- **Undo sends conditional ops that the server evaluates when it applies them:**
  `set_if(field, expect: after, value: before)`. If someone else changed the field since, the server
  skips it rather than clobbering their edit, and the client says "couldn't undo: changed by …".
  - **Why on the server:** the first draft checked "does the field still hold my value?" on the
    client. But the server can order someone else's edit between that check and the undo landing,
    especially after time offline. The model found this.
- **Undoing a delete** is `restore(id)`. It undeletes the server's tombstoned record, with any
  edits others made, rather than re-creating it from the client's possibly stale copy.
- Redo is symmetric. The stack lives per tab, survives reconnect, and is cleared on scene reset or
  when a migration reloads the board.

## 8. Presence

Presence is ephemeral and never enters the op log. Each entry carries a display name and colour
(chosen once, kept locally), the cursor in world coordinates (so it is right in either viewpoint),
selection, the current scene, the floor, and any in-progress drag preview. The client sends updates
at about 20 Hz; the server coalesces them per room and relays. A change after a quiet spell goes
out at once (the leading edge); changes within 20 ms of the last relay wait for the window to end
and go out together, one frame per peer. Measured with 3 browsers, sent-to-received went from
51 ms p50 (a trailing 50 ms batch) to 3.7 ms, and a receiver handles at most 50 frames a second.

- **Name tags on elements (operator, 2026-11-06):** whoever is interacting with an element
  (dragging it, selecting it, editing its text) has their display name shown beside it, the way a
  shared document shows collaborators' names. Presence carries `drag` and `focus` for this.
- **Display name:** asked for on joining a board, remembered on the device, changeable any time.
  It's presence only, never stored on the server.
- Viewers appear in the people list, and their cursors show. Their presence is rate-limited like
  everyone else's and is the only thing a view session may send.
- **Follow mode:** anyone can follow a presenter's scene, floor and viewport. This is the coaching
  workflow (operator, 2026-11-06):
  - **Following is one click,** and the presenter's name is always visible to click.
  - **A follower who changes what they see stops following:** flipping a scene, panning, zooming or
    switching floor. There's no half-state.
  - **Presenters can't force or nudge anyone;** getting back in is just as easy.
  - **Anyone can follow anyone who holds edit rights** (owner or edit link), so there can be several
    presenters at once. View-only people can follow but can't be followed. Presence carries each
    person's role, and the server stamps it from their link, so it can't be forged.
- Presence timeout: 30 s without a heartbeat removes the entry.
- **A peer that falls behind isn't sent presence it can't keep up with, but it isn't left stale
  either.** A batch is skipped for a peer more than 64 KiB behind. The room remembers whose
  changes that peer missed, and once its backlog drains it sends their current state (or their
  leaving). Presence is only sent on change, so without this a skipped peer kept old states for
  good. The soak found it.

## 9. Persistence, snapshots and backups

- **Storage:** SQLite in WAL mode, on the server's state directory.
  - `boards`: id, schema version, head seq, latest snapshot and the seq it covers
  - `ops`: board id, seq, client id, client seq, transaction JSON, time. Append-only.
  - `links`: token hash, board id, role, label, created, revoked
- **Stored rows are compressed JSON.** Each op row and base document is the engine's JSON,
  compressed with zstd and a static 16 KiB dictionary trained from the simulation (`just zdict`,
  reproducible byte for byte; `crates/server/dict/ops-v1.zdict`). JSON stays the inner format so
  `#[serde(default)]` field additions keep working (a positional format like postcard would not).
  Each row names its codec (`json`, `zstd-v1`): rows from before schema v4 are JSON and still read,
  a row that wouldn't shrink is stored as JSON, and a new dictionary is a new codec beside the old.
  On a realistic session this stores 2.7× smaller than JSON. (A dictionary trained on the same
  session reaches 4.6×, but only because it learns that board's ids; one trained on another
  session gets 2.7× too. Whole-log compression would get ~6×; that belongs with snapshots.)
- **The log lives on disk only.** The authority keeps the document, not the log: each accepted
  transaction leaves as an `Effect::Logged`, the room writes it, and catch-up pages are read back
  from SQLite on a second, read-only connection (§5). A cold load replays the rows one at a time
  to rebuild the document and keeps none of them. A fresh client starts from the room's current
  document (§5), so the stored base is read only for boards too big to send as one frame. A
  loaded room costs its document plus its client and connection tables, and its last fresh-join
  snapshot. (Measured: a room over 8 MB of history grew the server by 3.5 MB, against 11.6 MB when
  it held the log.)
- **Durable before ack.** A transaction is committed to `ops` before the client hears "accepted".
  **Commits are grouped:** the room applies a submit or hello, and every engine message already
  queued behind it, in memory, writes all their effects in one SQLite transaction (one fsync),
  and only then sends anything any of them produced: acks, broadcasts, rejections, catch-up
  ranges. Nothing waits to fill a batch. At low load a batch is one message; under load it's
  whatever queued during the last fsync, up to 256 messages or about 256 KiB of transactions,
  so one commit's acks stay a small part of any peer's outbox. A batch also ends as soon as
  compaction is due, so it runs before the history quota could refuse anything. A batch stops at
  the first other command (a
  join, a clone's snapshot, a revoke, presence), which runs after the commit, so a fresh join's
  snapshot or a catch-up range never includes anything that isn't on disk. Measured: 1000
  transactions from 4 writers, each waiting for its acks, took 3.3 s before and 0.06 s after,
  and server CPU per transaction fell from ~500 µs to ~40 µs.
  - **Crash points prove it.** A test-only feature (`--features failpoints`, never in a release
    build) aborts the server just before a commit or just after one, before its acks go out. It
    first waits 200 ms, as a slow fsync would, so an early ack would have time to land. The system
    tests kill the server mid-burst at each point, then check that every edit is in the log
    exactly once. A server that acked before committing fails it: after the restart its clients
    hold entries the log doesn't have.
- **Compaction.** After a commit, once 10,000 entries have been logged since the base
  (`BOARD_COMPACT_OPS`), or the kept entries reach half the byte quota, the room makes the board
  as it is the new base (`base_doc` at `base_seq`). It keeps only the newest entries, at most
  2,000 (`BOARD_KEEP_OPS`) and a quarter of the byte quota, for clients slightly behind, and
  deletes the rest. The same transaction records each client's next expected cseq (`client_seqs`,
  schema v5). The entries that showed it may be gone, and without it a resend of a compacted
  transaction would be applied again. A cold load replays from the base. Catch-up is served from
  the oldest kept entry on; a hello from below that is rebased (§5). The new base doubles as the
  fresh-join snapshot. Stored rejections are already pruned as soon as their client has heard them.
  - So a board's history no longer grows without bound. What's kept is at most ~12,000 entries
    (and ~15 MiB at the default quota), plus the base, whatever the board's age.
  - Version history and a retention window aren't built: compaction keeps only the tail.
- **Tombstones:** deleted ids stay tombstoned in the board (and so in every base), so a rebased
  client's pending work still finds what it refers to.
- **Version history** (not built) would come from the log within a retention window; compaction
  would then keep that window rather than a fixed tail. A restore would be a new transaction, so
  it could be undone.
- **Backups:** continuous off-box replication of the SQLite file (Litestream to object storage), plus
  a nightly verified `.backup` snapshot. A restore is tested in CI against a fresh database.
  *(Target bucket: Q5.)*
- **Room lifecycle:** a room loads on its first connection and unloads after 5 minutes with no
  connections (`ROOM_IDLE_SECS`). Every acknowledged edit is already on disk, so unloading and
  shutting down flush nothing. A join that races an unload retries against a freshly loaded room.
- **Durability means "on disk before it's heard":** the authority reports each change as an effect
  (logged, or rejected), and the room writes it before sending anything. If storage fails, the room
  closes rather than acknowledge what it couldn't save (crash-only). Rejections are stored as well,
  so a restart doesn't turn a client's next edit into a sequence gap.
- **The history caps are now a backstop.** Compaction keeps the log's tail well under them, so a
  board no longer fills (`BoardFull`) in use. They still bound what a cold load reads if
  compaction were to fall behind. The caps, each overridable by environment variable:

  | Cap | Default | Env | Why this number |
  |---|---|---|---|
  | Transaction size (JSON) | 64 KiB | (schema `Limits::max_tx_bytes`) | Twice the largest legal op: an undo of a full note carries 4000 chars twice, at most 4 bytes each, about 32 KB. A test builds the worst ops and checks the bound |
  | WebSocket frame | 65 KiB | (derived) | `max_tx_bytes` plus 1 KiB for the frame around it. A tx just over the limit gets a typed `TxTooLarge`; only frames no honest client sends close the socket. Was 256 KiB |
  | Transactions kept per board | 100,000 | `BOARD_MAX_OPS` | Counts what's kept since the compaction floor, so in use it stays near the 2,000-entry tail plus up to 10,000 since the last base. A backstop for cold-load time |
  | History bytes kept per board (as stored) | 20 MiB | `BOARD_MAX_BYTES` | Counted compressed and on what's kept. Compaction runs at half of it and keeps a quarter, so even adversarial history (60 KB of random text per edit) compacts long before it binds |
  | Editing clients per board | 1024 | `BOARD_MAX_CLIENTS` | Distinct devices that have edited. View links register nothing (§11) |
  | Stored rejections per board | 4096 | `BOARD_MAX_REJECTIONS` | Sixteen clients' worth of the 256 each may leave; past it, a refused transaction closes its sender instead of being stored |
  | Boards in memory | 256 | `MAX_OPEN_ROOMS` | Was 32. A room no longer holds its history: a board full of history costs ~1.6 MB, a small one ~0.3 MB. 256 small rooms opened at once are 87 MB |
  | Room memory | 128 MiB of estimates | `ROOM_MEMORY_BYTES` | A room's cost is its document, up to ~20 MB at the schema's limits (5000 records of 512-point strokes), so rooms are budgeted by estimate, not only counted. Rooms of the largest documents fill it at 8 open, 183 MB peak: 29% headroom under `MemoryMax=256M` ([journal](../journal/2026-11-07-security-fixes.md)) |
  | Boards stored | 5000 | `MAX_BOARDS` | Creation past it is refused with 507 |
  | Database size | 2 GiB | `MAX_STORAGE_BYTES` | Creation past it is refused with 507, and edits with `ServerFull` |

  A board at its history cap refuses edits with `BoardFull`. It stays readable and loads
  normally, and the client says the board is full and suggests cloning it, which starts a fresh
  history (§11). A cold load reads one row at a time and refuses a board over the caps rather
  than reading it, so a board written under larger caps reports a storage failure and is logged.
  Raising the cap opens it again. Lowering a cap below a stored board does the same to that board.
  When the open-room cap or the memory budget is reached, an idle room (nobody connected)
  unloads early to make way. If every room is in use, the join is refused with `busy` and the
  client retries with backoff. A room's estimate (`Doc::approx_heap_bytes`, its tables, and its
  current outbox backlog) is taken at load and kept current as it's edited; an edit
  that would take the server past the budget is refused as `ServerFull` while an idle room is
  asked to unload. The budget is calibrated with `MALLOC_ARENA_MAX=2`, which the module and the
  image set: glibc's default arenas measured ~1.5× the estimates resident, against ~1.3× with two.
  Broadcast frames are serialized once and shared by every peer's outbox, and each outbox is
  capped at 4096 frames and 4 MiB (small frames meet the frame cap first), so a peer that stops
  reading is dropped before it pins memory. Presence is skipped, not queued, for a peer more than
  64 KiB behind. A room's weight counts its slowest peer's backlog as it stands. On the host, systemd restarts a failed server with
  exponential backoff (2 s doubling to 2 min) and gives up after 8 starts in 15 minutes, so a
  crash loop stops rather than spinning.

## 10. Schema versioning and migrations

- The board snapshot, the transaction format and the wire protocol each carry a version.
- **Migrations** are ordered pure functions `vN → vN+1`, applied to snapshots, and to queued ops
  where an op shape changed. They are tested with fixtures from every past version, which are
  checked in.
- The server migrates a stored board lazily on first load. It keeps the pre-migration snapshot, so
  a bad migration is reversible.
- **Mixed versions are refused, not reconciled.** The server serves the web client. A client older
  than the server's schema gets "mapcro updated, reloading". Its pending ops survive the reload,
  migrated where possible and otherwise kept as an offline copy (§5). This is deliberately simpler
  than tldraw's support for mixed-version writers. We control both ends, so we don't need it.
- `.mapcro.json` imports run through the same migrations, so files from any past version open.

## 11. Links, capabilities and security

**Capabilities.** Each board has three capability levels: `owner`, `edit` and `view`. Creating a board
returns the owner capability, stored on the creator's device. There are no accounts. Accounts can
later bind owner capabilities to a person.

- **Editors can share too (operator, 2026-11-06).** An edit link can mint view and edit links. It
  can list and revoke the links it minted, and those minted from them in turn.
- **Moving on without someone is a clone (operator, 2026-11-06).** Anyone with a link can clone the
  board's current state into a new board, which gets fresh links. Share those with everyone except
  the person you're leaving out. The clone copies scenes and records, not history, links or
  presence. The UI offers cloning, not revocation.
- **The owner sees and revokes everything.** Revocation stays in the API as an emergency backstop,
  for example for a link posted publicly. It isn't in the UI.
- **Revocation cascades:** revoking a link also revokes every link minted through it. A leaked edit
  link can then be cleaned up in one step, together with anything its holder handed out.
- View links can't mint.

- Tokens are 256-bit random, base64url. The server stores only SHA-256(token), so a database leak
  yields no usable links.
- **URL shape:** `https://<domain>/b/<boardId>#<token>`. The token sits in the fragment, so it never
  reaches server logs, proxies or `Referer` headers. The client sends it inside the WebSocket
  `hello`, never in a query string.
- **Revocation** is instant: revoking a link closes its live sessions. Each link has a label
  ("team scrim, edit"), so the owner can see what they handed out.
- **Server-side enforcement on every message.** A view session that sends an op is closed, and
  nothing is stored. Edit sessions are schema-validated, size-capped and rate-limited. Owner
  operations need the owner token.

**Attack surface and controls** (the public server is the exposure):

| Threat | Control |
|---|---|
| Guessing links | 256-bit tokens; board ids alone grant nothing |
| Link leakage | Fragment tokens, `Referrer-Policy: no-referrer`, revocation, labels |
| Malicious edit-link holder | Typed op validation, per-record and per-board size caps, per-transaction size cap, per-board history quota (§9), per-session op rate limit, owner restores from version history (not built yet; until then, clone) |
| Cross-site WebSocket hijacking | `Origin` allow-list on upgrade; no cookies, so no ambient authority |
| XSS via names, notes, callouts | All user text rendered as text, never HTML; strict CSP; no user-supplied URLs or images |
| Storage spam (anonymous board creation) | Per-IP creation rate limit plus a global hourly cap, max board size and history quota, total board and database caps (§9), idle-board expiry (Q3, not built) |
| Room flooding | Max sessions per room, sockets per address, presence rate limit, message size cap, open-room cap and room memory budget with early unload of idle rooms, outbox caps in frames and bytes |
| View link as a write primitive | A view connection registers no client id and stores nothing; only an id someone registered by editing is checked against its secret (security review 2026-11-07, H-B) |
| Hosting abusive content | Text only, with caps. Replay uploads are parsed into a timeline and deleted, never served back (§6a). Asset packs are placed in the data directory by the server operator, never through HTTP |
| Malicious replay files | Parsed only by the sandboxed worker (§6a): no network, own user, only the queue in view, memory, CPU, file-size and wall-clock caps, one job at a time; its output is shape-checked before it's cached |

**Address rotation (IPv6 /64), accepted.** Per-address limits key on an IPv4 address or an IPv6
/64, and someone with a routed /56 or /48 holds many /64s. That is left as is (security review
2026-11-07, M-A): the global caps bound the damage whatever the address count. Creation is capped
per hour server-wide, total boards and database size are capped, each board's history is capped,
and memory is capped by the open-room limit and the room memory budget. Rotation lets one party use up those shared budgets
faster, so its cost is availability (new boards refused, joins `busy`), never a crash or a full
disk. Widening the key to /56 would penalise everyone behind a shared prefix; revisit with
proof-of-work or accounts if rotation is seen in practice.

**Match import (§6a): upstream limits and privacy.**

- **Limits:** our server alone calls deadlock-api. It uses a global token bucket (5 calls, then
  one every 2 s, well under their published 100 per 10 s), at most 20 uncached imports per
  client address per hour, a 20 s timeout and a 16 MiB response cap. Ids are digits only, at
  most 12. Failures map to `bad_id`, `not_found`, `rate_limited`/`busy`/`upstream_limited`,
  `upstream_down` and `too_large`, are shown as short labels, and are never cached.
- **Privacy (operator, 2026-11-07):** players' names would be kept, but Steam and account ids
  never. Account ids are never even deserialised, so they can't reach the cache or a response.
  Names would have meant a second call to a profile endpoint, and the operator allowed names only
  if the match call itself returns them. It doesn't, so v1 imports no names and leaves
  `RosterName` alone. A player is a team, a slot and a hero.

**Match import's replay tier (§6a): trust boundaries and limits.** For the security review:

- **Boundary 1, the HTTP edge → the board server.** Upload bodies are untrusted bytes. Only the
  upload route lifts the global 16 KiB body limit; it needs an owner or edit link to the board
  (`401` without, `403` for view links or other boards), and streams to
  `inbox/.<job>.part`, never into memory. Caps: 800 MiB per upload (`413`, by `Content-Length`
  up front and while streaming), 60 s without a byte or 30 min in all (`408`), two uploads at
  once and one per client, 6 uploads or fetches per client address per hour (`429`), at most
  6 queued jobs and 3 GiB in the queue counting transfers in flight at their cap (`503`/`507`).
  The first 8 bytes must be `PBDEMS2\0` (`415 not_a_replay`); nothing else is read. A refused
  or broken upload leaves no file, a dropped connection included.
- **Boundary 2, upstreams → the board server.** deadlock-api's salts response is capped at
  64 KiB, and only `cluster_id` and `replay_salt`, as numbers, are taken from it: the CDN URL is
  built from them, so the response can't point the server anywhere else (no SSRF), and
  redirects aren't followed. The demo download streams to disk under an 800 MiB cap and a
  30 min timeout, and must start with bzip2, zstd or demo magic. 20 fetches server-wide per
  hour; a failed fetch isn't retried for an hour.
- **Boundary 3, the queue → the worker.** Everything in the inbox is hostile. The worker
  decompresses under a 1 GiB cap (bzip2 in Rust; zstd with a 128 MiB window limit) and parses in
  a child process inside the sandbox above. Its only outputs are files in its own `outbox/`; it
  can't write the inbox, so it can't plant a link the server would follow (M1).
- **Boundary 4, the worker → the board server.** The worker's output is untrusted too: at most
  4 MiB, deserialised into the typed timeline, and checked (array lengths match the duration,
  teams and keys have the pack's shape, numbers are in range, names are at most 32 characters
  and free of control characters, bidi overrides and `<>&"` (L3), the match id is the job's)
  before it is re-serialised into the cache. It's accepted only for a job the server queued
  (M2), read without following links. An unknown reason code reads as `parse_failed`.
- **Scope.** A demo carries no match id, so an upload's claim to be match N can't be checked:
  an uploaded timeline is served only to the board that uploaded it, and a new upload replaces
  it. A timeline fetched from Valve by match id is shared by every board.
- **Privacy, as in v1:** the worker never reads Steam or account ids (`m_steamID` is not among
  the fields it resolves), so no timeline can hold one. In-game names are kept when the demo
  carries them. Demos are deleted when their parse ends; only the derived timeline is kept.
- **Caddy:** the edge must pass request bodies up to 800 MiB and not time a slow upload out
  first (docs/deploy.md).

No end-to-end encryption, unlike Excalidraw. E2EE would stop the server validating ops, which is
the reliability and security boundary above. Boards are game strategy, so server trust plus TLS is
the right trade-off. A dedicated security review gates public exposure.

## 12. Game assets and the extraction pipeline

**Decision (operator, 2026-11-06):** mapcro is free forever. Art is extracted once, by whoever runs
the server, and the server serves it, so users never extract anything. Art stays out of the git
repo. The repo has no need for it, and keeping it out means a takedown request could only ever
reach a server's art directory, never the source code.

**`mapcro-extract`** is a Rust CLI in the workspace. It reads a local install
(`Deadlock/game/citadel`) and writes a versioned **asset pack**. The server operator then uploads or
syncs that pack to the server's data directory. The server never needs the game installed.

- It opens only allow-listed paths. The folder also holds per-account files, which are never read.
- It reads the 8.4 MB VPK directory, then just the needed byte ranges, about 15–20 MB of a 33 GB
  install.
- The minimap layers and hero portraits are uncompressed BGRA textures. Hero data and map entities
  are binary KV3, which no Rust library reads yet. We port the needed parts of ValveResourceFormat
  (MIT, credited).
- VRF's own CLI is the **test oracle**: a local check diffs our output against it on the real
  install. CI uses only synthetic VPK fixtures generated by the tests.

**What it derives from the install**, so deadlock-api is no longer needed:

- Heroes come from `scripts/heroes.vdata_c`, with names from the localisation files.
- Objectives, camps, rifts, ziplines and sentries come from the map entity lump.
- The world→minimap transform is fitted against extracted objectives. deadlock-api's hard-coded
  radius of 10752 has no in-game source.

**Asset pack** (content-addressed, so builds that change nothing share their blobs):

```
pack.json   schema, extractor version,
            game { client_version, source_revision, date },
            sources [{ vpk, path, crc32, size }],       the cheap "did anything change" key
            heroes [{ hero_id, name, minimap_blob, state }],
            map { id, transform, layers [] },
            entities [{ key, kind, team, lane, world [x, y, z], src {...} }],
            geometry_hash
blobs/<sha256>.png
```

The server serves packs at `/packs/<pack_id>/…`. Responses are immutable and cached forever,
because the content is hashed. The server keeps every pack it has had, so an old board can still
render on the art it was made with.

**How boards reference the game.**

- Positions are world coordinates.
- Heroes are referenced by `hero_id`.
- Objectives use a **semantic key** such as `walker:amber:lane2`. The raw entity id is kept as
  evidence.
- Each board records the `pack_id` it was authored on, and opens on the newest pack by default.

When a board opens on a newer pack:

- Keys resolve first. Failing that, an entity of the same kind within a tolerance matches.
- Anything moved or orphaned is shown, never silently re-snapped.
- After a full map rework (6711 was one), the board offers "view on the map it was made for".

**Version tracking.**

- The server polls Steam's public `GetClientVersion` endpoint, which needs no key, and reports
  "pack is behind the live game" on its status page and in its logs.
- The operator re-runs the extractor. If the source CRCs are unchanged, the extractor says
  "nothing changed" and makes no new pack. Most builds don't touch the map: 6851 → 6860 left the
  minimap byte-identical.
- Automating extraction on the server (deadlock-api does it with Steam credentials and
  DepotDownloader) is possible later. It would bring in a credential, so it isn't planned.

**Legal posture:**

- Hosting extracted art is what every Deadlock tool we found does.
- Steam's agreement allows non-commercial fan use and forbids redistribution, so the risk is a
  takedown of the art, not of mapcro.
- mapcro stays free, carries a clear "not affiliated with Valve" notice, and keeps art out of the
  repo.

This is a risk posture, not legal advice.

## 13. Code and deploy shape

**Decision (operator, 2026-11-06): a Rust core.** One Cargo workspace holds the schema, the
authority, the replica, undo and migrations. That same code runs natively in the server and as WASM
in the browser, for local boards and the client replica. The UI stays TypeScript and talks to the
core through a narrow, typed boundary.

```
crates/schema     records, ops, invariants, migrations: pure, no I/O
crates/engine     authority (validate, sequence, apply), replica (confirmed/pending/rebase),
                  undo, text OT: pure and deterministic
crates/server     axum + WebSocket, rusqlite, one tokio task per room, links, limits, /healthz
crates/wasm       wasm-bindgen wrapper of engine for the browser; TS types generated (tsify)
crates/extract    mapcro-extract CLI (§12)
web/              Vite + TypeScript UI, SVG map renderer, IndexedDB store, calls crates/wasm
design/           Paseo design-canvas collections for UI iteration
```

**The WASM boundary** is designed so it never becomes a bottleneck or a source of bugs:

- The core owns the board state. Every call takes a transaction or a server message and returns
  the **changed records**. The JS store mirrors records for rendering and is never the source of
  truth.
- Edits are human-paced, so a call costs microseconds. Presence and drag previews bypass the core
  entirely, because they are ephemeral.
- Types crossing the boundary are generated from the Rust definitions, so TypeScript can't drift
  from them.

**Server process:**

- One Rust binary serves the built web client, `/api`, `/ws`, `/packs` and `/healthz`.
- Each open board is a tokio task that owns its state and processes messages one at a time from a
  channel. Applies are serial per room, with no shared mutable state.
- Config comes from env (`PORT`, `DATA_DIR`, `PUBLIC_ORIGIN`). It fails fast on bad config and logs
  to stdout.

**Infra:** the infra `rust-app` template fits directly. It is a `runtime = "systemd"` registry app
behind Caddy, which proxies WebSockets without extra config. SQLite and packs live in the unit's
`StateDirectory`. The backup timer is declared in mapcro's own NixOS module, with credentials passed
by path through sops. Nothing deploys without your OK at the time.

**Scale assumption:** one box, tens of concurrent rooms, under 50 people per room.

## 14. Validation harness

There are six layers. Layer 0 checks the design; the rest run the real code in a setting as close to real as that layer allows.
The harness is the judge of everything else, so Opus writes it and DeepSeek never does.

**0. Protocol model** (Quint, in `model/`)

- **What it is:** a small formal model of §3–§7, covering the op log, pending queues,
  connections, reconnect and undo.
- **Two ways to check it:**
  - `just model-check` runs TLC over **every reachable state** of the bounded model.
  - `just model-sim` runs fast random simulation.
- **A protocol change goes in the model first.** Rust test traces will later be generated from it
  (`quint-connect`).
- See the [experiment journal](../journal/2026-11-06-quint-sync-model.md).

**1. Sync simulation** (pure Rust, deterministic, the main gate)

- **Pieces:**
  - one authority
  - N replicas, each driven by a behaviour model: dragger, typist, undo spammer, offline commuter,
    scene reorderer, malicious editor
  - a simulated network with a seeded RNG: per-link latency, drops, duplicates, reordering,
    partitions and disconnects
  - a simulated clock
- **Checked after every step:** schema invariants hold on every replica and on the authority, and
  saved status is never shown while work is still pending.
- **Checked at quiescence:**
  - Every replica equals the authority.
  - Every acknowledged transaction appears in the log exactly once.
  - Every pending transaction either landed or became an offline copy.
- **Independent oracle:** a deliberately naive reference model rebuilds the board by replaying the
  authority's ordered log from scratch on every check. The real engine must match it. An undo
  oracle checks that undo restores exactly your own fields and never someone else's later edit.
- **Failures** print a seed and a minimised trace (proptest shrinking), plus a diff of the states.
  `just sim --seed <s>` replays one exactly.
- **WASM parity:** traces recorded natively are replayed through the WASM build, and state hashes
  must match.

**2. System tests** (the real server binary, real WebSockets, real SQLite)

- **Setup:** the server runs on a temporary data dir. Rust test clients use the same replica code.
  They connect through a fault-injecting TCP proxy that adds latency, cuts connections and leaves
  sockets half-open.
- **Crash:** the server is SIGKILLed at random points under load and restarted. Every acknowledged
  transaction must still be in the database, and every replica must converge.
- **Upgrade:** the previous release's binary writes a database, the new binary opens it, and the
  boards must migrate and load.
- **Backup:** a backup is restored into a fresh server, and its boards must equal the originals.

**2a. Many-peer soak** (`web/soak/`, `just soak`: the real server binary, real WebSockets, the
real `BoardSession` over the WASM replica, IndexedDB through `fake-indexeddb`)

- **Shape:** 40 peers by default (30 editors, 10 viewers) on one board, in worker threads, each a
  real session with its own IndexedDB. A seeded schedule drives a few actions per second per
  editor, with bursts: hero drags (a presence preview, then one transaction), group moves, souls,
  clocks and ults, ink, arrows, callouts, notes, objectives, waves, scene add, reorder and delete,
  undo and redo, cursors, lasers and follows, and contests where several editors write one field
  within milliseconds of each other.
- **Faults:** socket drops, tab reloads (the session is killed as a crash would kill it, so saves
  that hadn't landed are lost, and a new one starts from its IndexedDB), offline bursts that keep
  editing, a late joiner from scratch on a large log, and the server `kill -9`'d and restarted
  mid-run.
- **Checked at quiescence,** mirroring the simulation: every replica equals the log replayed and
  a fresh client's board; every transaction a peer saw acked is logged exactly once, at that seq,
  with the same contents; every rejected one is not logged and its peer heard the rejection; every
  entry a peer was given matches the log; presence converges (each peer's last state reaches
  everyone, nobody sees themselves, only editors can be followed); the final board passes
  `validate_doc`. During the run, protocol errors (gaps, ack mismatches) and `Fatal`s fail it, and
  views are sampled against `validate_doc`.
- **At 64 peers** (the room's session cap, a constant) it runs at the default history caps and
  checks that a 65th peer gets a clean `closed: full`. Otherwise it raises the history caps
  through env, so long runs never fill the board.
- **Reproducible decisions:** the same seed gives the same schedule (its fingerprint is printed);
  network timing still varies. What it found, and the bugs planted to prove it discriminates, are
  in the [journal](../journal/2026-11-07-soak.md).

**3. Security tests**

- **Adversarial raw-WebSocket client:** it tries a view token sending ops, revoked tokens, wrong
  board ids, cross-origin upgrades, oversized and malformed frames, and floods past the rate limits.
- **`cargo-fuzz`** targets the protocol decoder and the op validator.

**4. Browser end to end** (Playwright, Nix-provided Chromium, real server)

- Two or three browser contexts work on one board. The scenarios: create a board, share an edit
  link, edit from both sides, `setOffline`, reload with pending edits, a view link that cannot edit,
  follow mode, and per-user undo.
- Map rendering snapshots use a **synthetic test pack** of original, generated art, so goldens in
  the repo never contain Valve art. A local-only variant runs on the real pack.

**5. Extraction and migrations**

- A fixture generator writes synthetic VPK and binary KV3 files, so CI never touches game data.
- `just extract-check` runs locally on the real install and diffs the output against VRF's CLI.
- Determinism: the same install must always produce the same `pack_id`.
- Every schema version's snapshot fixture is checked in, and each new version must load them all.

**DX:**

| Command | What it runs | Target time |
|---|---|---|
| `just test` | unit tests plus 1k simulation seeds | under 30 s, the inner loop |
| `just test-all` | adds system, security and e2e | |
| `just soak` | many peers on the real stack with faults and server crashes (`just soak <seed> <peers> <seconds>`) | about a minute by default |
| `just sim --seed` | replays one seed | |

CI runs `just test-all` through the Nix flake. `cargo-mutants` over `crates/engine` checks that the
simulation actually catches broken logic.

## 15. Open questions for the operator

Settled on 2026-11-06: a Rust core (§13), and server-hosted art that users never extract (§12).

1. **UI language:** a TypeScript UI over the Rust core (recommended), or a full-Rust UI
   (Leptos/Dioxus)?
2. **Notes:** real simultaneous typing (the text OT in §3), or last-writer-wins plus a "someone else
   is editing" indicator for v1?
3. **Anonymous storage:** should idle boards expire, for example after 180 days with no opens? And
   are per-IP limits on board creation acceptable?
4. **Scenes:** is "a board is a sequence of scenes sharing one roster" the right model?
5. **Later:** the backup bucket. Decided: MIT licence; hosted at `https://mapcro.dmgdeadlock.com`
   (2026-11-07). The apex `dmgdeadlock.com` is a separate live site, so DNS for the subdomain
   only needs a new `A`/`AAAA` record pointing at the infra host, which must exist before the
   first deploy (ACME). Deploying still needs the operator's explicit OK at the time.
