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
