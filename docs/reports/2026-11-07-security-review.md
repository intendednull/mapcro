**Date:** 2026-11-07
**Status:** pre-public adversarial review (second pass)
**Reviewer:** a fresh Claude Opus subagent, adversarial, read-only on the repo, exploit scripts run against a release build on 127.0.0.1.

# mapcro security review (2)

Scope: server crate (axum + SQLite), engine `authority`/`wire`, schema `validate`, the new browser client under `web/src`, `nix/module.nix`, and the §11 threat model. Built with `nix develop -c cargo build --release -p mapcro-server` into a temp target, run on loopback with temp `DATA_DIR`/`PACKS_DIR` and `PUBLIC_ORIGIN=http://localhost:<port>`; every server killed before finishing. Scripts and raw output under `(local scratch: /tmp/mapcro-secreview-2/)`.

Prior Highs (H1 ClientId takeover, H2 view-token durable rejection spam, H3 unbounded op log) and all Mediums re-checked. H1, H2, M4, M5 are fixed and verified. H3 remains open and its real exposure is a trivially-reachable, self-perpetuating full-server crash. The view token is still a durable-write primitive, now via a different table. XSS is closed.

Severity counts: **Critical 1, High 2, Medium 2, Low/Info 4.**

**Going public:** the Critical blocks it. One anonymous HTTP request plus one WebSocket puts the whole instance into a restart loop that kills every board, and it survives restarts. Ship an op-log cap/quota first (C1). Everything else can follow.

---

## CRITICAL

### C1. Unbounded op log -> OOM crash-loop that takes down the entire server, from one anonymous client
**Files:** `crates/server/src/store.rs:173` (`base_seq` inserted as 0, never updated; no snapshot/prune exists), `:184-223` (`load_board` reads the entire `ops` log into a `Vec<Tx>`), `crates/server/src/room.rs:90-100` (replays the whole log into the in-memory `Authority`), `crates/engine/src/authority.rs:211-221` (every accepted `Submit` pushes to an unbounded `log: Vec<Tx>`), `crates/server/src/ws.rs:15` (`MAX_FRAME = 256 KiB`), `:20-21` (60 tx/s).

This is known-open H3; the point is its exposure, which is Critical. Board creation is anonymous (`api.rs:101`, no auth) and returns an owner (edit-capable) token. The 5000-record cap bounds doc size, not log length: repeatedly `Set`ting one field (a 4000-char note) is LWW, so the doc stays tiny while `ops` grows forever. Each `Set` can be a 256 KiB frame of 62 ops. No per-board op cap, no durable-write quota, no total-board/disk cap.

**Evidence (`h3_growth.mjs`, `h3_oom.mjs`):**
- One socket streaming max-size notes drove **13.3 MB/s** durable SQLite growth (782 tx / 198 MB in 15 s); RSS ~203 MB.
- Cold-loading that board pushed RSS from 7.7 MB to **392 MB** (full log resident).
- Under `MemoryMax=256M` (infra default for a systemd app, `lib/mkApp.nix` sets `MemoryMax = mkDefault "256M"`), the server was **SIGKILLed after ~20 s** (1026 tx).
- After restart on the same data, **merely opening the poisoned board OOM-killed the server again**, and dropped an unrelated board's live session on the same instance. With the module's `Restart=on-failure`/`RestartSec=1` this is a tight crash loop; the poison is durable so it never clears.

**Fix (interim, before real §9 snapshot+prune):** cap the op log per board (refuse/close `Submit` once `log.len()` >= N or on-disk size exceeds a quota) -- the single change that closes the Critical; add a per-board durable-write byte/rate budget; lower `MAX_FRAME` toward the 16 KiB HTTP-body limit; add a total-board/disk cap + alerting; set `StartLimitIntervalSec`/`StartLimitBurst` so one poisoned board degrades to a single 500 instead of taking the box down (raising `MemoryMax` only delays); then implement §9 snapshot/prune.

---

## HIGH

### H-A. Any board past ~4096 ops becomes permanently unloadable by a fresh or far-behind client
**Files:** `crates/server/src/room.rs:14` (`OUTBOX_DEPTH = 4096`), `:333` (per-connection outbox of that depth), `:370-376` (`try_send`; full outbox -> `close(TooSlow)`), `crates/engine/src/authority.rs:183-185` (a `Hello` with `last_seq=0` queues an `Entry` for every log position in one batch).

