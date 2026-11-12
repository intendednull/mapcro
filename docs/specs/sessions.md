**Date:** 2026-11-11
**Status:** draft for the operator's review. Phase 0 built (2026-11-11, §4.1 and §10). Phase 1
(the server) built 2026-11-12 (§10), awaiting its security review.
**Supersedes:** the 2026-11-10 sketch "Several replays on one board, as game tabs" (docs/backlog.md,
mockup `/home/intendednull/concierge/artifacts/mapcro-multi-replay/index.html`). The tab strip
and the reasons stay. The model changes: there is still one board per game, not several games
on one board.
**Builds on:** architecture-design.md §2 (document), §3 (sync), §4a (client state), §7 (undo),
§8 (presence and follow), §9 (persistence), §11 (links and capabilities);
[view-state plan](../plans/2026-11-11-view-state-sync.md) (the registry).

# Sessions: several boards as tabs

## 0. The operator's direction (2026-11-11)

> Don't put several games on one board. Instead a **session**: a shareable view that links
> several existing boards as tabs, to switch between them quickly and share the set with peers.

- Each tab is a full, normal board. It has its own room, document, scenes, notes, Player state
  and presence.
- Switching a tab loads that board's entire state, so nothing leaks across games ("very easy to
  accidentally leak the state across games").
- Removing a tab un-links the board. The board still exists on the server, and undo re-links it.
- Existing boards can be added to a session.
- Notes are per game, which means per board.
- No hard limit on tabs.
- The original reasons still apply: one URL for a multi-game review (a series, a scrim block),
  and scenes kept per game.

What this rules out, compared with the old sketch: filtering scenes by `scene.source.match_id`,
a special Whiteboard tab, per-game notes inside one board, and a shared LRU of timelines inside
one Player host. A board with no match is simply a tab whose board has no match (§7.4).

## 1. Summary

- A **session** is a small server-stored document: a title and an ordered list of **tabs**.
  Each tab holds a board id, a display name, and a reference to a **grant**. A grant is the
  server-side record of the access the person who added the board delegated to the session.
- The session document runs on **the existing sync engine**. It is a room like a board, with two
  new record kinds. Realtime add, remove, reorder and rename come with per-user undo and redo,
  durability before ack, offline pending and reconnect, all of it already proven.
- **Session links** work like board links (`/s/<id>#<token>`, roles owner, edit and view,
  cascading revocation). A session member opens a tab's board with the session credential. The
  server gives them `min(session role, grant role)` on that board, and a grant is never more
  than its adder held, capped at edit. Board tokens are never stored in the session, never sent
  to its members, and never minted for them.
- **On the client, switching a tab is a fresh mount keyed by board id**, and each board gets its
  own room connection. The thing kept warm across a switch is the board's sync session, parked
  (§5): its replica, pending edits and undo stack, which belong to that board only. Every Solid
  store, every Player host and every bit of module state is rebuilt. Timelines are cached as
  immutable data keyed by where they came from.
- **Follow across tabs**: everyone's current tab travels in the *session* room's presence. It is
  one view-state registry row, `session.tab`: Shared, unfollow Keep, override Stop. A follower
  switches with the presenter and then follows inside the board as today.

## 2. The session object

### 2.1 Storage

Sessions live in the same SQLite database and reuse the board tables, so the room, storage,
compaction, catch-up and backup code is shared and not copied:

- `boards` gets a column `kind TEXT NOT NULL DEFAULT 'board'`, and a session's row has
  `'session'`. Its `base_doc`, `ops`, `rejections`, `clients` and `client_seqs` rows are exactly
  a board's.
- Session links are rows in `links` with `board` = the session id. Role, label, `minted_by`,
  revocation and cascade are unchanged.
- A new table holds grants (§3.2):

  ```
  session_grants (
    session    TEXT NOT NULL REFERENCES boards(id),   -- kind 'session'
    grant_id   TEXT NOT NULL,                         -- 128-bit random, base64url; not secret
    board      TEXT NOT NULL REFERENCES boards(id),   -- kind 'board'
    link_hash  TEXT NOT NULL REFERENCES links(hash),  -- the grant's own links row (§3.2)
    added_by   TEXT NOT NULL,                         -- the session link hash that added it
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session, grant_id)
  ) WITHOUT ROWID;
  ```

- This is database schema v7 (`store.rs`), one step: the column, the table and an index on
  `session_grants(board)`. It is **additive** under §9's rule, so the compatibility floor stays.
  A v6 server never reads `kind` or `session_grants`. If it were given a session's id, it would
  fail to load that one room, because the document has record kinds it doesn't know, and every
  board would be untouched. The reviewer of the step confirms this.
- **Ids.** A session id has a board id's shape: 22 base64url characters, from
  `links::new_board_id()`. The server keeps them apart by type, not by shape. A `RoomKind` comes
  back with every link and room lookup, and every route says which kind it serves (§3.6).
- The caps of §9 apply as they do to boards. Sessions count toward `MAX_BOARDS` and the
  database size. They get the same idle expiry under §9a (180 days with no opens; opening the
  session counts). Opening a tab counts as opening that tab's board.

### 2.2 The document

Two record kinds join `Record` in `crates/schema`:

| Record | Fields | Mutable (has a `FieldValue`) |
|---|---|---|
| `SessionMeta` | title, schema version | title (`SessionTitle`, LWW, `max_title`) |
| `Tab` | `board: BoardId`, `grant: GrantId`, `name`, `order` | `name` (`TabName`, LWW, `max_name`), `order` (`TabOrder`, a fractional index like `Scene.order`) |

- `board` and `grant` are identity fields. They have no `FieldValue` variant, so they are
  immutable by construction (§2). A tab never comes to point at another board.
- **The kind of a document follows from its genesis record.** A document with `BoardMeta` is a
  board, one with `SessionMeta` is a session. `check_record` refuses a `Tab` in a board and any
  board kind (Scene, Stroke, …) in a session, as `Reject::WrongDocKind`. `SessionMeta`, like
  `BoardMeta`, is never created by an edit.
- **A removed tab is a deleted record.** It is tombstoned with its fields, so undo is
  `restore(id)` (§7), which re-links the same board through the same grant, with any rename a
  peer made in the meantime. This is the operator's "undo re-links it", and it comes with the
  engine.
- **Concurrent reorders don't collide**, because `order` is a fractional key, as with scenes.
  Two people renaming one tab is LWW: the last to commit wins, visibly.
- **Duplicates are allowed.** The same board can be in two tabs, for example with different
  names. Nothing breaks, because each tab still mounts that one board.
- **Caps.** The operator asked for no hard limit on tabs. Internally, a session document is
  capped at **2,000 `Tab` records, removed ones included**, because tombstones are kept (§9). At
  about 200 bytes a tab, that is a document of roughly 400 KB at most. No review needs anywhere
  near that many tabs, and it bounds what one edit link can make the server hold. Past the cap,
  an add is refused as `SessionFull` and the client shows "Session full". (Decided, §12.)
