# v1-board

The first UI pass for mapcro, written for the Design canvas. Open `/canvas` in the design agent's
session and pick **mapcro v1 board** from the menu at the top left. The full rationale and the
open questions are in the **Design notes** artboard (`notes.html`), where you can pin comments on them.

| Artboard | File | Size |
|---|---|---|
| Board, desktop: presenting (3 following) | `board-presenting.html` | 1440 × 900 |
| Board, desktop: following Coach | `board-follower.html` | 1440 × 900 |
| Board, desktop: drifted out of follow | `board-follower-drift.html` | 1440 × 900 |
| Share dialog (owner only) | `share-dialog.html` | 1440 × 900 |
| Phone: viewer following a presentation | `phone-following.html` | 390 × 844 |
| Map gestures: the map is the editor | `gestures.html` | 1000 |
| State gallery | `states.html` | 1000 |
| Design notes and open questions | `notes.html` | 1000 |

All pages share `board.css`, and each links `tweaks.css` last. The canvas declares five tweaks:
live accent, Amber, Sapphire, density and map darkness.

**No game assets.** The map is an original schematic SVG (three lanes, a mid, two bases and
generic glyphs) and says on screen that a server's map pack replaces it. Heroes are coloured
tokens with initials. The pages use no web fonts and make no network requests. See `provenance.json`.

## How the "map is the interface" rule was applied

- **No tool rail and no modes.** The Move, Arrow and Callout tools are gone. What you grab decides
  the action, and the cursor shows it before you press:
  - Dragging a token's body moves it (`grab`, then `grabbing`). Others see the move live, with a
    dashed trail in the dragger's colour (follower board, Juno moving Seven).
  - Dragging from a token's rim, or from empty map, draws an arrow (`crosshair`). Hovering a token
    shows the rim and a small arrow handle (presenting board, Abrams).
  - Clicking an objective glyph cycles it active → destroyed → hidden (`pointer`). Hidden glyphs
    show as faint outlines while the pointer is over the map, so they can be found again.
  - Double-clicking the map drops a callout already in edit mode (`text`). Enter keeps it and Esc
    removes it.
  - Right-clicking a token, or long-pressing it on touch, opens a radial menu: mark dead or alive,
    swap hero, unplace.
- **The roster edits in place.** Click a name to rename it, and drop a hero on a slot, which glows
  as a drop target.
- **Viewpoint** moved from a segmented control onto the map frame, as a small flip button in the
  corner.
- **The only chrome left:** the scene strip, presence (avatars and the people list), Share, save
  status, the follow banner, and one line of gesture hints under the map.
- On the **phone**, callouts collapse to numbered pins, with their text listed under the map.

## Where a separate control may still be justified (your call)

1. **Hero picker.** "Swap hero" and "drop a hero onto a slot" both need a list of heroes to
   choose from. It's a small popover that opens from the slot or the radial menu, not a panel.
   Without it, there's nothing to drag a new hero from.
2. **Scene note.** Free text for each scene has no place on the map, so it stays a text box in
   the side column. The alternative is to drop it and use callouts only.
3. **Undo and redo on touch.** Ctrl+Z works on the desktop. On a tablet, there's no keyboard to
   press. This pass shows no buttons, so touch editors may need two small ones.
4. **Restoring hidden objectives.** The faint outline that appears on hover can be found with a
   mouse, but not on touch. A "show hidden" toggle, or a long-press on the map, may be needed.
5. **Panning versus drawing arrows.** Dragging empty map draws an arrow, so panning needs
   Space+drag, a right-drag or two fingers. If coaches pan more than they draw, empty-map drag
   should pan instead, and arrows should start only from a token's rim (Q4 in the notes).
6. **Share dialog.** This is a real form: a label, a role and a list of links to revoke. Minting
   keys can't be done by dragging things on the map, so it stays a dialog.
7. **Arrow colour from empty map.** An arrow drawn from a token takes that token's team colour.
   One drawn from empty map has none, so it currently takes the colour of the last arrow drawn.
   A colour choice in the radial menu would make that explicit.
