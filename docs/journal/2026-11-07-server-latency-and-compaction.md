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
