import { expect, it } from "vitest";
import { recapFor } from "../src/player/recap";
import type { Timeline } from "../src/match/timeline";
it("matches a lethal hit to its sampled death without borrowing another hero or death", () => {
  const recap = { t: 4048, damage: [[255, 0, 500]] };
  const tl = { players: [{ team: "amber", slot: 0, recaps: [recap] }] } as unknown as Timeline;
  expect(recapFor(tl, { kind: "death", t: 405, team: "amber", slot: 0 })).toBe(recap);
  expect(recapFor(tl, { kind: "death", t: 404, team: "amber", slot: 0 })).toBeUndefined();
  expect(recapFor(tl, { kind: "death", t: 405, team: "sapphire", slot: 0 })).toBeUndefined();
  expect(recapFor(tl, { kind: "ult", t: 405, team: "amber", slot: 0 })).toBeUndefined();
});
