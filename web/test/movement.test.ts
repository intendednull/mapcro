import { expect, it } from "vitest";
import { movementAt } from "../src/player/movement";
it("uses recorded height and half-open zipline intervals when scrubbing", () => {
  const p = { height: [[2, 1], [4, 2], [6, 0]] as [number, number][], zipline: [[3, 5]] as [number, number][] };
  expect(movementAt(p, 1)).toEqual({ height: undefined, zipline: false });
  expect(movementAt(p, 3)).toEqual({ height: 1, zipline: true });
  expect(movementAt(p, 5)).toEqual({ height: 2, zipline: false });
  expect(movementAt(p, 6)).toEqual({ height: 0, zipline: false });
  expect(movementAt({}, 6)).toEqual({ height: undefined, zipline: false });
});
