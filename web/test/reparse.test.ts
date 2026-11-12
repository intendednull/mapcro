// Reparse in the app (operator, 2026-11-11): a stale upload whose demo is in the app's replays
// folder is offered Reparse; without the demo, today's upload stays the way; in a browser nothing
// changes; an app whose parser the server refused as older points at the update instead.
import { describe, expect, it } from "vitest";
import { OUTDATED_KEY, REPARSE, isOutdated, markOutdated, reparseOffer } from "../src/player/reparse";

const base = { app: true, stale: true, canUpload: true, inFolder: true, outdated: false };

describe("reparseOffer", () => {
  it("offers Reparse for a stale upload whose demo is in the app's folder", () => {
    expect(reparseOffer(base)).toBe("reparse");
  });
  it("offers nothing without the demo: the upload stays the way", () => {
    expect(reparseOffer({ ...base, inFolder: false })).toBeUndefined();
  });
  it("offers nothing in a browser", () => {
    expect(reparseOffer({ ...base, app: false })).toBeUndefined();
    expect(reparseOffer({ ...base, app: false, outdated: true })).toBeUndefined();
  });
  it("points at the update when this app's parser was refused as older, demo or not", () => {
    expect(reparseOffer({ ...base, outdated: true })).toBe("update");
    expect(reparseOffer({ ...base, outdated: true, inFolder: false })).toBe("update");
  });
  it("offers nothing for a current timeline", () => {
    expect(reparseOffer({ ...base, stale: false })).toBeUndefined();
    expect(reparseOffer({ ...base, stale: false, outdated: true })).toBeUndefined();
  });
  it("offers nothing to someone who can't upload (view only, or one under way)", () => {
    expect(reparseOffer({ ...base, canUpload: false })).toBeUndefined();
    expect(reparseOffer({ ...base, canUpload: false, outdated: true })).toBeUndefined();
  });
});

describe("the outdated mark", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  it("is unset until a refusal marks it, for this run's storage", () => {
    const s = store();
    expect(isOutdated(s)).toBe(false);
    markOutdated(s);
    expect(isOutdated(s)).toBe(true);
    expect(s.getItem(OUTDATED_KEY)).toBe("1");
  });
  it("is unset without storage, and storage that throws is no mark", () => {
    expect(isOutdated(undefined)).toBe(false);
    const bad = { getItem: () => { throw new Error("off"); }, setItem: () => { throw new Error("off"); } };
    expect(() => markOutdated(bad)).not.toThrow();
    expect(isOutdated(bad)).toBe(false);
  });
});

describe("the words", () => {
  it("are short tags (spec §4b)", () => {
    for (const w of Object.values(REPARSE)) expect(w.split(" ").length).toBeLessThanOrEqual(4);
    expect(REPARSE).toEqual({ text: "Outdated", button: "Reparse", title: "Reparse replay", update: "Update the mapcro app" });
  });
});
