**Date:** 2026-11-06
**Status:** draft for the operator's review. No code exists yet.
**Research:** [sync and collab boards](../research/sync-and-collab-boards.md) · [Deadlock assets and extraction](../research/deadlock-assets-and-extraction.md)

# mapcro: architecture and state

mapcro is a shared Deadlock minimap for macro coaching. People place the 12 heroes, toggle
objectives, draw rotations, add callouts and notes, and step through scenarios. A board is shared
by link, either to watch or to edit live. It works offline and saves locally. A small server on
the operator's infra relays edits and stores shared boards. Game art comes only from the user's
own install.

The design goal is reliability: an edit the UI calls *saved* is never lost, every client converges
on the same board, and a bad client cannot corrupt a board for anyone else.

## 1. What changes from the prototype

| Prototype | mapcro | Why |
|---|---|---|
| One JSON blob, replaced wholesale on every change; undo = whole-state clones | A board is a set of typed **records** changed by small **ops** | Ops can be merged, validated, replayed, synced and undone per user |
| Players are array indices 0–11, objectives keyed by API ids | Every record has a stable random id. Heroes are referenced by game `hero_id`, objectives by semantic keys (§12) | Survives reorders, concurrent edits and game updates |
| Positions in 0–1 minimap space of build 6851 | Positions in **world units** (game coordinates); the asset pack supplies the world→minimap transform | A minimap texture or crop change no longer moves every token |
| Hard-coded guard: build 6851 only | Boards record the build they were made on; any asset pack renders them, with placeholders for missing entities | Game updates degrade gracefully instead of breaking boards |
| Coordinates and hero list from deadlock-api.com, art from the install | Everything from the install, through one extractor | One source of truth, matched to the user's build |
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
whether notes are collaborative enough to justify this. See Q4.)*

## 4. Client state

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

1. Connect: `hello { boardId, capability, clientId, protocolVersion, schemaVersion, lastSeq }`.
2. The server sends the ops after `lastSeq`. If they are already compacted, it sends a snapshot.
3. The client rebases pending transactions and resends them. The server deduplicates by
   `(clientId, clientSeq)`, so a transaction whose ack was lost is never applied twice.
4. Reconnect uses exponential backoff with jitter. A heartbeat detects dead sockets in about 10 s.

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

- **Undo** writes the before-value for each field that still holds your after-value. If someone else
  changed a field since, undo skips it rather than clobbering their edit. Undo is itself a normal
  transaction.
- Undoing a delete recreates the record with its original id (the server allows recreating an id
  it has tombstoned).
- Redo is symmetric. The stack lives per tab, survives reconnect, and is cleared on scene reset or
  when a migration reloads the board.

## 8. Presence

Presence is ephemeral and never enters the op log. Each entry carries a display name and colour
(chosen once, kept locally), the cursor in world coordinates (so it is right in either viewpoint),
selection, the current scene, the floor, and any in-progress drag preview. The client sends updates
at about 20 Hz; the server coalesces them per room and relays.

- Viewers appear in the people list, and their cursors show. Their presence is rate-limited like
  everyone else's and is the only thing a view session may send.
- **Follow mode:** a viewer can follow a presenter's scene, floor and viewport. This is the coaching
  workflow. "Everyone follow me" is a request that each viewer accepts locally, not a forced state.
- Presence timeout: 30 s without a heartbeat removes the entry.

## 9. Persistence, snapshots and backups

- **Storage:** SQLite in WAL mode, on the server's state directory.
  - `boards`: id, schema version, head seq, latest snapshot and the seq it covers
  - `ops`: board id, seq, client id, client seq, transaction JSON, time. Append-only.
  - `links`: token hash, board id, role, label, created, revoked
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
  *(Target bucket: Q6.)*
- **Room lifecycle:** a room loads on its first connection and unloads after 5 minutes with no
  connections, once a final snapshot is written. A graceful shutdown flushes every room.

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
returns the owner capability, which is stored on the creator's device and is the only way to mint
or revoke links. There are no accounts. Accounts can later bind owner capabilities to a person.

- Tokens are 256-bit random, base64url. The server stores only SHA-256(token), so a database leak
  yields no usable links.
- **URL shape:** `https://<domain>/b/<boardId>#<token>`. The token sits in the fragment, so it never
  reaches server logs, proxies or `Referer` headers. The client sends it inside the WebSocket
  `hello`, never in a query string.
- **Revocation** is instant: revoking a link closes its live sessions. Each link has a label
  ("team scrim, edit"), so the owner can see what they handed out.
