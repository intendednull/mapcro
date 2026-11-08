# 2026-11-08: Replay capacity: two parses at once, and a queue you can see and wait in

The operator asked that replay parsing hold up when a few dozen people upload or fetch at once.
The production host, `web`, has 3 cores and about 2.9 GB of memory available, and it runs other
services. Before this, the worker parsed one demo at a time. The queue held 6 jobs and 3 GiB,
and a full queue refused an upload outright (`503 queue_full`, "Busy").

The spec is §6a: "The replay worker: isolation and limits" and the new "The queue". docs/deploy.md
lists the module options. The commits are 6ec25e1 (worker), 43af673 (server), 5976387 (module
and VM test), 1aa18ee (client), 61c18e3 (mutation gaps), and this entry's.

## What a parse costs

**What we expected.** An earlier measurement put a 478 MB demo at 19 MB anonymous plus 470 MB of
mapped file, and production reported a 624 MB MemoryPeak for a 504 MB demo fetched compressed. So
we expected the cost to be mostly the mapped demo's page cache, and a cap to reclaim it rather
than kill the parse.

**How it was measured.** The real 504 MB replay of 129738985 was run with the release worker's
`parse` mode in a transient user scope (`systemd-run --user --scope -p MemoryMax=… -p
MemorySwapMax=0`). That works on this NixOS box: the user manager delegates `memory`. The file's
page cache was evicted first (`posix_fadvise DONTNEED`), so its pages were charged to the scope.
The child's `smaps_rollup` and the scope's `memory.stat` were sampled every 50 ms. Parses ran
one at a time, behind the load gate.

| Input | Cap | Wall | Anonymous | File-backed (peak) | Cap hits |
|---|---|---|---|---|---|
| `.dem` 504 MB | none | 5.3 s | 26 MB | 484 MB (cgroup peak 510 MB) | 0 |
| `.dem` | 192M | 6.3 s | 26 MB | 186 MB | 4,031 |
| `.dem` | 128M | 6.2 s | 26 MB | 123 MB | 4,579 |
| `.dem` | 96M | 6.1 s | 26 MB | 91 MB | 4,675 |
| `.dem` | 64M | 6.2 s | 26 MB | 56 MB | 5,131 |
| `.dem` | 40M | 6.2 s | 26 MB | 32 MB | 4,650 |
| `.dem` | 32M | 7.0 s | 26 MB | 30 MB | 9,264 |
| `.zst` 356 MB | none | 6.3 s | 26 MB | 820 MB (cgroup peak 849 MB) | 0 |
| `.zst` | 128M | 8.9 s | 26 MB | 124 MB | 8,430 |
| `.zst` | 64M | 9.5 s | 26 MB | 60 MB | 8,868 |

Every run succeeded with the same 1,487,021-byte timeline, and none was OOM-killed.

- **Anonymous memory is 26 MB, and it isn't worth cutting.** It stays flat through
  decompression, parse and derive.
- **The rest is page cache.** That's the mapped demo, and for a compressed fetch the expanded
  copy being written too. The kernel reclaims it under a cap, at the cost of re-reading:
  +17% at 64M, +33% at 32M, and about +45% for a zstd input at 64M or 128M (the expansion's
  dirty pages wait on writeback).
- **The 624 MB production peak was cache, not need.**
- **No cheap optimisation to take.** boon maps the file itself and doesn't expose the mapping, so
  `MADV_SEQUENTIAL` would mean forking boon. The parse already streams well under a tight cap.
- **One cost we didn't measure:** a zstd window can add up to 128 MiB anonymous
  (`window_log_max(27)`). A level-3 zstd of this demo used a small window. Valve's level is
  unknown.

## The defaults, and why

- **2 parses at once** (`services.mapcro.replay.workers`). A parse is one core for ~5 s, so 2 on
  3 cores leaves one for the board server and the other services.
- **`MemoryMax` 384M a parse (768M).** That's 26 MB of need, room for a 128 MiB zstd window, and a
  page cache that doesn't thrash. It's lower than the old 1G for one parse, and it leaves ~2 GB of
  the host.
- **`CPUQuota` a core a parse (200%).** Same low CPU weight and idle I/O as before.
- **`TasksMax` 8 + 4 a parse.**
- **The queue: 8 GiB, 24 jobs.** Fetches arrive compressed (~330 MB), uploads raw (~500 MB), so
  that's 16 to 24 jobs, about 2 to 3 minutes of parsing at 2 at once. Expanded demos count once
  written, ≤ 1 GiB a worker, so the disk peak is ~10 GiB of the host's 32 GB free.
- **4 uploads at once, 2 downloads.** Uploads are bounded by people's uplinks, and 4 roughly
  matches 2 parsers at 20 s an upload. Two downloads from Valve match the parsers, and
  deadlock-api's 429 backoff still paces the salts.
