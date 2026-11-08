# Board handoff (2026-11-08)

Written by the implementer of the web board batches, for whoever works on `web/src/board` next.

## Layers.tsx

- **Presses:** a single native `pointerdown` listener on the overlay svg handles them. Solid delegates its `onPointerDown` handlers to the document, so the native listener sees a press first. That is why `down()` returns early on `.tok, .co, .wave-hit`.
- **Notes margin:** the svg has `overflow: visible`, and a `.notes-area` rect drawn past the svg's 0..1000 box catches presses in the margin. The svg box itself is still the map square, so the e2e `mapPoint` fractions stay valid. A position in the margin is a fraction below 0 or above 1.
- **Clamping:** `world()` clamps to the board including the margin (`clampToBoard`). Heroes and lane splits clamp to the map only.
- **Creating ink, arrows and comments** needs a target scene (`p.scene`). In Player that is the live layer, which can be missing. Each gesture uses the scene it started on.
- **Strokes** move by `Stroke.offset`. Always read their points through `strokePoints()`.
- **Hover + E** deletes through a capture-phase keydown on `window`, so it runs before the toolbar's E.
- **Live ink** goes out at most once per presence tick (`PRESENCE_MS`, 60 ms), capped at `LIVE_INK_POINTS` (128).
- **Laser:** `laser()` is a list of timed points, pruned by a 50 ms ticker. Presence also carries `laser_color`.

## Tokens.tsx

- **Keys:** tokens are keyed by roster slot, not by player record. A token's node survives a scene flip and glides with `smoothed(..., FLIP_MS, () => p.scene)`. The `last` fallback in `pl()` guards against a stale read while a row is being disposed.
- **Match preview:** under `p.preview?.()`, draw only the match, never `pl.state.*`.
- **K** checks what is actually under the pointer (`elementsFromPoint`) against the hover. It is off under a preview.

## Board.tsx and state.ts

- **Shared file:** Board.tsx is shared with Player work. Commit only your own hunks, through a private index or explicit pathspecs. Never use a plain `git commit` on the shared index.
- **Scene order:** `state.scenes()` runs depth-first through the scene tree and leaves out Player's live layer.
- **Scene names:** "Scene N" is derived from position. A stored name matching `Scene <number>` counts as unnamed.
- **Default view:** `FIT_VIEW` ("36 36 928"), not "0 0 1000". Zoomed in past it, the map gets the clipped HUD look. At it and beyond, the map and frame scale together.
- **Clear** deletes in chunks of 256 ops per step and relies on `edit()` returning a boolean.

## Testing

- **Playwright:** run with `--output /tmp/<your-dir>`. Parallel agents otherwise delete each other's traces.
- **Heavy runs:** gate them with `/tmp/mapcro-scripts/gate.sh <secs>` (busy check, load under 12, abort on timeout).
- **Flaky under load:** some tests are frame-rate sensitive (lane glide, the K test, flip glide).
- **Killing processes:** never `pkill -f` a pattern that also appears in your own command line. It kills your own shell.

## Open

- Recolouring placed things from the palette is not built: ink, arrows and comments have no selection.
- The console warning "computations created outside createRoot" was reported once by QA. It has not been reproduced, even with a dev-mode Solid bundle.
