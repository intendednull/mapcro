// What presence carries of a presenter's map layers and open panels (player/layers.ts, spec §8).
import { describe, expect, it } from "vitest";
import { deathFromWire, deathKey, deathToWire, layersFromWire, layersToWire, slotFromWire, slotToWire } from "../src/player/layers";

const none = { troopers: false, health: false, pings: false, cc: false, movement: false, heals: false, crates: false };

describe("map layers on the wire", () => {
  it("one bit per toggle, in wire.rs's order", () => {
    // LAYER_TROOPERS = 1 … LAYER_CRATES = 1 << 6 (crates/engine/src/wire.rs).
    expect(layersToWire({ ...none, troopers: true })).toBe(1);
    expect(layersToWire({ ...none, health: true })).toBe(2);
    expect(layersToWire({ ...none, pings: true })).toBe(4);
    expect(layersToWire({ ...none, cc: true })).toBe(8);
    expect(layersToWire({ ...none, movement: true })).toBe(16);
    expect(layersToWire({ ...none, heals: true })).toBe(32);
    expect(layersToWire({ ...none, crates: true })).toBe(64);
  });
  it("round-trips, ignores unknown bits, and an older presenter's absence is none", () => {
    const l = { ...none, troopers: true, cc: true, crates: true };
    expect(layersFromWire(layersToWire(l))).toEqual(l);
    expect(layersFromWire(0)).toEqual(none);
    expect(layersFromWire(128 | 2)).toEqual({ ...none, health: true });
    expect(layersFromWire(undefined)).toBeUndefined();
    expect(layersFromWire(null)).toBeUndefined();
  });
});

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