A client joining with no local copy (`known_seq = null`: fresh device, cleared browser, or anyone far behind) gets one `ServerMsg::Entry` per logged op, all pushed into the 4096-deep outbox at once. Past ~4096 ops the outbox fills, the room drops the connection, the client reconnects, repeat. The board becomes readable by nobody new, permanently. Independent of the memory issue: a legitimately busy board (60/s for a few minutes) reaches 4096 ops and silently stops admitting fresh viewers -- exactly the §8 coaching workflow.

**Evidence (`catchup_tooslow.mjs`):** on a ~6000-op board, three consecutive fresh-device joins each received exactly **4096 entries then the socket closed**, every time. A 783-op board loaded fine, pinning the cliff between.

**Fix:** paginate catch-up with backpressure (await capacity / window the entries) instead of dropping; really, serve a snapshot + short tail (C1's §9 work) so catch-up is O(doc) not O(history). Raising `OUTBOX_DEPTH` only moves the cliff.

### H-B. A view token is still an unbounded durable-write and memory-growth primitive (via the clients table)
**Files:** `crates/engine/src/authority.rs:137-158` (`hello` registers any new `ClientId` for any role -- it runs from `Conn::Connecting` before role gating -- emitting `Effect::ClientRegistered`), `crates/server/src/room.rs:362-363` -> `crates/server/src/store.rs:250-260` (`add_client`, a durable `INSERT OR IGNORE` under `synchronous=FULL`), `room.rs:98-100` (every stored client replayed into an in-memory `BTreeMap` on load). No cap on distinct clients per board; `clients` is never pruned.

H2 (durable rejection spam) is fixed -- a view `Submit` now closes the connection and stores nothing. But the same lowest-privilege credential (§11 calls it harmless) can still force unbounded durable writes: each connection may `Hello` once, and a `Hello` with a fresh `ClientId` + any secret writes a permanent `clients` row with an fsync. Churning connections (bounded only by 32 sockets per IP /64 and setup rate) accumulates rows that are never pruned and are all loaded into memory on every cold start.

**Evidence (`clientchurn.mjs`, `fixes.mjs`):** from a view link, 752 connect+Hello cycles in 8 s grew the DB ~4.0 MB (~94 durable registrations/s), no limiter trip. In `fixes.mjs`, 100 view `Submit`s wrote 0 durable bytes (H2 fixed) while one `Hello` wrote one 4120-byte WAL frame, confirming the write is per-new-client.

**Fix:** cap distinct clients per board (close further `Hello`s as abuse past the cap); prune `clients` at snapshot time; consider registering a client only on its first edit, so a pure viewer never writes.

---

## MEDIUM

### M-A. Per-IP limits key on an IPv6 /64, still rotatable; global board cap is the only real backstop; no total-board/disk cap
**Files:** `crates/server/src/api.rs:62-73` (`client_key` collapses IPv6 to /64), `:41-58` (30/IP/hr, 500/hr global defaults), `crates/server/src/ws.rs:24,51-59` (`MAX_SOCKETS_PER_IP = 32`, keyed on /64). Prior M2 is mitigated (per-/64 + global cap) but not closed: a routed /56 or /48 (common) presents many /64s.

**Evidence (`probes.mjs`):** 30/40 creations allowed from one IP (limit works); **40/40** allowed when rotating the /64, bounded only by the 500/hr global cap. Socket cap: exactly 32 sessions from one /64 before `429`, then rotate the prefix. The global cap bounds creation rate but not total boards; with C1's unbounded per-board growth, disk exhaustion is reachable while respecting every limit.

**Fix:** key creation/quota on a wider prefix (/56 or /48) or add proof-of-work; add a total-board and disk-usage cap; bound the still-unbounded `windows` map.

### M-B. No cap on concurrent rooms/clients resident in memory
**Files:** `crates/server/src/room.rs:59` (`MAX_SESSIONS = 64`/room, good), `ws.rs:24` (32 sockets/IP /64, good), but nothing caps distinct *boards* a source can hold open, nor distinct `ClientRecord`s accumulated per room (`authority.rs:39`). Each open board holds its full doc + log in memory (C1); each distinct client adds a record. Opening many boards (within the rotatable socket cap) multiplies C1's per-board memory.
**Fix:** cap concurrent open rooms globally and per source; prune idle `ClientRecord`s; §9 snapshot bounds per-room memory.

---

## LOW / INFORMATIONAL

- **L1 -- CSP `style-src 'unsafe-inline'` (unchanged).** `main.rs:100`. `MapView` injects a `<style>` for pack art (`map/MapView.tsx:99-101`), needing inline style or a nonce. script-src is tight (`'self' 'wasm-unsafe-eval'`); `object-src` falls back to `'self'` not `'none'`; `base-uri`/`frame-ancestors` are `'none'`. Low risk: no user data reaches any inline style (palette indices / operator pack URLs only). Consider a style nonce and `object-src 'none'`.
- **L2 -- XSS: verified closed (prior hypothesis resolved).** Every user string (title, scene name, callout, note, roster/display name, link label, presence) renders through Solid JSX text/attribute interpolation (auto-escaped) or `document.title` (text, `Board.tsx:212`). The only `innerHTML` props are `Ico` components and `Board.tsx:306`, each fed a module-constant SVG path (`board/tools.ts` etc.) -- no user/peer data. No `href="javascript:"`, no user data in `href`/`src`/`style`; SVG `<text>`/`<title>`/`data-*` are escaped. Server-side `check_text`/presence validation is defence in depth.
- **L3 -- `OrderKey::between`/`midpoint` underflow (unchanged, not server-reachable).** `schema/src/ids.rs:116` (`dh - dl` underflows if `lo >= hi`). Server only calls `is_valid`, never `between`; the TS port uses `Math` and can't panic. Client-robustness nit; use `checked_sub`.
- **L4 -- token handling sound.** 256-bit tokens, stored only as SHA-256; token lives only in the URL fragment (`core/api.ts:64-73`), sent only in the WS `auth` frame body (`session.ts:182`); mint/clone/rotate use an `Authorization` header on POST/DELETE, never path/query; tokens never logged; `referrer-policy: no-referrer` set. localStorage/IndexedDB hold tokens per-device by design. Share dialog shows a token only on the minting device.
- **L5 -- SQLite injection: none; pack path traversal: none.** All queries parameterized (incl. `substr(hash,1,16)=?2`). `packs.rs:84-88` (`safe_relative`) rejects absolute/`.`/`..`/empty/backslash; served files are the hash-checked manifest allow-list only; MIME is an allow-list.

---

## Threat-model (§11) delivery check

- Guessing links (256-bit): OK (L4).
- Link leakage (fragment, no-referrer, revocation, labels): OK. Revocation now instant and verified -- a revoke closes the live socket (`closed=revoked`) and the token is refused on reconnect.
- Malicious edit-link holder (typed ops, caps, rate limit, owner restores): partial. Op validation/size caps hold, but an edit (or anonymous owner) holder grows the op log without bound (C1), and "owner restores from version history" does not exist (§9 unbuilt).
- Cross-site WS hijacking (Origin allow-list): OK, verified -- only exact `PUBLIC_ORIGIN` accepted; `https://evil`, empty, `null` get 403. No cookies.
- XSS (text only, strict CSP): OK (L2); CSP slightly loose (L1).
- Storage spam (per-IP limit, max board size, idle expiry): weak. Per-IP limit /64-rotatable (M-A); max board size does not bound op-log length (C1) or the clients table (H-B); idle unload works; no total-board/disk cap.
- Room flooding (max sessions, presence rate limit, message cap): OK -- 64/room, 32/IP, 60/s + 256 KiB frame. The 256 KiB cap is itself the C1 amplifier.
- Hosting abusive content (no uploads): OK.

Omissions worth noting: the view token as durable-write/memory primitive (H-B), the op-log/catch-up cliff making busy boards unloadable (H-A), and the absence of any total-board/disk quota. Presence role-stamping is correctly server-side (`room.rs:236-246`, view drag stripped; `wire.rs:138-146`). Snapshots, version history/restore, compaction remain unbuilt (§9).

Verified-fixed from the prior review: H1 (ClientId bound to a per-client secret; claiming another's id returns `Fatal "client id belongs to another client"` and leaves the victim undisturbed), H2 (view `Submit` closes and stores nothing -- 0 durable bytes for 100 attempts), M4 (owner-token rotation works; old refused, new accepted), M5 (post-join revocation re-check `ws.rs:113-119` + atomic `add_link`), M3 (in-place apply with rollback, `schema/src/lib.rs:106-146`), M1 (session + socket caps exist).
