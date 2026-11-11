// The map's stencil: the shape the HUD shows the map through, and the edge drawn over it
// (feedback #21). Pure geometry, no DOM. One shape, with the pack or without.
//
// Units are the frame's: its box is 0..100 a side, and the map square is its middle 90
// (`#hud_minimap` is 360 of the 400 px frame), so the map spans 5..95.
//
// With the pack the stencil is `compass_frame_mask`'s shape, measured from its alpha (880 px a
// side; 2026-11-11, build 6860): a disc, centre (438.5, 439.5) radius 394.5 px, and two bumps of
// radius 102.3 px, the top one centred (487, 102) and the bottom one its turn by 180° about the
// disc's centre (390, 777). The art's small fillets where they meet are left out. Its rim is a
// 3 px band of rgb(90 90 90 / 0.29) (compass_frame). Without the pack the same shape: the drawn
// frame (`frame-fb`, a disc of radius 43 with centred bumps) is only a stand-in, and a smaller
// stencil there cut a fresh board's heroes.

/** Frame units → the map's box, 0..1 (an `objectBoundingBox` clip on the map's element). */
export const FRAME_TO_BOX = "translate(-0.055556 -0.055556) scale(0.0111111)";
/** Frame units → view units, 0..1000 over the map square (the board's overlay). */
export const FRAME_TO_VIEW = "translate(-55.5556 -55.5556) scale(11.11111)";

/** The stencil, in frame units: the disc's arcs between the bumps' arcs. */
export const STENCIL =
  "M45.55 5.31A11.63 11.63 0 0 1 66.50 8.33A44.83 44.83 0 0 1 54.11 94.57A11.63 11.63 0 0 1 33.16 91.55A44.83 44.83 0 0 1 45.55 5.31Z";
/** The stencil as circles (frame units), for a point test: inside one is inside. */
const DISCS = [
  { x: 49.83, y: 49.94, r: 44.83 },
  { x: 55.34, y: 11.59, r: 11.63 },
  { x: 44.32, y: 88.29, r: 11.63 },
];

/** Whether a point (frame units) is inside the stencil. */
export function inStencil(pt: { x: number; y: number }): boolean {
  return DISCS.some((d) => Math.hypot(pt.x - d.x, pt.y - d.y) <= d.r);
}

/** View units (0..1000 over the map square) → frame units. */
export const viewToFrame = (v: { x: number; y: number }) => ({ x: 5 + v.x * 0.09, y: 5 + v.y * 0.09 });
