// The trooper dots: decoding, sliding between samples, and never inventing one.
import { describe, expect, it } from "vitest";
import { RIFT_TROOPER, decodeSample, troopersAt } from "../src/player/troopers";
import type { Timeline } from "../src/match/timeline";

function pack(list: Array<[number, number, number]>): string {
  const b = new Uint8Array(list.length * 6);
  const v = new DataView(b.buffer);
  list.forEach(([id, x, y], i) => {
    v.setUint16(i * 6, id, true);
    v.setInt16(i * 6 + 2, x, true);
    v.setInt16(i * 6 + 4, y, true);
  });
  return btoa(String.fromCharCode(...b));
}

const tl = {
  troopers: { every_s: 1, amber: [pack([[1, 0, 0], [2, 100, 100]]), pack([[1, 100, -50]]), ""], sapphire: [pack([[9, -300, 400]]), "", ""] },
} as unknown as Timeline;

describe("trooper dots", () => {
  it("decode little-endian id, x, y triples", () => {
    expect(decodeSample(pack([[65535, -16384, 16384]]))).toEqual([[65535, -16384, 16384]]);
    expect(decodeSample("")).toEqual([]);
  });
  it("slide a trooper seen in both samples, and keep gaps as gaps", () => {
    expect(troopersAt(tl, 0.5).filter((d) => d.team === "amber" && d.id === 1)).toEqual([{ team: "amber", id: 1, x: 50, y: -25, rift: false }]);
    // Trooper 2 is gone by the next sample: shown only in the first half.
    expect(troopersAt(tl, 0.25).some((d) => d.id === 2)).toBe(true);
    expect(troopersAt(tl, 0.75).some((d) => d.id === 2)).toBe(false);
    // Nothing recorded at 2 s: no dots, none invented.
    expect(troopersAt(tl, 2)).toEqual([]);
  });
  it("mark a rift's trooper by bit 15 of its id, and follow it by the whole id", () => {
    const rift = { troopers: { every_s: 1, amber: [pack([[RIFT_TROOPER | 7, 0, 0], [7, 50, 50]]), pack([[RIFT_TROOPER | 7, 100, 0]])], sapphire: ["", ""] } } as unknown as Timeline;
    expect(troopersAt(rift, 0.25)).toEqual([
      { team: "amber", id: RIFT_TROOPER | 7, x: 25, y: 0, rift: true },
      { team: "amber", id: 7, x: 50, y: 50, rift: false },
    ]);
  });
});
