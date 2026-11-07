# 2026-11-06: server, browser client core and packaging

**Built:**

- `crates/server` (axum + SQLite) with rooms, capability links and durable-before-ack.
- `crates/wasm` (the browser's replica) and generated TypeScript types.
- `web/src/core` (the board session).
- Nix packaging to the infra contract, with a NixOS VM test.

The operator also asked for real game art in the design canvas. It now loads from a git-ignored
`design/_art/`, extracted from the local install (build 6860).

## The model, extended

The Quint model now includes rejected transactions, `pending_from` and two new properties:

- `acksInOrder`: a client's own acks arrive in the order of its pending queue.
- `rejectedNeverLogged`: a rejected transaction never lands, and a client never thinks a landed
  one was rejected.

A `rejectAfter` variant, with rejections sent after the catch-up, fails `acksInOrder` in random
simulation in about 4 s. So the model independently reproduces the third bug, which was first found
by reasoning (engine entry). The fixed model passes. Its exhaustive TLC run is much larger than
before (76 million states with 15 million still queued, at the time of writing), so the result
will be added below.

## Every layer got a mutation check

| Layer | Planted bugs | Caught |
|---|---|---|
| Engine, via the simulation | 6 (journal: engine entry) | 6 |
| Simulation server restart | "forget stored rejections on restart" | yes |
| Server system tests | 7 (no persistence, revoke leaves sessions live, revoked or other-board tokens accepted, no Origin check, rejections not reloaded, edit token manages links) | **5 at first**, 7 after adding two tests |
| Web session tests | 3 (pending not persisted, no reconnect, revocation treated as transient) | 3 |

**The two server misses were test-design errors.**

- The "edit token can't manage links" check ran *after* that link was revoked, so it passed for the
  wrong reason.
- No test covered "rejection, then restart, then the next edit".

Both now have dedicated tests.

**The web tests found a real bug on their first run.** `stop()` dropped the socket without telling
the replica, so the save indicator said *Syncing* while offline. The spec's honest-status rule
caught it, because the test asserted the exact status.

## A process slip, and its fix

While running an ad-hoc mutation, `git checkout -- <file>` restored the file to its committed
state. That threw away uncommitted work in the same file (the simulation's server-restart fault).
The work was recreated. The output was identical to before the slip, down to the counts, which also
confirms the simulation is deterministic.

**Rule adopted:** commit before mutating. The scripted mutation runners (`/tmp/mapcro-*-mutants.py`)
already assume committed state; the ad-hoc one didn't.

## Not yet done (and why)

- **UI rendering:** waits on the operator's design comments.
- **Snapshots and compaction, idle room unload:** the log is replayed in full on load, and rooms
  stay in memory. Fine for now; both are on the list, and the security review may push them up.
- **Backups:** need a bucket decision (Q5).
- **Extractor:** part 1 (VPK, textures, `pack.json`) is delegated to a DeepSeek session, with VRF's
  CLI as the oracle. Part 2 (binary KV3 for the hero list and map entities) follows.
- **Security review:** a fresh Opus reviewer is running against the server and the link model.
