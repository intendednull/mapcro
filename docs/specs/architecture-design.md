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
- `stroke`: freehand ink as a list of world points (capped), colour, width, and an `offset` added
  to every point when drawn. Moving a stroke is one last-writer-wins `set` of its offset, skipped
  on a deleted stroke like any other field write. It is never a delete and re-create, which would
  bring back a stroke a peer had deleted. Older strokes load with offset 0.
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
| Select | the default: drag tokens and callouts, click objectives (named Move until feedback #31, 2026-11-11) | ops |
| Draw | freehand ink in a palette colour | a `stroke` record |
| Arrow | drag out a rotation arrow | an `arrow` record |
| Callout | click to place a label, typed in place | a `callout` record |
| Laser | drawing that fades: the trail holds briefly, then fades away. Each press-to-release is its own trail: pressing again while one fades starts a new one, never joined to it (presence `laser_starts`, 2026-11-08). Everyone gets it, viewers included (operator, 2026-11-06) | presence only, never stored |
| Erase | click or scrub over ink, arrows and callouts | deletes |
| Clear | a menu: removes every stroke, arrow or comment on this scene, or all of them, as one undoable step | one transaction of deletes |

The map is still the surface for every tool; the picker only chooses the gesture.

**The map's edge (feedback #21):** heroes, troopers and their rings and labels are clipped to the
map's stencil (the HUD frame's shape) and take no pointer past it, and the edge is drawn over
them. A dragged hero stops at the map's disc. Ink, arrows and comments may still go into the
notes margin round the map (design/parity/README.md, Stencil and edge).

