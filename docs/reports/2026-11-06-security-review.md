**Date:** 2026-11-06
**Status:** landed (fixes in commit 7c328e0; see the journal entry of the same date)
**Reviewer:** a fresh Claude Opus subagent, adversarial, read-only, with exploit scripts run against the real server.

# mapcro security review

Adversarial, read-only review of `/storage/projects/mapcro`. Scope: server crate, engine
`authority.rs`, schema `validate.rs`, web `core/`, and the §11 threat model.

**Important:** the repo was being edited live during the review (several server sources changed at
22:27, after an earlier binary build at 22:17). All code citations and exploit runs below were
re-verified against a server rebuilt from the sources as of the final read
(`nix develop -c cargo build -p mapcro-server`, run on 127.0.0.1 with a temp `DATA_DIR`, killed
before finishing). Exploit scripts are under `/tmp/mapcro-secreview/`.

Severity counts: Critical 0, High 3, Medium 5, Low/Informational 6.

---

## HIGH

### H1. ClientId is a disclosed, unbound identity: any link holder can disconnect, impersonate, or silently blackhole other clients
**Files:** `crates/engine/src/authority.rs:119-150` (`hello`), `:152-187` (`submit`);
`crates/engine/src/protocol.rs:214-221` (`ServerMsg::Entry { tx }` carries `tx.client`).

The engine treats `ClientId` as the authenticated identity of a participant, but (a) it is broadcast
to every peer, including view-only peers, inside every `Entry` (each `Tx` carries its `client`), and
(b) `hello` accepts *any* `ClientId` with no binding to the link or connection. Consequences, all
reachable by a holder of a freely-shared **view** link:

- **Forced disconnect of any participant.** `hello` supersedes every other live connection with the
  same `ClientId`, sending it `Fatal("superseded by a newer connection")` (`authority.rs:133-143`).
  An attacker learns a victim's `ClientId` from a broadcast `Entry`, then opens a socket (view token
  suffices — role only gates `Submit`, not `Hello`) and sends `Hello` with that id. The victim is
  cut off and can be cut off again on every reconnect.
- **Edit forgery** (edit token): after claiming a victim's `ClientId`, `submit`'s `tx.client ==
  client` check passes, so the attacker's ops are logged as the victim's.
- **Silent edit blackhole** (edit token): submitting at the victim's `next_cseq` advances the
  server's per-client `next_cseq`; the victim's genuine submit at that `cseq` then hits
  `tx.cseq < rec.next_cseq` and is silently dropped as a "resend" (`authority.rs:157-159`).

**Evidence:** `ex_disclose2.mjs` / `ex_takeover.mjs` against the rebuilt binary:
```
ATTACKER(view): [ 'ready', 'msg:Entry#1:00000000000000001111111111111111' ]
victim id ...1111 => disclosed? true
VICTIM received Fatal / was disconnected by a VIEW-token attacker impersonating its ClientId: true
```
**Fix:** bind the live identity to the connection/link server-side; reject a `Hello` whose
`ClientId` is already live elsewhere instead of superseding it; stop exposing one client's
`ClientId` to other roles, or treat it as strictly non-authenticating.

