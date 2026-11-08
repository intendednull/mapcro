# 2026-11-07: presence latency, group commit, compaction

Three server items in order, after the client performance work: presence that no longer waits
for a batch, durable writes grouped into one fsync, and real snapshots with compaction.

## 1. Presence on the leading edge

The perf report measured presence waiting a full 50 ms on the server: 51 ms p50 from A's send
to B's receipt. The room started a 50 ms timer on the first change and sent when it fired.

*Prediction:* flushing on the leading edge (send at once after a quiet spell, coalesce inside
the window) takes the 50 ms back for a client that sends every 60 ms.

*Result:* half right. With a 50 ms window it went to 24.6 ms p50, not ~2 ms. The window is
room-wide, so with three people moving, an update often lands inside the window someone else's
update opened. Drag steps got irregular too (gaps p95 72 → 103 ms), because updates alternated
between going at once and waiting. A per-sender window would send everything at once, but at
40 peers each receiver would then handle a frame per update (hundreds a second, ~1 ms each).
So the window stays room-wide and got shorter: 20 ms.

| `just perf local --fs disk --browsers 3 --seconds 60 --storm 10` | Sent → received p50 / p95 | Drag gaps p50 / p95 / p99 | 1-min load |
|---|---:|---:|---|
| Before (trailing 50 ms) | 51.0 / 53.4 | 60.4 / 71.6 / 98.8 | ≤ 7.9 |
| Leading edge, 50 ms | 24.6 / 50.0 | 51.3 / 103 / 113 | ≤ 10.6 |
| Leading edge, 20 ms | **3.7 / 32.3** | 60.2 / 79.6 / 84.4 | ≤ 9.4 |

At 40 peers (`--peers 40`), against the report's `a3-disk-40` run: sent → received 35.8 → 15.4 ms
p50 (62.7 → 46.2 p95). Each Node peer gets 56.7 frames/s instead of 22.5, but each is smaller
(2 entries p50 instead of 5), and the browsers' presence handler time is about the same in total
(p50 0.8 ms × 9,261 calls against 2.1 ms × 3,774). End-to-end edit paint read 41.1 / 80.0 ms
against 37.8 / 71.3, but at load ≤ 9.5 against ≤ 4.4, so it's not comparable.

Test: `presence_goes_out_on_the_leading_edge_and_bursts_coalesce`: ten updates 120 ms apart
arrive in 1.8 ms median, and a burst of twenty goes out as one frame with the last state.
Reverting to the trailing timer makes every update wait 51–53 ms, and the test fails.

## 2. Group commit

Every acknowledged transaction was its own SQLite transaction, so it had its own fsync, one after
another in the room's loop, and presence waited behind them. §9 had promised commits grouped
per tick and they weren't.

Now the room applies an engine message in memory, takes every engine message already queued
behind it (up to 256), writes all their effects in one transaction, and only then sends any of
their acks, broadcasts, rejections and catch-up ranges. It doesn't wait to fill a batch: what
queued during the last fsync is the next batch. A batch stops at the first other command. A
join's snapshot, a clone or a catch-up range read in the middle of a batch would include state
that isn't on disk yet.

*Prediction:* throughput rises sharply under load, and nothing changes for a lone editor.

| 4 writers × 250 transactions, each waiting for its acks (load 4.2–4.5) | Wall | Server CPU per tx |
|---|---:|---:|
| Before (ee56315) | 3.36 s, 3.29 s | 510 µs, 480 µs |
| After | 0.06 s, 0.07 s | 40 µs, 40 µs |

The system test suite went from 30–60 s to about 10 s, because its own writers batch too.
`just soak 0x2a 40 120` passed (7,290 logged, every ack seen) at load 4–11.

**The crash test the soak couldn't do.** The soak kills the server at random moments, so it
rarely lands between a commit and its acks. A test-only feature, `failpoints`, aborts at an
exact point: just before a commit, or just after one, before the acks go out. Release builds
don't have it. `a_crash_between_write_and_ack_loses_nothing_and_doubles_nothing` runs three
editors' paced bursts, kills the server at the 20th commit at each point, restarts it, and checks
all 183 edits are in the log exactly once.

**The test needed two goes to catch the bug it's for.** The mutation "send the acks, then
commit" passed it twice:
- The abort came straight after the acks were handed to the socket tasks, before any reached
  the network. The failpoint now waits 200 ms first, as a slow fsync would.
