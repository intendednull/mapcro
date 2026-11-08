**Date:** 2026-11-07
**Status:** pre-public adversarial review of the match-import **replay tier**, before first deploy to the shared `web` box at https://mapcro.dmgdeadlock.com
**Reviewer:** a fresh Claude Opus subagent, adversarial, read-only on the repo. Static review of the reviewed commits plus a release build of `mapcro-server`/`mapcro-replay`; mechanism proofs run on 127.0.0.1 with temp dirs. Scratch and scripts under `(local scratch: /tmp/mapcro-secreview-3/)`.

# mapcro replay-tier security review (3)

Scope: `crates/replay` (288e98f), server endpoints + NixOS module + VM test (a81753d), web panel (9004092), docs (acfbd4d), the dropped-upload fix (d4933f4), and tier selection in `matches.rs`/`replays.rs`. The four §11 trust boundaries were each walked. Prior reviews (2026-11-06, -07) re-read for format and standing findings.

Severity counts: **Critical 0, High 0, Medium 2, Low/Info 6.**

**Blocks deploy: NO.** Every replay route requires a capability link to the board (edit for upload/fetch, any link to read); there is no anonymous, remotely-reachable path to a crash, disk-fill, SSRF, or host rollback. Both Mediums are post-compromise defense-in-depth (they presuppose a memory-safety compromise of the worker — the very thing the sandbox exists to contain) and are cheap fast-follows. Sandbox, caps, SSRF closure, output re-validation, cleanup, and deploy-gate isolation all hold.

---

## MEDIUM

### M1. Shared inbox is symlink-followable: a queue-writing process can make the *server* truncate/overwrite files outside the queue (its SQLite DB, the cache)
**Files:** `crates/server/src/replays.rs:441` (`tokio::fs::File::create(&part)` -> `O_WRONLY|O_CREAT|O_TRUNC`, no `O_NOFOLLOW`/`O_EXCL`), `:402`/`:425` (the drop guard `remove_file` unlinks the symlink, not its target), `nix/module.nix:83` (inbox `2770 mapcro-replay:mapcro-replay`), `:134` (`SupplementaryGroups=[mapcro-replay]` on the server).

The inbox is read-write to both the server (`mapcro`) and the worker (`mapcro-replay`) through the shared group. The worker parses hostile demos. If a process that can write the inbox plants `inbox/.<job>.part` as a **symlink** to a path the *server* can write (its own `DATA_DIR/mapcro.sqlite`, or anything under `DATA_DIR`), the server's next upload to that job opens the part file with `File::create`, which **follows the symlink and truncates the target to zero**, then streams up to 800 MiB of attacker-chosen body into it. The 8-byte magic gate only decides whether bytes are *also written* after the truncation — the destruction happens on open regardless. One step corrupts every board's durable state, from inside the queue.

- **Precondition:** write access to `inbox/` — i.e. a compromised worker (a boon memory-safety bug reached by a malicious `.dem`). No remote/unauthenticated actor can plant the symlink (the upload path only ever creates a server-named part file, never a symlink). So this is strictly a *post-compromise escalation* that lets an otherwise-contained worker reach out of the queue and destroy the server's state — most of the isolation value the sandbox exists to provide.
- **Status: proven mechanism.** `scripts/open_follows_symlink.py` reproduces the exact `open(O_CREAT|O_TRUNC)` without `O_NOFOLLOW` that `File::create` performs: a pre-existing symlink at the part path is followed and its target truncated+overwritten (240 B stand-in DB -> 21 B of `PBDEMS2\0ATTACKER BODY`). The precursor worker RCE is **hypothesis** (no boon bug demonstrated). End-to-end against the live upload route not run: the shared box ran another project's verify the whole window and the cached pre-built binary predated the replay commits; settle with `scripts/check_inbox_symlink.py` against a fresh build.
- **Fix:** create the part file with `O_EXCL|O_NOFOLLOW` (`OpenOptions::new().write(true).create_new(true).custom_flags(O_NOFOLLOW)`) so a symlinked/pre-existing path fails instead of being followed; and/or an unguessable part suffix. Best: don't share a writable dir — let the server own `inbox/` (worker reads+deletes only).

