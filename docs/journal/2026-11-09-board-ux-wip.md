# 2026-11-09 — board UX batch (selection, stencil, tool keys, team names, hero focus): WIP at reboot

The operator's five board-UX asks. Paused for a reboot; the box load was ~50 (not ours), so no e2e ran
after the stencil fix.

## Done (committed on main, not pushed)

- `d86b63d` feat(model): `export const teamName = (t: Team) => string` in `web/src/map/model.ts`.
  Returns "Hidden King" (amber) / "Archmother" (sapphire). Verified on deadlock.wiki: the Amber Hand
  became the Hidden King and the Sapphire Flame became the Archmother in Old Gods, New Blood. The
  Hidden King and the Archmother are rivals. timer-gaps uses it, and its signature is fixed.
- `34383be` fix(map), item 2 (stencil):
  - Root cause: `hud()` in `MapView.tsx` kept the zoomed look (fixed frame, disc clip) only while the
    view lay wholly inside the map square. Crossing any edge dropped the stencil.
  - Fix: `hud()` is now `view().w < FIT_VIEW.w - 0.5`.
  - Test: `web/e2e/map-stencil-edge.spec.ts`. With the old `hud()` it fails at the west edge
    (class check). Still to do: confirm the clip-path and hit-test checks fail alone, and take an after
    shot with real art.
  - Side effect: when zoomed in, margin notes outside the disc are now always hidden.
  - Shots: `/tmp/mapcro-shots/stencil-*`.

## Uncommitted, in the tree (item 4, team names)

The code is complete: tsc is clean and `test/player-events.test.ts` passes. No e2e has run yet.
- `model.ts`: `teamShort`, `rosterTeamName`, `rosterTeamShort`, `slotTag` (after `rosterTeamName`).
- `events.ts`: the `team()` helper goes through `teamName`. The haystack also adds the raw `e.team` key,
  so searching "amber" still finds events. The rest of `events.ts` belongs to timer-gaps (rejuv_*).
- `Board.tsx`: imports, takenBy text, role chip, roster `.team-head`, `slotTag` chips, picker aria-label.
- `TopBar.tsx`: slot placeholder label and total-souls label.
- `PlayerTopBar.tsx`: one extra `import { rosterTeamShort }` line (kept separate from timer-gaps'
  `rosterTeamName` import, so the hunks don't overlap) and the slot placeholder.
- `Tokens.tsx`: `initials()` uses `slotTag`, and the label placeholder uses `rosterTeamShort`
  (line ~274; timer-gaps owns `partText` nearby).
- `HeroPicker.tsx`: the "who" placeholder.
- Tests: `e2e/team-names.spec.ts` (new, not yet run), `player-names.spec.ts` / `player-objective-tips.spec.ts`
  ("King 1"; the latter also carries another agent's hunks), `hero-unique.spec.ts`
  ("Hidden King"), `test/player-events.test.ts`.
- Tell timer-gaps: their `test/rejuv-rift.test.ts:88-89` and `e2e/player-rejuv-rift.spec.ts:142`
  expect "Sapphire …" from events.ts. With my events.ts hunk they now get "Archmother …".

Next: when load < 12, run team-names, player-names, hero-unique and objective-tips with
`--workers 2`. Then do the mutation check (e.g. `teamName` back to Amber/Sapphire), commit item 4 and
look at the shot (`web/shots/team-names.png`).

## Left

- Item 1, selection highlight in the user's presence colour: not started (`app.css` ~256
  `.mk.picked::after`, plus the hero dashed ring in `Tokens.tsx`).
- Item 3, tool keys: not started.
- Item 5, hero focus on portrait/roster click (smooth pan, ping, token flash): not started.

## Defaults chosen

- Full names: "Hidden King" / "Archmother". Short forms (placeholders like "King 2", top-bar slots):
  "King" / "Archmother". Slot tags "K1…K6" / "A1…A6", from the patron's initial; the "A" no longer
  means Amber.
- Wire keys, CSS classes, data-slot (`Amber-0`) and testids stay unchanged.
- Planned tool keys (item 3): Q Move, E Draw, R Arrow, T Comment, A Laser, S Erase. W unbound.

## Gotchas

- Shared tree: `player-objective-tips.spec.ts` and `events.ts` have other agents' uncommitted hunks.
  Stage by context patch only.
- The box load hit 50+ from other work. Check `uptime` before any e2e.
