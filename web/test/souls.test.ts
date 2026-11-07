import { describe, expect, it } from "vitest";
import { formatSouls, parseSouls, teamTotal } from "../src/core/souls";

describe("souls", () => {
  it("format like the HUD, truncating", () => {
    expect(formatSouls(950)).toEqual({ value: "950", k: false });
    expect(formatSouls(9040)).toEqual({ value: "9.0", k: true });
    expect(formatSouls(7399)).toEqual({ value: "7.3", k: true });
    expect(formatSouls(44830)).toEqual({ value: "44", k: true });
    expect(formatSouls(null)).toEqual({ value: "–", k: false });
  });
  it("read what people type", () => {
    expect(parseSouls("9040")).toBe(9040);
    // A bare number under 1000 is thousands.
    expect(parseSouls("8")).toBe(8000);
    expect(parseSouls("20")).toBe(20000);
    expect(parseSouls("7.5")).toBe(7500);
    expect(parseSouls("999")).toBe(999000);
    expect(parseSouls("1000")).toBe(1000);
    expect(parseSouls("9k")).toBe(9000);
    expect(parseSouls(" 9.5K ")).toBe(9500);
    expect(parseSouls("12,500")).toBe(12500);
    expect(parseSouls("")).toBeNull();
    for (const bad of ["abc", "-5", "9kk", "1e5", "5000000"]) expect(parseSouls(bad), bad).toBeUndefined();
  });
  it("team totals are sums, untracked counting as nothing", () => {
    expect(teamTotal([9040, 7310, null, 6120])).toBe(22470);
    expect(formatSouls(teamTotal([9040, 7310, 6120, 7100, 7500, 7760]))).toEqual({ value: "44", k: true });
  });
});

import { ultFromVector, ultStep } from "../src/core/souls";
describe("ult ring", () => {
  it("maps the drag angle clockwise from 12 o'clock", () => {
    expect(ultFromVector(0, -1)).toBe(0);
    expect(ultFromVector(1, 0)).toBe(25);
    expect(ultFromVector(0, 1)).toBe(50);
    expect(ultFromVector(-1, 0)).toBe(75);
    expect(ultFromVector(-0.01, -1)).toBe(100);
  });
  it("scrolls in 5% steps within 0–100", () => {
    expect(ultStep(60, true)).toBe(65);
    expect(ultStep(0, false)).toBe(0);
    expect(ultStep(100, true)).toBe(100);
    expect(ultStep(null, true)).toBe(5);
  });
});

import { splitTotal } from "../src/core/souls";
describe("team total, shared out", () => {
  it("splits evenly, the remainder one soul each to the first heroes, summing exactly", () => {
    expect(splitTotal(40000, 6)).toEqual([6667, 6667, 6667, 6667, 6666, 6666]);
    expect(splitTotal(40500, 6)).toEqual([6750, 6750, 6750, 6750, 6750, 6750]);
    expect(splitTotal(5, 6)).toEqual([1, 1, 1, 1, 1, 0]);
    expect(splitTotal(0, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    for (const t of [1, 59999, 123457]) expect(splitTotal(t, 6).reduce((a, b) => a + b)).toBe(t);
    expect(splitTotal(100, 0)).toEqual([]);
  });
});
