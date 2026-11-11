// Panels a person moves on the board pane (#35, #37; player/panelPlace.ts): a place relative to
// the pane, read back on a pane of another size, clamped into it and off its controls; and the
// hero panels and the recap's place as presence carries them, within what the server takes.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initSync, presenceFrameOk } from "../src/wasm/mapcro_wasm.js";
import { VIEW_STATE } from "../src/gen/viewState";
import { PLACE_SCALE, type HeroPanelOpen, heroPanelsFromWire, heroPanelsToWire, placeFromWire, placeToWire } from "../src/player/layers";
import { type Pane, cascade, clampSpot, paneOf, placeOf, spotOf } from "../src/player/panelPlace";
import { createViewState, type Values, VIEW_KEYS } from "../src/player/viewstate";

initSync({ module: readFileSync(join(resolve(__dirname, "../.."), "web/src/wasm/mapcro_wasm_bg.wasm")) });

const pane = (w: number, h: number, top = 0, bottom = 0): Pane => ({ w, h, top, bottom });
const MAX = VIEW_STATE["heroes.panels"].max;

describe("a panel's place in the pane", () => {
  it("is measured from the nearer edge on each axis, and reads back where it was", () => {
    const p = pane(800, 600);
    expect(placeOf({ left: 40, top: 60 }, 200, 100, p)).toEqual({ x: 500, y: 1000, right: false, bottom: false });
    // Right of centre and below it: from the right and bottom edges, to the panel's own.
    expect(placeOf({ left: 560, top: 440 }, 200, 100, p)).toEqual({ x: 500, y: 1000, right: true, bottom: true });
    // By the panel's centre, not its corner: left of centre at its corner, right of it at its centre.
    expect(placeOf({ left: 350, top: 260 }, 200, 100, p)).toMatchObject({ right: true, bottom: true });
    expect(placeOf({ left: 250, top: 240 }, 200, 100, p)).toMatchObject({ right: false, bottom: false });
    for (const at of [{ left: 40, top: 60 }, { left: 560, top: 440 }, { left: 299, top: 251 }, { left: 301, top: 249 }]) {
      // To a tenth of a pixel on this pane (a place is in ten-thousandths of it).
      const back = spotOf(placeOf(at, 200, 100, p), 200, 100, p);
      expect(Math.abs(back.left - at.left) + Math.abs(back.top - at.top)).toBeLessThan(0.1);
    }
  });
  it("keeps the layout on a pane of another size: the same share of it from the same edge", () => {
    const big = pane(1000, 1000);
    const small = pane(500, 400);
    // A panel near the right edge stays that near it, as a share of the width, whatever its size there.
    const right = placeOf({ left: 700, top: 100 }, 250, 300, big);
    expect(right).toMatchObject({ right: true, bottom: false });
    expect(spotOf(right, 250, 300, small)).toEqual({ left: 500 - 25 - 250, top: 40 });
    // One at the bottom left keeps its gap to the bottom.
    const low = placeOf({ left: 20, top: 650 }, 250, 300, big);
    expect(spotOf(low, 200, 200, small)).toEqual({ left: 10, top: 400 - 20 - 200 });
  });
  it("is clamped into the pane and off its controls' bands, on every screen", () => {
    const p = pane(500, 400, 36, 30);
    // Off every side.
    expect(clampSpot({ left: -50, top: -50 }, 200, 100, p)).toEqual({ left: 0, top: 36 });
    expect(clampSpot({ left: 900, top: 900 }, 200, 100, p)).toEqual({ left: 300, top: 400 - 30 - 100 });
    // Too tall for the room between the bands: at its top (its height is capped to the room).
    expect(clampSpot({ left: 10, top: 200 }, 200, 390, p)).toEqual({ left: 10, top: 36 });
    // A place from a bigger screen lands inside a small one.
    const far = placeOf({ left: 1500, top: 1500 }, 250, 300, pane(1800, 1800));
    const at = spotOf(far, 250, 300, p);
    expect(at.left).toBeGreaterThanOrEqual(0);
    expect(at.left + 250).toBeLessThanOrEqual(500);
    expect(at.top).toBeGreaterThanOrEqual(36);
    expect(at.top + 300).toBeLessThanOrEqual(400 - 30);
  });
  it("opens a step down and right of the last, below the controls, starting over after eight", () => {
    const p = pane(1000, 1000, 50, 0);
    const spots = [0, 1, 7, 8].map((n) => spotOf(cascade(n, p), 0, 0, p));
    expect(spots).toEqual([{ left: 12, top: 50 }, { left: 36, top: 74 }, { left: 180, top: 218 }, { left: 12, top: 50 }]);
  });
});

describe("the pane's own controls", () => {
  const rect = (left: number, top: number, width: number, height: number) => ({ getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }) }) as unknown as HTMLElement;
  it("take a band from the nearer edge past them, with a gap; ones off the pane or hidden take none", () => {
    const paneEl = rect(100, 50, 500, 400);
    // A row at the top (Map layers), one at the bottom (#33 moves them there), one hidden, one beside the pane.
    const got = paneOf(paneEl, [rect(104, 54, 120, 28), rect(110, 410, 200, 30), rect(300, 200, 0, 0), rect(620, 60, 40, 40)]);
    expect(got).toEqual({ w: 500, h: 400, top: 82 - 50 + 4, bottom: 450 - 410 + 4 });
    expect(paneOf(paneEl, [])).toEqual({ w: 500, h: 400, top: 0, bottom: 0 });
  });
});