### M2. A compromised worker can poison any match's (and the shared CDN's) timeline cache for every board
**Files:** `crates/server/src/replays.rs:661-690` (`collect` caches any `done/<job>.json` whose `valid_job` passes and whose `match_id` equals the job's), `crates/replay/src/worker.rs:110-118` (the worker names its own `done/` outputs), `lib.rs:valid_job` (charset/length check only).

The server trusts the *presence and name* of a `done/` file. A compromised worker can write `done/<anyMatchId>-cdn.json` (the shared, every-board CDN scope) or `done/<anyMatchId>-<anyScope>.json`, and the server will shape-validate and serve it as the replay timeline for that match to every board, regardless of which job it dispatched. `validate()` bounds the content (shape, ranges, `match_id==job`, short control-free names) so the data is well-formed — but it is attacker-chosen and globally visible. Same precondition as M1.
**Fix:** only accept a `done/` result for a job the server dispatched and is tracking as `parsing`; drop unknown job outputs. Pair with M1's ownership change.

---

## LOW / INFORMATIONAL

- **L1 — Demo fetched from Valve over plaintext HTTP, no integrity check.** `replays.rs:574` builds `http://replay{cluster}.valve.net/...`; the salt is secrecy, not integrity. An on-path attacker could swap the demo. Contained: parsed only in the sandbox, output re-validated, so worst case is a well-formed wrong timeline cached under the shared `cdn` scope. Matches Valve's real (http) CDN. Prefer https if available; at least note the trust assumption.
- **L2 — In-game player names (personal data) are kept on the replay tier and readable by any board link, including view.** `timeline.rs:45`, `parse.rs:190`, `derive.rs:199-201`. By design (operator). No Steam/account ids — `m_steamID` is never resolved (`parse.rs`). Flag so it stays a conscious choice.
- **L3 — `validate()` permits HTML metacharacters in names.** `timeline.rs:148` rejects only control chars + length; `<>&"` pass. Safe today only because the Solid client escapes every string under a strict CSP (prior review L2). Server output is not self-safe — it relies on the client. Consider rejecting `<>&"` in names.
- **L4 — Feature-level DoS of parsing/fetching.** One worker, one job at a time, up to 300 s each; an edit-link holder enqueues up to 6 jobs and a few clients can saturate the queue; the server-wide 20 fetches/hr can be spent by one edit-link holder. The *box* stays healthy (one core, low weight, idle IO, memory hard-capped). Availability of the feature only; consider per-board fairness later.
- **L5 — SIGBUS from a truncated/mutated mmap'd demo is contained but mislabeled.** boon mmaps the demo (`boon .../parser.rs:146`, the sole `unsafe`). A truncation while mapped faults the child (SIGBUS); `worker.rs:run_child` maps any signal death to `too_large` and carries on. Correctly contained (parse in a child); reason code is wrong. Only the single-threaded worker touches `work/`, so the trigger needs the M1/M2 precondition.
- **L6 — Minor benign races.** `room()` TOCTOU is bounded by `uploads_at_once=2`/per-client=1 and the conservative `(in_flight+1)*cap` reservation; the `failed` map is lost on restart (re-reads as `none`, retriable — intended). No security impact.

---

## Trust-boundary walk (spec §11)

- **B1 (edge->server):** upload needs owner/edit link (401/403), body limit lifted **only** on the upload route (`:142-148`, `main.rs:139-141`), 800 MiB on received bytes *and* up-front Content-Length, idle+total timeouts, 2-at-once + 1-per-client + 6/hr, queue 6 jobs/3 GiB with in-flight reserved, magic gate, partial files cleaned on every exit incl. dropped conn (drop guard, d4933f4 — correct). Holds. Residual: M1.
- **B2 (upstreams->server):** salts capped 64 KiB; only `cluster_id:u32`+`replay_salt:u64` taken; URL built from numbers (cannot leave valve.net); `max_redirects(0)`; 800 MiB + 30 min; magic-gated. **No SSRF.** Residual: L1.
- **B3 (queue->worker):** decompression streamed under `take(max+1)` -> `too_large` (bz2+zstd), zstd `window_log_max(27)` caps the window to 128 MiB, parse in a child under 300 s + the 1 G cgroup. **Bomb-safe.** Residual: M1/M2.
- **B4 (worker->server):** output <=4 MiB, typed deserialize, every array length = duration+1, numbers in range, keys pack-shaped, names short/control-free, `match_id==job`, then re-serialized. **Re-validated before serving.** Residual: L3.

## Availability of the shared box

- **Deploy cannot roll back the host on a bad worker.** The `/healthz` gate (infra `lib/mkHost.nix:39-46`) probes only app *ports*; `mapcro-replay` has none, so a down worker is never probed. `switch-to-configuration` does not exit non-zero when a `wantedBy=multi-user.target` service fails to start, and deploy-rs `magicRollback` is connectivity-only (infra `flake.nix:95,106`). The server's `/healthz` is worker-independent. `startLimitBurst=8/900s` caps a crash loop. Confirmed in infra.
- **Memory:** `MemoryMax=1G` + `MemorySwapMax=0` — a cgroup-v2 hard limit; a crafted demo is OOM-killed inside the worker cgroup (child dies -> `too_large`), never box-wide. Real anonymous use ~19 MB; the rest is reclaimable mmap. The 4 GB box is safe.
- **Disk:** queue 3 GiB + one expanded demo <=1 GiB + cache 1 GiB ~= 5 GiB bounded vs a ~40 GB box; enforced (`room`, `trim_cache`).
- **CPU:** `CPUQuota=100%` (one core), `CPUWeight=20`, `Nice=10`, `IOSchedulingClass=idle`.
- **Cross-board (no compromise):** uploads scoped by `hash(board)[..16]`; the upload path never writes the shared `cdn` scope (only `fetch()` does, from Valve); A cannot read/write B's timeline. Isolated. (M2 breaks the CDN scope *with* a worker compromise.)
- **Privacy:** account/steam ids never resolved; names kept by design (L2).
- **Cleanup:** demo + decompressed copy removed on every worker path; server removes partial uploads on every exit and sweeps stale inbox files. No leak.

## Live checks

`scripts/open_follows_symlink.py` — PROVEN the `open(O_CREAT|O_TRUNC)` symlink-follow + truncate that underlies M1. `scripts/check_inbox_symlink.py` / `scripts/lib.py` — harness to confirm M1 end-to-end against a fresh `mapcro-server` once the shared box frees (the cached binary predated the replay commits; a HEAD build was queued behind another project's verify for the whole window). No real demo was read or copied; all test inputs were synthetic.
