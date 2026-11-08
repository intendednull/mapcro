**Date:** 2026-11-07
**Status:** measurement and diagnosis only; nothing in the app or server was changed
**Code measured:** `7d6cb40` (a `git archive` snapshot, so other agents' in-flight edits didn't leak in)
**Harness:** `web/perf/` and `just perf` (this commit)

# mapcro performance: where the time goes

## Summary

- The server and the network are not the problem. On production with 3 people, an edit takes 6.3 ms p50 from send to ack (RTT about 4 ms), and A's input reaches B's screen in 34 ms p50, 108 ms p95.
- The client is the problem. Any record *creation* by anyone (a stroke, arrow, callout, first toggle of an objective) makes every client rebuild 1,000 to 3,500 DOM nodes: the roster panel, top bar, every token, every callout and the scene cards. That takes 10 to 70 ms per op, depending on board size, on this fast desktop. The sender pays it too, before it saves and sends.
- Every frame received, presence included, re-walks the whole board through Solid's `reconcile`/`unwrap`. That is 2.4 to 10 ms per frame, by board size, and up to 22% of the main thread at 40 peers.
- Remote drags look choppy: the ghost moves at about 15 Hz (68 ms median gap, 100 ms p95), with no interpolation. The client's 50 ms throttle and the server's 50 ms batch beat against each other.
- Presence relay costs O(n²) bytes: 6.4 MB/s out of one 40-peer room, 160 KiB/s into each client. fsync is 3 to 10 ms on real disks and stalls presence behind it, but only matters past about 50 tx/s.

## Setup and method

**Reproduce.** Run inside `nix develop`:

```
just perf local --fs disk  --browsers 3 --seconds 60 --storm 10      # 3 editors, ext4 SSD
just perf local --fs tmpfs --browsers 3 --seconds 60 --storm 10      # fsync taken out
just perf local --fs btrfs --browsers 3 --seconds 60 --storm 10      # btrfs on LUKS NVMe (/tmp)
just perf local --fs disk  --browsers 3 --viewers 3 --seconds 60     # 3 viewers following Ana
just perf local --fs disk  --browsers 3 --peers 10 --seconds 60 --storm 10
just perf local --fs disk  --browsers 3 --peers 40 --seconds 60 --storm 10 --max-load 8
just perf local --fs tmpfs --browsers 0 --peers 40 --seconds 30 --cursor-hz 20 --action-every 1000 --prefill 0
just perf local --fs disk  --browsers 3 --seconds 45 --prefill 0     # empty board (--prefill 1000: big board)
just perf live  --browsers 3 --seconds 55 --storm 10                 # production, gentle (capped at 5 clients, 120 s)
just perf report /tmp/mapcro-perf/out/<run>/raw.json                 # re-analyse a saved run
```

Results go to `/tmp/mapcro-perf/out/<run>/` (`summary.md`, `raw.json`, traces), never the repo. For the server's internal stage timings, build the binary under test from a copy of the tree with `web/perf/server-timing.patch` applied. It is measurement-only and is not applied to the app. It logs per-transaction queue, apply, write, fsync and fan-out times and per-flush presence costs under the `mapcro_perf` target. An unpatched binary works too; the server rows are then empty. The `r9` run used the unpatched binary and matches the patched runs within noise: ack p50 5.1 ms against 4.5 ms.

**What runs.**
- The real release server, with its data dir on the filesystem under test:
  - ext4 on a SATA SSD (`/storage`),
  - btrfs on LUKS on NVMe (`/tmp`, where the soak ran),
  - tmpfs (`/dev/shm`).