- **Server-side enforcement on every message.** A view session's ops are rejected. Edit sessions are
  schema-validated and rate-limited. Owner operations need the owner token.

**Attack surface and controls** (the public server is the exposure):

| Threat | Control |
|---|---|
| Guessing links | 256-bit tokens; board ids alone grant nothing |
| Link leakage | Fragment tokens, `Referrer-Policy: no-referrer`, revocation, labels |
| Malicious edit-link holder | Typed op validation, per-record and per-board size caps, per-session op rate limit, owner restores from version history |
| Cross-site WebSocket hijacking | `Origin` allow-list on upgrade; no cookies, so no ambient authority |
| XSS via names, notes, callouts | All user text rendered as text, never HTML; strict CSP; no user-supplied URLs or images |
| Storage spam (anonymous board creation) | Per-IP creation rate limit, max board size, idle-board expiry (Q5) |
| Room flooding | Max sessions per room, presence rate limit, message size cap |
| Hosting abusive content | No uploads at all in v1; text only, with caps |

No end-to-end encryption, unlike Excalidraw. E2EE would stop the server validating ops, which is
the reliability and security boundary above. Boards are game strategy, so server trust plus TLS is
the right trade-off. A dedicated security review gates public exposure.

## 12. Game assets and the extraction pipeline

**Rule: Valve's files never reach the repo, the server, a share link or an export.** They exist only
in the user's browser storage, extracted from their own install. Boards carry only ids and world
coordinates. (Every other Deadlock tool we found hosts Valve art. This is mapcro's deliberate
difference; see the [extraction research](../research/deadlock-assets-and-extraction.md).)

**One Rust extraction core, with two front ends.**

1. **In-browser extractor (primary), compiled to WASM.** The user picks their
   `Deadlock/game/citadel` folder. Chromium uses `showDirectoryPicker` and keeps the handle, so
   re-checking after a game update takes one click. Firefox and Safari use `<input webkitdirectory>`.
   The extractor opens only allow-listed paths: the folder also holds account-id files, which are
   never read. It reads the 8.4 MB VPK directory, then just the needed byte ranges from the 33 GB of
   chunks, about 15–20 MB in all. Nothing is uploaded.
2. **`mapcro-extract` CLI**, a native build of the same core. It is for headless use, debugging
   and Proton paths. It writes the same pack file, which the browser imports.

**Formats.** The minimap layers and hero portraits are uncompressed BGRA textures, which are easy.
Hero data and map entities are binary KV3 inside Source 2 resource containers, and no Rust or JS
library reads those yet. We port the needed parts of ValveResourceFormat (MIT, credited) to Rust.
VRF's own CLI is our **test oracle**: a local check runs both against the real install and diffs
the output. CI only ever uses synthetic VPK fixtures our tests generate.

**What the extractor derives from the install**, so deadlock-api is no longer needed:

- Heroes come from `scripts/heroes.vdata_c` (id, development state, minimap image), with names
  from the localisation files.
- Objectives, camps, rifts, ziplines and sentries come from the map entity lump, by classname.
- The world→minimap transform comes from the pack. deadlock-api hard-codes a radius of 10752 with
  no in-game source, so we fit it against extracted objectives and keep it in the pack.

**Asset pack** (local only, content-addressed, so builds that change nothing share their blobs):

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

**How boards reference the game.**

- Positions are world coordinates.
- Heroes are referenced by `hero_id`.
- Objectives use a **semantic key**, such as `walker:amber:lane2`. The raw entity id is kept as
  evidence, not identity.
- Each board records the `client_version` and `geometry_hash` it was authored on.

When a board opens with a different pack:

- Keys resolve first. Failing that, an entity of the same kind within a tolerance matches.
- Anything moved or orphaned is **shown** to the user, never silently re-snapped.
- A full map rework (6711 was one) makes the board read "authored for an earlier map".

**Version tracking.**

- The server polls Steam's public `GetClientVersion` endpoint, which needs no key and carries no
  art, and tells clients the live build.
- The client compares the live build with its pack's `client_version`. On a mismatch, it re-reads
  `steam.inf` and the source CRCs. Most builds change no map art, so a re-extract is usually a
  no-op (6851 → 6860 left the minimap byte-identical).

**Without a pack** (phone viewers, people without the game), the board renders on a neutral
background with placeholder glyphs and hero names. Whether that background is a blank grid or
original art we draw ourselves is Q3.

**Legal posture:**

- Steam's agreement allows non-commercial fan use of game content, and it forbids redistribution
  and reverse engineering.
- Extracting on the user's own machine keeps redistribution off our servers, but the decoding
  still happens on the user's machine.
