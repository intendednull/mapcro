# 2026-11-06: the first security review, and fixing it

**Reviewer:** a fresh Opus subagent, adversarial and read-only. It ran its exploit scripts against
the real server binary. Report: [docs/reports/2026-11-06-security-review.md](../reports/2026-11-06-security-review.md).

**Result:** 0 critical, 3 high, 5 medium, 6 low or informational findings.

## The finding that mattered most (H1)

Client ids are **public**: every log entry carries its author's id to every peer, view-only ones
included. Yet the authority treated a `hello` naming an id as proof of being that client. So
anyone holding a link, even a view link, could do three things:

- **Disconnect anyone,** because a new hello with the same id "superseded" the victim.
- **Forge edits as anyone** (with an edit link).
- **Silently swallow a victim's next edit,** by submitting at the victim's next cseq first.

**Why the earlier work missed it:**

- The model treated identity as given; it has no attacker.
- The simulation's attackers sent bad *transactions*, never hellos claiming someone else's id.
- **The checks only covered the ways I had imagined things going wrong.**

**Fix:** each client has a secret, sent only in its own hello and never broadcast. The first hello
registers its hash, and later ones must match. A mismatch is refused, and it never supersedes the
real connection.

**Regression coverage:**

- The simulation's attackers now reconnect claiming ids they learned from entries.
- A system test covers hijacking, including across a restart.

## The other fixes

- **H2:** a view link's submit now closes the connection and stores nothing. Rejections are capped
  per client and pruned once resolved.
- **M1:** 64 sessions per room, 32 sockets per address.
- **M2:** creation limits by IPv4 address or IPv6 /64, plus a global hourly cap.
- **M3:** in-place apply with a rollback log, which also made the simulation about twice as fast.
- **M4:** owner-token rotation.
- **M5:** the link is re-checked after joining a room.
- **L1:** stricter headers.
- **H3 (log growth without compaction):** still open. It needs the snapshot protocol change, which
  goes into the model first.

## Mutation check of the fixes

| Mutant | Result |
|---|---|
| Secret not checked | caught by the simulation and a system test |
| No rollback on rejection | **survived the simulation**, caught by new unit tests |
| Invariant check never runs | caught |
| View submit stored as a rejection | caught |
| No re-check after join | **survived** |

**The no-rollback survivor** taught the same lesson as before. The simulation's rejections were all
of kinds that fail before anything is written, so a missing rollback never showed. Unit tests now
pin it directly: a transaction that fails at its last op, or at the invariant check, must leave the
board exactly as it was.

**The re-check survivor** is a race between a revocation and a join, in a window narrower than
anything a black-box test can hit. That fix is reasoned, not tested. A test would need a hook to
pause between the two steps.

## A process failure: committing other agents' work

Two of my commits used `git add -A` while other agents were writing into the same tree.

- One swept the DeepSeek session's **unreviewed, half-written extractor** into a security commit.
  Caught before pushing and redone with explicit paths.
- One swept the design agent's in-progress fonts and pages into an unrelated commit. That content
  was harmless (OFL fonts, no art), so it stays in history as it happened.

**Rule now in force:** with other agents writing to the tree, commit with explicit paths only.
