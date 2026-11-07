# 2026-11-06: engine tracer bullet and the simulation harness

**What was built** (plan: [engine tracer](../plans/2026-11-06-engine-tracer.md)):

- `crates/schema`: typed records and field-level ops (`Create`, `Set`, `SetIf`, `Delete`,
  `Restore`), validation, board invariants, and one `apply_tx` shared by server and client.
- `crates/engine`: the `Authority` and the `Replica`.
- `crates/sim`: the layer-1 harness. It runs one authority, six editors, a view-only client and an
  attacker over simulated FIFO connections with random disconnects, all from one seed.

**The model's two fixes went in as designed.**

- Connections are `Connecting → Live`, and only live ones get broadcasts.
- Undo emits `SetIf` and `Restore`, which the authority evaluates when it applies them.

## A third ordering bug, found by reasoning while designing rejection

The Quint model leaves out rejected transactions. Designing them raised a question: what happens
when a rejection is lost in a disconnect?

1. A client has transactions 5 and 6 in flight. The server rejects 5 and accepts 6, and both
   replies are lost.
2. On reconnect, the catch-up delivers 6's entry, the client's own ack. But the client still has 5
   at the front of its pending queue, so the ack doesn't match.

**Fix:** `hello` carries `pending_from`, the client's oldest unacknowledged cseq. The server answers
with any rejections from there on *before* the catch-up. It also prunes rejections below
`pending_from`, so the record of them stays small.

## Proving the harness discriminates (mutation check)

Each known bug was put back into the engine by hand, then the simulation ran 300 seeds:

| Mutant | Result |
|---|---|
| M1 broadcast before hello (model finding 1) | caught: `entry 7 arrived but 1 was next` |
| M2 undo as a plain client-decided write (model finding 2) | caught: `Undo … overwrote … but the transaction it reverses wrote …` |
| M3 rejections after catch-up (the bug above) | **survived at first**, then caught after the harness fix |
| M4 replica doesn't resend pending on reconnect | caught: sequence gap reported to an honest client |
| M5 server ignores the link's role | caught: a view-only client's transaction was applied |
| M6 server forgets deduplication | caught: `transaction … is in the log twice` |

**Why M3 first survived:**

- It survived 5,000 seeds × 1,000 steps. A new counter then showed that honest editors were rejected
  **zero** times.
- The default setup had three editors: one `Dragger`, one `Undoer` and one `Editor`. No two clients
  ever competed to create the same objective or delete the last scene.
- So the harness never produced the precondition for the bug at all.
- Raising the setup to six editors, including two `Editor`s and a `SceneShuffler`, gives about 1.3
  editor conflicts per seed. M3 then failed on seed 4.

## What we learned

1. **A passing simulation proves nothing until a planted bug makes it fail.** The first full
   run passed 10,000 seeds. Only the mutation check showed that one scenario was never exercised.
2. **Measure that the preconditions occur, not just that the checks pass.** The fix was a coverage
   counter (`editor conflicts`) printed in every run's summary, so a silent drop to zero is visible.
3. **A model, a harness and reasoning each found something.** The model found two bugs, reasoning
   found the third, and the harness confirmed all three by mutation. None of them alone would have
   covered all three.
4. **The first harness failure was a mistake in a check.** The check treated "logged and still
   pending" as an error, but it's the normal window before an ack arrives. Checks need review as
   much as code does.

## Numbers

- `just test`: 1,000 seeds in about 20 s.
- Soak runs before the conflict fix (three editors): 10,000 seeds × 400 steps took 87 s, and
  1,000 seeds × 3,000 steps took 515 s. Both were clean, but they were weaker tests than they looked.
- Soak run after the fix (six editors): 3,000 seeds × 1,000 steps took 448 s and was clean. It made
  614,827 log entries and checked 67,302 undo fields. Of 121,678 rejections, 19,805 were editor
  conflicts, and there were 62,500 disconnects.

## Next

- Add rejection to the Quint model, so finding 3 is checked exhaustively too.
- Put the server (axum, SQLite, durable before ack) around the authority, and run the crash test.