- The test clients didn't read while they edited, so the early acks were never applied. They
  were discarded with the socket, and the replicas resent the work. The clients now read as they
  go.

Now the mutation fails: after the restart, a client holds acks for entries the server never
wrote, and it's refused as ahead of the log. A second test, from per-commit sizes the feature
records, shows 306 engine messages going into 9 commits. Capping batches at one message fails it.

## 3. Snapshots and compaction (H3)

The real fix for unbounded history. Until now the log was the board's whole history; the caps
stopped a board growing, at the price of a board that eventually fills.

**The protocol change, modelled first.** Fresh joins already start from a snapshot. The hard
case is a client *with* a copy whose `last_seq` is below what the server still keeps: its catch-up
is gone, and it may hold pending transactions that the server already applied (it just never
heard the acks). Adopting a base naively leaves those pending for ever, since their acks are
before the base. The answer is `Rebase { doc, seq, decided_below }`:
- the board now, and its log position;
- the client's oldest transaction the server hasn't decided.

The client adopts the board and drops its pending work below `decided_below`. Each of those is
in the board, or was refused, and its rejection came just before. It keeps the rest on top.

In `model/sync.qnt`:
- `compact` raises a floor (once per run).
- A hello from below the floor must get a rebase; one from above may get one either way.
- `decided_below` is computed from what the server logged or refused.

All seven properties held over 200,000 samples each. A variant where the client keeps its decided
work (`rebaseKeepsDecided.qnt`) fails `acksInOrder` in 67 ms. TLC at the reduced bounds:

- At 2 transactions per client, with 1 drop, 1 fresh reload and 1 compaction, it explored
  **38,977,061 distinct states with no violation**. I stopped it with 14.7 million still queued:
  each hello now branches on catch-up or rebase, and it was holding 4 cores of a shared machine.
- With fresh reloads off (their path was checked exhaustively at the same bounds earlier, 17.2
  million states), the run was exhaustive: **14,917,578 distinct states (75.1 million
  generated), depth 24, no error**, in 7 m 36 s on 4 workers. That's every interleaving of
  compaction and rebases with edits, undos, drops, reconnects and rejections at that size.

**Engine and sim.**
- The authority keeps a floor and rebuilds from a snapshot plus each client's kept next cseq.
- Its quota counts only what's kept.
- The replica adopts a rebase.
- The sim compacts at random (1,550 times in 1,000 seeds, 4,107 rebases) and restarts from its
  stored base.
- Three sim mutations each fail a seed:
  - the replica keeping decided work: "acknowledgement for cseq 2 but the oldest pending is 0";
  - `decided_below + 1`: "transaction #2 vanished";
  - `decided_below − 1`: an ack mismatch.

**Server.**
- *When:* after a commit, once 10,000 entries have been logged since the base, or the kept bytes
  reach half the quota.
- *What:* the room writes the board as the new base and keeps the newest 2,000 entries (and a
  quarter of the byte quota) for catch-up, in one transaction.
- *Kept across it:* each client's next expected cseq goes in a new `client_seqs` table (schema v5).
  Without it, a resend of a compacted transaction would look new.
- *Loads:* a cold load replays from the base.
- *Rebase frames:* they go outside the outbox's byte cap. A board-sized frame would otherwise get
  the client dropped as too slow on every reconnect.
- *Config:* `BOARD_COMPACT_OPS` and `BOARD_KEEP_OPS` are read in room.rs, because config.rs had
  another agent's work in progress.

**Tests.**
- `compaction_keeps_history_bounded_and_old_copies_rebase`, with compaction every 40 entries and a
  10-entry tail:
  1. Client A's five edits land, but it leaves without hearing an ack.
  2. B makes 100 more.
  3. The database holds the base at 105 and only entries 96–105.
  4. After a restart, A comes back from seq 0, is rebased, and the log has exactly 105 entries,
     then 107 after A's next two edits.
  - Three mutations fail it. Dropping `client_seqs` when writing or when loading lands A's five
    edits twice (110). Serving catch-up below the floor breaks on the missing rows.
- The web session test: a tab with a stored copy at seq 0 and two unsent edits reloads after
  compaction, is rebased through the WASM replica, and its edits land once.

**Caps.** `BOARD_MAX_OPS` and `BOARD_MAX_BYTES` now count what's kept since the floor. Compaction
holds that to about 12,000 entries and under half the byte quota, so `BoardFull` no longer
happens in use. The caps stay as a backstop for cold-load time.

