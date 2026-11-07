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