**Keys (operator, 2026-11-09; reordered by use 2026-11-11, feedback #28):** under the left hand,
the most used on the nearest: Select Q, Laser W, Draw E, Arrow A, Comment S, Erase D (D under E,
so drawing and erasing sit side by side; D over a placed thing deletes it, in any tool). The
toolbar lists them in that order, each button showing its key and its hover saying it ("Select
[Q]"). C opens the Clear menu and Shift+C clears everything on the scene at once, the menu's All
as one undoable step (operator: "a button that clears without opening the menu"); T adds a scene
after this one, as the scene tree's + does (feedback #30). Clear and T are an editor's only; a view
link has Q and W. F follows the presenter, K kills or revives the hovered hero; R is unbound. The
keys don't fire while typing in a field, in a dialog or a menu (`core/keys.ts` `boardKeys`), or
with Ctrl, Cmd or Alt held, so Ctrl+C still copies; Shift is allowed.

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
- **Changing values ease.** The operator asked on 2026-11-08 for each changing value to "lerp quickly and
  smoothly rather than jump", and for "UI elements that represent changing values" to follow
  suit. A value shown from the match or the data eases to each new value instead of jumping. The
  curve is easeOutExpo ([easings.net](https://easings.net/#easeOutExpo)) over 350 ms. A long scrub
  eases too, in the same 350 ms.
  - **How.** In CSS, use `transition: <property> var(--value-ease-ms) var(--ease-out-expo)`, with
    the variables in `styles/app.css`. A custom property must be typed with `@property` to
    animate. A number drawn as text or as geometry CSS can't transition goes through
    `easedNumber(source)` (`board/smooth.ts`), which uses the same curve and duration. Round it
    for display from the eased value. Data attributes keep the exact value.
  - **Never eased.** What changes with zoom or layout, such as an arc's dash: measure it in
    `pathLength` or percent so the zoom isn't eased. Never ease what the user is moving, either:
    the scrubber's thumb, the match clock (the playback position itself), or a value being dragged
    or typed on the scene bar.
  - **Snaps.** The first value after none snaps, and so does a hidden tab.
  - **Reduced motion.** `prefers-reduced-motion` sets `--value-ease-ms` to 0, and `easedNumber`
    snaps, so every value jumps.
  - **Eased today:** top-bar health bars, token health arcs, objective fills, the Player top bar's
    ult rings, souls, team totals and respawn countdown, the lanes' zipline colours, and the
    upload's bar and percent.
  - **Tested** in `e2e/player-health.spec.ts` and `e2e/player-ease.spec.ts`.

## 4b. Labels and hover text

Operator, 2026-11-10, after the Tab scoreboard's investment bars read "weapon: 4,800 souls in
equipped items (current shop prices)": hover text had grown into explanations. The rules:

1. **Labels are tags, not prose.** One to three words naming the thing: "Weapon invest",
   "Kills", "Max health". No sentences and no voice (no "you", "we", "this replay", nothing
   addressed to the reader), no caveats, provenance or method ("current shop prices",
   "calculated") and no numbers the element already shows.
2. **Use the game's word when the game has one** (its localisation, HUD or the operator's
   reference screenshots), shortened only as the operator asks. Don't invent labels for things
   the game names.
3. **Missing data is "—" on screen and "Not recorded" on hover.** Nothing longer.
4. **Values follow the game's scale.** A bar, meter or ring fills the way the game's does (its
   HUD sources or reference screenshots), never relative to something we picked, such as the
   hero's own largest category.
5. **Explanations live in docs and dialogs, not hovers**: method and caveats go in the spec, the
   research map or a help dialog. A calculated value carries one quiet mark, "≈" before the
   number (operator, 2026-11-10); a recorded value carries none.

Reviewers check new or changed `title`, `aria-label` and tooltip text against these rules.
`aria-label` follows the same rule; it may add a tag a screen reader needs ("Weapon invest, 4,800"), still not a sentence.

## 5. Offline and reconnect

1. Connect. The socket's first frame is `auth { board, token, known_seq, build? }`. `build` is the
   client's protocol build, `BUILD_ID`. It is a hash of the schema's and the engine's sources,
   computed by `crates/schema/build.rs` and shared by the server and the browser's WASM. If it
   differs from the server's, the server answers `closed: outdated`. A missing `build` (older
   clients, tools) skips the check. The server answers
   `ready { role, base?, peer, head? }`, sending a base document only to a client that has none. Then the
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
   - **A copy is current once it reaches `head`.** `head` is the log length when the room took
     the join (2026-11-11). Until its copy is there, a client's view can lack records others
     made, so the client doesn't make records from it automatically: Player's live layer, whose
     ids anyone would derive the same, waits (`BoardSession.current()`). Before this, a second
     editor opening a board in Player made the layer again from its stale snapshot, the server
     refused it `IdTaken`, and its save status said "Conflict" (backlog 2026-11-11). Two editors
     making it at once still race; the loser's `IdTaken` is the outcome wanted, so the session's
     `ensure` doesn't report it. An older server sends no `head`; a live copy then counts as
     current.
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
     - **A catch-up can be overtaken.** Catch-up is a range the socket reads lazily, and compaction
       may delete its start after the range was queued (in the hello's own batch, or while a slow
       client pages through it). A range that starts below what's kept closes the connection as
       `too_slow`, logged at info, not an error. The client's reconnect, from where it got to, is
       below the floor and is rebased.
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
  so the CSP's `connect-src` is `'self'` plus only the Windows app's IPC channel (`ipc: http://ipc.localhost`, operator 2026-11-10; nothing answers there in a browser). We hold no Steam account.
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
- **Previews (2026-11-10, the Windows app's replay picker, §6b):** `GET /api/matches/{id}/preview`
  is one card's data, under 1 KB: `{match_id, start_time, duration_s, game_mode, winner, teams:
  [{team, heroes: [[slot, hero_id]], kills, souls}]}` (Amber first). It's derived from the cached
  summary and cached beside it (`<id>.preview.json`, dropped when the summary is fetched again).
  The summary now keeps `winner` (`winning_team`) and `team_kills` (the players' `kills`) when the
  metadata has them; without them `winner` is `null` and a team's kills are the other team's
  deaths (equal on 129738985: 39/35). Souls are the players' last `stats[]` net worth (equal to
  their final `net_worth` there). No names or ids. An uncached match goes the way an open does:
  the per-client and global limits, and the summary it fetches is cached for the open that
  follows. After the metadata call says 429, previews don't ask deadlock-api for 60 s (opens
  still do). Errors are the summary's (`not_found`, `brawl`, `upstream_limited`, …).
  - **Read from the demo first (2026-11-11, operator: every replay in the folder gets a card):** in
    the app, a card's preview comes from the `.dem` itself (`crates/replay` `preview::read`, the
    same shape plus `build`; `start_time` is 0, the demo doesn't record it), so fresh matches,
    matches deadlock-api doesn't have and uploads get one with no server call. It reads the
    signon and the match's last minute (a few MB; 129738985: 0.2 s, 11 MB of 504 MB) and takes
    the end as the full parse does: heroes by slot, kills, souls at the winning tick, the winner,
    the clock to the win, the mode. Any build and mode reads (a Brawl demo is a card that says
    "Street Brawl"). The server's preview is asked only when the app has none (a broken file, an
    app without the command). docs/research/demo-preview.md.

  - **Summary format (2026-11-11):** a cached summary carries `summary_format` (now 1: the
    winner and team kills). One below it (unstamped and without `winner`, cached before the
    winner was kept) is derived again on its next open or preview, from one metadata read on the
    same limited path, once a process; if that read fails or is limited, the old one is served.
    A cached card with `winner: null` isn't served as it is: it's made again from the summary,
    so an old one picks up the winner (a match with none just makes the same card).
- **Not in the metadata tier:** ults, zipline colours, camps, rifts, powerups and z. A match older than the
  pack is drawn on it with an "Older map" label.
- The mid boss's respawn time isn't in the match data. The preview shows it down from a kill
  until the next kill (the replay tier has the real respawn, below).

### Tiers: the replay is the rich one (operator, 2026-11-07)

One panel, two tiers. When a replay timeline exists for the board and match, it's used;
otherwise the metadata timeline is. A small label names the tier in use ("Replay" or
"Metadata"). `GET /api/boards/{board}/matches/{id}` (any link to the board) makes the choice:
the board's own upload first, then a timeline fetched from Valve's CDN, then the metadata (v1,
above). The old `GET /api/matches/{id}` still serves the metadata alone.

- **Where a replay comes from,** uploads first:
  - **Upload:** an editor picks or drops a `.dem` from the game's replays folder (§6b, Getting
    a replay in). It needs no metadata: a match deadlock-api doesn't know yet opens on its
    replay alone.
    `POST /api/boards/{board}/replays/{id}/reserve` first (its turn, below: The queue), then
    `POST /api/boards/{board}/replays/{id}/upload`, raw bytes, with upload progress.
  - **Fetch:** `POST /api/boards/{board}/replays/{id}/fetch` asks deadlock-api's salts endpoint
    for the match's cluster and replay salt, then downloads
    `http://replay{cluster}.valve.net/1422450/{id}_{salt}.dem.bz2` (zstd since 2026-07-20; the
    magic decides). A stored row comes back before deadlock-api's rate limiter, so it's free;
    only a match with no row spends one of the 3 Steam lookups an hour per address, and that GC
    lookup is the one path that can create a replay salt (docs/research/deadlock-api-salts.md).
    So the free read (`disable_steam=true`) goes first. Only a match it has no row for gets the
    read that may ask Steam, and only once the match is past deadlock-api's salts pass (2 h 10
    min after its end, by the cached metadata; a match without it counts as past). Before then,
    a Steam lookup never found a replay salt the free read lacked (salts "Results").
  - **Fetched on open (operator, 2026-11-08):** attaching a match to a board (the landing's Open
    match by id, Player's Load) starts that fetch on its own, unless the `cdn` timeline is
    cached or its job is under way (one job for every board: a second board joins it), the
    board's own upload is under way or done, the match is past Valve's three weeks from its
    start (`expired`, from the cached metadata; a match without it isn't tried), or its fetch
    failed lately (including a lookup that met deadlock-api's backoff). The mode refusal comes
    first.
    - **Remembered failures:** no salts or no demo (`no_replay`) and a failed download are kept
      per match, so opening it again doesn't ask deadlock-api. A failed download and a match
      past the salts pass are kept 6 h. A match before the pass with no replay salt yet (or no
      row) is kept only until the pass, when most salts that come have come (about 10% at 1 h,
      42% at 2 h, 45–48% after). The 400 "won't be fetched, as it has metadata already" (no row,
      and Steam won't be asked) is `no_replay` too. **Fetch replay** stays, and goes past this.
    - **Pacing:** no fetch cap of ours. deadlock-api's own answers pace them: a `429` from the
      salts endpoint backs off the reads that may ask Steam for its `Retry-After`, else 60 s
      doubling to an hour. Free reads of the rows it holds go on meanwhile, so a match it has a
      salt for is fetched. A match with no row waits for the backoff (`upstream_limited`), on
      open and on a press of Fetch replay (`429 upstream_limited`). Fetches wait in
      the queue's line (below) for a download slot (2 at once) and its room rather than being
      refused.
    - **API key:** optional, from the file `DEADLOCK_API_KEY_FILE` names (never a value in the
      environment), sent as `X-API-KEY` on deadlock-api calls; it raises Steam-sourced salts to
      300 an hour (docs/deploy.md).
    - **Player:** the tier chip reads "Queued · N ahead" while it waits for a download, then
      "Fetching replay…", "Queued · N ahead" (with "~N min" when the server has an estimate)
      and "Parsing replay…", and upgrades in place. A fetch that fails or can't start settles on
      "API summary", and the tab that opened the match is asked what to do in the full-replay
      prompt (§6b, Getting a replay in).
    - **Why no fetch is coming, in the job state (2026-11-08):** with no job, the status says
      `failed` with the remembered reason (`upstream_limited` for a match whose lookup met the
      backoff, until it ends), `busy` for
      10 min to the board whose open our caps skipped (that board only), and `expired` for a
      match past the three weeks by its cached metadata, whether or not anything opened it.
- **Job state:** `GET /api/boards/{board}/replays/{id}` answers `none`, `waiting` (an upload's
  reservation in line), `uploading`, `fetching`, `queued`, `parsing`, `done` or `failed` with a
  short reason. `waiting` and `queued` carry `ahead`, the jobs before it; `queued` carries
  `eta_s` when there is an estimate (below: The queue). The reasons: `old_map`,
  `brawl`, `unsupported_mode`, `not_a_replay`, `too_large`, `timeout`, `parse_failed`, `no_replay`, `upstream_down`,
  `upstream_limited`. The panel polls it and shows labels only; a job that finishes swaps the
  replay timeline in, keeping the scrubber where it was.
- **Current map only:** a demo whose header's `game_directory` names a content build before 6712,
  or whose objectives don't sit on the current map's sites, fails as `old_map` ("Old map"). The
  header's `build_num` and `map_name` say nothing about the map (exploration §1). Pre-6712 demos
  also decode 16,384 units low on every axis; neither that correction nor old-era packs are
  built.
- **Standard mode only** (2026-11-08): the map, lanes and objectives describe the 6v6 mode
  alone. A demo whose game rules' `m_eGameMode` isn't 1 fails as `brawl` ("Brawl not supported",
  Street Brawl's 4) or `unsupported_mode` ("Mode not supported"). The metadata's
  `match_info.game_mode` refuses the same way on import (422, same codes); the server remembers
  the refusal (`DATA_DIR/matches/<id>.refused`), so it isn't fetched again and no board can
  attach the match or take a replay of it. Only the metadata records a refusal: a replay is
  untrusted. Metadata without a `game_mode` imports as before. The cached timeline keeps the
  mode (standard when the metadata didn't say), and a cache without one (written before the
  refusal existed) is fetched again once, then refused or served (QA 2026-11-08: a Brawl match
  cached earlier still opened a board).
- **Health** (replay tier, 2026-11-08):
  - The worker writes each hero's health in percent every second, 0 when dead, since a dead
    pawn can keep a stale value.
  - It writes `objective_health`: by board key, `[second, pct]` wherever the value changes, for
    guardians, walkers, base guardian pairs (their mean), shrines, the patron and the mid boss.
    The patron also gets `stage` (`m_ePhase` 1, final, is stage 2).
  - The loser's patron falls at the end, because the parse stops on the winner's tick.
  - On 129738985 this adds 9 KB to a 1.46 MB timeline.
  - Player shows, while Health is on (a transport toggle, on by default):
    - the HUD's own `#HealthBar` beside each top-bar portrait (operator, 2026-11-08, matching
      an in-game screenshot; it replaced a thin bar under the portrait): a 16 × 50 card drawn
      with the pack's `healthbar_backer_vert_mask` and `_border` art, slanted −10° on the
      friendly side and +7° on the enemy side. Its fill is the mask's shape cut to the health
      from the bottom, offWhite for friends and `#FF5656` for enemies. The size, offset and
      colours are `citadel_hud_top_bar.vcss`'s. Without a pack, a clip of the same outline
      draws it. A dead hero has no bar (`.Dead #HealthBar` collapses), so the respawn
      countdown stands alone. The bar is absolutely placed, so turning it on or off never
      shifts the top bar.
    - the HUD's low-health state (`.healthLow`) at 30% or under, alive only. The portrait becomes
      the hero's critical card (heroes.vdata `m_strIconHeroCardCritical`,
      `panorama/images/heroes/<hero>_card_critical_psd`, 280×380, exported by the extractor as
      `topbar/heroes/<id>_critical`). With the pack's hero cards it takes the badge's own frame
      (§6b, Top-bar portraits), so the swap moves nothing; on a pack without them it's drawn
      70.4 wide at the card's aspect, bottom on the disc's, under the same `hero_image_mask`. `#CriticalIndicator` puts a "Critical" tag under
      it, hidden on a phone, where it covers the team total; reduced motion stops its wobble.
      `hero_badge.vcss` also pulses the disc red with a glow and washes the portrait red. The
      operator had those removed (2026-11-08). No outline: the stylesheet has none for this
      state. The game sets the class from code, so 30% is ours.
  - The API summary shows none of these, and its tier chip says so.
- **What the replay timeline adds** (`crates/replay/src/timeline.rs`, the metadata timeline's
  shape plus fields; 1 Hz, about 140 KB for a 15-minute match):
  - Positions with the exact life state (the pawn's `m_lifeState` and health), deaths, souls
    (net worth, when it changes; the demo updates it about as rarely as the metadata does), and
    in-game names where the demo has them.
  - **Ult cooldown** left in percent at each second, which is `PlayerState.ult_cooldown`. A
    cooldown that reads 0/0 in the recording (it does, for tens of seconds around full packets)
    holds the last one seen.
  - **Rifts:** the `rift:` key that is up at t, from the spawner's position or the live
    cash-in's; when its cash-in opens (`live_s`, format 2); and from format 3 (timers audit,
    gap 2) its give-up deadline (`give_up_s`, `m_timeKothGiveUp`, opening + 60 s) and each
    team's capture progress (`capture`: `m_vecTeamKothStates[]`, index 0 Amber, 1 Sapphire,
    checked against the capturer on all five of 129738985's rifts). Progress is sampled at 2 Hz
    while the cash-in runs, as `[tenths of a second, amber %, sapphire %]`; a run of equal
    samples keeps only its ends, so the client's straight line between rows is exact. The
    cash-in's first tick still holds the last rift's progress (99/100 at 19:51.61); the deadline
    is set, and the progress reset, a tick later, so samples start then. On 129738985: 5 rifts,
    201 rows, 2.7 KB.
  - **The Rejuvenator** (`rejuv`, format 3, timers audit gap 1): the mid boss's reward, per team
    that took one: `taken_s` (its first shard, `RejuvStatus` 4), `ends_s` (`RejuvStatus` 6,
    180 s on; past the recording if that ends first) and revives left, `[second, n]`, from the
    rules' `m_iAmberRejuvCount` / `m_iSapphireRejuvCount` (one per shard picked up, one less as
    a revive is used: the charge goes at the death, the revive message 3 s later). Events:
    `rejuv_taken` (at the mid boss), `rejuv_revive` (the hero, from the message's pawn) and
    `rejuv_expired`. On 129738985: Sapphire 31:12–34:12 (revives 32:10, 32:35), Amber
    39:54–42:54 (42:21, 42:27), 177 bytes.
  - **Vision** (`Player.seen`, format 4, 2026-11-09; docs/research/replay-vision.md): when the
    enemy team could see each hero on its minimap. Each `CCitadelTeam`'s `m_vecFOWEntities` is
    that team's own feed; a hero pawn's entry (`m_eClass` 1, `m_nEntIndex` the pawn, mapped to
    its controller through `m_hPawn`) carries `m_bVisibleOnMap`. Read every tick, field by
    field: boon's `replay_inputs::EnemyMinimap` also resolves Steam ids, which we never read.
    Per hero, `[start_ds, end_ds)` in tenths of a second, in order, hidden gaps under 0.5 s
    merged (`SEEN_MERGE_DS`; half of all gaps are under a second, flicker), a glimpse under a
    tenth kept as one. The validator checks each interval is non-empty, inside the match and
    at least the merge gap after the last. On 129738985: 2,052 intervals, 26.6 KB (+1.8%);
    nobody seen before 18.2 s, when the laners first meet; 73 of 74 deaths seen within a second
    of dying; each hero seen 34–45% of the match. Objectives carry their own flags in the same
    feed (not read yet; docs/backlog.md).
  - **Powerups:** available or taken per `powerup:` key at each second.
  - **Zipline colours** (`zips`, 2026-11-08, replacing the trooper-front estimate): the game
    networks each rope node's owner (`CCitadelZipLineNode.m_iTeamNum`, exploration round 4),
    and along a lane it is always one Amber run, a bare gap, one Sapphire run. Each node's `t`
    is the board's own projection onto the lane curve (ported from `web/src/map/lanes.ts`, with
    a shared golden test; the nodes sit on our curves to 0.0 units). Per lane the timeline keeps
    `[second, amber_t, sapphire_t]` wherever an edge moves: Amber's edge is its furthest node
    (0 if none), Sapphire's its nearest (1000 if none). On 129738985 that is ~1,200 changes a
    lane, 53.6 KB, and every second matches the probe's.
  - **Camps** (`camps`, 2026-11-08): the game rules' neutral camp timers
    (`m_vecNeutralCampNextSpawnTimes`, −1 up, T > 0 back at match-clock T; exploration round 3),
    read every tick. Each timer's slot is matched to our camp (or, flagged as the mid boss, the
    mid boss) site **by its origin**, never by index. Per site: the first spawn second and the
    `[cleared_s, respawn_s]` intervals. The recording's first tick reads −1 everywhere before
    the first spawn times arrive; an "up" shorter than a second is that, not a spawn. On
    129738985: 52 sites, 227 clears, 5.6 KB, matching the probe's timeline.
  - **Healing pickups** (`heals`, format 5, 2026-11-09; docs/research/map-objectives-audit.md):
    the camps' shape, per `heal:` site: first up, then `[taken_s, back_s]`. Every
    `CCitadel_Pickup_Health` is read every tick; a map pickup is one entity all match, up at its
    spawner and `m_bActive` false while taken, and the class also drops elsewhere from a pool, so
    a site takes only the entities that only ever come up on it. A take the recording ends inside
    is back on the map's 180 s. On 129738985: 36 sites, up at 150 s, 6 takes each back 180 to
    181 s later, 2.2 KB (128 bytes gzipped).
  - **Tough crates** (`crates`, format 7, 2026-11-09; the Heavy boxes): the heals' shape, per
    `tough_crate:` site: first up, then `[broken_s, back_s]`, from the same code. Every
    `CCitadel_BreakableProp` whose `m_nSubclassID` is the tough crate's token (MurmurHash2 of
    `citadel_breakable_prop_tough_crate`) is read every tick: one entity per crate all match,
    created when its spawn group comes up and inactive while broken. The token, not the place:
    a wooden crate sits 11 units from one. A break the recording ends inside is back on 180 s.
    On 129738985: 78 sites, up at 180 s (64), 300 s (8) and 600 s (6), 232 breaks over 64 crates,
    231 back 180 s later and one 300 s, 7.7 KB of the 1.54 MB.
  - **Respawns** (`Player.respawn`, 2026-11-08, both tiers): `[died_s, back_s]` per death.
    Replay: the second the hero is next seen alive, else (the recording ends first) the pawn's
    `m_flRespawnTime`, last read while dead (exploration round 5: the two agree to 0.1 s in 70
    of 71 respawns on 129738985; the one that came back early, and the one whose timer dropped,
    were Sapphire heroes dead as Sapphire's Patron lost its first stage, which shortens respawn
    timers (operator, 2026-11-08); here by 20 s, for that team's dead only). Metadata: `game_time_s + death_duration_s + 1`, so the
    countdown ends on the path's first sample back.
  - **The Soul Urn** (`urn`, 2026-11-08, exploration round 6): read every tick. On the ground
    it is a `CCitadelItemPickupIdol`; picked up, that entity goes and the open delivery point
    (`CCitadelIdolReturnTrigger`, `m_bDisabled` false) takes the carrier's team in
    `m_iTeamNum`; dropped, a new idol appears where it fell; delivered, the point closes. The
    carrier is the carrying team's living hero nearest where the urn lay (on 129738985, all 11
    drops and deliveries put that hero within 570 units of the event). The timeline keeps
    the spawns (second and `urn:` site), the state per second it changes (`ground` at x, y;
    `carried` by team and slot; `none`), the open point, and `urn_pickup`, `urn_drop`,
    `urn_delivered` events. On 129738985: 7 spawns every 300 s from 10:00, alternating west and
    east, 50 states, 22 events (11 pick-ups, 4 drops, 7 deliveries).
    The urn also moves on its own after it has lain a while (operator, 2026-11-08: 700 units
    over 28:13–28:28 on 129738985, nobody holding it): that's the game's, recorded as more
    `ground` places with no team or carrier. The carrier is only inferred at a pick-up, for
    the run up to the next drop or delivery.
  - **Builds, casts, status effects, height** (format 7, 2026-11-09; docs/research/
    abilities-and-items.md, status-effects.md, elevation.md). **Stored, not shown**: the operator
    holds the UI until it can be done without clutter. Per player, all slot-keyed, every id the
    game's CUtlStringToken (`timeline::token`, MurmurHash2 of the lower-cased internal name) as
    it appears; names and icons come later from the pack. `_ds` is tenths of a second; `src` is
    the causing hero's index in `players`, `NO_HERO` (255) when it wasn't a hero.
    - `items` `[t_ds, item_id, kind]`: user message 309 (`AbilitiesChanged`, slot + 1 is the
      controller). A sale is real (`ITEM_SOLD`) when message 360 (`ItemPurchaseNotification`,
      `sell`) for the item lands within 0.25 s; else a component used up by a buy of the same
      hero within 0.1 s (`ITEM_MERGED`); else `ITEM_REMOVED`. The build at t is the buys minus
      the rest. On 129738985: 239 bought, 25 sold, 71 merged, 0 removed; every merge is a
      component of what was bought with it, and no sale is (checked against boon-data's catalog).
    - `abilities` `[second, ability_id, level]`: the controller's `m_vecAbilityUpgradeState`,
      once a second; level = popcount of `m_nUpgradeInfo` bits 16–19 (1 unlocked, 2–4 tiers
      1–3). 190 changes, 4 abilities each.
    - `casts` `[t_ds, ability_id, cooldown_end_ds]`: every message 365 (abilities and active
      items, 2227), the ult events unchanged beside them. The end is the ability entity's
      `m_flCooldownEnd` (owner pawn and `m_nSubclassID`, read every tenth of a second for up to
      1.5 s after the cast), 0 if it didn't show (2107 of 2227 have it). Cooldown at t is
      client-side: no per-second percentages. `charges` `[t_ds, ability_id, n]` where
      `m_iRemainingCharges` changes on an ability or item the hero bought, levelled or cast.
      The worker decodes every class with a cooldown, a subclass and an owner for this.
    - `cc` `[start_ds, end_ds, state, src, ability_id]`: the pawn's `m_bvEnabledStateMask` bits
      in `CC_STATES` (immobilized, disarmed, muted, silenced, stunned, dash disabled, shooting
      disabled, asleep, cubed), the source the enemy-hero modifier applied within 0.15 s of
      its start, preferring one whose definition sets that state (`modifiers::CC_MODIFIERS`),
      then one with an ability. 124 stuns, 109 attributed.
    - `effects` `[start_ds, end_ds, effect_id, src, ability_id, stacks]`: the `ActiveModifiers`
      table's modifiers on heroes whose token is in `modifiers::ICON_MODIFIERS`, the ones the
      game shows an icon for, applied to removed (or the recording's end), with the most stacks
      reached. 4170 intervals. The token lists are generated from boon-data's catalog by
      tools/modifier-tokens/gen.py (token ids only); a modifier a later patch adds isn't stored
      until they're regenerated.
    - `recaps` `{t, damage: [src, ability_id, damage], cc}`: per lethal hit (message 300,
      `victim_health_new` 0; another within 3 s is the same death), the damage taken in the 10 s
      before by source and ability, most first, and the `cc` rows overlapping that window. 78.
      A source that isn't a hero is `256 + kind` when msg 300's attacker class is known
      (trooper, medic or melee trooper, guardian, walker, base guardian, patron, mid boss,
      neutral camp, Sinner's Sacrifice, sentry turret; timeline.rs `NPC_KINDS`), else 255. Added
      without a FORMAT bump (2026-11-11, feedback #20): an older format-9 timeline or app writes
      255 there and still reads as "World / other"; the server must be deployed before an app
      that writes kinds. Player names each as the game does ("Trooper", "Walker", "Sinner's
      Sacrifice", citadel_main), and an ability with only an engine name shows its parent's name,
      else "Weapon" or "Ability". A death pairs with the latest lethal hit up to 1.5 s before its
      sampled second (deaths are read once a second).
    - `height` `[second, level]` (0 level, 1 above, 2 below): the hero's own team's
      `m_vecFOWEntities` `m_eHeight`, held 2 s; level before the first entry. `zipline`
      `[from_s, to_s)`: the pawn's `m_eZipLineLaneColor` non-zero, held 2 s. Alive seconds:
      75.5% level, 15.0% above, 9.5% below, 8.1% on a zipline.
    - The metadata tier fills `items` and `abilities` from the match's `items[]`: a buy at
      `game_time_s`, `ITEM_REMOVED` at `sold_time_s` (the summary can't tell a sale from a
      merge), and an entry with `upgrade_info` as an ability at its level. Whether the API's
      `item_id` is the demo's token is unconfirmed (no untrimmed payload checked yet).
    - The server's checks bound each list's length, keep its times in the match and in order,
      ids non-zero, sources a player of the match, states and levels known, stacks, charges,
      cooldowns and damage capped (`timeline::extras_ok`).
  - **Format stamp** (`mapcro_replay::timeline::FORMAT`, the one constant the worker and the
    server share): each worker timeline carries `format` (1 from respawns and the urn; 2 buff
    types and rift openings; 3 the Rejuvenator and rift capture; 4 vision; 5 healing pickups; 6
    the clock holding through a pause; 7 builds, casts, status effects, height and the tough
    crates; 8 each hero's level, max HP, kills and assists; 9 statue pickups; 0 before). Format 3 adds 4.2 KB to 129738985's 1.50 MB; format 4, 26.6 KB (1,501,758
    to 1,528,328 bytes); format 7, 304 KB for the hero data (1,530,253 to 1,834,572 bytes; 577 to
    657 KB gzipped), effects 160 KB and casts 53 KB of it, plus 7.7 KB for the crates. The
    timeline routes answer gzip or zstd to a client that accepts it. New fields are optional, so
    older cached timelines still load without them.
    - **A fetched timeline in an older format** (2026-11-08), for a match inside Valve's three
      weeks, is fetched and parsed again when an editor opens the match: the same line, caps and
      fairness as any fetch on open. The old one is served meanwhile; the job's status (fetching,
      queued, parsing) shows instead of `done`, so Player watches it, its chip reading
      "Updating replay…", and swaps the new timeline in place when it's done. Once a match,
      whatever comes of it (kept in memory: a restart allows one more try). A failed refetch
      leaves the old one `done`. Past the three weeks the old one stays.
    - **An upload in an older format** stays: its demo went with its parse, so nothing can parse
      it again. Its status says `"stale": true`; Player then offers "Upload replay file" on the
      full replay, and the chip's hint says it's an older parse. A new upload replaces it.
  - **PVS gaps:** a demo records only entities near players. Powerups with nothing in the
    recording hold their last value, and the timeline lists those seconds as stale. Zipline
    colours and camp timers are networked whatever anyone sees. An objective counts as
    destroyed only when its health is seen to fall and nothing on its site is seen alive after.
  - **Deaths** follow the pawn's life state, except a revive in place: a hero back alive within
    5 s and 2,500 units of where it fell didn't die (129738985 had four such 3 s gaps, which the
    metadata doesn't count either; real respawns take ≥ 10 s and start at the base).
- **The game clock:** `(tick + server_start_tick − paused ticks) × tick interval −
  m_flGameStartTime`, until the game rules name a winner. Checked against the metadata of match
  122134063: deaths and objectives within a second, the same 890 s duration. The exploration's
  formula, without `server_start_tick`, ran 48 s early.
- **Save as scene** also writes each player's ult cooldown, the rift that's up (rifts default
  off), taken powerups (they default available), cleared camps (and the mid boss, down until its
  respawn) and a `Wave` per lane. A scene has one split per lane, so the zipline colours' two
  edges become their midpoint, `round((amber_t + sapphire_t) / 2)`: the middle of the bare gap,
  the contested ground (decided 2026-11-08; the gap's width is lost).
- **Preview while scrubbing:** ult rings beside each hero in the panel, the rift, powerup and
  camp states on the map, and the zipline colours; local only, like the rest of the preview.
- **Keys:** the worker keys sites by its built-in map (`web/src/map/fallback-data.ts`), the
  metadata by Valve's lanes, and a pack can key the same site differently (the dev pack's
  patrons are `lane3`, its mid boss `lane4`, its camps numbered by lane, where the built-in map
  has `lane0`). The client resolves a timeline key to the board's marker
  (`match/timeline.ts`, `markerKey`): the key itself, else the marker of the same kind on the
  built-in site's spot, else for the patron and mid boss the same kind and team.

### The replay worker: isolation and limits

Parsing untrusted files happens in a separate process on a shared production box, never in the
board server (`MemoryMax=256M`; a 480 MB demo's pages alone exceed it).

- **`mapcro-replay`** (`crates/replay`, boon 0.19.0 pinned and vendored with a streamed reader,
  MIT, `crates/vendor/VENDORED.md`) runs as its own systemd service
  in the same NixOS module, as its own user. It has no network (`PrivateNetwork`,
  `RestrictAddressFamilies=none`, `IPAddressDeny=any`), sees nothing of `/var/lib` but its
  queue, can't see other processes, and has a full systemd sandbox (no capabilities, a system
  call filter, `MemoryDenyWriteExecute`, `LimitFSIZE` at the demo cap).
- **Caps** (2026-11-08, journal 2026-11-08-replay-capacity): `REPLAY_WORKERS` jobs at once
  (2), each in its own child process under its own 300 s wall clock; `MemoryMax` 384M a job
  (768M) with no swap, `CPUQuota` a core a job (200%) at a low CPU weight and idle I/O. A child
  killed at the memory cap fails its job as `too_large` (`OOMPolicy=continue`), one past its
  clock as `timeout`; the
  worker and the other jobs carry on. The next job is the first the server's order lists
  (`inbox/.order`, below), else the oldest.
- **Measured** on this machine, release build, the real 504 MB demo of 129738985 (2026-11-08, format 6): 5.3 s, 26 MB
  anonymous plus 484 MB of the memory-mapped demo's clean pages. Those are reclaimable: under a
  transient cgroup's cap the parse still succeeds, at 96M in 6.1 s, at 64M in 6.2 s (+18%), at
  32M in 7.0 s, never OOM-killed. From zstd (356 MB), uncapped 6.3 s with an 849 MB peak (both
  files' page cache), at 128M 8.9 s. A zstd window adds at most 128 MiB anonymous
  (`window_log_max(27)`). So a parse costs a core and ~33 MB at format 9 (below); the 384M a job is headroom for a
  window and a page cache that doesn't thrash. **Re-measured 2026-11-11** at format 9
  (docs/research/parser-memory.md): 48 MB anonymous before the parser-memory change, 32.5 MB
  after, and a parse completes under a 36M cap (40M killed it before); 13–15 s on a loaded box.
  The worker's record now carries the child's anonymous peak (`peak_anon_bytes`, beside VmHWM,
  which counts the mapped pages) and a zstd download's window (`zstd_window_bytes`, from the
  frame header). The 384M stays until a real CDN download's window has been read from those. On `web` (3 cores, ~2.9 GB available), 2 at once
  leaves a core and ~2 GB to the rest of the box.
- **The parse is streamed** (2026-11-11, docs/research/parser-memory.md "Streamed"): the child
  reads the demo front to back through a bounded buffer (boon's vendored `StreamParser`), with
  no memory map, so a demo changed under it is a parse failure, not a SIGBUS. A fetched `.bz2`
  or `.zst` decompresses straight into the parse under the 1 GiB cap: no expanded copy in
  `work/`, so a job writes ~2 MB (its timeline) where it wrote ~506 MB. A decoder error fails
  the job as `not_a_replay`, the cap as `too_large`. Measured on 129738985: the same timeline
  bytes as the mapped parse, the same wall time, 33 MB anonymous from a `.dem` (36 MB from
  zstd, 37 MB from bzip2), VmHWM 37–40 MB where it was ~540 MB, and a parse completes under a
  34M cap (the mapped one is killed there). The decompression has no phase of its own now
  (`decompress_s` is absent; it's in `parse_s`).
- **The queue** is `/var/lib/mapcro-replay` (`REPLAY_DIR`), group `mapcro-replay`, which the
  board server's user joins. Neither side can write where the other writes (security review
  2026-11-08, M1/M2):
  - `inbox/` (2750, the server's): complete, magic-checked files, written as `.<job>.part`
    with O_EXCL|O_NOFOLLOW and renamed in. The worker can only read it (and its unit mounts it
    read-only).
  - `outbox/` (2770, the worker's): `<job>.parsing` while it works, then `<job>.json` or
    `<job>.failed` (a reason code). The server reads results without following links and
    removes them.
  - `work/` (0700, the worker's alone): a result being written and its record.

  A job is `<match id>-<scope>`, where the scope is `cdn` or 16 hex digits of the board id's
  hash. The server deletes the demo when it collects the result, within a second, either way. A worker restarted
  mid-job (a deploy, a crash) puts the job back in the queue once, marked in `work/`
  (`<job>.requeued`); a job it was on when it went down a second time fails (`parse_failed`),
  so a demo that brings the worker down isn't tried for ever. The board server never parses: its health check doesn't depend
  on the worker, so a crashed worker can't fail a deploy.
- **The board server's side** (`crates/server/src/replays.rs`): it collects results every
  second, only for jobs it queued itself (a result for any other job is dropped, so a worker
  can't publish a timeline nobody asked for, nor one under the shared `cdn` scope for an
  upload), checks each against the timeline's shape and size, and caches it as
  `DATA_DIR/replays/<job>.json`. It drops jobs still queued after an hour (`timeout`) and
  partial transfers. A job being parsed is the worker's, under its own wall clock: its hour
  counts from when its parse was first seen, not from its arrival, so a long wait in the queue
  never deletes a demo under the parser. It keeps the cache under 1 GiB by dropping the oldest
  timelines.

### The queue (2026-11-08: a few dozen people uploading or fetching at once)

- **Budgets** (`REPLAY_*`, docs/deploy.md): the queue holds at most 8 GiB (`MAX_QUEUE_BYTES`)
  and 24 jobs (`MAX_QUEUED`): files queued or being parsed, transfers under way at their size,
  and turns given but not yet used. Fetched demos arrive compressed (~330 MB for 35 minutes),
  uploads raw (~500 MB), so that is 16 to 24 jobs, a few minutes of parsing. Expanded demos
  being parsed count too (≤ 1 GiB each), so the disk peak is about 10 GiB of the host's 32.
  Uploads stream 4 at once (one per client), downloads 2.
- **One line, fair.** A transfer that can't start yet waits in line, uploads and fetches
  alike: they share the parser. The line is round-robin across clients (the address key): a
  client's k-th job, counting the ones it already has further along, is in round k, rounds go
  in order and arrival within one (`crates/server/src/replay_queue.rs`). Walking that order,
  each takes its bytes and a job from the budget and a slot of its kind; one that only lacks a
  slot of its kind (or whose client is uploading already) is passed over, and one the budget
  can't hold stops the walk, so a large upload isn't starved by smaller ones behind it.
- **Uploads reserve first.** `POST …/reserve {"bytes": n}` answers `ready` (send now),
  `waiting` with `ahead`, or `done` when the board has the match's fetched replay already
  (nothing to send: it uses the `cdn` timeline). The client asks again every 2 s, which keeps
  its place; a place nobody asks about for 90 s lapses (`REPLAY_RESERVE_TTL_S`: a hidden tab's
  timers run about once a minute in Chrome), and `DELETE …/reserve` (Cancel) gives it up,
  a turn given while the Cancel's ask was under way included. A request that gets no answer
  is asked again after 2, 4 and 8 s before the wait ends as `offline`.
- **A turn must be used.** A turn given holds an upload slot and its bytes, so asking alone
  doesn't keep it: its upload must start within 75 s (`REPLAY_GRANT_USE_S`, past a hidden
  tab's minute), or it goes and the client starts over at the back. Every turn given counts
  against the client's 6 an hour (`REPLAY_PER_CLIENT_PER_HOUR`), used or not, and so does
  each place it holds waiting: a client can't ask for more turns than it may use. The upload
  then may not pass the size reserved. An upload without a reservation is taken only if its
  turn is free now (and that turn counts). A client may hold 4 places waiting; past 64 in
  line (`MAX_WAITING`) a new one is refused (`503 queue_full`, "Busy. Try again in a few
  minutes."): the last resort.
- **Fetches waiting are capped too.** A client may have 4 fetches waiting in line
  (`429 busy`), and the line's 64 holds for them as for uploads (`503 queue_full`); a fetch on
  open that can't join simply doesn't start. A fetch waiting is told when its download may
  start (no polling).
- **Parse order.** The collector writes the queued files' fair order to `inbox/.order` every
  second (server-written, worker-read, like the rest of the inbox); the worker runs them in it.
  A file the server knows nothing of (queued before a restart) is its own client, by age.
- **Position and wait.** `ahead` for a queued file is the jobs parsing plus those before it in
  the order. The estimate needs three recent samples (the last 20 kept): a parse that made a
  timeline (a refusal or a crash ends at once, and would make the wait look short), from the
  collector first seeing its marker to collecting it; a download, from its start to the file
  being queued. A queued job's wait is the rounds before it (`ahead` ÷ workers, plus its own)
  times the mean parse; a fetch in line adds its download's turn and the download. Player
  shows it as "~N min" (whole minutes, at least one).
- **Dedupe** stays: one `cdn` job per match for every board, and a board shows the `cdn`
  timeline when it has no upload of its own.

### Timelines parsed on the user's machine (2026-11-10, desktop plan Phase 1)

The desktop app (and later perhaps a wasm parse in the browser) parses the `.dem` locally with
`crates/replay` and sends only the timeline: ~1.8 MB raw / ~0.7 MB gzipped for 44 minutes,
against a 504 MB demo (docs/research/desktop-app.md §4). The server checks it and caches it;
it takes no queue slot and no parse (`crates/server/src/replays.rs` `client_timeline`).

- **Request:** `POST /api/boards/{board}/replays/{id}/timeline`, `Authorization: Bearer <board
  link token>` (owner or edit, as `/upload`), body the timeline JSON exactly as
  `mapcro-replay parse` writes it. `Content-Encoding: gzip` (or `x-gzip`) is decoded; none or
  `identity` is plain JSON; any other encoding is refused.
- **Checks, in order:** the editor's link; `{id}` a match id; the match not refused for its
  mode (`<id>.refused` from the metadata, as for uploads: a timeline carries no mode, so the
  client parser refuses Brawl and `old_map` itself, as the worker does); replays on; the body
  under its caps; then the format stamp before the shape, so an old app hears "update" rather
  than a shape error; then `timeline::validate` (the worker's checks) and `match_id == {id}`.
- **Limits:** the body as sent at most 4 MiB (`REPLAY_MAX_TIMELINE_BYTES`) when gzipped,
  checked against `Content-Length` and again while streaming; decoded, at most
  `timeline::MAX_BYTES` (6 MiB), stream-decoded with a hard stop (a gzip bomb stops there). A
  plain body's cap is the decoded one. No body bytes for 60 s (`REPLAY_IDLE_S`) ends it. Each
  client (the address key, across boards) may send 30 an hour
  (`REPLAY_TIMELINES_PER_CLIENT_PER_HOUR`), counted when sent, taken or refused (the check is
  the cost). It is its own count: demo uploads keep their 6.
- **Stored** as the board's own replay (`DATA_DIR/replays/<id>-<board hash>.json`), the same
  scope and visibility as an uploaded demo's timeline (this board and its clones), never `cdn`.
  It replaces the board's older timeline for the match. The server sets the timeline's
  `source` to `"client"` whatever was sent; the board's status then says
  `{"state": "done", "source": "upload", "client": true}` (`source` stays `upload`: it names
  the board's scope, which the client's logic keys on). Refused while the board's demo upload
  for the match is under way.
- **Answers** (errors are `{"error": code}`, plus `"message"` where the code alone doesn't say
  what to do):

  | Status | `error` | When |
  |---|---|---|
  | 200 | none: `{"state": "done", "source": "upload", "client": true}` | cached |
  | 401 | `link_required` | no or malformed token |
  | 403 | `not_this_board`, `view_only` | another board's link; a view link |
  | 404 | `no_board` | not a board id (an old server without the route answers 404 with no body) |
  | 400 | `bad_id` | `{id}` not a match id |
  | 400 | `bad_encoding` | the gzip doesn't decode |
  | 400 | `aborted` | the body broke off |
  | 408 | `timeout` | the body stalled |
  | 409 | `in_progress` | the board's demo upload for this match is queued or parsing |
  | 413 | `too_large` | over either cap |
  | 415 | `unsupported_encoding` | a `Content-Encoding` other than gzip or identity |
  | 422 | `brawl`, `unsupported_mode` | the match was refused for its mode |
  | 422 | `outdated_parser` | `format` below the server's `timeline::FORMAT`; message "Update the mapcro app" |
  | 422 | `newer_parser` | `format` above it (the app is ahead of the server); a message says try later |
  | 422 | `not_a_timeline` | not JSON, or fails the timeline checks |
  | 422 | `wrong_match` | its `match_id` isn't `{id}` |
  | 429 | `rate_limited` | the client's hour is used |
  | 503 | `replays_off` | the replay tier is off |

- **Counted** as a replay job with `source=client` (`replay_jobs`, `replay_job_s`): `done`, or
  the refusal's code as its outcome, and refusals in `failures` (`replay client <code> after
  <s> s`, no ids), so `just stats` shows them beside uploads. `rate_limited` counts as a queue
  refusal, as for uploads.

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
  and from a replay rifts, powerups, zipline colours and camps; ult rings sit in Player's
  top bar. No scene
  state (alive, seen, placed, objective, rift or wave records) shows through in Player, and none of
  Player's shows through in Sandbox. Switching modes, scenes or matches leaves nothing behind
  (operator report 2026-11-08: heroes drawn dark where the scene had them dead).
- **Lanes** on the replay tier take the game's zipline colours (2026-11-08): Amber's colour
  over `[0, amber_t]`, Sapphire's over `[sapphire_t, 1000]`, and the gap between drawn bare,
  as the board's own split gap (never narrower than it). The colour is captured ground: a node
  keeps it after the wave dies, so it isn't where the troopers are (the trooper-front split it
  replaces landed in the true gap only 52–56% of the time; exploration round 4). Metadata-tier
  matches have no lane data and show the default split. Sandbox keeps its one draggable split.
- **Camps** on the replay tier (2026-11-08): the map shows only each camp's state: up, cleared
  (the board's dimmed look) or not yet spawned (fainter). Hovering a camp, or tapping it on the
  phone, says "Respawns in m:ss" or "Spawns in m:ss"; up, it says nothing, and nothing counts
  down otherwise. The mid boss is the same, from its timer, and is down from its clear to its
  respawn.
- **The map's furniture** (2026-11-09, operator: "heal pickups should be maybe a toggleable
  thing because it might clutter the map … adding the shops and the teleporters are also a good
  idea"; docs/research/map-objectives-audit.md). Drawn in Sandbox and Player alike, never an
  objective: a click doesn't toggle one, a drag-select doesn't pick one, a scene has no state for
  one, and the lite map leaves them out.
  - **Shops** (8: three lane shops a team and the two secret shops) and **teleporters** (4 ends
    of 2 tunnels) are always on the map, with the game's minimap icons, and say nothing on hover
    (the label rule). In Player, a lane shop is gone once the guardian beside it falls, as in
    the game (operator, 2026-11-09: "only the 2 secret shops are still up on the map after all
    guardians are down"); the audit's "Shops" has the replay evidence. A board keeps all 8. Hovering a teleporter draws a faint dashed line to its pair's other end, and
    a ring on it.
  - **Heals:** the 36 healing pickups, behind a toolbar toggle beside Comments (under the map in
    Sandbox and Player), off by default. Your own is remembered in this browser (localStorage,
    every board); a follower draws its presenter's while following (§8, map layers). On the replay tier from format 5, a pickup is timed like a camp:
    down before it first comes up and while taken, "Respawns in m:ss" on hover, nothing while up.
  - **Heavy boxes** (2026-11-09, operator: "can we do heavy boxes like we did the bats? as a
    separate toggle too"): the 78 tough crates (`citadel_breakable_prop_tough_crate`; not the
    wooden crates, item containers or bells), behind their own toggle beside Heals, off by
    default, remembered and followed like Heals. The game's minimap doesn't draw crates and the pack
    has no icon for them, so they're our own small braced box. On the replay tier from format 7,
    a crate is timed like a heal: down before its spawn group comes up (3:00, 5:00 or 10:00) and
    while broken, "Spawns in" / "Respawns in m:ss" on hover, nothing while up.
  - A pack without them (extracted before 2026-11-09) borrows the built-in map's, and so does one without
    tough crates (every pack before the Heavy boxes).
- **Hover labels** (operator, 2026-11-08: "a label should pop up with the info, just like how a
  label instantly pops up when a neutral camp is hovered"): one label, one look, for everything
  on the map, Player and Sandbox alike (`map/HoverLabel.tsx`). It shows at once on hover (a tap
  on the phone), and goes on leave; nothing on the map uses the browser's delayed `title` any
  more, and each thing keeps an `aria-label`.
  - **Labels, not captions** (operator, 2026-11-09): a label is short, and only there when it
    says something a player can't see: a timer, an objective's health, or a name that is the
    news. An objective with health says its name and health, rounded, following the playback
    while hovered ("Walker 62%", "Guardian 100%", "Mid boss 45%"; operator 2026-11-09), from the
    replay's objective health in Player while Health is on; with no health known (Health off, the
    API summary, Sandbox, where the board sets none) or once it's down, nothing (the mid boss
    down: its timer). A camp that's up says nothing; a silent marker still takes the hover, so
    the wave handle under it doesn't label. No "(at m:ss)" suffix, and no buff effects (the
    events keep those).
  - A hero token says its player and hero ("Coach, Haze"; under Names off, the slot). It has no
    buttons (kill and vision live on its portrait's menu, below); a dead one wears the skull
    badge and an unseen one the eye-slash, as marks.
    The wave handle says "Wave", below any marker under it.
  - **Timers** (replay tier), all from the replay's own times (exploration round 7, timers
    audit):
    - camps and the mid boss (down): "Respawns in m:ss" / "Spawns in m:ss" (above); the mid boss adds
      a held Rejuvenator, "Archmother Rejuvenator: 2 revives, ends in 1:40", joined by " · ";
    - **rifts**: "Rift opens in …" until its cash-in opens (`live_s`,
      `m_timeKothCashInStarted`; the spawner's announcement comes 80 s earlier and the label
      already counts to the opening), "Rift opens at the other site in …"; open, "Fades in
      0:41" (format 3; the game's word, citadel_main `Citadel_HUD_KothTimeRanOut` "Rift Faded
      Away...", feedback #13), then "Captured by …". The game has no fixed rift schedule, and no
      next-rift field; the replay's own next opening is used;
    - **bridge buffs**: up, the buff's name ("Casting buff"); else "Buff respawns in …"
      ("spawns" before the site's first). Spawns every 300 s from 5:00 (misc.vdata
      `m_flInitialSpawnTime`, `m_flSpawnInterval`), as the replay shows;
    - **the urn**: its points as below; the urn on the ground "Urn returns in m:ss" once it has
      landed or been dropped (misc.vdata walk-back wait, 180 s; on 129738985 the 25:00 urn
      landed at 25:12.5 and set off at 28:13), then "Urn returning"; falling, just "Urn".
  - The API summary has no rift, buff, camp or urn times, so its markers say nothing.
- **The Rejuvenator on the top bar** (replay tier, format 3): under the holding team's souls,
  where the game's `#RejuvenatorCharges` sits, a `.GameClock`-style chip with the pack's
  `rejuv_crystal` (minimap icon; our own crystal without a pack), the revives left ("×2") and
  the time to its end, both eased (`easedNumber`), underlined in the team's colour.
  The All builds button (Hold Tab) sits under the Rejuvenator's column, never beside it, so the
  two don't meet at any bar width, phone included (feedback #22).
- **Rift capture rings** (replay tier, format 3, `player/Rift.tsx`): around the open rift, an
  outer ring for Amber and an inner one for Sapphire, each filled clockwise from the top to its
  team's capture progress over a dark track; between the 2 Hz samples it's their straight line,
  and a jump eases.
- **Bridge buffs** (replay tier, format 2): each powerup site, while its buff is up, is drawn
  with that buff's own minimap icon and wash (`hud_minimap.vcss` `.powerup_gun` (weapon)
  #FFCC80, `.powerup_survival` (health) #D7FF9A, `.powerup_casting` (magic) #E1A6FF,
  `.powerup_movement` #99FFDD; `data-buff` on the marker), and in its generic look otherwise.
  The type is the pickup's `m_nSubclassID` at the spawn (exploration round 7); the events name
  it: "Powerup up (west): Gun buff (+fire rate, +ammo)", "Powerup taken (west): Gun buff". The
  game's names (citadel_main_english); what each gives, from misc.vdata, short (the values grow
  with the match and aren't shown). The API summary has only per-player totals, so not there.
- **Respawn timers** (2026-11-08, both tiers): a dead hero's top-bar portrait shows the seconds
  to its respawn over the darkened portrait, as the HUD counts, from the timeline's
  `[died_s, back_s]` per death (replay: when the hero is next seen alive, else the pawn's
  `m_flRespawnTime`; metadata: `death_duration_s`). It follows t, so it ticks with playback and
  scrubs, and followers get it with t. A timeline without it shows none. The map shows nothing
  for a dead hero (its token stays hidden).
- **Top-bar portraits** (operator, 2026-11-08: "match how it looks in game"): each hero is the
  HUD's hero badge, `CitadelHeroBadge.TopBar` (`hero_badge.vcss`, `citadel_hud_top_bar*.vxml`),
  in Player and on the board's own bar alike (`board/HeroBadge.tsx`).
  - The art is the hero card, heroes.vdata `m_strIconHeroCard`
    (`panorama/images/heroes/<hero>_card_psd`, 280×380 for most, 240×320 for three), which the
    extractor exports as `topbar/heroes/<id>_card` (`card_blob` in pack.json).
  - `.HeroImageContainer` is 80% of the 88 px badge, 70.4, at the badge's top, which is the
    120 px `.HeroContents`' top. The card fills it at its own aspect (`scaling="contain"`,
    70.4 × 95.5) under the opacity mask `hero_image_mask_psd`, which is the card's size: open
    above, a half-disc below, so the head spills over the circle.
  - `.HeroImageBackground` is a 70.4 circle at the container's bottom (y 25.1 to 95.5) in
    `team1Color` / `team2Color`. `.SoulsValueContainer` (margin-top 76, padding-top 20) shows
    from under it, and the health bar stands at the circle's left (friendly) or right (enemy).
    The operator's screenshot puts the circle's centre at y 58–60, as this does.
  - Low health swaps the critical card into the same frame. Dead: `.Dead #HeroImage` saturation
    0, brightness 0.2, on an `offBlack&ee` disc; the respawn countdown sits over the disc.
  - The game doesn't fade a hero out of vision; Player doesn't either. The board's dimmed
    "not seen" portrait is the board's own vision toggle and stays.
  - **The portrait menu** (operator, 2026-11-09: "for controls we can move the kill and hide
    controls for heros to right clicking the hero portrait"). On the board, an editor's right
    click anywhere on a hero's top-bar column opens a small menu at the pointer
    (`ui/ContextMenu.tsx`): **Kill** / **Revive** (the action for the hero's state now; reviving
    clears its respawn timer in the same step), **Mark not seen** / **Mark in vision** (the
    vision toggle, worded as what it marks, after the top bar's own "In vision" / "Not seen"),
    **Show on the map** (an empty slot only: its portrait is then the picker, so this is its
    focus), **Rename…** (2026-11-09: the slot's name, typed under the portrait; empty gives the
    match's name back) and **Change hero…** (**Pick hero…** for an empty slot), which opens the
    picker. Focus goes
    to the first item; Up/Down wrap, Home/End, Enter or Space runs, Escape or Tab closes and
    hands focus back; a press outside, a resize or a lost window focus closes it. The labels
    follow edits made while it's open. Viewers get no menu. The tokens' eye and skull buttons
    are gone; K still kills or revives the hero under the pointer, and the top bar's eye toggle
    stays. Player has none.
  - **No side roster** (operator, 2026-11-09: "the roster in the top right is back, I don't
    think we need it there either"): neither Player (since 0a1948b) nor Scenes lists the roster
    in the side panel. The top bar has what it had: names and heroes, focus (a portrait click,
    or the menu's Show on the map), the hero picker (taken heroes disabled with who has them,
    and No hero), and the menu's Rename….
  - A pack without hero cards (any pack before 2026-11-08) keeps the vertical bust
    (`m_strTopBarVertical`, 70.4 × 117.3 with its bottom on a grey disc at y 15 to 85.4), and the
    critical card in its own frame there.
- **Calculated stats** (replay tier, operator 2026-11-10: "yes to all" on the stat-calc spike;
  `match/stats.ts`, `player/BuildColumn.tsx`; docs/research/stat-calc-spike.md "Production
  plan"). The Tab column shows max health, bullet and spirit resist, weapon damage % and spirit
  power, calculated from the hero's build at t (owned items, level, ability tiers, statue
  pickups) with the stat table of the replay's own patch from the pack (`crates/stats`, through
  WASM). They are passive-build values: active items, stacks and enemies' debuffs are left out;
  life-threshold items (Battle Vest, Hollow Point) count while the hero's health is at or above
  the threshold, and a dead hero counts as full. Health is truncated, the rest rounded, as the
  HUD does. The calculated max health replaces the recorded one, which refreshes only at a
  spawn; the recorded one is the fallback. A build with no table (older than 6711 or newer than
  the pack's sources) shows "—" ("Not recorded"); no other patch's numbers stand in. So does a
  timeline from before format 9: without statue pickups the values would run short. Hovers are
  the stats' names (§4b); each calculated value carries a quiet "≈" before the number (operator,
  2026-11-10; §4b rule 5), drawn by CSS so the text stays the number.
  With a pack that has tooltips, hovering a stat or an investment bar shows the stat panel
  instead (below, "Tooltips"), and the plain title gives way to it.
  - **Investment bars**: the souls in owned items per category, each at its tier price in the
    replay's patch (sold items and components used up by an upgrade don't count), fill along the
    patch's ladder (`m_MapModCostBonuses`, 800 to 28,800 souls): each row takes its
    `flPercentOnGraph` share of the bar (the shares sum to 100) and fills linearly from the row
    below's threshold, so the bar is full only at the top tier. Without the build's table, the
    pack's own patch's ladder. This rule is ours, read from the vdata; that the game's Tab bars
    fill the same way is on the backlog's in-game checks. Hovers: "Weapon invest", "Spirit
    invest", "Vitality invest".
- **Tooltips** (replay tier, 2026-11-11, feedback #7 and #9; docs/plans/2026-11-10-game-tooltips.md;
  `player/GameTooltip.tsx`, `player/StatPanel.tsx`, `match/tooltips.ts`). With a pack that has
  them (§12 "Tooltips"), hovering (a tap on touch, focus on the keyboard) shows the game's own
  tooltip beside the thing, one at a time; Escape, a press elsewhere or a scroll closes it.
  - Also on the events list (a major purchase's item, an ult's ability) and on the death
    recap's hit icons.
  - **Items** (the Tab column, the build order, the hero panel): the game's item tooltip
    (`citadel_tooltip_mod_details.vcss`): the category's torn-paper backer and header art, the
    name, "Owned" for an item the hero owns at t (else its cost), the innate stat lines, then each
    Passive / Active section with its cooldown, its description (the localisation's markup:
    highlights, inline attribute icons, `{s:Prop}` values), its property cards and rows, and
    "Upgrades From:" / "Upgrades To:" (the components, and the items that list it as one).
  - **Abilities** (the Tab column's four, and the ult indicator on the top bar): the ability
    tooltip (`citadel_ability_details_panel.vcss`): the name, the header cooldown, each section's
    description, cards and rows, and the three upgrade tiers, the bought ones marked. Values are
    shown with the bought tiers applied (`m_eUpgradeType`: added to the base unless it says to
    the scale or to multiply). A property that scales with spirit power (Djinn's Mark's ×0.35)
    shows the "×" factor, and its value at the hero's calculated spirit power with "≈"; without a
    calculated spirit power, the base value. A tier card's header is the tier's ability-point
    cost, 1 / 2 / 5, hard-coded (`TIER_COSTS`, operator 2026-11-11) from the reference
    screenshot: no file we read holds it.
  - **Values** are the replay's patch's where the pack has them: the overlay of the stat table
    the build reads (`tableKeyFor`; boon-data snapshots, 6711 onward), else the pack's own. The
    words are always the pack's localisation. Values recorded at t are the column's (cooldown
    left, charges); the tooltip itself is static data.
  - **Stat panels**: hovering an investment bar, or the stats under it, shows the game's WEAPON /
    VITALITY / SPIRIT STATS panel (`citadel_hero_stats_panels_shared.vcss`) beside its investment
    ladder (`citadel_tooltip_mod_bonus_display.vcss`): the title and words from the localisation,
    the calculated stats mapcro has (Weapon Damage; Max Health, Bullet and Spirit Resist; Spirit
    Power under Spirit Power Impact), each with "≈", and the patch's `m_MapModCostBonuses` rows
    with the row the hero's souls reach lit, the rows below dimmed as reached and above as not, and
    the bar filled as the column's. The game's other panel stats (fire rate, ammo, regen, move
    speed…) need rules mapcro doesn't have, so they aren't shown (backlog "Calculated stats").
  - Hover only (operator, 2026-11-11: no pinning for now); on touch a tap opens one and a tap
    elsewhere closes it.
  - Without a pack's tooltips, the plain titles stay (§4b tags).
- **Hero panel** (replay tier, 2026-11-11, feedback #8; `player/HeroCard.tsx`). A single click
  (press and release within 6 px) on a hero's token with the Select tool opens a compact panel at
  the map's lower left: the hero, and the Tab column's parts for it at t (K/D/A, investment bars,
  stats, abilities with cooldowns and charges, items), with their tooltips and stat panels.
  Several can be open, one per hero, up to every hero's (#37, operator 2026-11-11): another
  token opens its own a step down and right of the last (or brings its open one to the front),
  × closes that one, Escape the front one, and another match closes them all. Vision: in a team's
  view, a hero it can't see has no token, so no panel opens for it; an enemy that leaves sight
  while its panel is open keeps only what the Tab scoreboard shows (no cooldowns, charges or
  effects; `data-limited`). Followers get them (§8 "Panels").
- **Moving panels** (#35, #37; `player/panelPlace.ts`): the death recap on the map and each hero
  panel move by a drag of their top bar, with a mouse, pen or finger (pointer events; the bar
  takes the touch, so it never scrolls the page). A press on a hero panel brings it to the front.
  Where a panel sits is a place relative to the board pane: on each axis, the distance from the
  pane's nearer edge to the panel's edge on that side, as a share of the pane's width or height.
  Each screen draws it from that place and clamps it into its own pane, clear of the pane's own
  controls (the Map layers and Vision row: a band at the pane's top or bottom, whichever the
  control is nearer), its height capped to the room between them; so a screen of another size
  keeps the layout and never shows a panel off-screen or over its controls. The next death's
  recap opens where the last was left; another match puts it back.
- **The match source** (the bar's "Match …" disclosure) closes once the match this user's own
  Load asked for is in (loaded, or its replay parsed) and it offers nothing more for it, as a
  menu does after its choice; it opens upward over the toolbar's left end, which it covered.
  Only for their own Load: a match a presenter opened, one open on page load, or a slow Load's
  answer once another id is being typed leaves it as it is. A match with only the API summary,
  or a stale parse (an upload is offered), keeps it open on its upload, the next step; a refused
  id or a failed load leaves it open, its status saying why.
- **The Soul Urn** (replay tier, 2026-11-08): the urn drawn as the game's minimap draws it
  (`hud_minimap.vcss`, in the pack; operator, 2026-11-08: "match how the real map looks").
  - On the ground, `.idol_spawn`: `soul_jar_marker` in a 32 px box, a rift's box
    (`.capture_point`), with its soft `shardColor` shadow. A dropped urn is the same marker; the
    game has no dropped look.
  - Carried, `.held_idol_image`: the same art over the carrier's icon, offset 8 and 10 of its
    32 px to the lower right, with a white shadow and a 1.3 s pulse. The game sets the hero
    icon's size in code, so the held urn takes a hero token's size. There is no team colour;
    the carrier's icon shows whose it is.
  - On the ground it glides between the places the worker recorded (it drifts on its own after
    a while), with no carrier.
  - Its two delivery points are map markers (`urn:` sites, pack kind `urn`), dim unless open.
    The open one is lit (class `lit`), as the game's `.idol_return_friendly` is: the jar at
    48 px with three `soul_jar_marker_return_pulse` images washed cyan. They close in on it
    from 2.35× and hold at half opacity, 0.35 s apart. Under `prefers-reduced-motion`, one
    pulse at rest. A point turned on in Sandbox is lit the same way.
  - Hovering a point, or tapping it on the phone, says when the next urn spawns and where ("Urn
    spawns in m:ss", "Urn spawns at the other site in m:ss"), or "Urn delivery point" while
    it's open.
  - Pick-ups, drops and deliveries are events (the "Urn" filter) and ping where they happened.
  - Save scene keeps the open point. In Sandbox the points toggle like the rifts: off by
    default, one open at a time. The metadata tier has no urn.
- **The transport:** play and pause, speed (0.5×, 1×, 2×, 4×, 8×), a scrubber with a tick per
  event, ±10 s, the match clock, and the replay tier's toggles (Troopers, Health), with Pings.
  A tick hovered grows and shows its event's tag above it (the events list's short label, "Walker
  down", "Haze died"); a press jumps there as a row does (less the lead, with the ring). Ticks
  aren't in the tab order: ↑ ↓ step events from the keyboard (2026-11-11, feedback #6).
- **Names** (2026-11-08, operator: content creators hide usernames in videos): a transport toggle,
  shown when the timeline has players' names, on by default. Off, no player name is on screen
  (top bar, events and their search, tokens' hover titles; the hero or slot label stands in).
  It is this browser's alone: kept in localStorage for every board, never in presence, and a
  follower keeps its own (the one "Map layers" toggle that isn't followed, §8).
  - **In Scenes** (operator, 2026-11-09: "in the scene the player names are not showing"): a
    slot with no name of its own shows the open match's in-game name, as Player does: under its
    top-bar portrait, in the portrait's title and menu, and in its token's hover label. A scene
    saved from another match than the open one shows none. A name typed into the slot
    (Rename…) wins over the match's. Display only: nothing writes the match's names into the
    board, so Names off hides them in Scenes too. The heroes stay the board's roster (Save as
    scene sets them to the match's; a blank scene doesn't).
- **Vision** (2026-11-09, operator: "in a replay usually we can set it to only see the heroes …
  the current team could see"): a select in the map controls, "Vision: Hidden King [1] /
  Archmother [2] / All [3]", shown when the timeline has `seen` (format 4). Keys 1, 2, 3 pick
  Hidden King, Archmother and All (2026-11-11, feedback #10, #32: the teams read as team 1 and
  team 2), and each option shows its key (#29; the select's hover says "Vision [1 2 3]"); like
  the select they stop following, and they're off while typing or in a dialog or menu. The map
  controls (Map layers, Vision, Last seen, Flip map) sit at the map pane's bottom left, just
  above the dock's tools and timeline (feedback #33): the builds that holding Tab shows drop
  over the map's top and never cover them, and Map layers opens upward. In a team's
  view a mark at the map controls' right end (feedback #12) shows that team's name on a dot of
  its colour, with "Last seen" while the ghosts show; under All there is none. Flip sits in the
  same group, "Flip map" with a swap icon (feedback #17). In a team's view its own heroes always show;
  an enemy out of its sight isn't drawn, labelled or hoverable (2026-11-09, operator: a faded
  token "jumps around a lot"). Beside the select, in a team's view only, a "Show last seen
  location" toggle, off by default: on, an enemy out of sight is a ghost (the scene ghost's
  dashed ring and slashed eye, at 60% and desaturated) at its true position when last seen,
  its label ending "· Seen 0:12 ago", its health ring not drawn. Either way, one it hasn't
  seen yet, or not since that hero last died, isn't drawn. Leaving and coming back into sight
  eases the dimming (`--value-ease-ms`; reduced motion jumps); the token doesn't glide from its
  ghost spot to where it is, as the game's minimap doesn't. The urn on a carrier the view can't
  see now isn't drawn (operator 2026-11-09), ghost or not: it never follows a ghost; on the
  ground, delivered, or on a seen carrier it is as in All. On continuous playback (2026-11-09,
  operator: "a little smoother transition"), what vision shows and hides fades, out-expo over
  `--value-ease-ms` (board/fade.ts): an enemy coming into sight fades in; one leaving it fades
  out where it was last drawn, unhoverable and unlabelled, then goes; a ghost seen again
  elsewhere fades out on its spot as the hero fades in where it is; the carried urn goes and
  comes with its carrier the same way. A seek, scrub or jump, a change of view or of Show last
  seen location, a new match, or a frame over a second after the last snaps; so does reduced
  motion. What is drawn when is unchanged: only the going and coming. "All" is the map as before.
  Your own pair is remembered in this browser (localStorage, every board). **Following shows the
  presenter's** (2026-11-09, operator: "when following, it should show the vision setting of the
  presenter"): presence's `playback.vision` carries both (`team`: `Amber`, `Sapphire`, or null
  for All; `last_seen`), and a follower draws it, live, its controls showing the presenter's
  values. Stopping following brings the follower's own pair back untouched. Changing either
  control while following is a change to what you see, so it stops following (§8), and you keep
  everything you were seeing (the presenter's map layers too) with that one change. A presenter that sends no `vision` (an older
  client) leaves a follower on its own. Only the heroes, the urn and death skulls on the map follow
  it: the top bar, events, pings and troopers stay omniscient (docs/backlog.md).
- **Death skulls** (2026-11-09, operator: "show a little skull when a hero dies, that fades away
  quickly. to show the difference between dying and losing vision"): from each death until 2.5
  match seconds after (`SKULL_S`, player/skulls.ts), a small skull where the hero last stood
  alive: the dead badge's dark disc and skull, outlined and filled in the dead hero's team
  colour, about 60% of a token across, over the tokens and never taking the pointer (no hover: it is
  gone before one would help). Its opacity is the time since the death's, `1 − (age / 2.5)²`
  (it holds, then goes), so it is a function of playback time alone: a scrub or jump into the
  window shows it part faded, anywhere else none; a follower, at the presenter's time and
  Vision, draws the same; reduced motion changes nothing, as nothing animates. Match time, not
  wall time: 2.5 s at 1×, ~0.6 s at 4×, and a window wide enough to land in by scrubbing. In a
  team's Vision, its own heroes' deaths always show; an enemy's only if that team saw the hero at
  some moment in the second before it died (`seen` is in tenths and may close on the death tick
  or the one before, so "in sight at the instant" would drop deaths it watched). An enemy that
  merely goes out of sight fades as above and leaves no skull: that difference is the point. Both
  tiers: on the match-summary tier the spot is the path's last point before the death, so
  approximate, and there is no Vision there.
- **Keys while watching** (2026-11-08, operator): ↑ ↓ step to the previous and next event (its
  jump and ring), ← → seek 5 s (Shift: 30 s) and keep playing or paused, and a Space tap plays
  or pauses. A Space-drag still only pans, and nothing fires while typing. Viewing a scene, ← →
  step scenes instead. Space plays or pauses wherever the focus is (2026-11-11, feedback #11,
  #3: a clicked button, the scrubber, the speed or Vision list, a checkbox or a disclosure no
  longer takes it), except in a text field, a dialog or a menu (`core/keys.ts` `boardKeys`).
  Keyboard-only users press a focused button with Enter; Space on it plays or pauses.
  Holding Tab shows every build (All builds, as the game's scoreboard) wherever the focus is, in
  the same places (2026-11-11, feedback #24): plain Tab no longer moves focus through the board's
  controls, while Shift+Tab still does, and a text field, a dialog or a menu keeps its Tab.
  1, 2, 3 pick the Vision (below). The tools' keys and C / Shift+C (§4) work in Player as on a
  scene; T, a new scene, is a scene's key only (while watching, Save scene is the button).
- **Troopers** (replay tier, on by default): each lane trooper as a small dot in its team's
  colour with a dark rim, under the heroes, sliding between the 1 Hz samples and gone when it
  dies; like the map's icons it keeps its size on screen as you zoom. The game's files don't
  settle the minimap's trooper look (`hud_minimap.vcss` gives `.npc` only a position
  transition; the `npc_marker_*` icons are flat placeholder squares), so it's matched by eye.
  A captured rift's troopers (the timeline's `RIFT_TROOPER` bit) are drawn as the game draws
  them, bigger and darker (feedback #5): 1.6 times the dot, the game's model scale, in a darker
  shade of the team colour, tagged "Rift trooper" on hover; a follower sees the presenter's
  hover on one. At 8× with a follower the dots cost nothing measurable (perf-replay.spec.ts, 2026-11-08).
- **Event pings** (2026-11-08): while playback runs, each event it passes that the list shows
  under its filters and search gets a ring where it happened: a death on the victim's place,
  an objective on its icon, an ult on its hero. One ring per event, once, in the team's colour,
  1.5 s (1.06 s at 4×, 0.75 s at 8×); subtler than a jump's ring. Only a continuous forward run
  pings: a seek, scrub, jump, new match or mode switch, or five seconds without a frame (a tab
  back from the background), fires nothing for what it skipped. A follower pings from its own
  clock; it counts the presenter's jump when their playback isn't where their last one would be
  now, and never pings an event twice for a small correction back. "Pings" in the transport
  turns them off.
- **Events** (both tiers, each with what it has; `Event` in `crates/replay/src/timeline.rs`):
  deaths (who; the killer and the place when the data has them, else where the hero was last
  seen), objectives, mid boss kills, rifts up and captured, powerups up and taken (replay only, on
  seconds the spawner is in the recording; from format 2 with the buff), urn pick-ups, drops and deliveries (replay only,
  with the carrier), the Rejuvenator taken, each revive (with the hero) and its expiry (replay,
  format 3; the "Mid boss" filter), ult casts (replay only: a rise of the hero's ult
  cooldown, named by the game's `ImportantAbilityUsed` message, which covers every important
  ability, so it alone isn't an ult), and souls swings (the Amber-minus-Sapphire lead
  moving 5,000 within a minute and holding ten seconds on; none in the first two minutes, when
  starting souls arrive player by player). The sidebar lists them with their tier, searchable by
  hero, player name, type, team and time, with filter chips by type. **Jump** pauses at the event
  less a lead (5 s, adjustable) and pulses a ring where it happened; the list marks the event
  jumped to (not an earlier one the lead lands after) until playback passes the next listed
  event or you seek elsewhere (operator bug, 2026-11-08). **Save scenes** makes one
  scene per ticked event at its jump time, "<event> @ mm:ss", in one transaction (one undo).
- **Following** carries Player: presence's `playback` holds the mode, the match, t, playing and
  speed, the Vision pair (optional; above), the open panels (death recaps, builds and the popover
  open in one) and the events list's filters and search (§8), sent on every change and every 2 s while playing. It also holds the **jump** while it's
  pinned: the event's key in the list and the match time the jump landed at (the key at most 96
  bytes and the time a clock value, in the server's `is_valid`). A follower rings the same event
  at the same place and marks the same row; a new jump, or the presenter's seek back to the same
  one, rings again, and none (they seeked elsewhere) unpins the row (QA 2026-11-08). A follower adopts them, keeping its own
  clock while it is within 0.75 s of the presenter's. Changing your own playback, mode or match
  stops following, as changing the view does, and you keep what you were seeing (the
  presenter's layers and Vision) with that change.
- **Getting a replay in (operator, 2026-11-08: people can't find their replay files, and
  deadlock-api can't always fetch one).** Labels and short lines only.
  - **Where's my replay?** sits beside every upload (the landing's file controls, Player's
    Upload replay file), as steps through the game and Steam rather than a path; a browser
    can't open its file dialog anywhere in particular. 1. Download it in Deadlock: Match History
    → the match → Replay. 2. Steam: right-click Deadlock → Properties… → Installed Files →
    Browse…. 3. game → citadel → replays → `<match id>.dem`. The labels are the game's and
    Steam's own English strings (`Citadel_Profile_MatchHistory`, `Citadel_Replay_Download`,
    `AppProperties_LocalFilesPage`, `AppProperties_LocalFilesBrowse`). No OS paths (operator).
  - **Drop:** a `.dem` dropped anywhere on the landing, or on a board in Player while its match
    has no replay (the API summary, or no metadata at all), uploads it, behind an overlay while
    dragging. The file name gives the match id; another match's file is refused ("That file is
    match X, not Y"), and so is a file that isn't `.dem` or doesn't start as a demo does
    (`PBDEMS2\0`, read before uploading). A drop anywhere else is caught, so the tab never
    leaves the board to open the file.
  - **Linked replays folder (2026-11-10; `player/folder.ts`, `player/ReplaysFolder.tsx`):** on a
    browser with `showDirectoryPicker` (Chromium, secure context), a quiet **Link replays
    folder** beside the upload (Player's match source, its notice, the prompt). The directory
    handle is kept in IndexedDB (`mapcro-replays-folder`); a later visit reuses it, and when the
    browser wants a fresh OK, **Reconnect replays folder** asks on the click. While Player is
    shown it lists the folder on focus, when the tab is shown again and every 15 s: only
    `<digits>.dem` names are opened, newest first by `lastModified`; a file younger than 5 s
    waits (it may still be downloading). The open match's file shows **Upload <match> from
    your replays folder** (primary; Upload replay file steps down), which goes through the
    usual checks and upload. With no match open, up to three recent ids open their match.
    Nothing about the folder is sent or logged; a name leaves `folder.ts` only as its id. The
    UI reads only through `ReplaySource` (list by match id, read one), so a desktop bridge can
    plug in (lead, 2026-11-10).
    - **Limit:** Chromium's File System Access blocklist refuses Program Files (Windows) and
      `~/.local/share` (Linux) and their children, where Steam installs by default, so only a
      second Steam library can be linked. A cancelled or refused pick says "Browsers can't link
      Steam's default folder. Upload the file instead."; the plain file picker and the drop
      still open the default folder. Without the API nothing shows; the help's extra line
      (Chromium only) gives `…/steamapps/common/Deadlock/game/citadel/replays`.
  - **The Windows app (2026-11-10; `desktop/`, `player/desktop.ts`; desktop/README.md):** a
    Tauri 2 shell that loads the live site, one UI. In the app, the page's `ReplaySource` is the
    app's (`desktopSource`, feature-detected by `__TAURI_INTERNALS__.invoke`), and the linked
    folder's controls don't show. Nothing runs in the background: no watch, no notification, no
    tray (operator, 2026-11-10: discovery is part of the upload).
    - **Replay picker (operator, 2026-11-10; `player/ReplayPicker.tsx`, `player/picker.ts`;
      desktop app only, a browser keeps the file input, the drop and the linked folder):** the
      landing's **Select replay** (beside the match id), Player's **Upload replay** (match
      source and notice; **Select replay** with no match open) and the prompt's **Upload replay**
      open a dialog, "Replays", listing the folder's replays as cards: the open match's first
      ("This match"), then the latest match first by match id (ids rise over time; not by the file's
      time, which is when it was downloaded: operator, 2026-11-11), ten at a time (**More**). A file younger than 5 s
      isn't listed (it may be downloading). The folder is looked up and listed when the picker
      opens, on focus and every 5 s while it's open and shown; never while it's closed. Each
      card: the match id, when it was played ("Played 2 d ago", a date past a week) from the
      preview's `start_time`, else the file's time ("2 h ago", "Downloaded" on hover: the demo
      doesn't record a wall-clock start), the length ("34:12"), and, from the
      preview (§6a, asked once a card is in view, once per match for the tab: read from the demo
      by the app, which keeps it by the file's size and time across runs, else the server's; a
      server miss is asked again after a minute, ten for `not_found`), each team's name, its six heroes (the newest
      pack's minimap icons, the hero's name on hover), its kills ("Kills" on hover), its souls
      ("Souls") and **Win** on the winner's row. A mode the board doesn't take shows its name
      ("Street Brawl"). With no metadata: "Not recorded" and "—". A pick is the upload: parsed
      in the app, then its timeline sent. Another match's pick opens that match (attached)
      first, and isn't sent if it has its full replay or Valve's is on its way. A landing pick
      makes the board and hands the pick over (`handoff.ts` `local`); the board sends it and
      attaches the match. **Change folder** opens the system's folder chooser (never a file
      chooser) and the choice is kept for later runs; without one, the app uses Deadlock's own
      folder, found through Steam. "Replays folder not found" and "No replays" are its empty
      states. The file drop still works in the app.
    - **Upload:** the pick sends only the parsed timeline (gzip) to `POST …/replays/{id}/timeline`
      (§6a, Timelines parsed on the user's machine). Against a server without that route (a 404
      with no `{error}`), it sends the `.dem` as before.
    - **IPC:** six commands (list, read one, preview one, parse one, change the folder; and,
      portable only, whether an update is out), by match id, granted to the site's origin only.
    - **Installer or portable (operator, 2026-11-11; desktop/README.md):** the release carries the
      per-user installer and a portable zip (`--features portable`, fixed at build time). Portable
      registers `mapcro://` for the current user itself, and doesn't install updates: when the
      feed has a newer version the page shows **Update available**, a link to the release page.
    - **Download link:** "Get the Windows app" (the installer, by a stable name on GitHub
      Releases; "Portable", quieter, beside it) shows on Windows browsers only,
      never in the app. It sits beside Link replays folder, in "Where's my replay?" and in the
      landing's footer. It stays off until the first release (`WINDOWS_APP_RELEASED`). There is
      no Linux link yet (backlog).
    - **Board links (operator, 2026-11-11; desktop/README.md, Deep links):** a shared board
      opens in the app. `mapcro://b/<board>#<token>` is the canonical form: the share link (§11)
      with the scheme and host swapped, the token still in the fragment. The installer (per-user)
      and the Linux packages register the scheme; a link starts the app on that board, or the
      running app's window goes to it. Only a board id and token of the site's shapes are
      followed, and only to the board's page on the site; anything else is ignored. The link is
      never logged. On a board page in a browser, **Open in app** is that link (a quiet **Get the
      app** beside it, the installer, for a browser without the app), gated like the
      download link (a Windows browser, never in the app, `WINDOWS_APP_RELEASED`). In the app
      (no address bar), the landing's **Open link** field and **Ctrl+L** anywhere take a pasted
      share link, the site's or the `mapcro://` form; anything else reads "Not a board link". A
      board page whose fragment changes (the same board, another token) loads again.
    - **Linux (2026-11-10, branch `linux-desktop`):** the same app on WebKitGTK, built as an
      AppImage, a .deb and `nix build .#mapcro-desktop`; it behaves as on Windows. Gated on the
      e2e suite passing in WebKit (`just e2e-webkit`, operator). The NVIDIA blank-window
      workaround is desktop/README.md "Linux".
    - **Privacy:** the app reads only the Steam root (the registry key on Windows, fixed
      candidate paths on Linux), `libraryfolders.vdf`, Deadlock's one app manifest, the replays
      folder (or the one chosen with Change folder, whose path stays in the app) and its own
      config file, and nothing else. Previews carry heroes and scores, no names or ids. It never lists Steam's folders. It sends and logs nothing
      but match ids and reason codes: no paths, player names or account ids. It gets no replay
      salts in any form.
  - **Progress:** while the queue has no room, "Waiting for a slot · N ahead" (the file isn't
    sent until its turn, §6a The queue); then a bar with the percent and the size ("212 / 504
    MB", decimal MB), then the chip's "Queued · N ahead" and "Parsing replay…", then "Full
    replay". **Cancel** aborts it; the server drops the
    partial file (or gives up the place in line), and the board says "Upload cancelled." with
    the upload offered again. The
    board stays in use meanwhile (one upload at a time from a tab).
  - **From the landing:** a replay (picked or dropped) makes the board and opens it without a
    page load, handing it the file (`player/handoff.ts`, `core/nav.ts`): the upload runs on the
    board, which attaches the match once the server has the upload under way (past its first
    MiB), so no fetch from Valve starts. "Your boards" keeps it only once attached. Back from
    the board reloads.
  - **The full-replay prompt (operator-approved design and words, 2026-11-08;
    `player/ReplayPrompt.tsx`):** when Valve's replay can't come, a dialog over the map, the
    API summary playing behind it: "Full replay unavailable", a reason line, "The API summary
    has heroes, souls and events, but no troopers, health or camps.", **Try again**, **Upload
    replay file**, **Use API summary**, and Where's my replay?. Reasons: "Valve doesn't have
    the replay yet." (`no_replay`), "Valve keeps replays about 3 weeks, and this one has
    expired." (`expired`; no Try again), "Replay downloads are busy right now." (backoff, caps,
    full line), "deadlock-api is down right now.", "The download couldn't be read." (a fetched
    file that failed). An expired match asks on open, the rest when the fetch fails; until then
    the chip reads "Fetching replay…".
    - Only the tab that opened the match sees it (the landing's Open match or Player's Load, a
      tab-local mark in sessionStorage, so its reload asks again); others on the board, followers
      and viewers see the chip. Not over the join card.
    - Try again fetches again (the prompt returns if that fails); Upload is the usual upload;
      Use API summary (or Esc) closes it and is remembered for the match in this browser
      (localStorage). The "API summary" chip reopens it for the tab that opened the match
      ("Full replay unavailable: upload or try again"); for others it shows the hint.
    - The fetch failures it covers have no notice under the transport; uploads' and parses'
      failures keep theirs.
  - **Messages** (`player/notice.ts`), each an outcome and an action:
    - The match id isn't found (deadlock-api has no metadata yet): "Match not found yet." /
      "New matches can take a while to reach deadlock-api. Try again later.", with **Try
      again** and **Upload replay file**; the id stays in the field. The landing makes no board
      for it until a replay comes.
    - Loading the match while deadlock-api rate-limits or backs off: "Busy. Try again in a few
      minutes."; down: "deadlock-api is down. Try again later, or upload the replay file."
    - The parse's: "Not a replay. Pick the match's .dem file.", "Too large. …", "Corrupt.
      Download the replay again in Deadlock, then upload it.", "Timed out. Upload the replay
      again.", "Parse failed. …", "Old map. Only matches on the current map open.", "Brawl not
      supported. Open a standard match.", "Mode not supported. Open a standard match."
- **Annotation over playback (operator, 2026-11-08, decided):** you can annotate a live player,
  but to keep it you save it as a scene. Draw, arrows, comments, the laser and pings work in
  Player as ephemeral layers, cleared when the scene is saved or you leave Player.
- **Scenes and the match (operator, 2026-11-08).** On a board with a match the transport bar never
  goes: the map shows the match at t or a scene, and the bar says which and offers the way to the
  other.
  - **Watching the match:** play, ±10 s, speed, the scrubber, Save scene, and "Scenes" to view
    the current scene. Its top bar is the match's at t (portraits, souls and totals, ult rings
    on the replay tier, the dead, the clock), read-only; a tier without a field shows it
    untracked, never as a wrong value.
  - **Viewing a scene:** the bar stays, dimmed, reading `Scene "<name>" · m:ss` (the time only
    for a scene saved from this match). **▶ Play from here** (scenes saved from this match)
    copies the scene's drawings, with new ids and by silent edits, over the match's live layer,
    then plays the match from the scene's moment: the plan over what happened; heroes,
    objectives and waves are the match's, and Clear or edits there never touch the scene.
    **↩ Back to m:ss** returns to the match where it was, paused or playing as it was.
  - The scrubber marks each scene saved from this match (a diamond, unlike the event ticks):
    click to view it. Its row in the scene tree has a **▶ m:ss** chip that jumps the match there
    without leaving it; clicking the row views the scene.
  - ← → step scenes while viewing one. While watching, ↑ ↓ step events (with the jump's lead) and
    ← → seek (Keys while watching, above).
  - Followers follow the switch, the scene and the time. On the phone the bar sits above the
    scene nav. Boards without a match have no bar.
  - The jump ring follows the event's hero until the event, then stays on its place.
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
- **Hover (operator, 2026-11-08: "when following someone, when they hover a camp I don't see
  that hover info"):** presence carries `hover`, what the pointer is over on the map, as a key
  alone: `marker:<key>` or `token:<roster slot>[:vis|life]`, never an id or a name (at most 96
  bytes of `[A-Za-z0-9:_-]`). It's sent as it changes and cleared on leave. A follower shows the
  same hover label there, its rim and a dot in the presenter's colour, worded from the follower's
  own state: its playback time (mirrored) and its own Names toggle. The follower's own hover wins
  while it hovers something.
- **Follow mode:** anyone can follow a presenter's scene, floor and viewport (and in Player, their
  playback and Vision, §6b), their map layers and, in Player, their open panels (below). This is
  the coaching
  workflow (operator, 2026-11-06):
  - **Following is one click,** and the presenter's name is always visible to click.
  - **A follower who changes what they see stops following:** flipping a scene, panning, zooming or
    switching floor. There's no half-state. **They keep everything they were seeing, plus that
    one change** (operator 2026-11-11): the presenter's map layers and Vision stay on their
    screen, now their own. Stop following (the button), or the presenter leaving, is not a
    change to what you see: the follower's own layers and Vision come back.
  - **Presenters can't force or nudge anyone;** getting back in is just as easy.
  - **Anyone can follow anyone who holds edit rights** (owner or edit link), so there can be several
    presenters at once. View-only people can follow but can't be followed. Presence carries each
    person's role, and the server stamps it from their link, so it can't be forged.
  - **Map layers** (operator bug, 2026-11-11: "the follower doesn't see the same map layers"):
    presence's `layers` is one byte, a bit per "Map layers" toggle (wire.rs `LAYER_*`, each a
    registry row: lane
    troopers, health bars & arcs, event pings, crowd control, elevation & ziplines, healing
    pickups, heavy boxes). A follower draws the presenter's, its toggles showing them; Stop
    following, or the presenter leaving, brings its own back untouched. A follower's own toggle
    while following is a change to what it sees, so it stops following and keeps everything it
    saw (the presenter's layers and Vision) with that one change. A presenter that sends no `layers` (an
    older client) leaves a follower on its own. **Player names is the exception:** it stays each
    browser's own and is never in presence, as it is for recording without names (§6b "Names").
  - **Panels** (same bug: "doesn't see the death recap the presenter has open"): presence's
    `playback` carries the death recap open on the map (`skull_recap`: team, slot, the death's
    second), the events list's last opened recap still open (`event_recap`), the hero whose build
    the top bar has open (`inspect`), which of its Effects and Build order is open
    (`build_popover`, operator 2026-11-11), and whether every build is (`all_builds`: All builds
    or Tab held). Each is left out when closed, so a closed panel costs nothing in a frame resent on every
    cursor move. A follower opens and closes them as the presenter does; the map card goes by the
    follower's Vision (the presenter's while following) as it does for the presenter, so it never
    shows a death that team didn't see. Unlike the map, a panel is not "what you see" in §8's
    sense: a follower may open or close its own without stopping, and the presenter's next change
    wins: a change to any one of the panels applies all of them (one group), so a panel the
    follower closed opens again with it. Stopping leaves the panels as they are.
    **Where they sit, and the hero panels** (#35, #37, operator 2026-11-11): `playback` also
    carries the death recap's place once moved (`skull_place`, left out where it opens) and the
    hero panels open from the map, back to front, each with its place (`hero_panels`: team,
    slot, `at`). `hero_panels` is sent whenever `playback` is, `[]` for none: a presenter on an
    older build leaves it out, and its follower keeps its own hero panels. A place is
    `{ x, y, right?, bottom? }`, x and y in ten-thousandths of the pane from its left or right and
    top or bottom edge (§6b "Moving panels"), each at most 10,000; at most 12 hero panels (every
    hero's in a 6v6 match), each slot once, slots under 16 (`is_valid`; the client sends within
    them). A server reading a newer client's presence drops or clips what is past those bounds (a
    13th panel, a slot past 15, a hero twice, a place past 10,000) and relays the rest, rather
    than refusing the whole presence. Every hero's panel, moved, is under 1 KiB of a frame. A
    follower draws them at the presenter's places in its own pane, clamped there; a slot the
    match has no player in has no panel (and takes no Escape). They are in the panels group, so
    a follower's own open, close or move is its own until the presenter's next panel change, and
    doesn't stop following. What that next change does depends on what changed (lead
    2026-11-11): the presenter opening or closing a panel (any of the group's, the recaps and
    builds too) applies the whole group, as above; the presenter only moving a panel, or
    bringing one to the front, moves that panel only, in the follower's own panels that are the
    presenter's too. It opens and closes nothing, so a drag, sent at pointer rate, never undoes
    the follower's own panels, inspect or recap.
  - **The events list's filters and search** (operator 2026-11-11): presence's `playback`
    carries the filter chips that are on (`event_filters`, a bit per chip in the list's order,
    left out when none) and the search (`event_search`, at most 64 bytes, no control characters;
    the client clips what it sends, as the server closes a socket that sends more). A follower's
    list, and so its event pings, show the presenter's; like a panel, a follower may filter its
    own without stopping, and the presenter's next change to either wins; stopping keeps them.
  - **Each browser's own:** Player names, the sidebar tab (Events or Notes) and whether the Map
    layers popover is open (operator 2026-11-11: layout), the tool, ink colour, Comments toggle
    and jump lead. Not followed yet (docs/backlog.md): the events list's scroll and the teleporter
    pair's line.
  - **The view-state registry** (2026-11-11; plan: `docs/plans/2026-11-11-view-state-sync.md`):
    what following does with a piece of view state is declared, not wired per feature.
    `crates/engine/src/view_state.rs` has one row per key: whether a follower mirrors it, the
    presence field and bit that carry it, whether the follower's own value comes back on
    stopping, whether its own change stops the follow, its kind (on/off, a choice, a slot, a
    death, the open deaths, text with a byte bound), the group a presenter's change applies as,
    and whether another match resets it. `just ts` generates the rows into
    `web/src/gen/viewState.ts`, and the client's store (`web/src/player/viewstate.ts`) sends,
    mirrors and restores from them, and stops the follow itself on a follower's own change to a
    `stop` key. In it: the map layers, Vision and Last seen, the panels (both recaps, the
    inspected build and its popover, All builds, the hero panels and where the recap and they
    were moved), the events filters and search, and Player
    names (personal). Outside it by design: the board's scene, floor, viewport and hover
    (mirrored in Board.tsx, operator 2026-11-11), and the playback clock and the jump, which
    have apply logic of their own. Tests fail when a presence field, or a signal or `<details>`
    in Player, has no declared policy (`web/test/view-state-ledger.ts` lists the ones that
    aren't registry keys, with why); `web/e2e/follow-matrix.spec.ts` pins, per key, what a
    follower sees on following, after its own change, Stop following, the presenter leaving, a
    late join and a server restart (every key keeps following, by seat, below).
  - **Presence bytes are measured** (operator 2026-11-11): the server records each valid
    presence frame's size (`presence_bytes`, in `stats summary`), to decide from production
    numbers whether to send slow state (name, scene, playback, view state) apart from fast
    (cursor, laser, drag, ink). Until then, one frame carries all of it.
- **A follow survives a reconnect** (2026-11-11). Peer ids are per connection and start again
  with the server, so a server restart (every deploy) used to end every follow, and an old id
  could name someone else. Presence carries a **`seat`**: random per page load (at most 2^53 − 1,
  so a JavaScript number holds it), kept across reconnects, never derived from the name or
  anything else (sessions.md §6.1, which reuses it). A follower holds on to its presenter's seat
  and finds them by it: on the same join, by peer id unless that peer now has another seat;
  otherwise the newest editor with the seat, never itself. Missing, it keeps what it shows and
  waits: up to 20 s after its own reconnect (everyone is coming back; reconnect backoff reaches
  15 s), up to 5 s after the presenter's connection alone went (its own reconnect). Then
  "Presenter left", as before. A peer id from an earlier join is never trusted, and meanwhile
  the follower's presence says it follows nobody. A presenter with no seat (an older tab) is
  found by peer only, on the same join. A seat is not authority: copying one is as easy as
  copying a name. A reload is a new page, so a new seat: its followers are told it left.
  "Follow again" follows the seat it was on, not whoever holds that peer id now. The seat is
  the same on every board a page opens (by design, sessions.md §6.1), so someone in two of
  those boards can tell it is the same person in both, for that page load.
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
  transaction would be applied again. So does pruning a client's heard rejections: its last
  decided transaction may have been a refusal, and the prune deletes the only record of it. A cold load replays from the base. Catch-up is served from
  the oldest kept entry on; a hello from below that is rebased (§5). The new base doubles as the
  fresh-join snapshot. Stored rejections are already pruned as soon as their client has heard them.
  - So a board's history no longer grows without bound. What's kept is at most ~12,000 entries
    (and ~15 MiB at the default quota), plus the base, whatever the board's age.
  - Version history and a retention window aren't built: compaction keeps only the tail.
  - The floor (below it, a rebase) only rises. When the keep budget covers every row, it stays
    just below the oldest row still kept.
  - Compaction is housekeeping after a committed batch. If it fails, the error is logged and the
    room carries on (the history caps backstop it), retrying after another tenth of the interval.
- **Migrations are atomic per step.** Each schema step and its version bump are one transaction,
  and steps that create tables say IF NOT EXISTS, so a crash mid-migration leaves the database at
  one version or the next.
- **Rollbacks: the compatibility floor.** Beside `schema_version`, `meta` keeps `compat_floor`,
  the oldest server version that can safely open the database. Each step sets it in the same
  transaction: an additive step (only things an older server never reads) keeps the floor, any
  other raises it to the new version. A server older than the database opens it when its own
  version is at least the floor, with a warning, and leaves version and floor alone; migrations
  never run backwards. Below the floor, or with no floor recorded, it refuses to start. v6 (the
  metrics tables) is additive, floor 5; the steps before it predate the rule and raised it. The
  server deployed before v6 doesn't read the floor, so rolling back the deploy that first reaches
  v6 means restoring the pre-deploy copy (docs/deploy.md, Rollbacks and backups).
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

## 9a. Data retention

Agreed with the operator on 2026-11-10. **Policy, not built yet:** it is implemented when a stored
quantity nears its cap (the prod watcher's `plan:` alert, below), together with raising the caps
and moving bulk data to cheaper storage.

| Data | Rule |
| --- | --- |
| Boards (server) | Expire after **180 days with no opens**. A banner warns from day 150; any open resets the clock; Clone/export keeps a copy. |
| Boards (browser) | The user's own IndexedDB; we only ask for persistent storage. |
| Replay timelines, match metadata | Dropped **90 days after last opened**, within the replay cache's 1 GiB cap. Kept while a live board uses the match. Valve keeps replays about three weeks, so an older one can't be fetched again. |
| Replay files (`.dem`) | Deleted as soon as they are parsed (already so). |
| Metrics | Minutes 7 days, hourly rollups 400 days, failures 30 days or 1,000 rows (already so; unlinkable counts). |
| Server logs | journald capped at 30 days; no IPs in mapcro's own logs. |
| Feedback | Becomes a GitHub issue (the form says so); deleted or redacted on request. |

Players' in-game names come from Valve's match data and stay as shown. A short privacy note in the
footer says all of this, with a way to ask for a board's deletion.

**When to build:** the prod watcher (`tools/prod-watch/watch.py`) opens a `plan:<limit>` alert
when a stored quantity (disk, database, boards stored) passes 60% of its cap, or its 7-day
growth puts it at the cap within 30 days; `limit:` at 85% stays the urgent one. Check `just stats
limits` after each deploy.

## 10. Schema versioning and migrations

- The board snapshot, the transaction format and the wire protocol each carry a version.
- **Migrations** are ordered pure functions `vN → vN+1`, applied to snapshots, and to queued ops
  where an op shape changed. They are tested with fixtures from every past version, which are
  checked in.
- The server migrates a stored board lazily on first load. It keeps the pre-migration snapshot, so
  a bad migration is reversible.
- The database's own schema (`store.rs`, `SCHEMA_VERSION`) migrates forwards at start, one
  transaction a step, and records a compatibility floor so a rolled-back server can still open
  a database an additive step moved on (§9). Before a deploy that bumps it, copy
  `mapcro.sqlite` (docs/deploy.md).
- **Mixed versions are refused, not reconciled.** The server serves the web client. A client from
  another build gets `closed: outdated` at auth (§5). A client that can't parse a server message
  is treated the same way. Either way the session stops instead of retrying the same entry. The
  tab reloads once per build, guarded in sessionStorage. If it is still outdated after that, it
  shows "Update available" with a Reload button rather than looping. Its pending ops survive the reload,
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
  the person you're leaving out. The clone copies scenes and records and the board's matches
  (§11, Scope), not history, links or presence. The UI offers cloning, not revocation.
- **The owner sees and revokes everything.** Revocation stays in the API as an emergency backstop,
  for example for a link posted publicly. It isn't in the UI.
- **Revocation cascades:** revoking a link also revokes every link minted through it. A leaked edit
  link can then be cleaned up in one step, together with anything its holder handed out.
- View links can't mint.
- **Sessions** (several boards as tabs, [sessions.md](sessions.md), draft) delegate board access
  through grants that never exceed the adder's link, capped at edit (sessions.md §3).
- **"Your boards" (the landing's list, operator, 2026-11-11)** is the links this device holds
  (`core/device.ts`, localStorage), newest opened first. Each row shows the board's current title
  (freshened whenever the board is open here, so a rename by anyone shows), a match board's id
  beside a title it was given (not beside the default "Match <id>"), and two buttons, always
  shown (quiet until hovered on desktop, full strength on touch):
  - **Remove** takes the board off this device's list only, with an Undo toast. The board, its
    links and this device's other data for it (offline copy, colour, comments toggle, join) are
    untouched, and opening its link lists it again. Deleting a board is not built (backlog).
  - **Rename**, for a link the board last said can edit, opens the board with its title's
    editor open. Editors rename in the board's header too: click the title (`Title`, at most
    `max_title`), one undoable edit through the usual path, so it is live and works offline. A
    viewer gets no editor and no Rename. An empty name changes nothing.

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
| Malicious replay files | Parsed only by the sandboxed worker (§6a): no network, own user, only the queue in view, memory, CPU, file-size and wall-clock caps, two jobs at a time, each in its own child; its output is shape-checked before it's cached |

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
  `RosterName` alone. A player is a team, a slot and a hero. (Later: the timeline carries
  in-game names, shown by display only, never written to `RosterName`, which only Rename… sets.)

**Match import's replay tier (§6a): trust boundaries and limits.** For the security review:

- **Boundary 1, the HTTP edge → the board server.** Upload bodies are untrusted bytes. Only the
  upload route lifts the global 16 KiB body limit; it needs an owner or edit link to the board
  (`401` without, `403` for view links or other boards), and streams to
  `inbox/.<job>.part`, never into memory. Caps: 800 MiB per upload (`413`, by `Content-Length`
  up front and while streaming, and never past the size its reservation named), 60 s without a
  byte or 30 min in all (`408`), four uploads at once and one per client, 6 uploads per client
  address per hour (`429`; turns given count, used or not, and places waiting), a turn unused
  75 s after it's given lapses, at most 24 jobs and 8 GiB in the queue counting transfers in flight
  at their size; past those an upload waits in line for its turn (§6a, The queue: 4 places
  waiting per client, 64 in all, past which `503 queue_full`; fetches: 4 waiting per client
  (`429 busy`), within the same 64).
  The first 8 bytes must be `PBDEMS2\0` (`415 not_a_replay`); nothing else is read. A refused
  or broken upload leaves no file, a dropped connection included.
- **Boundary 2, upstreams → the board server.** deadlock-api's salts response is capped at
  64 KiB, and only `cluster_id` and `replay_salt`, as numbers, are taken from it: the CDN URL is
  built from them, so the response can't point the server anywhere else (no SSRF), and
  redirects aren't followed. The demo download streams to disk under an 800 MiB cap and a
  30 min timeout, and must start with bzip2, zstd or demo magic. Two downloads at once; more
  wait in line for a slot and the queue's room. deadlock-api paces fetches itself (a `429`
  backs off, §6a); a match whose fetch failed isn't fetched on open again for 6 h.
- **Boundary 3, the queue → the worker.** Everything in the inbox is hostile. The worker
  decompresses under a 1 GiB cap (bzip2 in Rust; zstd with a 128 MiB window limit) into the
  parse, streamed, in a child process inside the sandbox above. Its only outputs are files in its own `outbox/`; it
  can't write the inbox, so it can't plant a link the server would follow (M1).
- **Boundary 4, the worker → the board server.** The worker's output is untrusted too: at most
  6 MiB, deserialised into the typed timeline, and checked (array lengths match the duration,
  teams and keys have the pack's shape, numbers are in range, names are at most 32 characters
  and free of control characters, bidi overrides and `<>&"` (L3), the match id is the job's)
  before it is re-serialised into the cache. It's accepted only for a job the server queued
  (M2), read without following links. An unknown reason code reads as `parse_failed`.
- **Scope.** A demo carries no match id, so an upload's claim to be match N can't be checked:
  an uploaded timeline is served only to the board that uploaded it (and its clones, below), and
  a new upload replaces it. A timeline fetched from Valve by match id is shared by every board.
- **A clone keeps the matches (operator, 2026-11-09).** Clone copies the board's match list, and
  hard-links each uploaded timeline under the clone's own scope: the copy opens in Player on the
  same match at the same tier, with no fetch or parse. Either board's re-upload or the cache's trim
  replaces or removes only its own name (the trim counts a linked timeline's bytes once). Any link
  that can clone could already read those timelines, so a clone grants nothing new, and the
  clone's names carry only its own id's hash. An upload still in the queue isn't carried.
- **Privacy, as in v1:** the worker never reads Steam or account ids (`m_steamID` is not among
  the fields it resolves), so no timeline can hold one. In-game names are kept when the demo
  carries them. Demos are deleted when their parse ends; only the derived timeline is kept.
- **Caddy:** the edge must pass request bodies up to 800 MiB and not time a slow upload out
  first (docs/deploy.md).

No end-to-end encryption, unlike Excalidraw. E2EE would stop the server validating ops, which is
the reliability and security boundary above. Boards are game strategy, so server trust plus TLS is
the right trade-off. A dedicated security review gates public exposure.

## 11a. The feedback form

Operator, 2026-11-09: "a feedback button … asks for a title and a description and … creates an
issue in the Github repo." Code: `crates/server/src/feedback.rs`, `web/src/ui/Feedback.tsx`.

- **Where.** A "Feedback" button in the board's top bar beside Clone and Share, and a "Feedback"
  link in the landing's footer. Both are hidden unless `GET /api/feedback` answers
  `{"enabled": true}`, which it does only when the server has a token.
- **The dialog.** Title (required, 120 characters) and description (required, 5,000 characters,
  counted from 80%), the notice "This creates a public issue on GitHub (intendednull/mapcro).
  Don't include personal info or board links.", and Cancel and Send. Success says "Thanks —
  sent." and links the issue in a new tab. A failure keeps the text and offers "Try again"; a
  429 says when, from `Retry-After`. Its keyboard contract comes from `web/src/ui/modal.ts`, which
  other dialogs can reuse: it renders through a Portal, the rest of the page is `inert`, Tab and
  Shift+Tab wrap inside it, Escape closes it, focus goes back to the opener, and key presses
  don't reach the board's window listeners.
- **The match (operator, 2026-11-09: "maybe we should include the match id in the feedback
  issue?").** Opened from a board in Player with a match loaded, the dialog shows "Includes:
  match 134570618 at 9:02 (Full replay)" (or "(API summary)"), with a checkbox, ticked by
  default, and "Helps find the moment. Untick to leave it out of the issue." The match and time
  are read when the dialog opens, not as playback moves on. In the sandbox, from the landing, or
  with no match (or while another one loads) there's no line and nothing is sent.
- **`POST /api/feedback`** `{title, description, match?: {id, t_s, tier}}` → 201 `{url}`.
  `match` is absent (an older client, or the box unticked) or null for none; otherwise the
  server checks it strictly and refuses the whole submission with a 400 ("the match details
  aren't valid") rather than dropping it: `id` a string the match routes accept
  (`matches::valid_id`: 1–12 digits, no leading zero), `t_s` a whole number of seconds up to the
  timeline's `MAX_DURATION_S` (4 h), and `tier` exactly `"replay"` or `"summary"`. Other fields
  in it are ignored. The server trims both fields,
  drops control characters (a description keeps newlines and tabs, and CRLF becomes LF), and
  checks the lengths in characters itself. It then inserts zero-width joiners so the issue,
  opened under the operator's account, can't ping anyone or backlink into other repositories:
  after every `@` (`@user`, `@org/team`, `owner/repo@sha`), after a `#` that follows a name
  character (`owner/repo#123`; this repository's own `#123` stays a link), and inside every
  `github.com` (so no GitHub URL links or references). Then it calls GitHub's
  `POST /repos/{FEEDBACK_GITHUB_REPO}/issues` with `Authorization: Bearer`,
  `X-GitHub-Api-Version: 2022-11-28`, a User-Agent and a 10 s timeout. The body is the
  description, then `---`, then the server's own line for a match, "Match 134570618 at 9:02
  (full replay)" or "(API summary)" (m:ss, the minutes past 59 when a match runs over an
  hour), built from the checked values only, and "— Sent from the mapcro feedback form (build
  <BUILD_ID>)". The
  label is `feedback`; on a 422 it retries once without the label. Only an `https://` link is
  passed back. Answers: 400 invalid, 404 off, 429 limited, 502 GitHub failed (a clean message,
  never GitHub's). The body cap is 32 KiB, its own, since 5,000 four-byte characters are past
  the API's 16 KiB.
- **Privacy.** The issue holds the cleaned text and the footer only (with the match line when
  the sender leaves it in: a public match id, a time and a tier). No address, client key,
  board, link, name, account id or user agent goes into the issue, the log or the metrics, and
  the text is never logged. The token is read once from the file `FEEDBACK_GITHUB_TOKEN_FILE`
  names (a systemd credential, like `DEADLOCK_API_KEY_FILE`), and its `Debug` is redacted.
- **Abuse.** 100 issues an hour per client key (`api::client_key`: an IPv4 address or an IPv6
  /64) and 500 a day server-wide (raised from 3 and 30 on 2026-11-10, operator: testers hit the hourly cap), as sliding windows (`FEEDBACK_PER_CLIENT_PER_HOUR`,
  `FEEDBACK_GLOBAL_PER_DAY`). Past either, 429 with `Retry-After`. Only a submission that passes
  validation counts, and a GitHub failure still spends its slot, so a failing GitHub can't be
  hammered. The windows are in memory, so a restart empties them.
- **Off.** With no token file, or an unreadable or empty one, the form is off: a warning at start
  (naming neither value nor contents), `{"enabled": false}`, and 404 on POST. A malformed
  `FEEDBACK_GITHUB_REPO`, or a `FEEDBACK_GITHUB_API` that isn't https or localhost (the override
  exists for tests), stops the server at start.

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
- Items, abilities and status effects (modifiers) come from `scripts/abilities.vdata_c`,
  `scripts/modifiers.vdata_c` and the modifiers nested in `scripts/misc.vdata_c` (pickups, props)
  and `scripts/npc_units.vdata_c`. Item prices come from `scripts/generic_data.vdata_c`. All of it
  goes into one names table keyed by the token the replay timeline uses (below).
- Objectives, camps, rifts, ziplines and sentries come from the map entity lump.
- The world→minimap transform is fitted against extracted objectives. deadlock-api's hard-coded
  radius of 10752 has no in-game source.

**Asset pack** (content-addressed, so builds that change nothing share their blobs):

```
pack.json   schema, extractor version,
            game { client_version, source_revision, date },
            sources [{ vpk, path, crc32, size }],       the cheap "did anything change" key
            heroes [{ hero_id, class_name, name, dev_state, disabled,
                      minimap_blob, topbar_blob, card_blob, critical_blob,
                      abilities [4 tokens, slot 1 to 4; 0 unbound] }],
            map { id, transform, layers [] },
            entities [{ key, kind, team, lane, world [x, y, z], src {...} }],
            geometry_hash,
            abilities { blob, items, abilities, modifiers, icons, icons_missing }   (schema 4)
            stats { format, covered_through, builds, tables }        (optional, no bump)
            tooltips { format, blob, records, overlays }             (optional, no bump)
blobs/<sha256>.png
data/abilities.json   the names table, a blob of type application/json
data/stats/<key>.json         per-patch stat tables (§6b "Calculated stats")
data/tooltips.json            item and ability tooltips (below)
data/tooltips/<key>.json      a patch's tooltip values, keyed like the stat tables
tooltips/<path under panorama/images>.png|.svg   tooltip frames, property and inline icons
abilities/<path under panorama/images>.png|.svg   item, ability and modifier icons
```

**The names table** (`data/abilities.json`, pack schema 4) is `{"records": {"<token>": record}}`.
The token is the game's `CUtlStringToken`: MurmurHash2 of the lower-cased name, seed `0x31415926`,
the same as `mapcro_replay::timeline::token`. One table serves every id the timeline carries:
items, ability levels, casts, charges, hard-CC causes, status effects and their causes.

- **Records.**
  - An item or ability is a top-level record of `abilities.vdata`, keyed by its name. Records
    marked `_not_pickable` are base classes and are left out, since the compiled vdata already
    folds in what each record inherits.
  - A modifier is any object with `_class` and `_my_subclass_name` nested in a record, keyed by its
    qualified name: the record's name, then each subclass name on the way down, joined by `/`
    (`upgrade_toxic_bullets/modifier_item_bleeding_bullets_active/…`). A modifier is one whose
    `_class` contains `modifier`. Projectiles still add their names to the chain, but scale
    functions don't. `modifiers.vdata`'s own records keep their bare names, and so do a few engine
    modifiers listed by name.
- **Fields.**
  - Every record has `name`, `kind` (`item`, `ability` or `modifier`), `label` and `label_from`.
  - Items and abilities have `ability_type`.
  - Items also have `slot` (`weapon`, `vitality` or `spirit`), `tier`, `cost` (the tier's price),
    `components` (tokens) and `disabled`.
  - Modifiers have `ability`, the token of the record they're nested in, plus `hidden`,
    `icon_class` (the Panorama class of the game's small icon), `debuff` and `states` (the
    `MODIFIER_STATE_*` names of the enabled-state mask).
  - A record has `icon`, a blob key, when the pack carries its icon.
- **Display names** come from the English localisation, which is loose in the install. The VPK holds
  only a stub `items_english.txt`. The files are read in this lookup order:
  - `citadel_gc_mod_names` (items);
  - `citadel_heroes` (hero abilities and many modifiers);
  - `citadel_attributes` (generic modifiers such as stun);
  - `citadel_mods`;
  - `citadel_main`.

  A modifier is looked up by its `m_sLocalizationName`, else by its own name. Without a name of its
  own, it takes the localised name of the item or ability it's under (`label_from: ability`).
  Otherwise the label is the internal name with `upgrade_`, `ability_` or `modifier_` stripped
  (`label_from: internal`).
- **Icons.** An item's icon is `m_strAbilityImage`, else `m_strShopIconLarge`. A modifier's icon is
  its own `m_strHudIcon`; without one, the client shows the icon of its `ability`. `.psd` and `.png`
  sources are textures decoded to PNG, and `.svg` sources are SVGs. Only entries under
  `panorama/images/{hud/abilities,upgrades,items,hud/modifiers}/`, at most one folder deep, are
  read. The pack carries icons for:
  - items still in the shop;
  - playable heroes' four signature abilities;
  - modifiers with a HUD icon.

  Each source file is written once, however many records name it.
- **Client 6860:**
  - 257 items, 552 abilities and 2067 modifiers;
  - 383 records with an icon, from 318 files (316 PNG, 2 SVG) totalling 3.6 MB;
  - a 516 KB table, in a 21 MB pack.

  On 129738985, every one of the 57 cast names resolves, with an icon and a localised name. So do
  all 182 `ability_subclass` ids (179 of them on heroes). 476 of the 479 modifiers on heroes
  resolve, and 707 of the 711 overall. Six of the resolved ones are engine modifiers that no vdata
  defines, such as `modifier_citadel_tossup`. The extractor lists them by name
  (`abilities::ENGINE_MODIFIERS`). The other 3 are engine modifiers whose names we don't know.

**Tooltips** (`data/tooltips.json`, 2026-11-11; `crates/extract/src/tooltips.rs`; the
manifest's optional `tooltips` section, so no schema bump: schema 5 is still unused, and the
server serves older packs as before). `{"format": 1, "client_version", "strings", "icons",
"inline", "art", "records": {"<token>": {"tip", "values"}}}`:

- **Records**: every shop item and hero signature or ultimate ability of `abilities.vdata`.
  - An item's sections are its `m_vecTooltipSectionInfo` (`innate`, `passive`, `active`; a
    section with no type is `info`), each attribute a block: its description
    (`m_strLocString`), cards (`m_vecImportantAbilityProperties`) and rows
    (`m_vecAbilityProperties`, then `m_vecElevatedAbilityProperties`). A passive or active
    section's first `AbilityCooldown` or `ProcCooldown` row is its header's cooldown.
  - An ability's are its `m_AbilityTooltipDetails.m_vecAbilityInfoSections` (cards from
    `m_vecAbilityPropertiesBlock`, rows from `m_vecBasicProperties`; `requires` from
    `m_strAbilityPropertyUpgradeRequired`), its header `AbilityCooldown` plus
    `m_vecAdditionalHeaderProperties`, and its upgrade tiers (`m_vecAbilityUpgrades`, the text
    `<name>_t<n>_desc`, a non-additive bonus's `m_eUpgradeType`).
  - A record with no description of its own gets `<name>_desc`.
- **Properties**: `m_mapAbilityProperties` entries; label, prefix and postfix from the
  localisation's `<key>_label`, `_prefix`, `_postfix` (key: `m_strLocTokenOverride`, else the
  property name). One without a label, or `m_bIsHidden`, isn't shown; nor is a zero value
  (client). `css` is `m_strCSSClass`, `scale` a scale function's stat and `m_flStatScale`,
  `conditional` `ConditionallyApplied`, `negative` `m_bIsNegativeAttribute`. `aliases` maps a
  token override back to its property, for `{s:Override}` in the text.
- **Values** are kept apart from the layout: each property's `m_strValue` written as the game
  writes it (at most two decimals; `"40m"` → `"40"`), cut to what the tooltip shows or
  substitutes, and each tier's bonuses. `data/tooltips/<stat key>.json` holds, for each
  boon-data snapshot a stat table is built from, only what that patch changes (properties and
  tier bonuses); a key with no overlay reads the install's values. Descriptions stay unsubstituted,
  so a patch's values reach the text too.
- **Strings**: the chrome's localisation (`Citadel_Mod_Tooltip_Active`, `Citadel_Shop_Purchased`,
  `Citadel_ComponentRequired`, `CitadelHeroStats_*`, `Citadel_ModBonus_*`, `StatDesc_*`), and every
  `InlineAttribute_*`, keys lower-cased (the words of `{g:citadel_inline_attribute:'X'}`).
- **Icons and art**, from the game's own rules, not a mapping of ours: `icons` is
  `ability_property_icons.vcss`'s `.prop_<class>` rules (image and `wash-color`, the palette
  resolved from `citadel_base_styles.vcss`), `inline` its `.InlineAttributeIcon.<Name>` and
  `.InlineAttributeName.<Name>` (colour), `art` the fixed frames (`allow::TOOLTIP_ART`: the item
  backers and their masks, the category headers, the ability backer, the "Owned" check, the
  cooldown clock, the souls glyph, the stat panels' backgrounds, the ladder's star). The icon
  images the rules name are read only under `allow::TOOLTIP_ICON_DIRS`.
- **Client 6860**: 600 records, a 0.64 MB table (values trimmed), 27 overlays of up to 7 KB
  (6837's: 16 records), 62 images (8.2 MB, the category headers and backers most of it), in a
  40 MB pack.
- The tooltip and stat-panel styles ship as HUD sources (`hud/*.vcss`): the client's port
  (`web/src/styles/tooltips.css`) names each rule it follows.

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
3. **Anonymous storage:** decided 2026-11-10: idle boards expire after 180 days with no opens
   (§9a, built when the limits call for it). Per-IP limits on board creation: still open.
4. **Scenes:** is "a board is a sequence of scenes sharing one roster" the right model?
5. **Later:** the backup bucket. Decided: MIT licence; hosted at `https://mapcro.dmgdeadlock.com`
   (2026-11-07). The apex `dmgdeadlock.com` is a separate live site, so DNS for the subdomain
   only needs a new `A`/`AAAA` record pointing at the infra host, which must exist before the
   first deploy (ACME). Deploying still needs the operator's explicit OK at the time.
