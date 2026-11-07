**Date:** 2026-11-06
**Status:** landed (steps 1–5, 2026-11-06; see journal)
**Spec:** docs/specs/architecture-design.md (§2–§7, §14)

# Plan: the engine tracer bullet

**Goal:** a thin, real slice of the core, the part everything else stands on. It ends with
schema → engine → simulated server and clients, with the layer-1 simulation passing. No UI, no
network and no SQLite yet.

**Defaults taken while the operator's open questions stand** (spec §15): a TypeScript UI later,
last-writer-wins notes for v1, the scene model as specified, board expiry deferred to deploy.

## Steps

1. **Toolchain.** `rust-toolchain.toml` (stable, plus `wasm32-unknown-unknown` for later), with
   rust-overlay in the flake so Nix honours it. A Cargo workspace.
2. **`crates/schema`.** Ids, record kinds as enums, field values, ops (`Create`, `Set`, `SetIf`,
   `Delete`, `Restore`), transactions, and the invariants as a validator. The validator returns
   typed errors, never strings.
3. **`crates/engine`.**
   - `Authority`: validate, dedup by `(client, cseq)`, sequence, apply, and connection typestate
     (`Connecting → Live`, the model's finding 1).
   - `Replica`: confirmed + pending, rebase, seq contiguity checks, and undo as `SetIf`/`Restore`
     (finding 2).
   - Everything is pure and deterministic; the transport is the caller's job.
4. **`crates/sim`.** The layer-1 harness:
   - Pieces: seeded RNG, simulated connections (FIFO while up, a disconnect drops everything in
     flight, as in the model), behaviour models and a simulated clock.
   - Invariant checks after every step and at quiescence.
   - The reference oracle: naive replay of the authority's log.
   - `just sim` and `just sim --seed`.
5. **Mutation check.** Revert each model finding in the engine and confirm the simulation catches
   it. That proves the harness discriminates.

## Not in this slice

The server, persistence, the WASM build, the UI, extraction and presence. Each follows once this
slice runs.