### H2. A view token forces unbounded durable writes (rejections never pruned); fsync amplification
**Files:** `crates/engine/src/authority.rs:165-186` (view → `Err(Reject::Forbidden)` → stored),
`crates/server/src/room.rs:226-228` (`Effect::Rejected` → `add_rejection`),
`crates/server/src/store.rs` (`add_rejection`, `synchronous=FULL`). No server-side pruning exists
(only the in-memory `rejected.split_off` on a client's own `Hello`, `authority.rs:126`).

Every `Submit` from a view session is rejected, and each rejection is written to `rejections` before
the client is told — under `synchronous=FULL`, one fsync per rejected frame. Rows keyed
`(board, client, cseq)` are pruned only when *that client* sends a higher `pending_from`, which an
attacker never does. So the lowest-privilege credential — called harmless in §11 — has durable
write-amplification. The 60/s per-socket limiter bounds one connection, but there is no per-IP
WebSocket cap (M1), so reconnects/`cseq` rotation are unbounded.

**Evidence:** `ex_rejspam.mjs` with a view token wrote 48 durable rows (all `"Forbidden"`) before the
per-socket limiter tripped; WAL grew ~325 KB; unbounded across reconnects.
**Fix:** do not persist authorization-failure rejections (close a view `Submit` as abuse); cap stored
rejections per `(board, client)`.

### H3. No snapshotting or log pruning — op log grows without bound; cold load replays everything
**Files:** `crates/server/src/store.rs:139` (`base_seq` inserted as 0, never updated — no
`UPDATE boards`/snapshot/prune anywhere), `:151-181` (`load_board` replays the whole `ops` log),
`crates/server/src/room.rs:74-78`.

Spec §9 promises snapshots after 500 ops and retention pruning. Neither exists: `base_seq` is
permanently 0, no snapshot is written, `ops` is append-only with no deletion. The 5000-record cap
bounds document *size* but not op-log *length*: an edit holder can `Set` the same field 60×/s
forever — the doc stays tiny while `ops` grows without limit. Disk fills, and every cold room load
re-applies the entire history (O(total ops)), degrading load latency toward DoS.
**Fix:** implement §9 (snapshot into `base_doc`/`base_seq`, prune `ops` below it, prune resolved
`rejections`); document the exposure until then.

---

## MEDIUM

### M1. No per-room session cap and no per-IP WebSocket connection cap
**Files:** `crates/server/src/room.rs:199-216` (`join`, no limit); `crates/server/src/ws.rs` (no
accounting). §11's "Max sessions per room" is unimplemented. One link holder opens unlimited
sockets; each adds an authority conn + a 4096-deep outbox (`OUTBOX_DEPTH`), and every op broadcasts
O(N) (`authority.rs:173-178`); distinct `ClientId`s accumulate `ClientRecord`s for the room's loaded
lifetime. Memory/CPU DoS (keep one socket alive to defeat the 5-min idle unload).
**Fix:** cap live connections per room and per IP; cap distinct clients per room.

### M2. Per-IP board-creation limiter bypassable (IPv6 rotation); no global board cap
**Files:** `crates/server/src/api.rs:41-64` (`CreateLimiter`, `client_ip`). The limiter keys on a
single `IpAddr`. A client with a routed IPv6 prefix (/64 routine) presents a fresh source per
request; Caddy forwards each as the rightmost `X-Forwarded-For`, giving each its own 30/hour bucket.
No global board cap → creation spam → disk exhaustion; the `windows` map is unbounded within the
hour. The rightmost-XFF choice itself is sound for a correctly-appending Caddy (attacker-supplied XFF
is prepended, not trusted) — the hole is IPv6 rotation, not XFF spoofing.
**Fix:** limit on IPv6 /64 (or /56) prefixes; add a global/table-size board cap or proof-of-work;
bound the map.

### M3. `apply_tx` deep-clones the whole document per transaction
**Files:** `crates/schema/src/lib.rs:358-373` (`let mut scratch = doc.clone();`), called from
`authority.rs:167`. Each edit-role `Submit` clones the entire `Doc` (up to 5000 `Entry`s, notes up
to 4000 chars) before applying. Fill a board near the cap, then spam tiny transactions at 60/s →
repeated full-doc deep clones → CPU/allocator pressure on the single room task. A rejected *edit* op
pays this clone *and* the H2 fsync.
**Fix:** apply in place with rollback, or clone only touched records; validate op shape before cloning.

### M4. Owner link cannot be revoked or rotated — leaked owner token is permanent
**Files:** `crates/server/src/store.rs:259` (`revoke` query `... AND role != 'owner'`),
`crates/server/src/api.rs` (no rotation or board-delete endpoint). Revocation excludes the owner
link and there is no rotation/recovery/delete path, so a leaked owner token grants permanent,
un-revocable full control — contradicting §11's "revocation is instant" and worsened by the
no-accounts design.
**Fix:** support owner-token rotation and/or board deletion under owner auth.

### M5. Revocation race: a session may join after its Revoke is processed (hypothesis)
**Files:** `crates/server/src/ws.rs:53-71`, `crates/server/src/api.rs:193-211` (`revoke_link`:
DB update then `RoomCmd::Revoke`), `crates/server/src/room.rs:177-184` (Revoke closes only
*currently* matching peers). Auth reads the link as valid, then issues `Join`. If the owner revokes
in that window, the `Revoke` command can be handled before the attacker's `Join`, leaving the
attacker joined with a revoked link and no later re-check; the join-retry loop does not re-validate.
**Evidence:** code path only; not won in a test. **Settle it by** a timing harness interleaving
`revoke_link` with a connecting session. **Fix:** re-check `revoked` inside the room on `Join`, or
keep a revoked-set on the room that also evicts later joiners.

---

## LOW / INFORMATIONAL

- **L1 CSP/headers** (`main.rs`): `style-src 'unsafe-inline'` weakens the "strict CSP" claim;
  no HSTS/COOP/COEP (maybe added by Caddy); `object-src` falls back to `'self'` not `'none'`.
  Script-src is otherwise tight.
- **L2 XSS (hypothesis)**: `validate.rs check_text` permits newlines and all non-control Unicode in
  user text; safety depends on the not-yet-present renderer. Unverifiable now.
- **L3 `OrderKey::between`/`midpoint` panic** (`ids.rs:389-416`): `dh - dl` `usize` underflow if
  `lo >= hi`. Not server-reachable (server only calls `is_valid`), but a client/WASM robustness risk;
  use `checked_sub`.
- **L4 Token/timing — OK**: 256-bit tokens compared only after SHA-256 + PK lookup, so timing isn't
  invertible to the token; `link_id` enumeration grants nothing. Working as intended.
- **L5 SQLite injection — none**: all queries parameterized, including `substr(hash,1,16)=?2` and
  path-derived `link_id`/`board`.
- **L6 Log injection/secrets — clean**: tokens never logged; `board` logged only after charset/length
  validation; XFF not logged.

---

## Threat-model (§11) delivery check
- Owner revocation missing (M4); XSS CSP weakened + unverifiable (L1/L2); storage-spam limiter
  IPv6-bypassable with no global cap and no snapshot/prune (M2/H3); max-sessions-per-room NOT
  implemented (M1). Table omits: cross-client identity abuse (H1), bound on durable rejection/op
  growth (H2/H3), owner-token rotation/recovery (M4). Idle-room unload IS implemented
  (`room.rs:150-165`); presence and version-history/restore are not implemented.
