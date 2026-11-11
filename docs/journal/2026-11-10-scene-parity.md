# Scene mode matches replay mode — 2026-11-10

Branch `proto-scene-parity` (off `prototype-layout`). The operator's verdict on the prototype: the
visual style is good; scene ("Scenes") mode should look like replay ("player") mode, and the parts
both use should be one component each, so a change is made once.

## The audit: where the two modes diverged

Screenshots before the change: `/tmp/mapcro-parity/before-{scene,replay}-{1440,1920}.png`.

Top bar (`board/TopBar.tsx` vs `player/PlayerTopBar.tsx`):

1. **Names under the bar.** Scenes drew every player's name under its portrait; replay had
   stopped (040bb18: names only in the expanded Tab columns, `.pl-tb-name.replay { display: none }`).
2. **Reserved name row.** Both bars still took the `.named` class, 40 units taller to leave room
   for those names, so replay kept an empty band between the bar and the map after 040bb18.
3. **Two copies of the bar's frame**: the host, the `--u` unit's ResizeObserver and `BAR`, the
   team columns, the centre, in each file.
4. **Two copies of `Souls`** (the "9.0k" number with its demoted k).
5. **Two ult rings**: Player's read-only `Ult` and the scene's `UltRing` repeated the same
   markup, classes and state logic; only the scene's drag/scroll editing differs. Their titles
   differed for an untracked ring ("Ult: untracked" vs "Ult").
6. **Two team-score blocks** (`.tb-score`, background, row, team icon on the centre side).
7. **Two portrait slots**: `.tb-player` with its team/side/card-art/dead/unseen classes, the souls
   tab and the hero badge, built separately in each bar.
8. **Two eye icons** for the vision mark (the same path, drawn twice).
9. **Portrait hover label.** Scenes: the slot's name (typed, else the match's), then the hero.
   Replay: only a *typed* name, so a match's player name never reached the portrait's label.
10. **Dead CSS** from the design port: `.tb-caret`, `.tb-souls.editing`, `.tb-clock.editing` (the
    live rule is `:has(.ie-input)` in app.css), and `.tb-host.editable .tb-souls { cursor: text }`
    in both stylesheets.

Elsewhere on the page:

11. **The stage head** ("Scene 2 of 2 · 5:00 Match moment", with the scene's name and clock
    editors) shows only in Scenes, pushing the bar and map ~28 px lower than in replay. Its clock
    repeats the bar's; its name repeats the scene list's and the player bar's "Scene “…” · 5:00".
    Kept: see the backlog ("Scenes' stage head repeats what the bar and the list show").
12. Map controls (Map layers, vision, Flip), the drawing toolbar, the side panel (Events / Scene
    Notes, People), and the scene list are already one render in `Board.tsx` for both modes, and
    the dock's player bar is one component (`Player`) with a `scene` state. No divergence there
    beyond what each mode has to say.

Intentional differences (kept):

- Scenes edit in place: souls, team totals (shared out), the clock, the ult ring (drag/scroll,
  click for ready); right-click opens the hero menu (Kill/Revive, vision, Rename…, Change hero);
  an editor gets the pick/swap button and the vision toggle on hover.
- Replay draws what the match has: build dropdowns and the All builds / hold-Tab view with
  kills and the level disc, health cards and the critical card, respawn countdown, the
  Rejuvenator, vision dimming from the selected team, eased values.
- Scene ult rings follow the pointer exactly; replay's ease (`.pl-topbar .tb-ult` transition).

## What changed

`web/src/board/TopBarParts.tsx` holds the shared parts; both bars are now built from them:

- `TopBarFrame`: the host (`data-testid=topbar`), the unit measurement, the two columns and the
  centre; `overlay` for the scene's hero menu, `ref` for Player's outside-click handling.
- `TeamColumn`, `PortraitSlot` (the `.tb-player` with its state classes, souls tab slot and
  `HeroBadge`; mode parts as children), `UltDial` (the ring; the scene's `UltRing` wraps it with
  its editing), `TeamScore`, `BarClock`, `EyeIcon`, `Souls`, `portraitTitle`, `BAR`.
- Names follow the game's rule in both: `.pl-tb-name` is never shown under the bar (the element
  stays, so the name is there for the hover label, tests and Player's columns). The scene's
  Rename… editor shows in place, over the ult row of its portrait, while it is open; the
  outermost slots' editors keep inside the bar. The renamed name shows on the portrait's hover
  label and the token's.
- The `.named` height reservation is gone in both modes, so replay lost its empty band too.
- Replay's portrait hover label now leads with the player's name, as its token and its Tab
  column do (the match's name first, then a typed one: Player's existing order).
- Dead and doubled CSS above removed; name rules live in `topbar.css` with the bar.

`e2e/player-names.spec.ts`: same intent (names render, never under the map, rename propagates
to everyone and to the token); it now also checks the names are not shown under the bar in either
mode, the portrait title carries the name in replay, and the rename editor is visible in place.

Screenshots after: `/tmp/mapcro-parity/after-{scene,replay}-{1440,1920}.png`,
`after-scene-rename-1920.png`, `after-{scene,replay}-bar-1920.png`.