- **64 waiting is the last resort.** Past it, a new upload or fetch is refused ("Busy. Try again
  in a few minutes.").

## The queue

- **One line for every transfer, fair across clients** (round-robin by the address key,
  `replay_queue.rs`). Uploads and fetches share it, because they share the parser.
- **An upload reserves first** and is sent only when its turn comes. Its place is kept by asking
  every 2 s, and it lapses after 20 s unasked. Cancel gives it up.
- **The worker runs queued files in the same fair order.** The server writes `inbox/.order`
  (its own directory, read-only to the worker, like the demos).
- **The status says how many are ahead,** and, after three recent parses, an estimate.
- **The chip reads, in turn:** "Waiting for a slot · 2 ahead", "Uploading 40%", "Queued · 3
  ahead · ~1 min", "Parsing replay…", "Full replay".

A board whose match was already fetched from Valve needs no upload. Its reservation answers
`done`, and the board shows the `cdn` timeline. Before this change, a landing upload of such a
match would have parsed the same match again.

## Load test: 30 jobs at once

**What we predicted.** With the old settings, the last of 30 would wait several minutes and
several people would be refused and have to come back. With the new ones, the last would be
ready in about 30 × 5.3 s ÷ 2 ≈ 80 s, plus the first upload, and nobody would be refused.

**The setup** (`/tmp/mapcro-capacity/loadsim.py`, outside the repo):

- The real server binary, a fake deadlock-api and CDN, and a stand-in worker. The stand-in
  follows `.order` and runs N parses at once, each sleeping the measured 5.3 s.
- 30 people at t = 0, each from its own address: 15 upload (500 MB at 25 MB/s, 20 s) and 15
  fetch (330 MB from the CDN in 7 s).
- Bytes are scaled 1/1000, the budgets with them. Time is real.
- **Old:** 1 worker, 6 jobs, 3 GiB, 2 uploads at once, no reservations. A refused person tries
  again after 60 s ("Busy. Try again in a few minutes.").
- **New:** the defaults.

| | Last ready | Median | Last upload | Last fetch | Refusals |
|---|---|---|---|---|---|
| Old settings | 513 s | 92 s | 513 s | 97 s | 62 (13 of 15 uploaders, one 8 times) |
| New settings | 90 s | 51 s | 90 s | 83 s | 0 |

With the old settings, the fetches took the queue. They wait for room instead of being
refused, so all 15 were done by 97 s. Meanwhile 13 of the 15 uploaders were turned away at least
once, and the last one came back 8 times before its file got in, at 8.5 minutes. The single
parser sat idle between those retries. The old run used today's server with the old limits and
no reservations, so its refusals are the old ones; only its parse order is the new fair one,
which doesn't change the last job's wait.

With the new settings, results came two at a time every ~5.3 s, alternating fetches and uploads.
That's the fair line at work. The last job was within a few seconds of the ideal: nothing can
parse before the first download lands at 7 s, then 15 rounds of two parses at 5.3 s each comes
to about 87 s.

## Verified

- **Worker** (`worker.rs` tests):
  - Two 1 s jobs finish in about 1 s with both markers present at once. One worker takes 2 s.
  - A hung child times out alone while three others finish beside it.
  - The server's order comes first, its junk lines are ignored, and unlisted jobs still run.
- **Server** (`tests/replays.rs`, real binary, the test plays the worker):
  - Two parse at once, and the third counts both ahead.
  - The parse order takes turns across clients.
  - The estimate appears after three parses.
  - A full budget makes uploads wait in line. Out-of-turn and unreserved uploads are refused, and
    nothing reaches the disk.
  - A lapsed reservation, and a lapsed unused turn, free their places.
  - The bytes on disk never pass the budget.
  - Cancel moves the next one up, and dedupe answers `done`.
  - The line's cap refuses, and a fetch waits in the same line for room.
  - Given turns hold job and upload slots.
- **Mutation.** `cargo mutants` over `replay_queue.rs` (73 mutants) and the queue wiring in
  `replays.rs` (31: `schedule`, `reserve`, `release`, the places, the parse order). The first
  runs missed 7 and 5: the download-slot count, the download stats, given turns against the job
  and upload budgets, and the fetches-ahead count. Tests for each were added, and both runs then
  caught every mutant.
- **e2e** (`replay-queue.spec.ts`, a slow worker played by the test):
  - "Queued · 4 ahead" holds while two of the four parse, then counts down to "Queued · 1 ahead
    · ~1 min", "Parsing replay…" and "Full replay".
  - A full queue shows "Waiting for a slot · 1 ahead" on the chip and the upload row, with no
    bar. Cancel says "Upload cancelled.", and its turn sends the file.
  - A backlog past the cap says "Busy. Try again in a few minutes."
  - Specs that expected "Parsing replay…" before the worker started now expect "Queued", which
    is the truth.
  - The screenshots were looked at: each label sits in the transport bar's chip, one line, no
    overflow at 1440.
- **NixOS VM test.** `MemoryMax=805306368`, `MemorySwapMax=0`, `CPUQuotaPerSecUSec=2s`,
  `TasksMax=16` and `REPLAY_WORKERS=2` on the worker, and the budgets in the server's
  environment. A reservation answers `ready`, and the synthetic job round-trips.

## Not verified

- **Valve's zstd window size**, so the worst-case anonymous memory of a fetched demo. The cap
  allows 128 MiB.
- **Two real parses at once under the 768M cap.** The brief's rule was to parse the real replay
  one at a time on this shared box. The stand-in worker and the per-parse measurements stand in
  for it.
- **Real uplinks on `web`.** 4 uploads at once assumes the host's link isn't the bottleneck.