- mapcro stays non-commercial: no ads and no paid tiers.
- It carries a clear "not affiliated with Valve" notice.

This is a risk posture, not legal advice.

## 13. Code and deploy shape

The app is TypeScript end to end (npm workspaces, Nix flake dev shell), and the extractor is Rust. The deciding reason: the
authority code must run in **both** the server and the browser (§6), and so must the schema and the
migrations. One language means there is one implementation of each, not two kept in step. *(Q1 asks
whether you'd rather have a Rust core.)*

```
packages/schema    records, ops, invariants, migrations: pure, no I/O
packages/engine    authority (validate, sequence, apply), client replica (confirmed/pending/rebase),
                   undo, text OT, presence model: pure and deterministic
apps/server        Node 24: HTTP + WebSocket (ws), SQLite (better-sqlite3), rooms, links, limits
apps/web           Vite + React UI; SVG map renderer; IndexedDB store; asset-pack loader
crates/extract     Rust extraction core → WASM (browser) and the `mapcro-extract` CLI (§12)
design/            Paseo design-canvas collections for UI iteration
```

**Server process:** one Node process serves the built web client, `/api` (create a board, mint or
revoke links, import), `/ws` (sync and presence) and `/healthz`. Each board is an in-memory room
owned by that process. Ops for a board are applied one at a time, so the server has no concurrency
races to reason about. Config comes from env (`PORT`, `DATA_DIR`, `PUBLIC_ORIGIN`). It fails fast on
bad config and logs to stdout.

**Infra:** the infra `node` template gives a `runtime = "systemd"` registry app behind Caddy, which
proxies WebSockets without extra config, with the SQLite database in the unit's `StateDirectory`. The
backup replication runs as a timer and service declared by mapcro's own NixOS module, with
object-storage credentials passed by path through sops. Domain, port and backup target are
deployment-time decisions (Q6). Nothing deploys without your OK at the time.

**Scale assumption:** one box, tens of concurrent rooms, under 50 people per room. Several
processes or boxes would need room-to-process affinity; nothing in the model prevents that later.

## 14. Testing reliability

- **Deterministic sync simulation (the core gate).** A seeded harness runs one authority and N
  replicas over a fake network that delays, reorders, duplicates and drops messages, and
  disconnects clients at random. It generates random transactions, undos and offline periods. At
  quiescence, it asserts that every replica equals the authority, that every acknowledged
  transaction appears exactly once, that no pending work vanished (it either landed or became an
  offline copy), and that invariants hold. Any failure replays from its seed.
- **Crash durability.** A real server with real SQLite is `kill -9`'d mid-stream and restarted. The
  test asserts that every acknowledged transaction survived.
- **Migrations:** checked-in fixtures from every schema version must load and round-trip.
- **Security:** view tokens can't write, revoked tokens are disconnected, cross-origin upgrades are
  refused, and oversized or malformed messages are rejected. These run against the real server.
- **End to end:** Playwright with two browser contexts on one board, including `setOffline`,
  reload with pending edits, and follow mode.
- **Extraction:** CI runs against synthetic VPK fixtures generated by our own test code. No Valve
  data is involved. A local-only check runs against the real install.

## 15. Open questions for the operator

1. **Language.** The recommendation is TypeScript for the app and server, so that one copy of the
   schema, authority and migrations runs in both places, plus Rust for the extractor. The
   alternative is a Rust core compiled to WASM for the app too, which brings typestate and enums
   end to end at the cost of a WASM boundary on every op and slower UI iteration.
2. **Extractor order.** The recommendation is browser-first (Rust → WASM), with VRF's CLI used only
   as a test oracle. The quicker alternative for v1 is a CLI that wraps VRF, like the prototype,
   whose output pack is imported into the browser, with the WASM extractor following later.
3. **Board view without a pack** (phones, people without the game): a neutral grid with
   placeholders, or original schematic map art we draw ourselves and commit (lanes and landmarks,
   SimpleRadar-style)? The art is real work, but it makes shared links useful to everyone.
4. **Notes.** Do scene notes need real simultaneous typing, with the text OT in §3? Or is
   last-writer-wins plus a "someone else is editing" indicator enough for v1?
5. **Anonymous storage.** Should idle boards expire, for example after 180 days with no opens? And
   are per-IP limits on board creation acceptable?
6. **Deploy details** (needed later, not now): the domain (`mapcro.intendednull.com`?), the backup
   target (Hetzner Object Storage or another bucket), and the licence (MIT or AGPL) before the first
   push.
7. **Scenes.** Is "a board is a sequence of scenes sharing one roster" the right model? Or should
   each saved scenario be its own board?
