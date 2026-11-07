# 2026-11-06: architecture decisions

**Context:** we started from an offline single-file prototype. Over the day, research and the spec
draft led to a discussion with the operator.

## Decided

- **Sync model:** a server-authoritative op log with per-field last-writer-wins, not a CRDT.
  - **Why:** the server must validate every edit, because view-only links are the security
    boundary, and typed records migrate with plain functions.
  - **Runner-up:** Yjs + Hocuspocus. It lost because rejecting a bad update is hard and old
    clients make migrations hard. ([research](../research/sync-and-collab-boards.md))
- **Rust core** (operator), compiled natively for the server and to WASM for the browser, with a
  TypeScript UI over it.
  - **The cost we accepted:** a typed boundary between the core and the UI, and harder debugging
    across it.
- **Art is server-hosted** (operator): mapcro is free forever, the server operator extracts once,
  and users never extract.
  - **What changed:** this replaced the earlier "art never leaves the user's machine" design, and
    it removed the in-browser extractor entirely. Art still stays out of git.
- **Validation:** a five-layer harness (spec §14). The operator then asked whether a functional
  language could check the core. That led to the Quint experiment.

## What we learned

- The most useful research finding was a **licence**, not a technique: tldraw sync, the closest
  prior art, can't be used in production without a key.
- The operator's "users don't need to extract" removed the most complex component of the draft.
  **Asking who actually runs a step is worth doing early.**
