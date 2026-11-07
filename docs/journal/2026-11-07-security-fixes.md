# 2026-11-07: fixing the second security review

The [second review](../reports/2026-11-07-security-review.md) found one Critical (C1), two Highs
(H-A, H-B), two Mediums and some Lows. This entry covers what each fix is, what the tests caught,
and why each number is what it is. The real fix for C1 is snapshots and compaction (§9). That is
a protocol change and goes into the Quint model first, so it isn't here. What's here is the
interim: caps that make the crash impossible without changing the protocol.

## What each fix is

- **C1, the op log that crashed the server.** Rewriting one note keeps a board tiny while its
  history grows without limit. A cold load read all of it into memory and killed the process, and
  the kill repeated on every restart. Now:
  - A board's history is capped at 20,000 transactions and 4 MiB. Past the cap, edits are refused
    with a new typed reason, `BoardFull`. The board stays readable and loads normally. The client
    says "Rejected: the board is full", and its *Why?* suggests cloning, which starts a fresh
    history.
  - A transaction is capped at 64 KiB of JSON (`Limits::max_tx_bytes`, refused as `TxTooLarge`).
    The WebSocket frame cap is now derived from it: 65 KiB, down from 256 KiB.
  - A cold load reads one row at a time and stops at the caps. A board over them (written under
    bigger caps) is refused and logged rather than read.
  - The server stores at most 5000 boards and 2 GiB. Creating past either gets a 507 with "this
    server is full". Edits once the database is full are refused as `ServerFull`.
  - systemd now restarts with backoff (2 s, doubling to 2 min) and gives up after 8 starts in 15
    minutes, instead of every second forever.
- **H-A, fresh clients dropped from busy boards.** A hello used to queue the whole history into a
  4096-deep outbox, so past 4096 ops every fresh client was cut off. Now the authority answers with
  a catch-up *range*, which sits in the outbox where the entries used to be. The socket streams it
  from the room a page at a time, at the client's pace. Live entries queue behind the range, so the
  order the model checks (rejections, then catch-up, then live) holds. The engine change is the
  `Outgoing::CatchUp` variant; the simulation expands it in place, so the sim checks the same
  thing as before.
- **H-B, the view link as a write primitive.** Every hello with a new client id wrote a permanent
  row, from any link. Now a view link registers nothing: a viewer never edits, so there's nothing to
  bind its id to. An id that an editor registered is still checked against its secret from any
  link, so the H1 fix stands (its test is unchanged and passes). Editing clients per board are
  capped at 1024, and stored rejections per board at 4096.
- **M-A and M-B.** Rooms in memory are capped at 32. At the cap, a room nobody is in unloads early
  to make way. If every room is in use, the join is refused with a new close reason, `busy`, and
  the client retries. IPv6 /64 rotation is left as is: the global caps bound what it can do, so
  rotation costs availability, never a crash or a full disk. The spec now says so (§11).
- **L1:** the CSP gains `object-src 'none'`. `style-src 'unsafe-inline'` stays: removing it means
  a nonce on the pack-art `<style>` plus checking every inline style in the UI, which isn't a few
  lines. **L3:** `OrderKey::between` uses `checked_sub`, so bounds in the wrong order give a key
  instead of a panic.

## Choosing the numbers

The rule was to start from the spec's own limits rather than guess.

