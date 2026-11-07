# v1-board

The first UI pass for mapcro, written for the Design canvas. Open `/canvas` in the design agent's
session and pick **mapcro v1 board** from the menu at the top left. The full rationale, the
operator's answers and what's still open are in the **Design notes** artboard (`notes.html`),
where you can pin comments on them.

| Artboard | File | Size |
|---|---|---|
| Board, desktop: presenting, with ink and a live laser | `board-presenting.html` | 1440 × 900 |
| Board, desktop: following Coach | `board-follower.html` | 1440 × 900 |
| Board, desktop: stopped following (panned) | `board-follower-drift.html` | 1440 × 900 |
| Share dialog: owner, sees every link | `share-dialog.html` | 1440 × 900 |
| Share dialog: editor, own links | `share-dialog-editor.html` | 1440 × 900 |
| Clone to a new board (flow) | `clone-flow.html` | 1440 |
| Join card: first visit | `join.html` | 1440 × 900 |
| Phone: viewer following a presentation | `phone-following.html` | 390 × 844 |
| Tools and gestures | `gestures.html` | 1000 |
| State gallery | `states.html` | 1000 |
| Design notes | `notes.html` | 1000 |

All pages share `board.css` and link `tweaks.css` last. The canvas declares five tweaks: live
accent, Amber, Sapphire, density and map darkness.

**Fonts** are self-hosted OFL faces in `design/fonts/`, each with its `OFL.txt`. Federo sets the
display text and Atkinson Hyperlegible Next the UI. Sources and hashes are in `provenance.json`.
No network: the canvas blocks it, and nothing here asks for it.

## The map

Every artboard's map is the shared parity minimap (`design/shared/minimap.js` and `.css`). It's
the in-game HUD rebuilt from the game's sources: see `design/parity/README.md` for the spec.

- Board layers draw on top: tokens, ink, arrows, callouts, laser, name tags and cursors.
- **Viewpoints:** the desktop boards are from the Amber side. The phone is from the Sapphire
  side, rotated with icons upright. The join card's backdrop uses the neutral tints.
- Scene thumbnails use the minimap's lite mode.

## Operator decisions applied (2026-11-06, spec §4, §8, §11)

- **Tools.** This reverses the earlier "no tool rail" rule. A compact picker under the map
  chooses what the cursor does, and the map stays the surface for every tool:
  - Move (V), the default: drag heroes and callouts, click objectives, drag empty map to pan.
  - Draw (D): freehand ink.
  - Arrow (A): drag out a rotation arrow.
  - Callout (C): click to place a label and type it in place.
  - Laser (L): a glowing trail others see, fading in about a second, never saved.
  - Erase (E): click or scrub over ink, arrows and callouts.

  Each tool sets its own cursor on the map through `data-tool`. Right-click on a hero opens the
  radial menu in any tool. The presenting board shows Coach's ink and Juno's live laser.
- **Follow is binary.** If you change what you see (flip a scene, pan, zoom, switch floor), you
  stop following. Following again is one click: the presenter's name and **Follow** are always
  in the top bar. There's no presenter nudge.
- **Several presenters.** Anyone with edit rights can be followed. The people list gives editors
  a one-click Follow, and viewers get none. The top bar names who you follow, with one-click
  switching ("Also presenting: vexa").
- **Editors share; nobody revokes.** Owners and editors both mint view and edit links. The owner
  sees every link, arranged as a tree, and editors see their own subtree. The dialogs only list
  links. To stop sharing with someone, anyone with a link, viewers included, uses **Clone to a
  new board**.
  - The clone keeps the scenes, roster, positions, ink and notes. It leaves behind history,
    links and presence.
  - It posts to `POST /api/boards/{id}/clone` and lands you on the copy as its owner, with Share
    ready.
- **Ink, laser, clear.**
  - Ink takes its colour from a palette that opens beside Draw, and the Draw button shows the
    current colour.
  - Laser holds briefly, then fades from its tail, and is never saved. Everyone has it: a view
    link's picker is Look plus Laser, as on the phone board.
  - **Clear ink** sits beside Erase. It removes every stroke on the scene in one undo step, and
    its toast says Undo.
- **Name tags on what people touch.** Dragging, selecting or editing an element shows the
  person's name beside it in their presence colour, with a matching outline. Two people on one
  element stack their tags; on the presenting board, vexa and Marrow share a callout. This draws
  on presence `drag` and `focus`.
- **Names are set on joining.** A one-field join card asks for a name and a colour, and Enter
  joins. Both are remembered on the device, and the people list's **Name** button changes them.
- **Fonts:** Federo, single weight, stays.

## Still a separate control (your call)

- **Hero picker.** "Swap hero" and dropping a hero onto a slot need a list of heroes to pick from.
- **Scene note.** Free text for each scene has no place on the map.
- **Restoring hidden objectives on touch.** The hover outline doesn't exist on touch, so a
  long-press or a "show hidden" toggle is needed.
- **Share and clone dialogs.** Minting a link and naming a copy are forms by nature.
- **Ink palette.** A row of swatches that only shows while Draw is active.

## Local game art (optional, never committed)

`design/_art/` holds art extracted from the local Deadlock install: the surface minimap layer,
the HUD objective icons and 12 hero minimap portraits. It's git-ignored. `_art/manifest.json`
records the source path, the build (6860, SourceRevision 11211860), and each file's archive
entry, CRC and SHA-256.

- Pages link `../_art/art.css`. That file defines only CSS variables (`--art-*`, `--art-display`
  and `--schem-display`). `board.css` uses each one with a fallback.
- With the art present, the real streets show in the board's palette, with the game's objective
  icons tinted by team and portraits on team-ringed tokens. Shrines keep the original glyph,
  because the game files have no minimap icon for them.
- Without it (a fresh clone), the canvas drops the missing stylesheet. Every artboard then
  renders the original schematic, with no errors and no requests.
- Objectives sit at their real map positions, taken from the entity lump via deadlock-api's
  transform (`R = 10752`). The schematic lanes run through them.
