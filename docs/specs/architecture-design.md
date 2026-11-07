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

## 5. Offline and reconnect

1. Connect. The socket's first frame is `auth { board, token, known_seq }`. The server answers
   `ready { role, base? }`, sending a base document only to a client that has none. Then the
   engine's `hello { client, last_seq, pending_from }`, where `pending_from` is the client's oldest
   unacknowledged cseq.
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
     outbox (4096 frames, 1 MiB) bounds only how far behind *live* traffic a client may fall before it is
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
at about 20 Hz; the server coalesces them per room and relays.

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
  to rebuild the document and keeps none of them. The base document isn't held either; a fresh
  client's comes from storage. A loaded room costs its document plus its client and connection
  tables. (Measured: a room over 8 MB of history grew the server by 3.5 MB, against 11.6 MB when
  it held the log.)
- **Durable before ack.** A transaction is committed to `ops` before the client hears "accepted".
  Commits are grouped per event-loop tick, so throughput doesn't cost durability.
- **Snapshots:** after 500 ops, or when a room goes idle, the server writes a full snapshot.
  Ops older than the retention window (30 days, tunable) are pruned down to the snapshot boundary.
- **Tombstones:** deleted ids stay tombstoned while the retention window lasts, so offline clients
  can still rebase against them. A client whose `lastSeq` is older than the pruned boundary gets a
  full snapshot and a rebase instead of a diff.
- **Version history comes from the log for free.** Any board can be viewed or restored at a past
  seq inside the retention window. A restore is a new transaction, so it can be undone.
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
- **Not yet built:** snapshots and compaction. A load currently replays the full log; that is fine
  for boards within the caps below (measured: the largest documents' 54 MB of history loads in
  about a third of a second). Compaction needs a protocol addition: a replica far
  behind must rebase its pending work onto a fresh base. That change goes into the model first.
- **Until then, history is capped (interim, security review 2026-11-07, C1).** Without compaction
  the op log is the board's whole history, and one anonymous client could grow it until a cold
  load ran the server out of memory. The caps, each overridable by environment variable:

  | Cap | Default | Env | Why this number |
  |---|---|---|---|
  | Transaction size (JSON) | 64 KiB | (schema `Limits::max_tx_bytes`) | Twice the largest legal op: an undo of a full note carries 4000 chars twice, at most 4 bytes each, about 32 KB. A test builds the worst ops and checks the bound |
  | WebSocket frame | 65 KiB | (derived) | `max_tx_bytes` plus 1 KiB for the frame around it. A tx just over the limit gets a typed `TxTooLarge`; only frames no honest client sends close the socket. Was 256 KiB |
  | Transactions per board | 100,000 | `BOARD_MAX_OPS` | Was 20,000. History is now on disk only, so this bounds disk and cold-load time, not memory. 100,000 is many coaching sessions of honest edits (notes save on blur) |
  | History bytes per board (as stored) | 20 MiB | `BOARD_MAX_BYTES` | Was 4 MiB of JSON. Counted compressed: a realistic edit stores at ~107 bytes (288 as JSON), so 100,000 realistic edits take ~11 MB and the op cap binds first. Adversarial history (60 KB of random text per edit) fills it at ~35 MB of JSON, 22 MB on disk |
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
  capped at 4096 frames and 1 MiB (small frames meet the frame cap first), so a peer that stops
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
| Hosting abusive content | No user uploads at all; text only, with caps. Asset packs are placed in the data directory by the server operator, never through HTTP |

**Address rotation (IPv6 /64), accepted.** Per-address limits key on an IPv4 address or an IPv6
/64, and someone with a routed /56 or /48 holds many /64s. That is left as is (security review
2026-11-07, M-A): the global caps bound the damage whatever the address count. Creation is capped
per hour server-wide, total boards and database size are capped, each board's history is capped,
and memory is capped by the open-room limit and the room memory budget. Rotation lets one party use up those shared budgets
faster, so its cost is availability (new boards refused, joins `busy`), never a crash or a full
disk. Widening the key to /56 would penalise everyone behind a shared prefix; revisit with
proof-of-work or accounts if rotation is seen in practice.

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
- **Faults:** socket drops, tab reloads (the session is thrown away and rebuilt from its
  IndexedDB; saves not yet started die with the tab), offline bursts that keep editing, a late
  joiner from scratch on a large log, and the server `kill -9`'d and restarted mid-run.
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
