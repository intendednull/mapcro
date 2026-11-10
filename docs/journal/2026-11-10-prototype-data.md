# Scoreboard extraction prototype (2026-11-10)

Implemented the authorized bounded subset in branch `prototype-data`: format 8 adds
optional sparse `level`, `kills`, `assists`, `max_health` changes, each `[second, value|null]`.
Values come from the recorded controller/pawn fields, never from catalog calculations.
The TS helper `scoreboardValueAt(series, t)` keeps true zero distinct from missing data,
reads only entries at or before t, and honors null gaps. No UI files changed.

Read the operator handoff and supplied global rules; no AGENTS.md exists in this worktree.
Used an isolated worktree/target directory and CARGO_BUILD_JOBS=2, with load below the stated
limit. No deployment, push, original-cache mutation, game assets, secrets or replay identities.

Verification:
- All 65 replay library tests passed in release mode.
- Focused web replay timeline suite: 11 tests passed; web `tsc --noEmit` passed using the
  existing local dependency and generated wasm directories.
- Real standard replay 129738985 passed the new ignored local test: all 12 players;
  476 positive level changes (1–45), 83 positive maximum-HP changes (690–4560);
  74 final kills, matching 74 deaths, and 134 assists. Every player's initial K/A was zero;
  later positive counters did not leak into those initial entries.
- Initial local assertions assuming a maximum level of 30 and a positive kill total for
  every player failed; corrected to the observed 45 and to permit a real zero-kill player.
- The real test removes names in memory before serialization. Its optional
  `MAPCRO_SANITIZED_TIMELINE` output was saved outside the repo and handed to the coordinator
  for their prototype cache; this branch did not modify that cache.
- Boundary tests cover timestamps/order, value bounds, known zero, null gaps/recovery and
  loading old timelines with all four fields absent.

See `docs/research/scoreboard-values.md` and the backlog update for remaining resistance,
category progression and active-item work, and the existing cache upgrade policy.
