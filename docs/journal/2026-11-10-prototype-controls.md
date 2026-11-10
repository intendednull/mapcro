# Controls layout prototype — 2026-11-10

Implemented in isolated `/tmp/mapcro-controls`, branch `prototype-controls`. Reference: Argon UX notes and control organization only; retained existing board typography, palette, surfaces, frames, and all game art. Existing collapsed/expanded scoreboard is unchanged.

- Drawing toolbar contains annotation tools, ink, comment visibility, clear, undo and redo.
- Canvas controls group Map layers, team vision, last seen and flip. Layer disclosure contains replay health/names/troopers/pings, optional default-off CC when data exists, healing pickups and heavy boxes. Native disclosures close on Escape/outside click.
- Replay transport fits a single row at desktop sizes. Match source/load/upload controls live in a disclosure; replay tier remains visible in the board header.
- Scene tree includes an explicit Replay entry and does not highlight a saved scene while watching replay.
- Right sidebar has keyboard navigable Events and Scene Notes tabs, plus people footer. Notes explicitly identify the selected scene during replay. Clicking an event returns to replay. Saving a replay scene switches to the scene so moved annotations remain visible.
- Phone retains layers/vision/flip through the same controls; transport wraps for its smaller viewport.

Verification: TypeScript typecheck passed with peer death/CC changes copied temporarily for the shared interfaces (not included in this commit). Five existing unit suites passed, 29 tests total (vision, playback clock/events, live ink, scenes), two workers. Browser smoke against isolated backend with names replaced by `Player 1` through `Player 12` before rendering: layer toggle persisted state, both right tabs, save switches to scene, Replay entry returns to match, no page errors. At 1280×800, 1440×800 and 1920×1080, toolbar was 34px tall, transport 30px, and tools/save remained inside stage. Sanitized screenshots are `/tmp/controls-{1280,1440,1920}.png`, not committed.

Focused existing health/names/pings e2e specs now reveal controls through a shared helper. Full e2e execution and integration build remain for coordinator; other existing specs that directly act on hidden source/layer controls need the same helper when run. No heavy build, deployment, push, asset commits, or server shutdown performed. Phone layout retained by code review; desktop browser checks were the focus.