describe("the store's hero panels", () => {
  it("an equal list is no change: nothing remembered, nothing re-sent", () => {
    const first = Object.fromEntries(VIEW_KEYS.map((k) => [k, undefined])) as unknown as Values;
    const own: unknown[] = [];
    const s = createViewState({ ...first, "recap.event": [], "events.search": "", "heroes.panels": [] } as Values, { onOwn: (k, v) => k === "heroes.panels" || k === "recap.skull.place" ? own.push(v) : undefined });
    const list = () => [{ slot: "amber-0", at: { x: 1, y: 2, right: false, bottom: false } }];
    s.set("heroes.panels", list());
    s.set("heroes.panels", list());
    s.set("recap.skull.place", { x: 3, y: 4, right: true, bottom: false });
    s.set("recap.skull.place", { x: 3, y: 4, right: true, bottom: false });
    expect(own).toHaveLength(2);
  });
});

describe("panels as presence carries them", () => {
  it("is the scale and cap wire.rs checks", () => {
    expect(PLACE_SCALE).toBe(VIEW_STATE["recap.skull.place"].scale);
    expect(PLACE_SCALE).toBe(VIEW_STATE["heroes.panels"].scale);
    expect(MAX).toBe(12);
  });
  it("a place: whole units in the pane, the edges left out when left and top; anything else is none", () => {
    expect(placeToWire({ x: 120.4, y: 400, right: false, bottom: false })).toEqual({ x: 120, y: 400 });
    expect(placeToWire({ x: 0, y: 10_000, right: true, bottom: true })).toEqual({ x: 0, y: 10_000, right: true, bottom: true });
    expect(placeToWire({ x: 10_001, y: 0, right: false, bottom: false })).toBeUndefined();
    expect(placeFromWire({ x: 5, y: 6, bottom: true })).toEqual({ x: 5, y: 6, right: false, bottom: true });
    for (const w of [null, 3, "a", { x: -1, y: 0 }, { x: 1 }, { x: 1.5, y: 2 }, { x: 1, y: 10_001 }]) expect(placeFromWire(w)).toBeUndefined();
  });
  it("hero panels: back to front, each hero once, at most every hero's (the front ones)", () => {
    const list: HeroPanelOpen[] = [...Array(14)].map((_, i) => ({ slot: `${i % 2 ? "sapphire" : "amber"}-${i >> 1}` }));
    const wire = heroPanelsToWire([{ slot: "amber-0" }, ...list], MAX);
    expect(wire).toHaveLength(MAX);
    expect(wire.at(-1)).toEqual({ team: "Sapphire", slot: 6 });
    expect(heroPanelsToWire([{ slot: "amber-1" }, { slot: "amber-1", at: { x: 1, y: 1, right: false, bottom: false } }, { slot: "nobody" }], MAX)).toEqual([{ team: "Amber", slot: 1 }]);
    expect(heroPanelsFromWire([{ team: "Amber", slot: 2, at: { x: 1, y: 2 } }, { team: "Purple", slot: 1 }, { team: "Amber", slot: 2 }, { team: "Sapphire", slot: 16 }, 7], MAX)).toEqual([{ slot: "amber-2", at: { x: 1, y: 2, right: false, bottom: false } }]);
    expect(heroPanelsFromWire({ team: "Amber" }, MAX)).toEqual([]);
  });
  it("every hero's panel moved, and the recap moved, is a presence the server takes", () => {
    const first = Object.fromEntries(VIEW_KEYS.map((k) => [k, undefined])) as unknown as Values;
    const s = createViewState({
      ...first,
      "recap.event": [],
      "events.search": "x".repeat(VIEW_STATE["events.search"].max),
      "builds.popover": "order",
      "vision.team": "amber",
      "recap.skull": { slot: "amber-1", t: 86_400 },
      "recap.skull.place": { x: 10_000, y: 10_000, right: true, bottom: true },
      "heroes.panels": ["amber", "sapphire"].flatMap((team) => [0, 1, 2, 3, 4, 5].map((n) => ({ slot: `${team}-${n}`, at: { x: 10_000, y: 10_000, right: true, bottom: true } }))),
    } as Values);
    const playback = { player: true, match_id: 999_999_999_999, t: 86_400, playing: true, speed: 16, ...(s.wire("playback").playback as { hero_panels: unknown[] }) };
    expect(playback.hero_panels).toHaveLength(MAX);
    const frame = (pb: object) => JSON.stringify({ t: "presence", state: { name: "n", color: 1, cursor: null, laser: [], laser_starts: [], drag: null, drag_group: [], picked: [], focus: null, following: null, ink: null, ping: null, laser_color: null, scene: null, floor: "surface", view: null, hover: null, layers: 127, playback: pb } });
    expect(presenceFrameOk(frame(playback))).toBe(true);
    // One past the cap, the same hero twice, a place past the pane: refused.
    const panels = playback.hero_panels;
    expect(presenceFrameOk(frame({ ...playback, hero_panels: [...panels, { team: "Amber", slot: 6 }] }))).toBe(false);
    expect(presenceFrameOk(frame({ ...playback, hero_panels: [panels[0], panels[0]] }))).toBe(false);
    expect(presenceFrameOk(frame({ ...playback, skull_place: { x: 10_001, y: 0 } }))).toBe(false);
  });
});
