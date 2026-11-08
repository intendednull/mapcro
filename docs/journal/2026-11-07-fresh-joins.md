# 2026-11-07: late joiners load the board, not its history

The soak measured ~0.7 ms per entry to apply on the client. A fresh client on a 32,809-entry board
waited 23 s, and the soak's late joiner, arriving at seq 23,421, took 47 s. The room already holds
the current board, so a client with no copy should start from that and replay only what came
after.

## The design, and why it's small

A fresh join's `Ready` already carried a `base`, `{ doc, seq }`. It used to be the stored genesis
document at seq 0. Now it's the room's current document and its log length. The room reads them
together in the one step that handles the join, and the client builds its replica at `seq` and
says hello from there. Anything logged between the join and the hello comes back as ordinary
catch-up: behind any rejections, ahead of live entries, through the same FIFO marker as before.
So the engine didn't change. The base only moves where the client's `last_seq` starts.

*Prediction:* the existing properties hold, provided the base's seq is exactly the position its
document is at. Off by one either way breaks something visible: one entry short means a missing
edit, one entry long means an entry applied twice.

## Model first

`model/sync.qnt` gets `freshReload`. A client with nothing pending clears its storage and comes
back from a snapshot of the server's board at any k up to the log length (k = 0 is the old
replay-everything path; k below the current length is a slightly stale cached snapshot). It then
says hello from k. One per client, bounded by `MAX_RELOADS`.

**The model's first answer was a counterexample**, in 56 ms: `acksInOrder` failed. Client a had
made three transactions, all logged, cleared its storage, rejoined from k = 0, and then received
its own old entries during catch-up with an empty pending queue. The ghost variable counted them
as out-of-order acks. That was the model's simplification, not the protocol. The real client
makes a new client id when it starts with no copy, so those entries aren't its own any more. The
model reused the id to keep the state space small. It now gives each reload an `epoch`: a
reloaded client's earlier transactions count as someone else's. With that, all seven properties
held over 200,000 random samples each (up to 30 steps).

The off-by-one is a variant, `model/snapshotSkew.qnt` (the base labelled one entry later than it
is). It fails `confirmedIsLogPrefix` in 44 ms, so the model can tell.

TLC on the fixed design, at the old bounds (3 transactions, 1 drop and now 1 reload per client):
it explored **142.7 million distinct states** (457 million generated) with no violation before I
had to stop it. That's more than twice the old model's entire space (64.9 million, exhaustive in
16 minutes), and the queue still held 54.7 million, so this run isn't exhaustive. Each reload's
choice of k multiplies the interleavings. It held 14 cores, which also starved the system tests
(below), so it was paused, then ended at the 2-hour limit. So I ran it exhaustively at one bound lower, 2 transactions per client (1 drop and 1 reload
each, as before), with 4 workers on a shared machine: **17,200,802 distinct states (66.4 million
generated), depth 31, no error**, in 7 m 25 s. Every interleaving of fresh joins with edits,
undos, drops, reconnects and rejections at that size satisfies all seven properties.

## Tests, and what they caught

- `a_fresh_client_loads_the_board_not_its_history`: a 20,000-entry board (written as a database
  directly; through the server it'd be minutes of fsyncs). A fresh client gets a base at seq
  20,000, one entry after it, and is in sync in 0.38 s on a debug build. The last entry before
  the join is a Create, which can't be applied twice. A base at seq−1 makes the client apply it
  again (IdTaken, a protocol error); a base at seq+1 makes it claim to be ahead of the log
  (Fatal). Both mutations fail the test.
- **The first snapshot cache didn't cache anything.** It held the snapshot weakly, meant to share
  it while a burst of joiners' frames were in flight. But the socket copies the document into
  its own Ready frame and drops the shared copy at once. So there was no reuse, and no memory
  protection either. It came out in a test that tried to keep a snapshot in flight by never
  reading. The cache is now held strongly and counted in the room's memory weight, and a
  server-wide cap of 32 MiB bounds the base frames being sent at once.
- `a_shared_snapshot_keeps_its_own_position`: a joiner after five more edits gets the cached
  snapshot at its original seq and catches up the five. Labelling a reused snapshot with the
  current seq fails it.
- `a_board_too_big_for_one_frame_falls_back_to_catch_up`: a board with ~10 MB of ink as JSON gets
  the stored base and paged catch-up, not a snapshot. Removing the fallback fails it.
- The existing tests used `fresh_catch_up` to check catch-up from disk, and with snapshots they'd
  have passed without testing it. The long-history and migration tests now use a client that
  already holds a copy at seq 0, so catch-up through every row (old JSON rows included) is still
  checked.
- The sim gains fresh joins: a client with nothing pending clears its storage and comes back as a
  new client from a snapshot at the current position or up to three entries stale. 1000 seeds
  include 198 of them. A replica built one entry off its snapshot fails seed 3 at step 220.
- **A flaky failure that wasn't the code.** The long-history test failed about half the time
  while TLC held 14 cores: a writer heard nothing for 10 s. With TLC paused (SIGSTOP), it passed
  four times out of four. Under that load, a hello queued behind ~1000 fsync'd submits really can
  wait that long.

## Clients that hold a copy keep catch-up

A device far behind could also take a base, but its replica may hold pending transactions that
the base already contains. It only drops one when it sees the ack, and those acks are before the
base. It would resend them, the server would ignore them as already decided, and they'd stay
pending for ever. Doing it right needs the base to say which of the client's transactions it
holds and which were refused. That's a protocol change for the model, and not needed yet.

## Soak: the late joiner, before and after

`just soak 0x2a 40 600`, the same schedule, back to back. The baseline is a release build of
ea9463a (the deployed server); the soak harness is the current one for both (see below). 1-minute
load average sampled every minute during each run:

| | Late joiner | Fresh client, whole board | Load (1 min) |
|---|---|---|---|
| Before (ea9463a) | joined at seq 23,621, caught up in **27.5 s** | 33,867 entries in **23.6 s** | 3–10 |
| After | joined at seq 23,578, caught up in **1.3 s** | 33,963 entries in **0.1 s** | 4–10 |

An earlier pair, taken before I recorded load, gave 34.4 s before and 1.4 s and 1.5 s after.
One more run, taken while the machine was overloaded (load ~50; ack p99 46 s, schedule lag 49 s),
gave 41 s for the late joiner but still 0.1 s for a fresh client. Once the server itself is that
far behind, the late joiner waits on it, not on replay. So the late-joiner figure only means
something with the load beside it.

### What the soak caught

- **Its own log reader.** The final check read "the whole log" by joining as a fresh client,
  which now gets a snapshot near the head and almost no entries. So every transaction looked
  lost. It now records the genesis base when the board is made and reads the log as a client
  that already holds it. The fresh client is then checked against the log replayed, which makes
  that existing check a check that snapshots are right.
- **A real presence bug of mine, from the morning's outbox work.** A batch skipped for a lagging
  peer is never re-sent, because presence goes out only on change, so that peer held stale states
  for good. The room now records whose changes each skipped peer missed and sends their current
  state (or their leaving) once it has caught up. Spec §8.
- **Stale presence with every build after 7d6cb40, which turned out to be the harness again.** Its
  peers sent viewports without the new `side`, and the server's relayed copy (with the default
  filled in) no longer matched the sender's own. I narrowed it down by building my own commit
  without it (the soak passed) and the current tree with only that hunk reverted (also passed),
  and flagged it. Fixed in the harness (09bbbc2): real clients always send `side`. The baseline
  build still fails that one check, as expected: it predates `side`.