- **64 KiB per transaction.** The largest legal single op is an undo of a full note. It carries
  4000 characters twice, at up to 4 bytes each, about 32 KB. `Limits::max_op_bytes()` computes
  that bound from the other limits. A schema test builds the worst ops (that undo, a full note,
  a 512-point stroke at the map's corner) and checks they fit. Twice the largest op leaves room for
  a few ops together. No honest client action comes close: notes save on blur, and a stroke is a
  few KB.
- **65 KiB frames.** That's the transaction limit plus 1 KiB for the `{"t":"msg",…}` around it. A
  frame cap below the largest legal transaction would be a trap: the client keeps the transaction
  pending, reconnects, resends it, and gets closed again, forever. Deriving the cap rules that out.
- **20,000 transactions, 4 MiB.** §9 says a full replay is fine "for boards with tens of
  thousands of ops". 20,000 is about 5.5 minutes at the 60/s session limit, or many hours of honest
  coaching. A drag is ~100 bytes, so an honest board is far under 4 MiB.
- **32 rooms.** The infra default is `MemoryMax=256M`. Before choosing, the guess was "a full
  room is about twice its 4 MiB history resident, so 32 rooms is 256 MB at worst". The
  measurement (below) came in lower: 32 full boards opened cold at once peaked at 155 MB, about
  4.7 MB a room. Filling 40 boards at once under the same cap peaked at 219 MB. That is the
  tighter figure, with about 15% headroom, so 32 stays and isn't raised.
- **5000 boards, 2 GiB.** The storage cap is what actually bounds the disk. The board cap bounds
  the worst case if someone makes many small boards and fills them later.

## What the tests caught

Each fix has a black-box test in `crates/server/tests/system.rs` (real server, real sockets),
except L3, which the server can't reach and has a unit test. Then each fix was reverted on its
own, one at a time, after committing, to see its test fail: 15 mutations.

- **One mutation survived at first.** Putting the frame cap back to 256 KiB didn't fail the
  frame test. The 96 KB transaction it sends was still kept out of the log, by the new
  `TxTooLarge` check instead of the frame cap. The test asserted "not logged" when it meant "the
  socket closes before the transaction is read". It now asserts that, and the mutation fails it.
- **The long-history test first failed on its own setup.** 25 writers, all in the room at once,
  each had to keep up with the whole fill live, and the fsync rate couldn't meet the 20-second save
  deadline. Writers now fill in waves of five and leave when done.
- **A per-board constant had no black-box test.** The stored-rejection cap was a constant at 4096,
  too big to reach in a test. It's now a quota field (`BOARD_MAX_REJECTIONS`), and the test sets it
  to 3.

## The review's exploits, re-run against the fixed release build

All against `target/release/mapcro-server`, from `/tmp/mapcro-secreview-2/`, unmodified. The
original C1 scripts send 252 KB frames, which the new cap refuses outright. So two adapted
scripts (in local scratch, `/tmp/mapcro-secfix-runs/`) also attack the quota with frames that
fit: 15 note rewrites, 61 KB a frame.

| Script | Before | After |
|---|---|---|
| `h3_growth` | 13.3 MB/s disk growth, 392 MB to cold-load | first frame closes the socket; database 0.2 MB, RSS 8.6 MB |
| `h3_growth`, adapted (61 KB frames) | | 69 tx accepted (4 MiB), then `BoardFull`; after 256 refusals the client is cut off; RSS 15 MB; a cold reload gives a fresh device all 69 entries |
| `h3_oom` under `MemoryMax=256M` | killed in ~20 s, then killed again by opening the board | alive after 90 s of streaming; the board reopens; the bystander's session survives |
| 40 full boards, adapted, under `MemoryMax=256M` | | filled and reopened cold all at once: 32 open with every entry, 8 refused `busy`; peak 155 MB opening, 219 MB filling; never killed |
| `catchup_tooslow` (~6000-op board) | every fresh device got 4096 entries, then was dropped | all three trials got the whole log (4983 entries) and stayed connected |
| `clientchurn` (view link) | 752 hellos grew the database 4.0 MB | 1016 hellos grew it 0 bytes |
| `probes` | view hellos wrote 4120 bytes | 0 bytes; origin checks, creation limits and socket cap unchanged |
| `fixes` (H1, H2, revoke, rotate) | fixed | still fixed |

One surprise: `catchup_tooslow` logged 4983 of the ~6000 transactions it sent. Every writer
stayed connected. The server was still writing when the script killed it: each transaction is
its own fsync'd commit, about 300 to 450 a second on this disk. §9 promises commits grouped per
event-loop tick, but that isn't built. It's a throughput limit, not lost acknowledged work, and
it's left open.

## Left open

- C1's real fix, snapshots and compaction (§9), modelled in Quint first. Until then a busy board
  fills up, and cloning is the way on.
- `style-src 'unsafe-inline'` (L1).
- Group commit, so durable write throughput isn't one fsync per transaction.
- IPv6 /64 rotation (M-A), accepted in §11 because the global caps bound it.

## Later the same day: smaller state instead of tighter caps

The operator asked whether we could make the state smaller rather than cap it. Two changes, then
the caps were re-measured and raised.

**Compressed rows.** Stored ops and base documents are now zstd with a static 16 KiB dictionary,
JSON inside, one row at a time. JSON stays the inner format because `#[serde(default)]` field
additions are how the schema evolves; postcard is positional and would break them. Each row
names its codec (`json`, `zstd-v1`), schema v4 adds the column, and rows from before still read.
The dictionary is trained from 300 simulation seeds by `just zdict`; two runs produce the same
bytes. The stored frame drops zstd's 4-byte magic number (the codec tag says what it is), its
dictionary id and its checksum, which matters when a row compresses to about 100 bytes.

*Prediction vs result.* The coordinator measured a trained dictionary at 4× on a realistic
2000-edit session. The sim-trained dictionary got 2.7× on that session (215 KB vs 575 KB of
JSON). That looked like the simulation being a poor teacher, so a dictionary was trained on a
*different* session of the same shape: also 2.7×. The 4× came from training on the session it
was measured on. A board's own ids (client, scenes, players, 32 hex characters each) repeat in
every row, and a dictionary trained on that board learns them. No static dictionary can know a
new board's ids, so 2.7× is the honest per-row figure. Getting more needs per-board context:
whole-log compression (about 6×), which belongs with snapshots.

**No log in memory.** `Authority.log` existed only to serve catch-up. Now the authority keeps
the log's length and stored size; each accepted transaction leaves in `Effect::Logged { seq, tx }`
for the host to write; and the socket reads catch-up pages from SQLite on a second, read-only
connection. The FIFO marker stays exactly where it was, so the order is still rejections, then
catch-up, then live. Cold load replays rows one at a time and keeps none of them. The simulation
keeps its own stored log (what the server has on disk) and serves catch-up from it. Its 1000
seeds gave the same counts as before (73,059 entries, 1003 rejections), so the engine change
preserved behaviour. The Quint model is unchanged: its server is the authority plus durable
storage, and that composition is what the engine and host still implement. The room no longer
holds the base document either; a fresh client's comes from storage.

**What the measurements changed.** With no history in memory, a room's cost is its document.
That ranges from 0.3 MB for a small board to about 21 MB for the largest the schema allows (5000
records, almost all 512-point strokes). A clone can carry a document past any one board's history
cap, so the history caps don't bound it. A count cap alone would have to assume every room is
the worst: about 7 rooms at 256M. So rooms are now admitted against a memory budget of estimates
(`Doc::approx_heap_bytes` plus a fixed base), unloading idle rooms to make way. An edit that would
grow memory past the budget is refused as `ServerFull`.

The first budget run surprised us: rooms admitted within a 128 MiB budget used 207 MB, 1.5× their
estimates, and a catch-up pushed the peak to 222 MB. One room alone had been within 17% of its
estimate. The difference was glibc's per-thread malloc arenas, which keep each thread's freed
load buffers. With `MALLOC_ARENA_MAX=2` the same run used 177 MB, about 1.3×, and catch-up added
nothing. The workspace forbids `unsafe`, so the server can't call `mallopt` itself. The module and
the OCI image set the variable instead, the server warns at startup when it's missing, and the VM
test checks the unit sets it.

While measuring, one more hole: frames are shared between peers, but a peer that stops reading
keeps every frame since then alive, up to 4096 of them at up to 64 KiB each. Outboxes are now
capped in bytes as well as frames (first at 256 KiB, which proved too tight; see below).

## The numbers, before and after

All on the release build, under `MemoryMax=256M`, with `MALLOC_ARENA_MAX=2`:

| | Before | After |
|---|---|---|
| Stored size, realistic edit | 288 B (JSON) | ~107 B (2.7× smaller) |
| History cap per board | 20,000 tx, 4 MiB of JSON (~14,500 realistic edits) | 100,000 tx, 20 MiB stored (100,000 realistic edits ≈ 11 MB, so the op cap binds) |
| Disk, board at the byte cap | ~4.5 MB | 22.3 MB (577 edits of 60 KB random text: 34.6 MB of JSON) |
| RSS, room full of history | ~4.7 MB (32 rooms, 155 MB) | ~1.6 MB |
| RSS, small room | (not measured) | 0.31 MB (256 rooms at once: 87 MB) |
| RSS, largest document | (not measured) | ~21 MB; budget admits 8, peak 183 MB |
| Open rooms | 32 | up to 256, within `ROOM_MEMORY_BYTES` = 128 MiB of estimates |
| Loading a room with 8 MB of history | (log held) +11.6 MB | +3.5 MB (system test bound: 7 MB) |

The worst case in that table is 183 MB, leaving 29% of 256M as headroom. The target was 25%.

## What the tests caught (second round)

- **The byte-quota test broke, as it should have.** It assumed 15 rewrites fill 64 KiB. Counted
  compressed, highly repetitive rewrites barely count. It now uses pseudo-random letters, which
  compress to about 60%, and asserts that more than 15 fit. Reverting the quota to count JSON
  fails it.
- **The memory test needed a threshold with room on both sides.** Loading a board with about
  8 MB of history grew the server by 3.5 MB (mostly SQLite's page cache), against 11.6 MB with a
  mutation that keeps the transactions. The first threshold, 4 MB, was too tight to be robust, so
  it's now 7 MB.
- **Mutation runs:** compression off, codec tag ignored, quota counting JSON, the room keeping its
  history, catch-up reading from the wrong position, the budget always admitting, budget growth
  unchecked, no idle nudge, no outbox byte cap. All nine failed their tests, and the outbox
  mutation was re-run against the rewritten slow-peer test.

## Exploits re-run, second round

- `h3_oom` under 256M survives as before.
- `catchup_tooslow`: every fresh device gets every logged entry and stays connected. But the
  board ends up with fewer entries than with the earlier build: 2000 to 2800, where that build
  managed 4983 under lighter load.

That last one was two things. The first was a real bug, found while chasing it. The new
256 KiB outbox byte cap was tighter than the 4096-frame cap for small frames (4096 frames of
~200 B is ~800 KB). In a busy room, an honest writer that fell slightly behind was dropped as too
slow, and the submits it had already sent were discarded with it. The long-history system test
caught the same thing under load. The cap is now 1 MiB, so small frames meet the frame cap
first, as before. Presence, which is per-peer and ephemeral, is skipped rather than queued for a
peer more than 64 KiB behind, and a room's memory weight counts its slowest peer's actual backlog
rather than a fixed worst case. The slow-peer test now shrinks its own receive buffer, so it
reaches the cap in seconds even on a loaded machine.

The second was the machine. Other agents' builds kept the load average between 15 and 118. A
diagnostic run with every writer recording its acknowledgements showed all twelve still
connected and nothing rejected. The server was simply behind, logging about 30 transactions a
second with one fsync each. An old build managed 2777 in one such run. A paired benchmark that
waits for every acknowledgement found the same wall time for old and new builds, with about 10%
more server CPU per transaction on the new one (an extra serialization and the compression). So
`catchup_tooslow`'s count measures disk contention here, not the code. Group commit (§9,
promised, not built) is what would raise that ceiling.

Re-run once the machine went quiet (load average about 4), alternating builds: the old build
and the new one each logged ~4983 of `catchup_tooslow`'s transactions, and every fresh device that
joined after the backlog cleared got all of them. No regression.
