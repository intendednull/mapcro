# Research: sync models and collaborative boards

**Date:** 2026-11-06 · **Question:** which sync model and library should mapcro use for a small,
structured, link-shared board that must not lose edits? · **Used by:** [architecture spec](../specs/architecture-design.md)

Versions come from the npm registry and crates.io, checked on 2026-11-06, unless another source is cited.

## 1. tldraw sync

| Aspect | Finding |
|---|---|
| Version | `@tldraw/sync-core` / `@tldraw/sync` **5.6.0**, released 2026-10-28 ([npm](https://www.npmjs.com/package/@tldraw/sync-core), [releases](https://github.com/tldraw/tldraw/releases)) |
| Model | **Server-authoritative.** One `TLSocketRoom` per document "stores the authoritative copy of the document". Running two rooms for the same document means users "will overwrite others' changes" ([docs](https://tldraw.dev/docs/sync)) |
| Store | Typed JSON records keyed by id. Clients push diffs, and the server answers each push with **commit**, **discard** or **rebaseWithDiff** (it sends back the diff it actually applied). Deletes leave tombstones stamped with a clock. Below `tombstoneHistoryStartsAtClock` the history is dropped, and clients that old get a full reload ([TLSyncRoom.ts](https://github.com/tldraw/tldraw/blob/main/packages/sync-core/src/lib/TLSyncRoom.ts)) |
| Migrations | Each session records the client's schema. Outbound diffs are **down-migrated** to that schema and inbound pushes are **up-migrated**. If either fails, the server rejects the session with `CLIENT_TOO_OLD` or `SERVER_TOO_OLD` and the client asks the user to refresh. Migrations without a `down` step lock old clients out. tldraw's advice is to deploy the backend first ([TLSyncRoom.ts](https://github.com/tldraw/tldraw/blob/main/packages/sync-core/src/lib/TLSyncRoom.ts), [docs](https://tldraw.dev/docs/sync)) |
| Authority | Each session has `isReadonly` and an `objectAccess` setting. Denied operations are *skipped*, and the client is corrected by the push result. Records are validated on the server, and `authorizeRecord` hooks fail closed. **Presence is not gated by `isReadonly`** ([TLSyncRoom.ts](https://github.com/tldraw/tldraw/blob/main/packages/sync-core/src/lib/TLSyncRoom.ts)) |
| Presence | One presence record type, kept in a separate ephemeral store and deleted when the session leaves |
| Persistence | `InMemorySyncStorage` (the default, lost on restart) or `SQLiteSyncStorage`, which is recommended for production and runs on Node or Durable Objects ([docs](https://tldraw.dev/docs/sync)) |
| **Licence** | sync-core states "licensed under the tldraw license" ([package LICENSE.md](https://www.npmjs.com/package/@tldraw/sync-core)). That licence allows use in development only, "Not to use the Software in Production Environments", unless you hold a trial or commercial agreement ([LICENSE.md](https://github.com/tldraw/tldraw/blob/main/LICENSE.md)). tldraw says the SDK "would not be Open Source by any definition". Downstream users of an open-source project need their own licence ([licence page](https://tldraw.dev/community/license)). Hobby keys are discretionary and keep the watermark ([license-key](https://tldraw.dev/sdk-features/license-key)). **`@tldraw/store` is MIT** ([npm](https://www.npmjs.com/package/@tldraw/store)) |

**Verdict:** tldraw sync is the best design reference in this list, but mapcro cannot ship it. Self-hosters of an open-source project would each need a tldraw licence, and mapcro is not a tldraw canvas anyway. Study the design but don't copy code from sync-core.

## 2. Excalidraw collaboration

- **Reconciliation.** Every element carries a `version`, incremented on each edit, and a random `versionNonce`. The higher version wins, and on a tie the lower nonce wins. An element you are editing right now beats the remote copy. Deletes are `isDeleted` tombstones. The team admits concurrent edits to the same element can be lost ("we don't really care!"). Its multiplayer undo fix is to "clear the undo/redo stack whenever you receive an update from a new peer", which it calls "subpar" ([P2P blog](https://plus.excalidraw.com/blog/building-excalidraw-p2p-collaboration-feature)).
- **Relay.** `excalidraw-room` is a Socket.IO relay with no authority (MIT) ([repo](https://github.com/excalidraw/excalidraw-room)).
- **E2EE.** An AES-GCM key lives in the URL `#fragment`, which browsers never send to the server ([E2EE blog](https://plus.excalidraw.com/blog/end-to-end-encryption)). Rooms persist in Firestore as `{sceneVersion, iv, ciphertext}` ([source tour](https://pyshine.com/Excalidraw-Virtual-Whiteboard-Source-Tour/), secondary source).
- **Weaknesses for us.** The server can't read the content, so it **can't validate it or enforce view-only links**. Tombstones grow forever while a session is live. Ties between clients are settled arbitrarily by the nonce rather than by server order. Whole-element LWW loses concurrent edits to *different* fields of the same element.

## 3. Yjs ecosystem

| Piece | Status |
|---|---|
| `yjs` | 13.6.33 stable (2026-09-23). **v14 is still a release candidate** (`14.0.0-rc.29`, 15 Oct) and unifies the shared types, so expect API churn ([releases](https://github.com/yjs/yjs/releases)) |
| Awareness | Ephemeral per-client state with a timeout, the standard way to do cursors and presence |
| `Y.UndoManager` | Tracks transactions whose origin is in `trackedOrigins`, so remote changes are excluded and undo is per user. Edits within `captureTimeout` (500 ms) merge into one step, and `stack-item-added`/`popped` metadata restores the selection ([docs](https://docs.yjs.dev/api/undo-manager)) |
| y-websocket | 3.1.0 is the client; the server ships separately as `@y/websocket-server` 0.1.5. Both MIT |
| Hocuspocus | `@hocuspocus/server` 4.8.0 (2026-10-28), MIT, Node. Setting `connection.readOnly` in `onAuthenticate` makes a connection view-only ([auth guide](https://tiptap.dev/docs/hocuspocus/guides/authentication)) |
| y-sweet | A Rust server on yrs with S3 or filesystem persistence. Last crate release 0.9.1 in Sept 2025 ([crates](https://crates.io/crates/y-sweet)). Its company Jamsocket moved to Modal ([New Stack](https://thenewstack.io/jamsockets-session-lived-infra-gets-a-new-home-with-modal/)), so treat it as low-maintenance |
| y-redis | `@y/redis` is **AGPL-3.0 OR proprietary** ([npm](https://www.npmjs.com/package/@y/redis)) |
| `yrs` (Rust) | 0.28.1, 2026-11-04, about 4.7M downloads: mature but still 0.x ([crates](https://crates.io/crates/yrs)). Server glue (`yrs-warp` 0.9, `yrs-axum` 0.8) is thin and community-run. **There is no Hocuspocus-grade Rust server.** You would write auth, persistence and room lifecycle yourself |
| `y-octo` | 0.1.1. Update-v2 encoding, XML types and subdocs are still in progress. AFFiNE uses it in production ([repo](https://github.com/y-crdt/y-octo)) |

- **GC.** With `gc: true`, deleted *content* is discarded but the item IDs and lengths stay, so documents still grow slowly over time ([forum](https://discuss.yjs.dev/t/should-size-of-binary-ydoc-be-monotonically-increasing/2325)). Version snapshots need `gc: false`.
- **Migrations are the weak spot.** The forum consensus is that clients must not migrate a shared doc. Clients that are out of date race and duplicate or lose data, so the server should migrate while clients wait ([1](https://discuss.yjs.dev/t/pause-observers/1047), [2](https://discuss.yjs.dev/t/what-is-the-correct-way-to-apply-document-migrations/2321)). Yjs has no schema, and an update cannot be "un-sent" once a peer has merged it.

## 4. Automerge and Loro (brief)

| | Automerge 3 | Loro |
|---|---|---|
| Version | JS 3.5.0 (2026-09-16), Rust `automerge` 0.12.0. 3.0 shipped in July 2025 with memory use cut by more than 10× ([blog](https://automerge.org/blog/automerge-3/)). Stable automerge-repo is 2.5.6; the npm `latest` tag points at `2.6.0-alpha.3` | 1.17.1 (2026-10-22), Rust core, MIT ([crates](https://crates.io/crates/loro), [releases](https://github.com/loro-dev/loro/releases)) |
| Server | automerge-repo sync server (JS). `samod` 0.16 is a compatible Rust repo ([crates](https://crates.io/crates/samod)) | `loro-websocket` 0.6.2 has a "SimpleServer". Otherwise you build it yourself |
| Undo | **I found no first-party undo manager** (unverified; check before relying on this) | `UndoManager` is local-peer only and transforms its stacks against remote edits. Undoing a map child's deletion creates a *new* container id unless you use mergeable containers ([docs.rs](https://docs.rs/loro/latest/loro/struct.UndoManager.html)) |
| Presence | Ephemeral messages | `awareness` module |
| Fit | Full history and local-first. Same validation and migration problem as Yjs | Best CRDT undo story, and the Rust core is attractive. Its ecosystem is the smallest |

## 5. Server-authoritative, non-CRDT

- **Figma.** The server keeps the latest value for each (object, property). Clients apply edits optimistically and *ignore server echoes that conflict with their own unacknowledged changes*. Object ids embed a client id so objects can be created offline. Deleted data lives in the deleting client's undo buffer. The undo rule: undo, then redo, must leave the document unchanged. Figma rejected OT as too complex and CRDTs as unnecessary given its central server ([Figma](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)).
- **Liveblocks.** Per-key LWW in arrival order at one point per room ([guide](https://liveblocks.io/docs/guides/how-conflict-resolution-works-in-liveblocks-sync)). Self-hosting is an Enterprise add-on, so it's out.
- **Zero** 1.11.4 (Apache-2.0) has been stable since 1.0 ([notes](https://zero.rocicorp.dev/docs/release-notes/1.0)). It is a query sync engine over Postgres, which is too much machinery for one JSON-sized board (the Postgres requirement wasn't re-checked this session). **Replicache** 15.3.0 has seen no release since July 2025 and uses proprietary terms ([npm](https://www.npmjs.com/package/replicache)).

**You don't need a CRDT when** a server is always the meeting point, one process can own each document, the data is records with scalar fields (positions, toggles, labels) rather than long shared text, and offline gaps are minutes, not weeks. LWW per field, in server order, is the *correct* result when two coaches drag the same token. A CRDT would give the same answer with more bytes, and with a server that can't easily say no. mapcro meets every one of these conditions. Free-text notes are the only gray area.

## 6. Recommendation for mapcro

**Build a tldraw/Figma-style server-authoritative record store with per-field LWW.** No CRDT. Write it in-house, roughly 1–2k lines per side. Typed JSON records (`token`, `objective`, `arrow`, `callout`, `note`, `scenario`) each carry `id`, `typeName` and fields. The server holds a monotonic room clock. Clients send batches of `put`/`patch`/`delete` ops tagged with a client-generated `(clientId, seq)`. The server validates each op, applies it, persists it, then acknowledges or rebases. One room actor per board, backed by SQLite.

Why this one wins:

1. **The server can say no.** View-only links, schema validation, size limits and rate limits all apply per op. A CRDT relay can drop *all* writes from a view link, but it can't cheaply reject *some* malformed writes from an edit link.
2. **Migrations are plain functions over typed records.** The server knows each session's schema version, as tldraw's does.
3. **Per-user undo becomes inverse ops**, generated on the client and sent as new ops (the Figma rule). There are no CRDT undo semantics to fight.
4. **Tombstones can be pruned.** The server owns the clock, so it can force a full reload on clients that are too old.

**Node vs Rust:** I lean **Node + TypeScript**. One module of record schemas, validators and migrations can then run unchanged on both client and server, and migration drift between the two is the bug class that hurts most. Choose Rust only if you are willing to treat a TS→WASM or JSON-Schema codegen boundary as the source of truth. Library-wise nothing favors Rust here: there is no strong Rust sync framework for this model. `@tldraw/store` (MIT) is worth reading for its migration-sequence design.

**Runner-up: Yjs with Hocuspocus** (Node, MIT; or yrs on Rust). You get awareness, `UndoManager` with `trackedOrigins`, offline and reconnect for free, plus mature providers. It lost for four reasons. Schema validation needs a staging Y.Doc and a forced resync whenever an update is rejected. Migrations with old clients connected are an open problem. GC never fully reclaims space. And the Rust server story is DIY. **Switch to it** if notes ever need real simultaneous typing. Even then, a better hybrid is one `Y.Text` per note body inside the LWW model.

### Pitfalls to design around

| # | Pitfall | Design |
|---|---|---|
| 1 | **Crafted updates on a view or edit link** | View and edit links are separate random capabilities, stored hashed. Never derive one from the other, and make both revocable. The server ignores every doc op from a view session. Validate *every* op with a strict schema (deny unknown fields, numeric bounds, string caps, record-count caps, message-size and rate limits). Decide on purpose whether viewers send presence (tldraw lets them), and rate-limit it. Don't use Excalidraw-style E2EE: the server must be able to read content to enforce any of this |
| 2 | **Migrations while old clients are connected** | Each migration step is pure and has an `up`. A `down` is required as long as old clients must keep working. Clients advertise their schema at handshake. Each session's diffs are migrated to its schema, or it gets a clean "refresh" rejection *before* any pending ops are dropped: keep them locally and replay them after the reload. Deploy the server first. Keep a corpus of fixture boards from every schema version in CI. Clients never migrate shared state |
| 3 | **Lost edits on reconnect or offline** | The pending-op queue is persisted in IndexedDB until acknowledged. Ops are idempotent, deduplicated on `(clientId, seq)`. The server acknowledges only after a durable SQLite (WAL) commit. Ignore server echoes that conflict with your own unacknowledged fields (Figma). Rebase on `push_result`. Ids are client-generated (UUIDv7) so offline creates never collide |
| 4 | **Undo across concurrent edits** | Each user's stack holds inverse patches captured at commit time. On undo, skip or narrow the patch when another user has since deleted the record or changed that field. Never resurrect a record someone else deleted without a visible cue. Coalesce a whole drag into one step. Clear redo on any new local op |
| 5 | **Tombstone and history growth** | Tombstones carry clock stamps and are pruned past a horizon. Clients whose last clock predates the horizon get a full snapshot instead of a diff. Throttle drag streams (for example 30 Hz to peers) but persist only the final value. Keep the op log for replay and debugging separate from the state table, and compact it |
| 6 | **Two rooms for one board** | Exactly one in-memory room per board in one process. Take a lock row on boot. tldraw warns that duplicate rooms overwrite each other |
| 7 | **Snapshots and backups** | A named scenario is an immutable copy stamped with its schema version, migrated when restored. Use the SQLite online backup plus an off-box copy. Test the restore on a schedule |

### Not verified

- Whether tldraw would grant licences for an open-source self-hosted product.
- Whether Automerge has an undo API.
- Whether y-sweet is still maintained after the move to Modal.
- Zero's current infrastructure requirements.
- The Excalidraw Firestore details, which come from a secondary source.