- **What the document never holds:** board tokens, link hashes, roles, or anything derived from
  a secret. Every session member, viewers included, receives the whole document. The grant id
  is not a secret (§3.3).

### 2.3 Why reuse the engine instead of a simpler model

The simpler model would be one JSON list per session, written with compare-and-swap over HTTP
and broadcast to whoever is watching. It is less code on day one, but it has to rebuild most of
what the engine already gives a list that people edit live:

| Needed | Engine (reuse) | Simple list |
|---|---|---|
| Realtime add, remove, reorder, rename, seen by peers | room broadcast | a new broadcast path |
| Concurrent edits don't lose each other | per-field LWW plus a fractional order | CAS retries; a whole-list write loses a concurrent rename |
| Per-user undo and redo; undo of a remove re-links | `set_if` / `restore` on tombstones, evaluated by the server (§7) | new undo semantics, unmodelled |
| Durable before ack, dedup on resend, offline pending | §5 and §9, Quint-checked | new |
| Presence for "who's on which tab" and follow | room presence | a second channel |
| Compaction, backups, caps, metrics | shared | new |

The cost of reuse is small and contained: two record kinds, three `FieldValue` variants, a doc
kind check in `check_record`, a `kind` column, and `BUILD_ID` moving (old tabs reload, §10). The
board code paths don't change. The risk is kind confusion, a session id taken where a board id
belongs or the reverse. It is handled with types and with a test that runs every route against
both kinds (§3.6, §9.2).

The alternative inside "reuse" would be making the engine generic over a schema trait. It is
cleaner in theory, but it means a refactor of the authority, replica and WASM for two record
kinds. Not now.

## 3. Capabilities and security

This section is the security boundary. A session is a way to **delegate** access to boards. It
is never a way to **gain** access.

### 3.1 Roles and links

- Sessions have the board link model (§11): `owner`, `edit`, `view`. Creating a session returns
  the owner token, which is kept on the creator's device ("Your boards", §7.3). Editors mint
  edit and view session links, view links can't mint, revocation cascades, and the owner sees
  and revokes everything.
- URL: `https://<domain>/s/<sessionId>?tab=<tabId>#<token>`. The token is in the fragment, as
  for boards. `tab` is not secret (§7.1). The app's form is `mapcro://s/<sessionId>#<token>`,
  for `parseBoardLink`'s sibling and `desktop/core/src/link.rs`.
- Session roles mean the following:

  | Session role | The tab list | Each tab's board |
  |---|---|---|
  | owner | edit; mint, list and revoke all session links | `min(edit, grant)` (owner is never delegated, §3.2) |
  | edit | add, remove, reorder, rename; mint edit and view session links | `min(edit, grant)` |
  | view | read only; can follow | `view` (`min(view, grant)`) |

### 3.2 Grants: how board access enters a session

**Adding a board needs a credential for it, presented once to the server, and the result is a
grant.**

1. A session editor adds board B by pasting B's link or choosing it from Your boards. The
   client sends `POST /api/sessions/{s}/grants` with `Authorization: Bearer <session token>` and
   the body `{ board, board_token, role? }`. The board token is sent once, over TLS, in the
   body, never in a URL.
2. The server checks the session link: live, kind `session`, this session, role edit or owner.
   It checks the board token: live, cascade not revoked, kind `board`, this board, role R.
3. It computes `G = min(R, edit, role?)`. An owner token gives an edit grant. A view token gives
   a view grant, whatever `role?` asks for. `role?` can only lower it (the add dialog's "Can
   view", open question 2).
4. It writes **a new `links` row for B**: the hash of a fresh random token that is then thrown
   away, role `G`, `minted_by` = hash(board_token), and label "Session: <session title>"
   (cleaned and capped like any label). It also writes the `session_grants` row that points at
   it. No one ever holds that token, so the row can only be used through the session path
   (§3.4). Adding the same board again through the same board link at the same role, while
   that grant is live, writes nothing and returns the existing grant (200, not 201). Any link
   may add its board, a view link too, so this and the per-board cap (§3.8) bound the rows a
   session can write on someone else's board.
5. It returns `{ grant_id, board, role: G }`. The board token is dropped from memory. It is
   never logged, stored, echoed back, or put in the session document.
6. The client creates the `Tab { board, grant, name, order }` record with an ordinary engine
   transaction. The add is then in the adder's own undo stack.

Why the grant is a `links` row: B's existing machinery then covers it with no new code paths.

- **Cascade.** Revoking the adder's link, or any link above it, revokes the grant (§11).
- **Visibility.** B's owner sees it in B's link list, labelled with the session.
- **Emergency revocation.** B's owner revokes it like any link.
- **Live sessions close.** The room's `Revoke { link_hash }` closes every connection that came
  in through it.

**Why delegating view is safe:** a view-link holder can already share that link by copying it,
so a view grant gives a session's members nothing the adder couldn't hand them. **Delegating
edit** is what an edit-link holder can already do by minting an edit link. **Owner powers**
(seeing and revoking every link, rotating the owner token) are never delegated. An owner who
adds a board gives an edit grant.

So the invariant, for every session member M and every tab t:

> `role(M, board(t)) via the session = min(sessionRole(M), G(t))`, and
> `G(t) ≤ min(role of the adder's board link when added, edit)`, and it is **none** if the
> session link, the grant row, the grant's link chain or the tab record is gone (revoked,
> deleted, or the board expired).

A view-only board added to a session stays view-only for everyone, session owners included.

### 3.3 What the session document and its members learn

- **They learn:** board ids, tab names, grant ids, and who is on which tab (session presence,
  §6). Board ids "alone grant nothing" (§11). A grant id grants nothing without a live session
  token for *that* session (§3.4), and holding such a token already means you can read the
  document that lists the grant ids. So the session token is the only secret.
- **They never learn:** any board token. No endpoint returns one to a session-derived caller
  (§3.5). The adder's token is used once in step 2 and discarded.
- **A session viewer sees** the tab strip (names, and each tab's match details when they load,
  §8), opens any available tab read-only, sees the people in the session and on their current
  board, and follows. A viewer can't add, remove, rename, reorder, edit the boards, mint or
  share.
- **A board's own people** (someone who opened B on its own with B's link) see session members
  who are on B in B's people list, exactly as they would see anyone in B's room. They see
  nothing of the session: not its other tabs, its title, or its presence.

### 3.4 Opening a tab's board

- **WebSocket.** `Auth` gains an optional `via: { session, grant }`. With `via`, `token` is the
  session token. The server accepts only if all of the following hold, and checks them in one
  place, `auth::resolve`:
  1. the session link is live and kind `session`, and its `board` is `via.session`;
  2. a `session_grants` row exists for `(via.session, via.grant)` with `board` = `Auth.board`;
  3. the grant's `links` row is live, with nothing revoked up its `minted_by` chain (the
     store's existing check);
  4. the session's document has a **live** `Tab` with that grant and board. It is asked of the
     session room, which is loaded if it isn't; it is small.
  
  The role is `min(session role, G)`. The `Peer` records `link_hash` = the grant's link hash
  and `via_hash` = the session link hash, for revocation (§3.7).
