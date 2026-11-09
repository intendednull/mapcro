# 2026-11-09: Timer gaps, work in progress (stopped for a reboot)

Agent rejuv-rift, on the timers audit's gaps (docs/research/replay-timers-audit.md): the
Rejuvenator, the open rift's capture and give-up deadline, the urn walking back. The operator
later added the label rules below. Stopped for a reboot.

## Done (committed)

- **01ec8c3** `feat(replay)`: worker format 3.
  - `rejuv` (taken, ends, revives left), the `rejuv_*` events, `Rift.give_up_s`, and
    `Rift.capture` at 2 Hz.
  - Unit tests, plus `match_129738985_has_its_rejuvenators_and_rift_captures` in
    tests/local_replay.rs (set `MAPCRO_REPLAY_129738985`).
  - 13 of 13 mutations killed. +4,163 bytes on 129738985 (+0.28%).

## Uncommitted in the tree: finished, but e2e not re-run since the last label changes

All tsc-clean, and vitest passed 164/164 before the health rule. After it, the targeted suites
passed: objective-tips, rejuv-rift and replay-timeline. The last e2e run (before the empty-text
fix and the health rule) passed 17 of 18. The one failure was the wave handle labelling through
a silent mid boss, which the empty-text fix addresses (not yet re-run).

- **Client:**
  - match/timeline.ts: `captureAt`, `rejuvAt`, `riftAt` with `giveUp`/`capture`, and
    `urnAt().returns` (180 s from landing or a drop).
  - player/Rift.tsx: the rings. board/Board.tsx wires them in.
  - player/PlayerTopBar.tsx: `RejuvBadge`. map/pack.ts: the `rejuv` image
    (`icons/rejuv_crystal_psd`).
  - player/events.ts: labels, in the "Mid boss" group. host.ts and preview.tsx carry `rejuv`.
  - The CSS in app.css and topbar.css.
- **Label rules (operator, via the lead):**
  - Camps.tsx and Urn.tsx tips rewritten. Labels are short and appear only for a timer, an
    objective's health or a name that is the news.
  - A camp that's up, an idle rift, and Sandbox markers say nothing.
  - "Respawns in 1:20", "Buff respawns in 0:35", "Rift opens in 0:46", "Gives up in 0:41",
    "Captured by <teamName>", "Casting buff", "Urn", "Urn returns in 2:13", "Urn delivery
    point". No "(at m:ss)" suffix (my call: keeps them short); no buff effects.
  - Objectives with health: "Walker 62%", from `pv.health` (so only with Health on), rounded.
    Down: nothing (the mid boss: its timer). The editor has no per-objective health, so
    nothing there.
  - Team words through model.ts `teamName()` / `rosterTeamName()`.
- **Hover plumbing:**
  - HoverLabel.tsx doesn't draw an empty text. MarkerTips resolves a silent marker to `""`, so
    it still masks the wave handle under it.
  - Tokens.tsx: the eye and skull say their part only when those buttons are drawn (editable,
    or the eye while unseen).
- **Tests:**
  - web/test/rejuv-rift.test.ts (new). objective-tips and replay-timeline tests updated.
  - web/e2e/player-rejuv-rift.spec.ts (new; includes the walker health test, never run yet).
  - web/e2e/shots-rejuv-rift.spec.ts (new; real-replay screenshots, never run).
  - Updated expectations in player-objective-tips, player-lanes-camps, player-urn-respawn and
    hover-hidden.
- **Docs:** spec §6a/§6b (timeline fields, the label rules, badge, rings, events), the audit
  table marked done, and docs/journal/2026-11-09-rejuv-rift.md with its README row.

Not mine, in the tree: web/src/map/MapView.tsx, web/e2e/map-stencil-edge.spec.ts.

## Left

1. Re-run the targeted e2e (the specs above plus player-health and markers) with
   `MAPCRO_WEB_DIR` set to a fresh build. The server binary needs format 3 (`cargo build -p
   mapcro-server`).
2. Run shots-rejuv-rift on the real replay (`MAPCRO_SHOT_REPLAY` = a format-3 parse,
   `MAPCRO_SHOT_PACKS=~/.local/share/mapcro/packs`) and look at the ring while contested
   (12:20–12:59), the badge (31:20, 40:00) and the urn (26:40, 28:20).
3. Mutation-check the e2e visuals (badge side, ring fill), then commit the client and docs as
   one piece.
4. Statues: not possible from the replay (709 breakables never change). Pause mark: skipped.

## Gotchas

- PNG screenshots trip the Read hook's line count: `magick x.png -resize 50% x.jpg`, or crop.
- vitest's server-backed suites (journal, session…) fail with "server never became healthy"
  while the shared debug server binary is being rebuilt or the box is overloaded. Not related.
- The box sat at load 35–55 for over half an hour, so gate.sh blocked every run.
