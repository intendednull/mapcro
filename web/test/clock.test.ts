import { describe, expect, it } from "vitest";
import { formatClock, parseClock } from "../src/core/clock";

describe("match clock", () => {
  it("reads what people type", () => {
    expect(parseClock("8:00")).toBe(480);
    expect(parseClock(" 12:30 ")).toBe(750);
    expect(parseClock("8")).toBe(480);
    expect(parseClock("0:05")).toBe(5);
    expect(parseClock("1:02:03")).toBe(3723);
    expect(parseClock("")).toBeNull();
  });
  it("refuses what isn't a clock, or is past the schema's four hours", () => {
    for (const bad of ["8:60", "abc", "8:5", "-1", "5:00:00", "241"]) expect(parseClock(bad), bad).toBeUndefined();
  });
  it("formats like the HUD", () => {
    expect(formatClock(480)).toBe("8:00");
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(3723)).toBe("1:02:03");
    expect(formatClock(null)).toBe("");
  });
});
