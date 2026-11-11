// What presence carries of a presenter's open panels (player/layers.ts, spec §8). The map
// layers' bits are registry keys: view-state.test.ts.
import { describe, expect, it } from "vitest";
import { deathFromWire, deathKey, deathToWire, slotFromWire, slotToWire } from "../src/player/layers";

describe("panels on the wire", () => {
  it("slots and deaths by roster slot", () => {
    expect(slotToWire("amber-0")).toEqual({ team: "Amber", slot: 0 });
    expect(slotToWire("sapphire-5")).toEqual({ team: "Sapphire", slot: 5 });
    expect(slotToWire("")).toBeUndefined();
    expect(slotFromWire({ team: "Sapphire", slot: 2 })).toBe("sapphire-2");
    expect(slotFromWire(undefined)).toBeUndefined();
    expect(deathToWire({ slot: "amber-1", t: 20 })).toEqual({ team: "Amber", slot: 1, t: 20 });
    expect(deathFromWire({ team: "Amber", slot: 1, t: 20 })).toEqual({ slot: "amber-1", t: 20 });
    expect(deathToWire(undefined)).toBeUndefined();
    expect(deathKey({ slot: "amber-1", t: 20 })).not.toBe(deathKey({ slot: "amber-1", t: 21 }));
  });
});