## What a clean `just check` found

The shared working tree held another agent's half-finished schema edit, so `just check` ran in a
clean worktree at HEAD. Two system tests failed there, and both were real interactions between
group commit and the earlier work:

- **A burst of acks dropped its own writer.** With one fsync per transaction, acks went out spaced
  out. With group commit, a client that sent 25 rewrites of 60 KB before reading anything got all
  25 acks in one go, about 1.5 MB, past the 1 MiB outbox cap, and was dropped as too slow. It
  failed one run in three. Batches are now capped at about 256 KiB of transactions, and the
  per-peer outbox at 4 MiB (still counted in the room's memory weight). The slow-peer test now
  writes 15 MB, to stay well over the new cap.
- **Compaction came too late inside a batch.** Sixty rewrites arrived as one batch, which is
  applied in memory with the quota checked per transaction. Compaction only runs after the
  commit, so the board hit `BoardFull` partway through. A batch now ends as soon as compaction is
  due. The byte-quota test runs with compaction off (`BOARD_COMPACT_OPS=0`), so it still checks
  the backstop. A new test, `compaction_means_a_board_never_fills`, takes the same 60 rewrites
  with compaction on: all accepted, under 64 KiB kept. Dropping the batch rule fails it.

## The independent review, and fixing it

A fresh reviewer read fb7cd15..282a14d. Verdict: ship with fixes. It found no break of
durable-before-ack, no double-apply and no lost pending work. Five findings were fixed, each with
a failing test first, then the fix, then the fix taken out again to show the test notices:

1. **Catch-up raced compaction.** A catch-up is a range the socket reads later. Compaction could
   delete its start, either in the hello's own batch or while a slow client paged through it, and
   the read failed as a storage error. Two failpoint tests (`--features failpoints`) force the
   order with test-only pauses before a commit and before each page. Now the range is recognised
   as compacted, the connection closes as `too_slow` without an error, and the reconnect is
   rebased.
   - The same-batch test turned out to have two right answers. Under load, the editor's
     transactions can reach the room ahead of the stale hello, on their own socket, and then the
     hello is simply rebased. It accepts either outcome, never a storage failure. The slow-pager
     test is the one that always takes the race path. Reverting the fix fails both.
2. **A pruned rejection lost the client's next cseq on restart.** The device was then wedged
   with "transaction sequence gap" on every reconnect. The prune now records next_cseq in
   `client_seqs` in the same transaction.
   - The model has learnt the prune and a restart (see below).
3. **The migration wasn't atomic.** A crash between a step and its version bump left a database
   the server couldn't open. Each step and its bump are now one transaction, and table-creating
   steps say IF NOT EXISTS. Tested from the real v4 fixture left half-migrated.
5. **A compaction error closed the room**, a reconnect loop if it persisted. Now it's logged and
   retried later. While it fails, compaction isn't "due", so batches don't shrink to one message.
6. **The floor could move backwards** when the keep budget covered every row (floor 0). The store
   keeps it below the oldest kept row, and the authority takes the maximum, so either layer alone
   holds.

Finding 4 (each stale hello clones the board for its rebase, uncounted in memory) is in the
backlog: the fix is to serialize once per position and count it, like the fresh-join snapshot.

**The model, extended for finding 2.**
- The server now deduplicates by its in-memory next cseq per client, prunes heard rejections on a
  hello, and can restart.
- A restart rebuilds next cseqs from what's durable only: the log after the base, stored
  rejections and `client_seqs`.
- `PRUNE_KEEPS_NEXT` switches the fix, and `noGap` (an honest submit is never a sequence gap) is
  the eighth property.
- All eight hold over 200,000 samples each. `pruneLosesNext.qnt`, the bug, survived 200,000
  samples and then 1,000,000 of up to 45 steps: the path needs a refusal, a reconnect, a restart
  and one more edit in a particular order, about 20 steps that random runs almost never take.
  TLC, which goes breadth-first: (TLC RESULT)

The review's other model gaps stay open and are worth knowing:
- The model never truncates its log, so compaction is only a floor that forces rebases.
- Catch-up is materialized when the hello is handled, so a lazily read range that compaction
  overtakes isn't in the model. Finding 1's fix makes that case a disconnect, which the model does
  cover.
- MAX_COMPACTS is 1.
