# 2026-11-06: experiment, a Quint model of the sync protocol

**Question:** can a small formal model, written in a functional specification language, find
problems in the sync design before any engine code exists? And what does it cost?

**Setup:**

- Quint 0.33.1 (npm, pinned in `model/package.json`).
- Apalache, the symbolic bounded model checker that Quint downloads itself, needs the dev shell's
  JDK 21. TLC 1.7.4 from nixpkgs, for exhaustive checking of the compiled TLA+.
- The model lives in `model/`, and it models the protocol only: abstract records with fields, the
  op log, acks, reconnects and undo. Heroes, arrows and scenes are left out on purpose.

## Predictions (written before modelling)

- **P1.** The model will find at least one real problem in spec §3–§7 as written. *Suspected:*
  per-user undo. Its "skip a field someone else changed" check runs on the client, but the server
  can order a concurrent edit between that check and the undo landing. If so, undo would
  overwrite someone else's change.
- **P2.** Exactly-once and no-lost-edits will hold for the basic protocol, since dedup by
  `(client, clientSeq)` plus resending pending work on reconnect is a well-trodden design. Any
  failure there would be a modelling mistake first and a design flaw second.
- **P3.** Exhaustive checking of 2 clients, 1 record and 1–2 fields at depth 10–15 finishes in
  minutes. Three clients will blow up.
- **P4.** Setup and the first model take about half a day. The hard part will be choosing what to
  leave out, not Quint's syntax.

## Log

**Writing the model (about an hour).** `model/sync.qnt`, about 250 lines.

- Most of the effort went into deciding what a connection *is*. WebSocket is TCP: messages are
  ordered while the connection is up, and a disconnect loses everything in flight. So the model has
  FIFO queues that a disconnect empties, rather than a network that reorders freely. Reordering and
  duplication then arise only from the protocol itself (reconnect, resend). That is what we want
  to test.
- **Noticed while writing, before running:** "connected" was doing two jobs. To the client it means
  "socket open". To the server it should mean "has received catch-up and can take broadcasts".
  Writing the broadcast rule forced a choice, and the spec had never made it. I wrote it down as a
  suspicion and kept the as-written behaviour, to see whether the checker would find it unprompted.
- Two Quint snags, each minutes to fix:
  - `x' = a or b` parses as `(x' = a) or b`, so it needs parentheses.
  - Every action must assign every variable. Adding a variable meant touching every action, and the
    effect checker caught each one I missed.

**First run: random simulation of the spec as written** (`quint run`, 20,000 traces, 20 steps):

| Property | Result |
|---|---|
| `exactlyOnce` | holds |
| `noLostEdits` | holds |
| `confirmedIsLogPrefix` | **violated** in 44 ms |
| `quiescentConverges` | **violated** in about 5 s |
| `noClobber` | **violated** in 51 ms |

**Reading the traces** (`model/tools/summarize.py` prints an ITF trace one line per step).

*Finding 1, the reconnect race.* Client `b` reconnects and queues `hello(0)`. Before the server
processes that hello, it applies `a`'s delete and broadcasts it as entry `[2]`. Then the hello's
catch-up appends `[1]` and `[2]` again. `b` sees `[2], [1], [2]`: out of order, then duplicated,
and its confirmed board no longer matches any prefix of the log. This is the suspicion from
writing the model, and the checker found it unprompted in 44 ms.

- **Fix:** the server connection is a typestate, `Connecting → Live`. A connection becomes live
  only after the hello and its catch-up, and broadcasts go only to live connections.

*Finding 2, undo clobbers.* This was prediction P1, and it held.

1. Client `a`, offline, sets `x=1` and then undoes it. Its own view says `x` still holds 1, so the
   undo becomes "write `x=0`".
2. On reconnect, the server orders `b`'s delete and re-create *between* `a`'s edit and `a`'s undo.
3. The undo then lands on a value it never wrote.

- **Fix:** undo sends `set_if(field, expect: after, value: before)`, checked by the server when it
  applies the op. Undoing a delete becomes `restore`, which keeps the server's copy of the record
  rather than the client's stale snapshot of it.
- **A related problem, from the same trace:** the old "recreate from the client's snapshot" undo
  also overwrote `b`'s edits to the record. The `noClobber` property was widened to cover it.

**Isolating the fixes.** Each one on its own, 50,000 traces:

| Variant | Prefix | Converges | No clobber |
|---|---|---|---|
| as written | ✗ | ✗ | ✗ |
| live-after-hello only | ✓ | ✓ | ✗ |
| server-side undo only | ✗ | ✗ | ✓ |
| both (`fixed.qnt`) | ✓ | ✓ | ✓ |

So the convergence failure was also the reconnect race. Each fix is necessary, and each is
sufficient for its own property.

**Exhaustive checking (P3).**

- **Apalache** (`quint verify`, symbolic, bounded) first rejected the model. It needs constant
  loop bounds, so `range(0, nextCseq)` became `range(0, MAX_TX)` with a guard. After that, it
  reached step 5 of 8 in about 11 minutes, and I stopped it at 12 in favour of TLC. Lists and
  maps make its SMT encoding heavy.
- **TLC** works much better here: the model is finite (3 transactions and 1 disconnect per client),
  so TLC can enumerate *every* reachable state with no depth bound at all. On the as-written
  design, it found the violation after 6,102 distinct states, in under 2 s.

TLC on the fixed design checked **every reachable state** and found **no error**:

- 64,878,246 distinct states (222 million generated)
- a complete state graph of depth 31
- 15 min 47 s on 16 cores

For this bounded scope (2 clients, 1 record, 1 field, 3 transactions and 1 disconnect each), all
five properties hold on every possible interleaving, not just on sampled ones.

## How the predictions held

- **P1 held.** The undo clobber was found in 51 ms.
- **P2 held.** `exactlyOnce` and `noLostEdits` were never violated, in either variant.
- **P3 was half right.**
  - The bounded symbolic checker (Apalache) was impractical here.
  - Explicit-state TLC finished *exhaustively*, with no depth bound, in 16 minutes. That's better
    than predicted: the bounds (transactions and disconnects) make the model finite, which suits
    TLC rather than Apalache.
  - Three clients remain untested. Expect far more than 65 million states.
- **P4 was faster than predicted.** It took about 2 hours in total, including toolchain setup.
  *Choosing what a connection is* was indeed the hard part. Quint's syntax cost minutes.

## What we learned

1. **The cheapest find came from writing the model, not checking it.** Spelling out the broadcast
   rule forced a decision the prose spec had skipped. The checker then confirmed it in 44 ms and
   handed back a concrete trace.
2. **Both bugs sit where the prose was vague.** The prose said "connected" and "still holds your
   value" without saying *who checks, and when*. A model has no room for that vagueness.
3. **Isolating each fix (a 2×2 of flags) cost almost nothing and showed causation**, not just
   correlation: each fix is necessary and is sufficient for its own property.
4. **Choose the checker by the model's shape.** A bounded, finite model suits explicit-state
   TLC. Apalache's strength is very large or unbounded spaces, and its SMT encoding of lists and
   maps was slow here.
5. **The model is only as good as its scope.** It leaves out rejected transactions. While designing
   the engine afterwards, reasoning about rejection turned up a third ordering problem: a rejection lost in a
   disconnect, followed by the catch-up of later acknowledged transactions (see the engine entry).
   **Next:** add rejection to the model.

## Reproduce

- `just model-sim` runs random simulation of the fixed design.
- `just model-check` runs the exhaustive check, about 16 minutes on 16 cores.
- `just model-check asWritten` finds the original bugs in 2 s.
- `just model-trace` prints a counterexample step by step.