- Real headless Chromium from nix (Playwright 1.59), one browser process per person, as on separate machines.
- **Browser instrumentation.** A probe (`web/perf/probe.js`) is injected before the app loads and changes no app code. It wraps:
  - WebSocket send and `onmessage` (the session's handler is synchronous: parse, WASM, Solid, DOM);
  - the WASM exports, at instantiation;
  - `JSON.parse` inside handlers;
  - IndexedDB `put` → transaction `complete`;
  - a MutationObserver (attributes and nodes each frame touched, and which subtrees it rebuilt);
  - `requestAnimationFrame` plus a message-channel task after it, giving "painted".
- **What the people do.** People act at a human pace through the real input surface: hero drags (12 steps over about 360 ms), ink scribbles and objective clicks, a mean of 3 s apart, with mouse hover between actions.
- **The board.** The board starts with 150 creates (strokes, arrows, callouts, objectives, moves) unless noted, so it looks like a used coaching board: about 200 records, 55 KiB of replica state.
- **Extra peers** at 10 and 40 are Node peers. Each is a real `BoardSession` over the real WASM replica on a real WebSocket, acting through the soak's builders (`web/soak/actions.ts`). Each has its own `X-Forwarded-For`, so 40 local peers don't meet the 32-sockets-per-address cap.
- **Clocks.** All timestamps are `performance.timeOrigin + performance.now()`. Across browser processes and Node on this machine they agree within 0.1 ms (measured). Stages are joined per transaction: client id and cseq for edits, and the log seq for server stages.
- **Storm.** In the storm phase, the other editors drag back to back while one observer is traced: a Chrome trace for 5 s, then a CPU profile for 5 s.

**Machine.**
- Ryzen 7 3700X (16 threads), 62 GB.
- The box is shared with other agents and another project. Every local run records its 1-minute load average.
- A run whose load passed 4 (8 for the 40-peer runs, where the harness itself is the load) is marked INVALID and left out, or flagged where used.
- The first two batches ran at load 10 to 64 (a TLC model check plus other soaks). They were discarded and rerun with each run waiting for a quiet machine (no Java, load under 3), one at a time.
- Marginal runs are flagged in the tables:
  - r1 and r2 peaked at 4.8 and 4.7 at the tail of another agent's soak, and match the clean r9 within about 10%.
  - r4 peaked at 4.9; all of it was its own six browsers (it started at 2.0).
- **Invalid and left out:** r8 (btrfs at 40 peers) and the 4-minute memory run's latency numbers. Its heap figures are used, since heap behaviour doesn't depend on load.

**Production.**
- One throwaway board ("Untitled") and 3 browsers, through the owner link only (no links minted).
- 55 s realistic plus a 10 s storm: about 80 s of client time and 103 transactions.
- No extra headers, no ssh, and a watchdog that would stop on any 5xx, 429, page error or server `closed` frame. None fired.
- The client machine was busy then (load 12 to 15). So production's network and server stages (ack, one-way) are upper bounds, and its client-side rows should be read like the local ones.
- RTT to the box: TCP connect and keep-alive `/healthz` both about 4 ms (5 requests).

**Caveats.**
- Headless Chromium on a fast desktop: a laptop is 2 to 4× slower on the client-side rows.
- In the tables, "network legs" means one-way minus the server's own time. Locally that is about 0.5 ms of real network. Its tail is the *receiver's main thread being busy* when the frame arrives.
- The fresh-join base in these runs is the room's snapshot from seq 0. The prefill peer joined first, so later joiners replay 150 entries. This is the designed reuse of a snapshot up to 256 entries stale (§5).

## Latency by setup

Each table shows one run. Rows indented under a stage are its parts. Server rows come from the patched binary.


### Production, 3 editors (client machine at load 12–15: client rows polluted)


| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 103 | 16.1 | 52.8 | 69.6 |
|   A's own apply + render | 103 | 1.60 | 14.4 | 16.1 |
|   A's IndexedDB save (put → commit) | 103 | 13.7 | 38.0 | 50.9 |
| Network + server (A sent → B received) | 206 | 6.40 | 26.6 | 40.6 |
| B: WASM receive() | 206 | 0.10 | 0.30 | 1.80 |
| B: Solid store + DOM writes | 206 | 1.40 | 17.7 | 22.4 |
| B: received → painted | 206 | 11.7 | 42.7 | 54.7 |
| **A input → B painted** | 206 | 33.8 | 108 | 141 |
| A's ack (sent → own entry back) | 103 | 6.30 | 21.8 | 45.7 |
| Presence: A sent → B received | 3043 | 23.6 | 56.6 | 64.3 |
| Presence: B received → painted | 2224 | 7.50 | 19.0 | 24.2 |
| Presence: gap between a remote drag's updates | 846 | 67.8 | 102 | 123 |

### r9: local ext4 SSD, 3 editors, unpatched server
*load average (1 min): max 1.6 during the run, 1.6 2.6 8.0 at start — VALID*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 59 | 11.2 | 51.0 | 63.3 |
|   A's own apply + render | 59 | 2.80 | 18.8 | 20.6 |
|   A's IndexedDB save (put → commit) | 59 | 6.90 | 33.3 | 41.6 |
| Network + server (A sent → B received) | 118 | 5.20 | 17.5 | 34.9 |
| B: WASM receive() | 118 | 0.20 | 0.30 | 0.30 |
| B: Solid store + DOM writes | 118 | 2.70 | 20.8 | 22.3 |
| B: received → painted | 118 | 7.40 | 42.0 | 43.9 |
| **A input → B painted** | 118 | 27.3 | 97.0 | 120 |
| A's ack (sent → own entry back) | 59 | 5.10 | 9.20 | 13.8 |
| Presence: A sent → B received | 3534 | 20.6 | 51.7 | 58.1 |
| Presence: B received → painted | 2159 | 5.30 | 17.1 | 19.7 |
| Presence: gap between a remote drag's updates | 412 | 67.3 | 100 | 101 |

### r1: local ext4 SSD, 3 editors (marginal load)
*load average (1 min): max 4.8 during the run, 3.5 8.9 18.6 at start — marginal (see Machine)*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 113 | 14.7 | 59.7 | 66.4 |
|   A's own apply + render | 113 | 3.20 | 21.5 | 23.7 |
|   A's IndexedDB save (put → commit) | 113 | 10.6 | 38.3 | 45.8 |
| Network + server (A sent → B received) | 226 | 5.10 | 24.2 | 35.8 |
|   server: queue + apply + durable write + fan-out | 113 | 3.82 | 6.76 | 8.56 |
|   network + B queueing (one-way − server) | 226 | 0.53 | 14.6 | 31.6 |
| B: WASM receive() | 226 | 0.20 | 0.30 | 0.60 |
| B: Solid store + DOM writes | 226 | 3.00 | 23.7 | 26.7 |
| B: received → painted | 226 | 10.3 | 44.1 | 56.6 |
| **A input → B painted** | 226 | 31.0 | 108 | 146 |
| A's ack (sent → own entry back) | 113 | 4.50 | 8.70 | 14.6 |
| Presence: A sent → B received | 4552 | 21.9 | 52.0 | 58.8 |
| Presence: B received → painted | 2794 | 7.60 | 17.8 | 22.1 |
| Presence: gap between a remote drag's updates | 956 | 67.6 | 100 | 115 |
| server: apply (validate, sequence, encode) | 113 | 0.05 | 0.10 | 0.45 |
| server: append: INSERT + commit (fsync) | 113 | 3.37 | 6.42 | 8.34 |
| server: append: spawn + lock wait | 113 | 0.02 | 0.06 | 0.22 |
| server: room queue wait (socket → room) | 113 | 0.01 | 0.03 | 4.62 |
| server: fan-out (serialize + queue to peers) | 113 | 0.02 | 0.03 | 0.04 |
| server: presence flush (per batch) | 994 | 0.03 | 0.05 | 0.07 |

### r2: local tmpfs, 3 editors, fsync taken out (marginal load)
*load average (1 min): max 4.7 during the run, 2.9 5.9 12.2 at start — marginal (see Machine)*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 99 | 12.1 | 47.0 | 85.3 |
|   A's own apply + render | 99 | 2.80 | 18.6 | 29.7 |
|   A's IndexedDB save (put → commit) | 99 | 7.60 | 27.3 | 65.0 |
| Network + server (A sent → B received) | 198 | 1.00 | 22.6 | 38.9 |
|   server: queue + apply + durable write + fan-out | 99 | 0.30 | 1.19 | 2.74 |
|   network + B queueing (one-way − server) | 198 | 0.60 | 22.4 | 38.6 |
| B: WASM receive() | 198 | 0.20 | 0.30 | 0.50 |
| B: Solid store + DOM writes | 198 | 2.60 | 21.6 | 26.2 |
| B: received → painted | 198 | 10.4 | 41.3 | 53.7 |
| **A input → B painted** | 198 | 27.3 | 98.2 | 142 |
| A's ack (sent → own entry back) | 99 | 0.80 | 6.20 | 40.6 |
| Presence: A sent → B received | 4383 | 27.9 | 52.0 | 60.0 |
| Presence: B received → painted | 2717 | 6.10 | 17.4 | 20.8 |
| Presence: gap between a remote drag's updates | 810 | 66.9 | 100 | 104 |
| server: apply (validate, sequence, encode) | 99 | 0.05 | 0.08 | 1.78 |
| server: append: INSERT + commit (fsync) | 99 | 0.11 | 0.15 | 0.20 |
| server: append: spawn + lock wait | 99 | 0.02 | 0.14 | 1.45 |
| server: room queue wait (socket → room) | 99 | 0.01 | 0.04 | 0.18 |
| server: fan-out (serialize + queue to peers) | 99 | 0.01 | 0.02 | 0.14 |
| server: presence flush (per batch) | 981 | 0.03 | 0.05 | 0.07 |

### r3: local btrfs on LUKS NVMe, 3 editors
*load average (1 min): max 2.9 during the run, 2.9 5.2 11.2 at start — VALID*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 109 | 15.2 | 48.3 | 54.2 |
|   A's own apply + render | 109 | 2.90 | 19.1 | 21.3 |
|   A's IndexedDB save (put → commit) | 109 | 10.4 | 28.9 | 33.1 |
| Network + server (A sent → B received) | 218 | 10.6 | 34.5 | 51.0 |
|   server: queue + apply + durable write + fan-out | 109 | 9.99 | 12.9 | 14.8 |
|   network + B queueing (one-way − server) | 218 | 0.55 | 26.6 | 37.9 |
| B: WASM receive() | 218 | 0.20 | 0.30 | 0.50 |
| B: Solid store + DOM writes | 218 | 2.80 | 21.0 | 23.9 |
| B: received → painted | 218 | 12.3 | 42.3 | 46.2 |
| **A input → B painted** | 218 | 36.2 | 102 | 136 |
| A's ack (sent → own entry back) | 109 | 10.5 | 32.2 | 50.6 |
| Presence: A sent → B received | 4287 | 22.3 | 52.2 | 69.6 |
| Presence: B received → painted | 2616 | 7.40 | 17.6 | 23.6 |
| Presence: gap between a remote drag's updates | 840 | 68.8 | 100 | 116 |
| server: apply (validate, sequence, encode) | 109 | 0.05 | 0.10 | 0.35 |
| server: append: INSERT + commit (fsync) | 109 | 7.07 | 10.2 | 11.6 |
| server: append: spawn + lock wait | 109 | 0.02 | 0.03 | 0.12 |
| server: room queue wait (socket → room) | 109 | 0.01 | 8.58 | 10.6 |
| server: fan-out (serialize + queue to peers) | 109 | 0.01 | 0.03 | 0.04 |
| server: presence flush (per batch) | 924 | 0.03 | 0.04 | 0.07 |

### r10: ext4, 3 editors, empty board
*load average (1 min): max 2.4 during the run, 2.4 4.0 9.7 at start — VALID*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 37 | 6.50 | 35.4 | 42.0 |
|   A's own apply + render | 37 | 0.90 | 10.1 | 10.1 |
|   A's IndexedDB save (put → commit) | 37 | 5.30 | 25.1 | 31.8 |
| Network + server (A sent → B received) | 74 | 5.20 | 23.4 | 39.5 |
|   server: queue + apply + durable write + fan-out | 37 | 4.81 | 5.63 | 8.10 |
|   network + B queueing (one-way − server) | 74 | 0.43 | 18.8 | 34.9 |
| B: WASM receive() | 74 | 0.10 | 0.60 | 2.70 |
| B: Solid store + DOM writes | 74 | 0.80 | 11.8 | 13.9 |
| B: received → painted | 74 | 8.10 | 28.1 | 34.9 |
| **A input → B painted** | 74 | 20.0 | 68.2 | 83.9 |
| A's ack (sent → own entry back) | 37 | 5.30 | 8.40 | 9.10 |
| Presence: A sent → B received | 1827 | 10.6 | 51.1 | 51.9 |
| Presence: B received → painted | 1335 | 2.90 | 15.2 | 16.9 |
| Presence: gap between a remote drag's updates | 262 | 71.5 | 101 | 101 |
| server: apply (validate, sequence, encode) | 37 | 0.04 | 0.38 | 0.39 |
| server: append: INSERT + commit (fsync) | 37 | 4.58 | 5.28 | 7.91 |
| server: append: spawn + lock wait | 37 | 0.02 | 0.07 | 0.08 |
| server: room queue wait (socket → room) | 37 | 0.01 | 0.02 | 0.03 |
| server: fan-out (serialize + queue to peers) | 37 | 0.01 | 0.02 | 0.07 |
| server: presence flush (per batch) | 525 | 0.02 | 0.03 | 0.04 |

### r11: ext4, 3 editors, board with 1,000 creates
*load average (1 min): max 1.4 during the run, 1.1 3.3 9.1 at start — VALID*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 36 | 30.9 | 135 | 145 |
|   A's own apply + render | 36 | 11.4 | 67.9 | 75.2 |
|   A's IndexedDB save (put → commit) | 36 | 16.7 | 66.9 | 76.0 |
| Network + server (A sent → B received) | 72 | 5.10 | 17.7 | 44.6 |
|   server: queue + apply + durable write + fan-out | 36 | 4.63 | 5.03 | 5.52 |
|   network + B queueing (one-way − server) | 72 | 0.42 | 12.9 | 39.1 |
| B: WASM receive() | 72 | 0.40 | 1.20 | 3.20 |
| B: Solid store + DOM writes | 72 | 10.3 | 69.4 | 77.2 |
| B: received → painted | 72 | 18.5 | 121 | 129 |
| **A input → B painted** | 72 | 64.7 | 259 | 282 |
| A's ack (sent → own entry back) | 36 | 5.20 | 17.8 | 26.0 |
| Presence: A sent → B received | 2821 | 28.4 | 51.9 | 75.5 |
| Presence: B received → painted | 1693 | 15.2 | 28.4 | 33.3 |
| Presence: gap between a remote drag's updates | 432 | 67.8 | 99.8 | 101 |
| server: apply (validate, sequence, encode) | 36 | 0.04 | 0.36 | 0.41 |
| server: append: INSERT + commit (fsync) | 36 | 4.42 | 4.70 | 4.76 |
| server: append: spawn + lock wait | 36 | 0.02 | 0.02 | 0.16 |
| server: room queue wait (socket → room) | 36 | 0.01 | 0.04 | 3.56 |
| server: fan-out (serialize + queue to peers) | 36 | 0.01 | 0.02 | 0.04 |
| server: presence flush (per batch) | 609 | 0.03 | 0.04 | 0.05 |

### r4: ext4, 3 editors + 3 viewers following Ana (6 browsers)
*load average (1 min): max 4.9 during the run, 2.0 4.2 10.3 at start — marginal (see Machine)*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 49 | 19.6 | 57.0 | 104 |
|   A's own apply + render | 49 | 3.30 | 29.6 | 35.6 |
|   A's IndexedDB save (put → commit) | 49 | 15.3 | 31.6 | 71.0 |
| Network + server (A sent → B received) | 245 | 5.70 | 13.4 | 36.8 |
|   server: queue + apply + durable write + fan-out | 49 | 5.01 | 9.79 | 12.7 |
|   network + B queueing (one-way − server) | 245 | 0.57 | 9.55 | 32.9 |
| B: WASM receive() | 245 | 0.20 | 0.30 | 0.50 |
| B: Solid store + DOM writes | 245 | 3.40 | 29.1 | 37.4 |
| B: received → painted | 245 | 11.7 | 65.0 | 85.6 |
| **A input → B painted** | 245 | 36.0 | 133 | 180 |
| A's ack (sent → own entry back) | 49 | 6.30 | 12.6 | 16.9 |
| Presence: A sent → B received | 8354 | 20.6 | 52.2 | 59.7 |
| Presence: B received → painted | 4376 | 5.90 | 17.0 | 22.3 |
| Presence: gap between a remote drag's updates | 1040 | 68.6 | 100 | 108 |
| server: apply (validate, sequence, encode) | 49 | 0.06 | 0.38 | 0.43 |
| server: append: INSERT + commit (fsync) | 49 | 4.78 | 9.48 | 10.8 |
| server: append: spawn + lock wait | 49 | 0.02 | 0.04 | 0.41 |
| server: room queue wait (socket → room) | 49 | 0.01 | 0.01 | 0.02 |
| server: fan-out (serialize + queue to peers) | 49 | 0.02 | 0.03 | 1.01 |
| server: presence flush (per batch) | 756 | 0.04 | 0.07 | 0.13 |

### r5: ext4, 10 peers (3 browsers + 7 Node)
*load average (1 min): max 1.7 during the run, 1.2 3.0 8.6 at start — VALID*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 115 | 15.1 | 58.2 | 91.3 |
|   A's own apply + render | 115 | 3.70 | 21.1 | 23.9 |
|   A's IndexedDB save (put → commit) | 115 | 9.80 | 34.2 | 72.0 |
| Network + server (A sent → B received) | 1348 | 4.04 | 33.2 | 41.8 |
|   server: queue + apply + durable write + fan-out | 307 | 3.26 | 6.11 | 8.66 |
|   network + B queueing (one-way − server) | 795 | 0.43 | 31.0 | 38.7 |
| B: WASM receive() | 795 | 0.20 | 0.30 | 0.40 |
| B: Solid store + DOM writes | 795 | 3.50 | 23.5 | 27.0 |
| B: received → painted | 795 | 13.1 | 47.2 | 62.0 |
| **A input → B painted** | 230 | 35.4 | 110 | 157 |
| A's ack (sent → own entry back) | 115 | 3.70 | 11.6 | 33.4 |
| Presence: A sent → B received | 22401 | 33.6 | 53.3 | 79.4 |
| Presence: B received → painted | 3117 | 9.10 | 19.1 | 26.3 |
| Presence: gap between a remote drag's updates | 2032 | 62.3 | 99.6 | 114 |
| server: apply (validate, sequence, encode) | 307 | 0.04 | 0.07 | 0.10 |
| server: append: INSERT + commit (fsync) | 307 | 3.07 | 5.90 | 8.47 |
| server: append: spawn + lock wait | 307 | 0.02 | 0.03 | 0.05 |
| server: room queue wait (socket → room) | 307 | 0.01 | 0.01 | 2.52 |
| server: fan-out (serialize + queue to peers) | 307 | 0.01 | 0.03 | 0.03 |
| server: presence flush (per batch) | 1080 | 0.05 | 0.10 | 0.12 |

### r6: ext4, 40 peers (3 browsers + 37 Node, cursors 5 Hz)
*load average (1 min): max 6.5 during the run, 1.1 2.3 7.4 at start — VALID*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 70 | 41.1 | 156 | 353 |
|   A's own apply + render | 70 | 8.00 | 40.5 | 48.6 |
|   A's IndexedDB save (put → commit) | 70 | 30.9 | 120 | 303 |
| Network + server (A sent → B received) | 5866 | 5.53 | 90.1 | 194 |
|   server: queue + apply + durable write + fan-out | 1253 | 2.92 | 4.90 | 7.35 |
|   network + B queueing (one-way − server) | 3462 | 8.84 | 117 | 220 |
| B: WASM receive() | 3462 | 0.30 | 0.40 | 0.60 |
| B: Solid store + DOM writes | 3462 | 7.10 | 50.3 | 62.1 |
| B: received → painted | 3459 | 23.2 | 145 | 218 |
| **A input → B painted** | 140 | 94.6 | 371 | 576 |
| A's ack (sent → own entry back) | 70 | 7.10 | 115 | 208 |
| Presence: A sent → B received | 101355 | 39.9 | 106 | 197 |
| Presence: B received → painted | 4144 | 15.9 | 89.4 | 178 |
| Presence: gap between a remote drag's updates | 8218 | 55.2 | 121 | 159 |
| server: apply (validate, sequence, encode) | 1253 | 0.05 | 0.09 | 0.12 |
| server: append: INSERT + commit (fsync) | 1253 | 2.26 | 4.45 | 6.27 |
| server: append: spawn + lock wait | 1253 | 0.02 | 0.04 | 1.16 |
| server: room queue wait (socket → room) | 1253 | 0.01 | 0.02 | 2.26 |
| server: fan-out (serialize + queue to peers) | 1253 | 0.04 | 0.06 | 0.08 |
| server: presence flush (per batch) | 1507 | 0.34 | 1.11 | 1.35 |

### r7: tmpfs, 40 peers (3 browsers + 37 Node)
*load average (1 min): max 5.5 during the run, 2.8 4.3 6.9 at start — VALID*

| Stage (ms) | n | p50 | p95 | p99 |
|---|---:|---:|---:|---:|
| A input → frame sent | 45 | 42.0 | 137 | 246 |
|   A's own apply + render | 45 | 6.20 | 39.7 | 63.4 |
|   A's IndexedDB save (put → commit) | 45 | 27.7 | 93.4 | 197 |
| Network + server (A sent → B received) | 4470 | 3.06 | 69.7 | 142 |
|   server: queue + apply + durable write + fan-out | 959 | 0.32 | 0.65 | 2.16 |
|   network + B queueing (one-way − server) | 2640 | 8.89 | 87.3 | 538 |
| B: WASM receive() | 2640 | 0.20 | 0.40 | 0.50 |
| B: Solid store + DOM writes | 2640 | 6.20 | 42.7 | 52.5 |
| B: received → painted | 2640 | 21.2 | 119 | 185 |
| **A input → B painted** | 90 | 78.3 | 274 | 490 |
| A's ack (sent → own entry back) | 45 | 5.50 | 59.1 | 83.9 |
| Presence: A sent → B received | 79092 | 37.6 | 92.3 | 169 |
| Presence: B received → painted | 3263 | 16.3 | 79.2 | 153 |
| Presence: gap between a remote drag's updates | 6340 | 55.2 | 110 | 154 |
| server: apply (validate, sequence, encode) | 959 | 0.06 | 0.09 | 0.12 |
| server: append: INSERT + commit (fsync) | 959 | 0.10 | 0.15 | 0.19 |
| server: append: spawn + lock wait | 959 | 0.02 | 0.04 | 0.86 |
| server: room queue wait (socket → room) | 959 | 0.01 | 0.01 | 0.27 |
| server: fan-out (serialize + queue to peers) | 959 | 0.04 | 0.05 | 0.17 |
| server: presence flush (per batch) | 1198 | 0.34 | 1.14 | 1.41 |


## Client profile findings

**1. One remote creation rebuilds most of the UI.** The MutationObserver counts are per frame received, on a board with 150 creates:

| Remote op | handler p50 (ms) | DOM attributes changed | nodes added |
|---|---:|---:|---:|
| `Set:PlayerPos` (hero moved) | 2.7–3.0 | 5 | 0 |
| `Set:ObjectiveStatus` | 3.2 | 2 | 0 |
| `Create:Stroke` | 18.6–22.4 | 3 | ~1,420 |
| `Create:ObjectiveState` (first toggle of an objective) | 19.7–23.7 | 5 | ~1,410 |

The rebuilt subtrees, for every creation, were these (nodes each time):

| Subtree | Nodes | Source |
|---|---:|---|
| `div.slot` | 624 | the roster panel's 12 slots, each with a hero `<select>` of every hero as `<option>`; 60 for viewers, who get no select |
| `div.tb-player` | 186 | the top bar |
| `g.co` | 133 | every callout |
| `g.tok` | 108 | all 12 tokens |
| `button.card` | 102 | the scene strip's cards and their player dots |

The cause:
- `web/src/board/state.ts`'s `live(kind)` scans `Object.entries(records)`, so each memo built on it subscribes to the record *set*. Those memos are `roster()`, `scenes()`, `playersIn()`, `inScene()` and Tokens' `players`.
- A creation or tombstone changes that set, so each memo re-runs and returns *new* wrapper objects: `{ id, slot }`, `{ id, state }`, `{ id, r }`.
- `<For>` keys rows by identity, so it unmounts and remounts every row.

Position changes stay fine-grained (5 attributes), because `reconcile` merges in place and nothing tracks `pos` in those memos.

It scales with board content. On an empty board, 150 creates and 1,000 creates (runs r10, r1 to r3, and r11):

| | Empty board | 150 creates | 1,000 creates |
|---|---:|---:|---:|
| Nodes rebuilt per create | 1,021 | 1,421 | 3,535 |
| Remote create handler p50 (ms) | 10 | 19–24 | 66–70 |
| Remote move handler p50 (ms) | 0.9 | 2.7–3.0 | 10.6 |
| Presence frame handler p50 (ms) | 0.4 | 2.4–2.7 | 9.8 |
| A's input → send, move (ms) | 6 | 11–15 | 28 |
| A's input → send, create (ms) | 24–35 | 40–52 | 117–135 |
| A's own render of its create (ms) | 9 | 18–21 | 68 |
| Replica state saved to IndexedDB per edit | 7 KiB | 55 KiB | 278 KiB |

**2. Every frame re-walks the whole board.**
- `createBoardState`'s `onChange` runs `setRecords(reconcile(Object.fromEntries(s.records)))` and a peers reconcile on *every* session change. That includes every presence frame, though presence changes no record.
- `reconcile` first `unwrap`s the new value: a deep walk of every record, every stroke point included.
- The storm CPU profiles name it. The hottest JS function, in minified code at `index-*.js:3:42208`, is Solid's `unwrap`:

  | Run (observer's CPU profile in the storm) | `unwrap` share of all samples | `unwrap` share of JS self time |
  |---|---:|---:|
  | 3 editors (r3) | 4.2% | about 60% |
  | 10 peers (r5) | 5.5% | |
  | 40 peers (r6) | 22.5% | |

  `reconcile`'s `applyState` comes next.
- At 40 peers the observer's main thread was 74% busy during the storm.
  - 12 long tasks in 5 s; 85 over the run, 4.9 s in total.
  - 22 frames longer than 50 ms; frame-interval p99 was 100 ms.
- With 3 editors it was 20% busy: 0 long tasks and 0 dropped frames in the trace window.

Trace and profile files (not committed):

| Run | Trace | CPU profile |
|---|---|---|
| r3, 3 editors, btrfs | `/tmp/mapcro-perf/out/r3-btrfs-3/trace-Ben.json` | `/tmp/mapcro-perf/out/r3-btrfs-3/profile-Ben.cpuprofile` |
| r5, 10 peers | `/tmp/mapcro-perf/out/r5-disk-10/trace-Ben.json` | `/tmp/mapcro-perf/out/r5-disk-10/profile-Ben.cpuprofile` |
| r6, 40 peers | `/tmp/mapcro-perf/out/r6-disk-40/trace-Ben.json` | `/tmp/mapcro-perf/out/r6-disk-40/profile-Ben.cpuprofile` |
| r1, r2 and production | same layout under `/tmp/mapcro-perf/out/{r1-disk-3,r2-tmpfs-3,live-3}/` | |

Main-thread time in the 5 s storm traces (ms):

| Run | Scripting | Rendering (style + layout) | Paint + composite | GC |
|---|---:|---:|---:|---:|
| 3 editors | 372 | 79 | 103 | 18 |
| 40 peers | 2,033 | 168 | 278 | 78 |

Script dominates. Layout and paint are small, because the SVG is small.

**3. The WASM boundary is cheap.**
- `receive()` takes 0.2 ms p50 and 0.6 ms p99 in the browser, and 0.2 ms in Node.
- `changed` holds 1 record per entry, the `Update` JSON is 270 to 370 B p50 (1.2 KB max), and parsing it takes under 0.1 ms.
- `edit()` takes 0.1 ms. `state()` (the whole replica as JSON) takes 0.3 ms at 55 KiB.
- The replica's full-document clone and diff per op are invisible at these sizes. Everything after the boundary is the cost.

**4. Joining replays history at full UI cost.**
- A fresh joiner gets the room's cached snapshot (reused while it is at most 256 entries old, spec §5) and replays the gap one entry at a time.
- Each replayed creation pays finding 1's rebuild: 150 catch-up entries cost 1.3 to 1.6 s of main-thread handlers over about 1.8 s, and added about 124,000 DOM nodes (65,000 for viewers).
- At the 256-entry limit that is about 2.5 s on this desktop. On the 1,000-create board it would be several seconds.
- A reload with a stored copy replays only what it missed since its last lazy save (300 ms debounce).

**5. IndexedDB before send.**
- Each edit saves the whole replica state before it sends: 7, 55 and 278 KiB for the three board sizes in finding 1.
- Saves in general commit fast: p50 1.2 ms. But the save on the send path commits at p50 7 to 14 ms and p95 29 to 38 ms. It is queued behind A's own synchronous render and the frame that follows it.
- At 40 peers it is 28 to 31 ms p50 and 93 to 120 ms p95, because the main thread is busy with presence.
- This is most of A's "Syncing" time before anything leaves the tab.

**6. Memory: no leak found.**
- Over 4 minutes of 3 editors:
  - The JS heap is a sawtooth between 10 and 37 MB, with no upward trend.
  - Event listeners stay between 85 and 450 and return to 85.
  - Live DOM grows only with content: 1,889 to 2,020 elements for 41 new strokes.
- The CDP `Nodes` count swings between 5,600 and 15,000, and reached 80,000 after a join. That is detached nodes from finding 1's rebuilds waiting for GC: churn, not a leak.

**7. Remote drags are stepped and late.**
- Pointer to sent takes 0 to 50 ms: the client throttle, `setPresence`, sends at most every 50 ms after the last send.
- Sent to received takes:

  | Setup | p50 (ms) | p95 (ms) |
  |---|---:|---:|
  | Local, 3 editors | 21–28 | 52 |
  | Production | 24 | 57 |
  | 40 peers | 38–40 | 92–106 |

  Received to painted is 5 to 8 ms (16 at 40 peers).
- The server's batch timer starts at the first update after a flush. With the client's own 50 ms cadence, updates from one dragger arrive 68 ms apart at the median and 100 ms apart at p95. That is about 15 Hz, not 20.
- Tokens and cursors have no transition or interpolation (the only `transition` on tokens in `board.css` is for `stroke`), so the ghost jumps and trails the dragger's hand by roughly 50 to 100 ms.

## Server findings

- **Apply is negligible.** Validate, sequence and encode take 0.05 ms p50 and 0.1 ms p95 in every setup.
- **Fan-out is negligible.** Serializing once and queueing to every peer takes 0.02 ms (0.04 ms at 40 peers).
- **The durable write is the server's latency.** One autocommit `INSERT` per transaction with `synchronous=FULL`, measured inside the blocking task:

  | Filesystem | fsync p50 (ms) | fsync p95 (ms) | fsync max (ms) |
  |---|---:|---:|---:|
  | ext4, SATA SSD | 2.3–4.4 | 4.5–7.7 | |
  | btrfs on LUKS, NVMe | 7.1–9.5 | 10–18 | 86 |
  | tmpfs | 0.10–0.13 | | |

  Production's ack of 6.3 ms p50 against a 4 ms RTT puts the box's whole server path near 2 ms p50 (p95 about 18 ms).
  - Waiting for the spawn and the global writer `Mutex` is 0.02 ms: there is no contention at one room.
  - Room queue wait was 0.01 ms p50 everywhere, with a p95 up to 8.6 ms on btrfs, where a second submit waits out the first's fsync.
- **It is serial per room, and blocks presence.**
  - The room task `await`s each `append_op` inside its one loop. Nothing else in the room runs during an fsync, including the 50 ms presence flush.
  - On btrfs, the presence flush's lateness reached 86.9 ms, matching the fsync maximum of 86.2 ms.
  - There is no group commit, although spec §9 says commits are "grouped per event-loop tick".
  - A room's ceiling is about 1/fsync: about 100 tx/s on btrfs and about 250 tx/s on this ext4 SSD. That is why the soak's 57 tx/s on a busy btrfs disk showed ack p50 at 148 ms. At our 20 tx/s for 40 peers, ack stayed at 3 ms server-side. The busy btrfs 40-peer run was invalid, so this report doesn't re-measure the soak's figure.
- **Room CPU is small.** The room task was busy 0.6 to 1.3% of the time with 3 editors, 4.4% at 40 peers, and 8.2% at most. The whole process used 0.7% of one core with 3 editors and 6.6% at 40 peers (cursors at 5 Hz). Peak RSS was 17 MB.
- **Presence relaying is O(n²) in bytes; CPU stays small.** `flush_presence` builds and serializes a separate frame for each peer, holding every other dirty peer's full state.

  With every peer moving at 20 Hz (runs p10, p20 and p40):

  | Peers | Bytes per flush | Out of the room | Into each client | Flush CPU | Process CPU |
  |---:|---:|---:|---:|---:|---:|
  | 10 | 19 KB | 0.33 MB/s | 33 KiB/s | 0.06 ms | 1.2% |
  | 20 | 80 KB | 1.5 MB/s | 74 KiB/s | 0.24 ms | 2.2% |
  | 40 | 329 KB | 6.4 MB/s (51 Mbit/s) | 160 KiB/s | 0.90 ms | 6.1% |

  Bytes per flush grow 4.2× each time the peer count doubles. The server copes. The cost lands on bandwidth (51 Mbit/s for one room on a shared box) and on every client, which handles about 21 presence frames a second at finding 2's per-frame cost.

## Ranked bottlenecks

| # | Bottleneck | Evidence | Proposed fix | Expected gain | Effort |
|---|---|---|---|---|---|
| 1 | **Creations rebuild the UI** (`<For>` over fresh wrapper objects from record-set scans) | 1,000–3,500 nodes and 10–70 ms per remote create on every client. The sender renders the same before its save. Joins replay at that cost: 1.5 s per 150 entries, 124k nodes | Key lists by id: memos return id arrays (strings are stable keys), and rows read `records[id]`. Or keep derived lists in a store reconciled with `key: "id"`. Render the hero `<option>` list once (a picker opened on demand, or one shared list), not 12 times. Split `live()` per kind so a new stroke doesn't wake roster, tokens and scenes | Remote create about 20 ms → about 1–3 ms (a `Set`'s cost). Sender's create-to-send about 45 → about 25 ms. Join replay about 10× cheaper | S–M (about a day; several components, pure UI) |
| 2 | **Whole-board `reconcile` on every frame**, presence included | `unwrap` is the top JS function: 4% of the main thread with 3 editors, 22.5% at 40 peers. The move handler goes 0.9/2.8/10.6 ms and presence 0.4/2.4/9.8 ms with board size | Apply only `Update.changed` (`setRecords(id, reconcile(entry))` per id). Give presence its own callback that touches only `peers` (and only changed peers) | Per-frame cost flat at under 0.5 ms whatever the board size. Frees 5–20% of the main thread at 40 peers | S (a few hours; `state.ts`, plus a small `session.ts` callback split) |
| 3 | **Remote drags are steppy and late** (client 50 ms throttle beating the server's 50 ms batch; no interpolation) | Update gap p50 68 ms, p95 100 ms (about 15 Hz). Ghost about 50–100 ms behind the hand. Presence one-way p50 22–24 ms local and production | Interpolate remote token and cursor positions on the client (rAF lerp or a short CSS transform transition, about 60–80 ms). Flush on the leading edge when the last flush was over 50 ms ago, or shorten the batch to about 25 ms for small rooms | Smooth 60 fps ghosts; the median gap drops to about 50 ms; perceived lag down by about 30–50 ms | S |
| 4 | **Presence fan-out is O(n²)**, one frame per peer | 6.4 MB/s out and 160 KiB/s per client at 40 peers; 329 KB per flush | Serialize one shared batch frame for the room; each client drops its own entry, as `Entry` broadcasts already do. Send only fields that changed, and skip peers whose state didn't change. Optionally filter by scene | Serialization n → 1 per flush. Bytes about 3–5× lower with deltas; delivery stays O(n²) by nature | S–M (wire change, so it needs the spec, the model and the soak's presence checks) |
| 5 | **Serial fsync in the room loop** (no group commit; presence blocked during writes) | fsync 3–10 ms p50 on real disks, max 86 ms on btrfs. Presence lateness tracks it (86.9 ms). Room ceiling about 1/fsync (100–250 tx/s); the soak's 148 ms ack at 57 tx/s | Group commit: drain the queued submits, write them in one transaction (one fsync), then ack all in order. Run the write as a future the room polls while still flushing presence, and keep acks and broadcasts behind it | No change at 3 people. Under bursts, p99 ack divided by the batch size. Presence never stalls on disk | M (touches durable-before-ack; model first, plus the failpoint test the soak journal asks for) |
| 6 | **Whole replica saved before every send** | 7/55/278 KiB per edit. On the send path the save commits at 7–14 ms p50 and 29–38 ms p95 (28–31 ms p50 at 40 peers) | Persist pending transactions as small separate records (append on edit, delete on ack), and the confirmed document lazily, as `persistSoon` already does | Send about 5–25 ms sooner; less IndexedDB churn on big boards | M (persistence format and migration; keep the soak's crash model) |
| 7 | **Fresh joiners replay up to 256 entries** | Finding 4. It is mostly #1's cost per entry | Fixing #1 is most of it. Batching the UI update per catch-up page (one Solid update for N entries), or a shorter reuse window for the snapshot, would cut the rest | Join to an interactive board in milliseconds, not seconds | S once #1 is done |

Not bottlenecks:
- WASM calls: under 0.3 ms.
- Server apply and fan-out: under 0.1 ms.
- The writer mutex: 0.02 ms.
- Local network: 0.5 ms.
- Production network: about 4 ms RTT.
- Server CPU: under 7% of a core at 40 peers.
- Memory: no growth.

## What "slow with 3 people" most likely was

Not the server, the disk or the network. With 3 people on production, an ack takes 6 ms p50 (22 ms p95), and an edit is painted on the others' screens 34 ms after the input (108 ms p95). Most likely it was the clients, made worse by the operator's own system load:

1. **Every stroke, arrow, callout and first objective toggle froze all three screens briefly.** Each one rebuilt 1,000 to 1,400 DOM nodes on every client: 15 to 25 ms here, 40 to 100 ms on a loaded laptop. The person drawing paid it before their edit even left the tab: 40 to 50 ms from input to send, 135 ms on a big board.
2. **Watching someone else drag felt laggy.** The ghost hero jumps at about 15 Hz, with gaps up to 100 ms, and trails the dragger by about 50 to 100 ms, with no smoothing.
3. **Joining, or opening the board on a new device, mid-session** replays up to 256 entries at that rebuild cost: one to several seconds of a busy tab.
4. **The board slows as it fills.** Each received frame, presence included, re-walks the whole board. On a well-used board that is 3 to 10 ms per frame at 15 to 20 frames a second per active person.

A busy machine makes all four worse, because all four are main-thread work.

Fixes 1 to 3 are client-side and small, and none touches the sync protocol.

## Harness notes

- `web/perf/run.ts`: the CLI, the phases and the analysis.
- `browser.ts`: people in Chromium.
- `probe.js`: the in-page probe.
- `worker.ts`: the Node peers.
- `server.ts`: the server, /proc CPU and RSS, and the patch's log lines.
- `trace.ts`: the trace reader.
- `server-timing.patch`: measurement only; base `7d6cb40`.

Two things the harness found about itself along the way:
- `WorldPos` is an integer type. A fractional cursor coordinate fails to parse, and the server closes the socket as `abuse`.
- A run of 40 local peers needs a distinct `X-Forwarded-For` per peer.