- **HTTP.** Every route that takes a board token today takes the session credential as well,
  through one extractor, `BoardAuth`. Those routes are matches list and attach, uploads, replay
  jobs, the client-timeline route, previews scoped to a board, and clone. The credential is
  `Authorization: Grant <session>.<grant>.<session token>`. Without the extractor, a route
  isn't reachable through a session. That fails closed, but the feature breaks, so the route
  test (§9.2) lists every route.
- **Using your own stronger link.** If this device holds its own link for B (Your boards) with
  a higher role than the session gives, the tab uses that link. The tab then shows "Owner" or
  "Edit" as B does today. The session neither adds nor removes power here: it's the device's
  own capability.

### 3.5 What session-derived access can't do

On the board, a session-derived connection or request is at most an edit that **can't share**:

- no `mint_link`, `list_links`, `revoke_link` or `rotate_owner` (403, "this link cannot
  share"). Minting would turn session-scoped access into a standalone token that outlives the
  tab's removal, the session link's revocation and the grant;
- no adding B to *another* session with this credential (v1). A later version may allow it as a
  grant of a grant (`minted_by` = this grant's hash, `G' ≤ G`), so it would still cascade
  (§11, Later);
- **clone is allowed**, as with every link (§11): anyone who can see a board can copy it by hand.
  The clone is a new board with its own owner token. Nothing is lent from B.

### 3.6 Kind confusion

Board and session ids share a shape and a table, so every lookup returns the kind and every
route asserts it:

- `/b/<session id>`, or a session token on any board route: 404 or 403, never a load.
- A board token on a session route: refused.
- A session token with a grant from another session: refused (check 2).
- A grant whose board isn't `Auth.board`: refused.
- A transaction carrying session records into a board, or board records into a session:
  `WrongDocKind` (§2.2).
- The socket's `Ready` says what the room is: `kind` is `"board"` or `"session"` (wire
  `RoomKind`; absent from servers before it). Without `via`, a token opens its own room, whatever
  its kind, so `/b/<id>` with a session's token joins the session. The client checks `kind` is
  what its page expected and leaves if not (phase 2 builds the check; phase 1 sends it).

### 3.7 Revocation

| Action | Effect |
|---|---|
| B's owner (or the link's minter) revokes the adder's B link, or one above it | cascade revokes the grant; B's room closes connections whose `link_hash` is the grant's; the tab reads "No access" for everyone |
| B's owner revokes the grant itself ("Session: …" in B's links) | the same, for that session only |
| The session's owner, or the session link that added the grant, withdraws it: `DELETE /api/sessions/{s}/grants/{g}` | the grant's links row on B is revoked (in the store, then `Revoke` to B's room); the same as B's owner revoking it. Anyone else, a grant credential and an unknown grant are refused, and "not yours" and "not found" both read 404 |
| B's owner rotates B's owner token | the grant is **not** cut, even one added with a leaked owner token: rotation re-parents what the old owner minted onto the new one, grants included, as for any link ("links the old owner minted stay valid"). The owner revokes what they don't trust from B's links (backlog: phase 2's rotate offers that review) |
| A session link is revoked (cascade) | the session room closes its sessions; the server sends `Revoke` to every open board room, matching `via_hash` too, so those board connections close; the tabs are gone for that holder |
| A tab is removed | it is un-linked: new opens through that grant are refused (check 4), and B's room is sent the existing `Revoke { link_hash }` with the grant's hash, which is unique to this session, so connections through it close |
| The removal is undone (restore) | check 4 passes again; open again. The grant row was never touched |
| B is expired or deleted (§9a) | its grants go with it; the tab reads "No access" |

Removing a tab is not revocation. The grant stays in the database, which is why undo can
restore it, but nothing can use it while the tab is removed. Removing one of two tabs with the
same board and grant closes nothing: the server sends `Revoke` only once no live tab uses the
grant, and only for a delete that removed a live tab. **Phase 2** offers two actions on a tab:
**Remove** (the tab only, undoable) and **Remove and revoke** (the tab, then the withdraw
above, which undo can't bring back). To cut a session off from B for
good, revoke the grant or the link it came from. Grants of tabs that have been removed for 30
days are deleted by housekeeping, and an undo after that reads "No access".

### 3.8 Abuse limits

| Threat | Control |
|---|---|
| Session spam | `POST /api/sessions` shares the board creation limiter (per address per hour, global per hour) and `MAX_BOARDS` and database caps; 507 past them |
| Grant spam (each one writes a `links` row on someone's board) | per session link: 120 grants an hour; per address: 240 an hour; the 2,000-tab cap bounds grants per session, and live grants per session are capped at 2,000 too. Adding a board again through the same link at the same role returns its live grant and writes nothing. A board holds at most 50 live grants from all sessions together (`MAX_GRANTS_PER_BOARD`); past it, adding answers 409 "board full" until B's owner revokes one. Someone with a view link could fill those 50 and keep others from adding B; B's owner sees each in B's links and revokes it |
| Probing grants or link ids | grant ids are 128-bit random; "not found" and "not yours" read the same, as for link revoke |
| Junk tabs (an editor writes `Tab` records with made-up board or grant ids) | harmless: check 2 fails on open and the tab reads "No access". An editor could already vandalize the list, and undo restores |
| Socket load | a person in a session holds one session socket plus one board socket (two during a switch, briefly). `MAX_SOCKETS_PER_IP` (32) then allows ~15 people behind one NAT in a session, against 32 on a board alone. Parked boards hold no socket (§5) |
| Room load | board rooms are loaded only by people on them, never by the strip. A 50-tab session with 6 people loads at most 6 board rooms and 1 session room |
| Presence | the session room's presence has the same validation and rate limit; it carries only slow fields (§6) |

## 4. Isolation on the client

**Rule: a tab is a board, and a board's state belongs to its mount.** Nothing a board created in
memory survives into another board's mount unless it is either:

- immutable data keyed by where it came from, or
- that same board's own sync session, handed back to it.

### 4.1 Switching

- `/s/<id>` renders `SessionView`. It owns the session's own connection (a `BoardSession` on
  the session document) and the tab strip, and renders
  `<Show when={tab()} keyed>{t => <Board board={t.board} credential={…} />}</Show>`. A new board
  id unmounts the whole subtree and mounts a fresh one. The Solid stores (`createBoardState`),
  the Player host (`createPlayerHost`), the view-state store, timers, listeners and dialogs are
  all new.
- **Prerequisite: Board unmounts cleanly.** Done in phase 0 (2026-11-11, below and §10):
  `web/e2e/board-unmount.spec.ts` mounts A, B and A again in one page and asserts that A's
  socket is closed (the server drops it), that nothing of A's runs, and that module state is at
  its defaults.
- **Module state is the leak to fear.** The scan on 2026-11-11 found module-level state that
  outlives a Board. Each needs a policy:

  | Module state | Policy |
  |---|---|
  | `map/HoverLabel.tsx`: `token`, `marker`, `handle`, `remote`, `resolvers` (keyed by slot and marker key, which collide across boards) | reset on Board cleanup; resolvers already unregister |
  | `player/GameTooltip.tsx` `openId` | reset on cleanup |
  | `player/handoff.ts` `pending` | already keyed by board id (`takeHandoff(board)`); keep |
  | `player/ReplaysFolder.tsx` `store`, `ReplayPicker.tsx` `appSource`, `art` | device-wide by design (the app's replay folder); keep |
  | `match/tooltips.ts`, `match/stats.ts` caches; `board/state.ts` `wasm` | immutable data keyed by pack or file; keep |

  A guard in the spirit of the view-state plan's guard 4 does the classifying. A test scans
  `web/src` for module-level `createSignal`, `createStore`, `new Map` and `let`, and fails on
  any that isn't in `web/test/module-state-ledger.ts` with a class (`reset-on-unmount`,
  `keyed-by-board`, `immutable-cache`, `device`) and a reason. The isolation test (§9.1)
  checks the `reset-on-unmount` ones.

  **Built in phase 0.** The guard is `web/test/module-state.test.ts`. It scans every module
  under `web/src` except `gen/` and `wasm/`, for a top-level `let`/`var`, a destructured
  `createSignal`/`createStore`/`createResource`, and a `new Map`/`Set`/`WeakMap`/`WeakSet`, an
  empty array or object, or a store or root. It also fails on any top-level reactive call it
  can't name. Three classes were added to the four above. `owner-cleared`: what sets it clears
  it as it goes (`HoverLabel` `resolvers`, `ui/modal.ts` `open`/`made`, `board/fade.ts`).
  `page`: page-wide on purpose (`core/seat.ts` `page`, `core/nav.ts` `href`, `core/feedback.ts`,
  `MapView.tsx` `styleEl` and its stencil id counter, `HoverLabel` `version`). `constant`:
  `TEXT_TYPES`, `MODE_CODES`. The `reset-on-unmount` ones (the hover label's `token`, `marker`,
  `unit`, `handle` and `remote`, and `GameTooltip` `openId`) are reset by
  `web/src/board/reset.ts`, which Board's cleanup calls. The same test sets each one away from
  its default and checks that the reset brings it back. The scan found nothing outside the
  table above. Every hover channel and the tooltip were already cleared by their own
  components' cleanup, so the reset is a backstop for phase 2's keyed remount.

  **What leaked on main (phase 0's characterisation, before the fixes).** Board unmounted
  without a reload, on main plus only the navigation change. The socket closed, and every
  interval, rAF, window and document listener, observer and modal was released. Three leaks
  showed, each fixed in phase 0:
  - **An upload in flight kept going.** One waiting for its turn asked the queue again every 2 s
    after the board was gone. One being sent kept its XHR open. Worse, a waiting one from board A
    took its turn and uploaded while board B was showing. Now the Player host aborts it on
    cleanup (a waiting one gives its place back), and the replay-job poll never re-arms after.
  - **IndexedDB connections.** Each mount's `IdbPersist` opened one, and none was closed (1, 2,
    then 3 over A, B, A). `BoardSession.end()` closes it once the writes in flight are done.
  - **The WASM replica** was left to the FinalizationRegistry. `end()` frees it at the same
    point and takes no edit after. `stop()` keeps its offline meaning for the tests and the
    soak.

  Also tidied: `end()` drops the session's presence and lazy-save timers. A lazy save landing
  after the board's next mount had read storage would write an older state. The journal and
  the server hold what that save would have held. `createBoardState`'s per-scene player memos
  (each in its own `createRoot`) aren't disposed: they read only that board's own signals, which
  nothing writes after it ends, so they go with the board's state.

  **Not handled yet (phase 2).** A gesture in progress at unmount (a token drag's window
  `pointerup`, a swipe) removes its own listener on its next pointerup. But it runs against the
  disposed board, whose session takes no edit. The "switch waits for the gesture" rule below
  covers it.
- **Device settings stay device-wide, as on a board today:** Vision, Show last seen, Player
  names, Heals and Heavy boxes (localStorage, every board). The ink colour is per board already
  (`mapcro.colour.<board>`). Comments open is per board. The tool resets to Move on a new
  mount. (Decided: Vision and layers per tab, §12.)
- **An edit in flight at a switch lands on its own board.** A drag dropped, a stroke released or
  an undo pressed while the switch happens goes to the `BoardSession` of the board it began on.
  Never to the newly mounted one: each gesture closes over its own session, and the switch waits
  for the current pointer gesture to end or cancels it (the map's existing cancel), before it
  unmounts.
- **Undo never crosses boards.** Ctrl+Z reaches the current board's own edits (its
  `BoardSession`'s stack, §7) and the strip's edits, merged into one history (§7.2), never another
  board's.

### 4.2 Per-tab remembered UI state

- On leaving a tab, the client stores `TabView` in `sessionStorage` under
  `mapcro.tabview.<session>.<board>`: scene, viewport, viewpoint, floor, Player or Sandbox, the
  match, t, playing, speed, the sidebar tab. It holds what the screen showed, so a follower who
  is moved off keeps what it saw: `Keep`, as for scene. Mounting that board in that session
  restores it.
- It is restored **only into the same board id**: the type carries the board id, and restore
  asserts it. Then it is checked against the board as loaded. A scene that no longer exists, or
  a match no longer attached, is dropped, and the board opens as it would cold.
- It is per browser tab (sessionStorage), kept across a reload, and never synced. It's §4a's
  "local view".
- At most 200 entries, oldest dropped.

### 4.3 Memory budgets

| Where | Holds | Budget |
|---|---|---|
| Client: active board | its document (typically < 1 MB, ≤ ~20 MB at the schema's limits), Player host, one timeline | as a board today |
| Client: parked boards (§5) | each one's replica, pending and undo | **3 boards and 40 MiB** (`Doc` estimate via the WASM's `approx_heap_bytes`), whichever comes first; LRU; also dropped after 10 min parked |
| Client: timeline cache | decoded timelines, frozen, keyed by `(scope, match id, tier, format)`, where scope is the board for an uploaded timeline and empty for one fetched from Valve (§11, Scope) | **48 MiB decoded** (a long match is ~6 MiB on the wire; measure decoded size in phase 3 and set the cap from it), LRU |
| Client: session document | tabs | ≤ ~400 KB at the cap |
| Server: session room | a room like a board's | ~64 KB base plus a tiny document; counted in `MAX_OPEN_ROOMS` and `ROOM_MEMORY_BYTES` like any room |
| Server: board rooms | loaded by people on them, never by the strip | unchanged |

## 5. Keeping recent boards warm (internal, not user-facing)

**What's kept is the board's sync session, not its UI.** Phase 3 adds a `RoomPool` beside
`SessionView`:

- The pool is keyed by `(board id, credential fingerprint)`. It holds the `BoardSession`: the
  WASM replica, the pending journal and the undo stack. A new mount for that key reattaches,
  draws at once from the replica, and reconnects with `known_seq` to catch up (§5 of the spec:
  usually a few entries). A key never matches another board, and if the credential changes
  (revoked, or a stronger own link found), the pool starts fresh.
- **A parked board holds no socket**, except while it still has pending edits, which it flushes
  and then closes. A switched-away person therefore leaves that board's people list at once.
  That is true: they aren't on it. And it costs no sockets (§3.8).
- Parking is limited by count, memory and time (§4.3). An evicted board falls back to what
  happens today on a cold open: IndexedDB's stored replica, then catch-up.
- **Why not keep whole Board UIs mounted and hidden?** That would be instant, but every mounted
  board's presence, timers, keyboard handlers and module state would be live together. That is
  exactly the leak the operator warned about, and it would hold N sockets each. The pool keeps
  the one part that is inherently per board (the replica) and rebuilds the rest.
- **Target:** a switch back to a parked board draws its last state in under 100 ms and is live
  within one round trip. A cold tab draws from IndexedDB in the same time if stored, and
  otherwise waits for `base`. Phase 3 measures before tuning. If cold switches are already fast
  enough, the pool is optional.
- **Prefetch:** none on the server. The client may warm the timeline cache for the tab next to
  the active one, once the active one is idle (one at a time, behind the replay lookup limits).
  It never opens a room for a tab nobody is on.

## 6. Follow across tabs

### 6.1 Session presence

The session room carries presence as any room does, using the same `Presence` struct. Only slow
fields are filled, and it is sent on change only:

- `name` and `color`, the same values as in the board room;
- **`tab: Option<RecordId>`**: the tab this person has open. New field, `#[serde(default)]`;
- **`seat: u64`**: random per page load, also sent in the board room's presence (built
  2026-11-11 for the board room: `Option<u64>`, absent from older tabs, at most 2^53 − 1 so a
  JavaScript number holds it; `web/src/core/seat.ts` `pageSeat()`, one per page across rooms;
  the follower's rules in architecture-design §8 "A follow survives a reconnect"). A follower uses
  it to find the presenter's connection in the next board room, because peer ids differ per
  room. It also covers the follow-matrix finding that a server restart ends every follow (peers
  come back with new ids), since the seat survives a reconnect. A seat is not authority. Copying
  someone's seat is as forgeable as copying their name; roles stay server-stamped.
- `following: Option<u64>`: as today, a session peer id.

Board-room presence is unchanged, plus `seat`. The server stamps role per room from the link.
For a connection that arrived through a session, it also stamps `session_role` in the board
room's presence, so a follower can check followability (§6.3) without trusting the client.

### 6.2 The registry row

By decision 1 of the view-state plan, new view state is a registry row:

| key | sync | wire | unfollow | on_override | note |
|---|---|---|---|---|---|
| `session.tab` | Shared | `Value { field: "tab", kind: Id }` | Keep | Stop | the presenter's open tab; switching your own stops following, as flipping a scene does (§8) |

- It needs one new value kind beside the plan's §3 list: **`Id`**, a `RecordId`. It is checked
  for shape in `Presence::is_valid` and resolved by the follower against its own copy of the
  session document. The plan says to keep the kinds list short, and this is one more entry.
- `seat` and `session_role` are `Outside::Core`.
- **Apply.** When the followed presenter's `tab` changes, the follower switches (§4.1). The new
  board mounts, the follower finds the presenter in that room by `seat`, and it follows there as
  today: scene, viewport, playback, Vision, layers, panels. Everything inside a board is the
  board's own follow, unchanged.
- **Keep**: stopping, or the presenter leaving, leaves the follower on the tab it is on.
- **Stop**: the follower picking a tab, from the strip, a key or a deep link, stops following
  and keeps the tab it picked. By the plan's decision 2 it keeps everything it saw plus that one
  change. Inside the board, the board's own Stop rules apply as today.

### 6.3 Who can be followed, and lacking access

- §8: anyone with edit rights can be followed. In a session, **followable = session role edit
  or owner**, stamped by the server in session presence. Inside a tab's board, a session editor
  whose board role is only view, on a view-only tab, can still be followed by members of the
  same session, through the stamped `session_role`. A board-only viewer (someone not in the
  session) still can't be followed. (Decided: yes, §12.)
- **Lacking access to the presenter's tab.** Every session member can open every tab whose
  grant is good (§3.2), so "no access" means the tab is unavailable to everyone: a revoked grant,
  an expired board, a junk tab. The follower stays on its tab and stays following, and the
  follow chip says **"No access"**. When the presenter moves to an available tab, the follower
  follows again. If the follower holds a stronger own link to that board, it uses it (§3.4).
- A presenter on a removed tab (a peer removed it under them) is moved, like everyone, to the
  tab to its left, and the follower follows that.
- **Several presenters at once** work as today: each person follows one.

## 7. Links, landing and adding

### 7.1 Deep links

- `/s/<session>?tab=<tab id>#<token>`. `tab` is the tab record's id, which is stable across
  rename and reorder. If it is missing or no longer live, the session opens on its first
  available tab, and the URL is updated in place with `history.replaceState`, so a shared
  address names the tab being looked at. A switch also replaces the URL, without adding history
  entries.
- The query string reaches server logs. It holds a tab id, which is not secret. The token stays
  in the fragment.
- **A board opened on its own works unchanged.** `/b/<board>#<token>`, its links, its people and
  everything else work as they do today. Being in a session changes nothing about a board. The
  board doesn't know it is in one.
- `mapcro://s/…` in the desktop app (`parseBoardLink` gains the session form; `link.rs` the
  same).

### 7.2 Editing the strip

- **Add** (any session editor, not only the owner): the strip's last tab is "+ Add game", and opens a menu:
  - **Load a game**: the landing's form: a match id, or **an uploaded replay** (the browser's
    file drop, or the desktop app's replay picker). It creates a board with the match, as the
    landing does, then adds it. The adder gets the owner token, kept in Your boards, so the grant
    is edit. This is how a group gathers the replays it wants to review: every session editor
    can upload their own games into the session (operator, 2026-11-11).
  - **Your boards**: the device's known boards (and sessions are left out), then add.
  - **Paste link**: a `/b/…#token` or `mapcro://b/…` link (`parseBoardLink`), then add.
  - **New board**: an empty board (Sandbox), as the landing's New board, then add.

  The new tab's name defaults to the board's title. The new tab opens, and the add is one undo
  step.
- **Remove**: the tab's ×, or the context menu's Remove. It deletes the `Tab` record. A toast
  reads "Removed <name>" with **Undo**. If you were on that tab, you move to its left neighbour.
- **Rename**: double-click the tab or use the context menu. This sets `TabName`. The board's own
  title is unchanged, and its editors rename it on the board (its header title, or Rename in
  "Your boards": architecture-design.md §11).
- **Reorder**: drag a tab, which sets `TabOrder` between its new neighbours.
- **One undo** (operator, 2026-11-11): the app's Undo button, Ctrl+Z and the toast's Undo all
  walk one history: your own strip edits (the session document's stack, §7) interleaved by time
  with your own edits on the board you are on. Undo takes the newest of the two. So after removing
  a tab (and being moved to its neighbour), the next Undo re-links it, wherever focus is. Edits on
  other tabs' boards stay out of reach (isolation, §4.1): switching back to a board brings its
  edits back into the history. Redo mirrors it.

### 7.3 A board becomes a session

- On a board page, "+ Add game" sits beside the board's title as a one-tab strip, for any role.
  It calls `POST /api/sessions { board, board_token, title }`. That creates the session (owner
  token back to this device), its first tab and that tab's grant in one request. The client then
  navigates to `/s/<id>?tab=<first>#<owner token>`, and the Add menu is open.
- The board is not migrated, copied or changed. **Migration for boards: none.** No board
  document, link, match list, timeline or IndexedDB key changes. The only database step is
  §2.1's additive v7.
- **Your boards** lists sessions beside boards, newest first: "Scrim review · 4 games". `device.ts`
  `KnownBoard` gains `kind?: "session"`, absent for boards, so old entries read as boards. Its
  cap of 50 is shared.
- Opening a session doesn't add its tabs' boards to Your boards. Only links the device holds
  are listed there.

### 7.4 Boards without a match

A tab whose board has no match is an ordinary tab, and its board opens in Sandbox as any board
does. The old sketch's Whiteboard tab and "scenes without a match" grouping are gone, because
each board has its own scenes. Its sub-line reads "Sandbox".

## 8. The UI, mapped from the mockup

| Mockup | Session view |
|---|---|
| header: logo, board title, Saved, Clone, Share | logo; **session title** (inline edit for editors); the active board's save status; **Share** opens the session's Share (session links: Edit, View); Clone stays on the board's own controls and clones the board |
| game tabs strip | the strip of `Tab` records by `order`. Each tab shows its name, then a sub-line from that board's newest match (the winner's colour dot, "Amber" or "Sapphire", the length) and the tier chip (`Full replay`, `API summary`, `Fetching… 40%`). With no match: "Sandbox". Unavailable: dimmed, hover "No access" |
| "+ Add game" | §7.2 |
| tab × | Remove (§7.2) |
| follower's eye on a tab | the presenter's tab carries the presenter's avatar dot; each tab shows the dots of the people on it (session presence) |
| left list: replay card, scenes | **unchanged**: the active board's own scene tree and replay card. No filter |
| right panel: Events, Scene Notes, People here | unchanged per board; the people list adds a "Session" group: who is in the session and which tab each is on |
| transport, Save scene | unchanged per board |

- **Strip details load lazily.** A tab's sub-line needs that board's match list and preview,
  fetched with the session credential only for tabs in view, and cached for the page's life.
  The strip never opens a board's room. Until the details arrive, the tab shows its name alone.
- **Many tabs:** the strip scrolls horizontally, and an overflow button "All games (n)" lists
  every tab. Keys: Ctrl+PageUp / Ctrl+PageDown switch tabs (outside fields, §4 keys). Q to T,
  A, S, F and K stay the board's.
- **Labels (§4b):** "Add game", "Load a game", "Your boards", "Paste link", "New board",
  "Rename", "Remove", "Removed <name>", "Undo", "No access", "Session full", "Sandbox", "All
  games". Hover text on a tab is its name only, plus "No access" when unavailable.
  `aria-label`s are "Game tab, <name>" at most. The add dialog may explain delegation in a
  sentence ("Session editors can edit this board"), because explanations belong in dialogs
  under §4b rule 5.
- **Phone** (the `mobile-ux` proposal, unmerged: "Match, People, Share, Clone and Feedback
  belong in the board menu"): the strip doesn't fit at 360 px. The header's session title
  becomes a button that opens a **Games** sheet: the tab list, Add game, and the same
  Rename/Remove menu. Switching closes the sheet and returns to the map. No flow depends on a
  swipe or drag gesture, per the proposal's rule, so reorder on the phone is "Move left" and
  "Move right" in the tab menu.

## 9. Test plan

Tests pin today's behaviour first (the plan's rule for state changes). In particular,
`e2e/follow-matrix.spec.ts` (branch `view-state`) must pass unchanged on a board opened alone
and on the same board opened as a tab.

### 9.1 Isolation: no state crosses tabs

`e2e/session-isolation.spec.ts`, table-driven like the follow matrix, with one row per piece of
state. Each row:

1. sets the state on tab A (with a peer on A where it's presence);
2. switches to B and asserts that B shows **its own** value (or the default) and that nothing
   of A's is drawn or sent;
3. switches back and asserts that A's value is restored where §4.2 remembers it, and default
   otherwise;
4. reloads and checks the same, from sessionStorage.

Rows (each one at least): scenes and the current scene; strokes, arrows, comments and notes;
roster and heroes; objectives; Player or Sandbox; the match; t, playing and speed; jump pin;
Vision and Last seen (device-wide, so the *same* on B by design: the row asserts that); the
seven layers (device-wide, the same); open skull recap, events recap, inspect, All builds; Effects
or Build order; events filters and search; hover label (local and remote); open game tooltip;
selection and picked objectives; the tool; ink colour (per board); comments open (per board);
peers' cursors, laser, drag previews, live ink and pings from A (never on B); people list; save
status and rejections; a pending edit made offline on A (it lands on A, never B); an upload
handoff to A; undo on B after an edit on A (doesn't undo A's); a drag released during the switch
(it lands on A); a parked A with pending edits (they flush to A); a parked A evicted (it reopens
cold, correct).

Unit level: `RoomPool` keying (another board or another credential never matches; eviction by
count, bytes and age); the module-state ledger guard (§4.1); `TabView` restores only into its
own board, and drops a dead scene or match.

### 9.2 Capabilities (server, Rust)

- **A role matrix**: session role (owner, edit, view, revoked) × grant role (edit, view) ×
  grant state (live, revoked directly, revoked via cascade, board expired) × tab state (live,
  deleted, restored). Each cell is checked for the WebSocket role and for each board HTTP route
  (`BoardAuth`), against `min(S, G)` or refusal.
- **A property test**: random sequences of create, add with an owner, edit or view token, mint,
  revoke, remove, restore and expire. Under all of them, the role any session member gets
  through the session never exceeds `min(sessionRole, edit, the adder's role at add time)`, and
  is none whenever anything in the chain is gone.
- **No delegation of owner**: adding with an owner token gives edit, and session-derived callers
  get 403 on mint, list, revoke and rotate.
- **A view stays view**: adding with a view token and asking for edit gives view.
- **Kind confusion**: every route in the router table, called with the other kind's id and
  token, is refused. The test enumerates the routes from `main.rs`, so a new route without a
  kind assertion fails it. Session records in a board transaction and board records in a session
  transaction are refused.
- **Cross-session**: a grant from session X with a token of session Y is refused.
- **Revocation closes live connections**: the grant, its parent link, a session link (by
  `via_hash`, across board rooms), and tab removal (`Revoke` with the grant's hash). A restore lets a new
  connection in.
- **No token leaks**: the session document's JSON, every response to a session-derived caller,
  and the server log at debug never contain the adder's board token or any board token. This is
  checked by searching for the token's bytes.
- **Abuse limits**: grant rate per link and per address; the 2,000-tab cap (`SessionFull`);
  session creation counts toward the creation limiter.

### 9.3 Follow across tabs (e2e)

- The presenter switches tab, and the follower switches and follows inside the board: scene,
  view and playback match, as the follow matrix does.
- The follower picks a tab itself: it stops and keeps that tab.
- The presenter goes to an unavailable tab: the follower stays, the chip reads "No access", and
  the follow resumes when the presenter comes back.
- The presenter's tab is removed: both move left, and the follow goes on.
- The presenter leaves the session: the follower stays where it is (Keep).
- A late joiner follows, and lands on the presenter's tab.
- A session editor on a view-only tab is followable by session members, and not by a board-only
  viewer.
- After a server restart mid-follow, the follower re-finds the presenter by `seat`.
- **Two presenters on different tabs, each with followers**: no follower's board shows the
  other presenter's state.

## 10. Build plan

Each phase is small, merges on its own, and leaves boards unchanged.

0. **Board unmounts cleanly** (no user-visible change). Reset module state on cleanup, add the
   module-state ledger guard, and add a test that mounts A, unmounts, and mounts B in one page.
   Fix whatever it finds. `core/nav.ts` back navigation can then stop reloading.
   **Done 2026-11-11 (branch `sessions-p0`).** What it found and fixed is in §4.1.
   - `core/nav.ts` follows `popstate` in place, with no reload. Back, forward and an edited
     fragment all fire it.
     `applink.followHashChanges` is gone. App mounts Board keyed by board and token, so another
     board, or another token for the same board, mounts afresh.
   - `e2e/board-unmount.spec.ts` drives A, B, A by real history traversal (`history.back()`
     onto entries the test pushes) and asserts one page load throughout. The page is
     instrumented from before the app loads, and each count is taken on the landing between
     boards and held to a fresh landing's: intervals; timeouts, rAFs and requests made in a
     quiet 2.5 s; live XHRs; window and document listeners; observers; open sockets; IndexedDB
     connections; inert body children. Each board is used before it's left: playing a match, a
     presenter followed, a hero hovered, an upload waiting or sending, and Share open. A second
     person on the board sees this one leave.
1. **Server: sessions and grants, no UI.** Schema v7, `RoomKind`, the `SessionMeta`/`Tab`
   records and the doc-kind check, `POST /api/sessions`, session links (reusing the handlers
   with a kind), grants, `Auth.via`, `BoardAuth` on every board route, tab removal closing connections, and the
   §9.2 suite. A security review of this phase gates phase 2.
   **Built 2026-11-12 (branch `sessions-p1`), not yet reviewed.** No UI.
   - **Schema** (`crates/schema`): `SessionMeta { title, version }` and
     `Tab { board: BoardId, grant: GrantId, name, order }`, `FieldValue::SessionTitle`, `TabName`,
     `TabOrder`, `Reject::WrongDocKind` and `SessionFull`, `LIMITS.max_tabs` = 2,000.
     `Doc::kind()` is `Session` when the document holds a `SessionMeta`; it's kept as records go
     in, so the check costs nothing per op. `check_record` refuses the other kind's records as
     `WrongDocKind`, and a `Tab` whose board or grant id isn't 22 base64url characters as
     `BadText`. A session's invariants: one live `SessionMeta`, only session records, at most
     2,000 tabs counting tombstones. `session_genesis` builds one.
   - **Database v7** (`store.rs`): `boards.kind` (default `'board'`), `session_grants` and its
     index on `board`. Additive, so the floor stays 5 and a v6 server opens it. Every link lookup
     joins `boards.kind` and returns a `RoomKind`. A grant and its links row are written in one
     transaction that refuses if the adder's board link or the adding session link was revoked
     meanwhile, or if the session holds 2,000 live grants.
   - **One auth check** (`crates/server/src/auth.rs`, `resolve`): a Bearer link, or a grant as
     `Authorization: Grant <session>.<grant>.<session token>` on HTTP and `Auth.via` on the
     socket. The four checks of §3.4 in order, and role `min(session role, grant role, edit)`.
     Every board route goes through it (`api::require_link`, `require_manager`,
     `replays::role`), and each asserts its kind. This is `BoardAuth` as a function, not an axum
     extractor, so each route keeps its own error bodies (the characterisation pins them).
   - **Endpoints** (`crates/server/src/sessions.rs`): `POST /api/sessions`
     `{ title, board?, board_token?, role? }` → `{ session, owner_token, tab?, grant? }`, and
     `POST /api/sessions/{s}/grants` `{ board, board_token, role? }` → `{ grant_id, board, role }`
     (201, or 200 with the existing grant), and `DELETE /api/sessions/{s}/grants/{g}` (204).
     Session links are the board handlers with `RoomKind::Session`:
     `/api/sessions/{s}/links` (mint, list), `/links/{link}` (revoke), `/owner/rotate`.
   - **Revocation** (`room.rs`): a peer that came through a session records `link_hash` = the
     grant's and `via_hash` = the session link's; `Revoke` matches either. A committed edit that
     deletes a `Tab` sends `Revoke` with that grant's hash to the board's room, after the commit.
     A session link's revocation or rotation sends `Revoke` to every open room. After joining,
     the socket resolves the whole chain again (the M5 race check, now with the tab).
   - **Tests**: characterisation of board auth first (`crates/server/tests/sessions.rs`, passing
     on main 262d507 before any change, and unchanged after), then §9.2 in the same file, the
     schema's in `validate.rs` `mod sessions`, and a v6 database in use migrating to v7
     (`store.rs`). Mutation testing over the auth and grant checks: the phase report.

   Decisions taken where this spec left a choice (the conservative option each time):
   - `POST /api/sessions` may also make an empty session (no board). It counts against the board
     creation limiter and `MAX_BOARDS` either way; made from a board, its grant also counts
     against the per-address grant limit.
   - The first tab's name, when the server makes it, is the board's title cut to `max_name` (24),
     as `TabName` allows. A grant's label is "Session: <title>" cut to `max_label` (40), as the
     title was when it was added.
   - **Download** (`/export`) is allowed through a session, as clone is (§3.5): both copy what a
     viewer can see.
   - A grant credential on a link-managing route is refused before anything is looked up (403
     "this link cannot share"); on `POST /grants` it's refused too, so a grant can't be passed on
     (no grant of a grant, v1).
   - Errors don't say which check failed: a bad board link, a revoked one, another board's or a
     session's all read 403 "not a link to this board"; on the socket every failed check is
     `Unauthorized`. A session room that can't load (busy) fails the tab closed: `Busy` on the
     socket, 503 on HTTP.
   - The 2,000 live grants cap answers 409 "session full".
   - The edit cap in the role (`min(…, edit)`) is redundant today, because a grant is never more
     than edit, and kept as defence in depth (an equivalent mutant: it survives mutation).
   - **Security review fixes (2026-11-12).** An adversarial review found six things; all fixed on
     the branch, each with a test that failed first:
     1. a grant could only be cut from the board's side: `DELETE /api/sessions/{s}/grants/{g}`
        (§3.7) lets the session's owner or the grant's adder withdraw it;
     2. any link, a view link too, could write unbounded "Session: …" rows on a board: adding
        again returns the live grant (§3.2), and a board holds 50 live grants (§3.8). B's link
        list shows revoked grant rows marked revoked, as it shows every revoked link: it hides
        none, so this didn't change;
     3. revocation sent `Revoke` to each room in turn from the request: one full mailbox, or a
        dropped request, left later rooms un-revoked. Each room is now sent to from its own task,
        after the commit;
     4. removing one of two tabs with the same grant revoked it for both: `Revoke` now waits for
        the last live tab, and a delete of an already removed tab sends nothing;
     5. `Ready` carries the room's `kind` (§3.6);
     6. a session's listed links were stamped kind `board`; they carry the room's kind now.
     Left as designed: board owner rotation doesn't cut grants (§3.7). Deleting a session must
     revoke its grants' rows on other boards (TD-54).
   - Not built, because what they hang on isn't built: board expiry (§9a: no board is ever
     deleted yet, so the matrix's "board expired" column can't be tried) and deleting grants of
     tabs removed 30 days ago (§3.7). Both are in docs/tech-debt.md (TD-54, TD-55).
2. **Client: the session view.** The `/s/` route, the session connection, the strip, keyed
   remount (no pool yet), `?tab=`, the add paths (Your boards, Paste link), remove/undo, rename
   and reorder, the toast, Your boards listing sessions, "+ Add game" on a board (§7.3), and the
   §9.1 isolation matrix. Validate in a real browser before deploy.
3. **Speed: remembered state and warmth.** `TabView`, the timeline cache, `RoomPool`. Measure
   switch times first. Add each piece only if it pays.
4. **Follow across tabs.** `seat`, `tab` and `session_role`, the `session.tab` registry row and
   the `Id` kind, the follow chip's "No access", and §9.3.
5. **Polish.** Strip details (match, winner, tier, job status), Load a game and New board from
   the strip, the overflow list, the phone Games sheet, and the mapcro:// session links.
6. **Later.** Adding a tab from another session (a grant of a grant), cloning a session (open question 11), a series scoreline, and
   cross-game build comparison.

## 11. Risks

- **Board was never unmounted.** Phase 0 can turn up leaks the scan didn't see: a store in a
  closure, a `document` listener, a WASM handle. The isolation matrix and the ledger are the
  net, and phase 2 doesn't start until phase 0 is green.
- **A board route missed by `BoardAuth`.** That fails closed (the feature breaks, nothing is
  exposed), but a route that hand-parses `Bearer` and skips the kind check would be a hole. The
  router-table test (§9.2) is the guard. All of them go through `auth::resolve`.
- **Kind confusion** in shared tables (§3.6). Types plus the router-table test cover it.
- **People confuse removal with revocation.** The remove toast says only "Removed". The add
  dialog and the docs say that B's owner can cut a session off from B's Share list. That list
  will grow "Session: …" rows.
- **NAT socket budget** halves for people in a session (§3.8). Watch `sockets per address`
  refusals in the stats after deploy. If LAN events hit it, give session-derived board sockets
  their own allowance rather than raising the global cap.
- **One history over two documents** (§7.2). The client merges the session stack and the
  current board's stack by local time. Risks: an entry that the server refuses on one side must
  not block the other; and remote edits that make an entry a no-op skip it as they do today. If
  this proves unworkable, report it to the operator before falling back to two stacks.
- **Session room auth on every tab open** adds a lookup (check 4). It is cheap (one in-memory
  room), but it makes board auth depend on the session room loading. A session over its caps,
  or a busy server, therefore blocks its tabs: they fail closed and retry with backoff.
- **The `Id` value kind** widens the registry's kinds by one. It's held to "a record id, shape
  checked only".

## 12. Operator decisions (2026-11-11)

All as proposed except 10 and 11:

1. Removing a tab cuts session access at once; people on it move to its neighbour; undo restores.
2. The add dialog offers "Can view".
3. Adding delegates edit (capped at the adder's role and at edit).
4. The internal cap of 2,000 tab records is fine as "no hard limit".
5. Session editors can be followed on a view-only tab.
6. Session viewers see who is on which tab.
7. Vision and map layers are remembered per tab.
8. Session grants appear in the board owner's Share list, revocable there.
9. No Whiteboard tab, no "scenes per game" filter.
10. **Changed: one undo**, not two (§7.2). Two undos would confuse: people press the undo button to
    undo a removal. If one merged history causes problems, raise it.
11. **Changed: cloning a session clones every board** too. A clone exists to edit without touching
    the original, so it never links the source boards.

The original questions follow, for the record.

### Questions as asked

1. **Removing a tab blocks access through the session at once.** People on that tab are moved
   to its neighbour, and undo restores the tab. Is that right? (The alternative is that removal
   only hides the tab, and the grant stays usable until it is revoked.)
2. **Should the add dialog offer "Can view"?** It would let an editor add a board view-only for
   the session even though they hold edit. The default is the adder's role, capped at edit.
3. **Adding delegates edit.** Session editors get edit on boards the adder could edit. Is that
   intended? (The alternative is that grants are view unless the adder opts in to edit.)
4. **"No hard limit":** is an internal cap of 2,000 tabs per session, removed ones included,
   fine? It shows only as "Session full".
5. **On a view-only tab, can session editors be followed** by session members (§6.3)? Today §8
   allows following only people with edit rights on the board.
6. **Who is on which tab**: should session viewers see it as well? This draft says yes, like the
   people list.
7. **Vision and map layers** are device-wide today, so the same on every tab. Should they be
   remembered per tab instead, as time and scene are?
8. **B's owner sees session grants** in B's Share list as "Session: <title>" and can revoke
   them. Is that the right place?
9. **No Whiteboard tab** (§7.4): a board without a match is just a tab. And scenes stay inside
   their own boards, so the old "scenes per game" filter isn't built. Is that agreed?
10. **Undo for the strip**: its own stack, used from the toast and with Ctrl+Z when the strip
    has focus, separate from the map's Ctrl+Z. Is that agreed?
11. **Cloning a session** (later): should it clone every board, or make a new session that links
    the same boards?
