import { describe, expect, it } from "vitest";
import { crowdControlAt } from "../src/player/cc";

describe("compact replay crowd control", () => {
  const p = { cc: [[100, 120, 14, 255, 0], [105, 115, 17, 1, 4], [108, 110, 20, 1, 4]] as Array<[number, number, number, number, number]> };
  it("uses half-open decisecond intervals and the strongest supported state", () => {
    expect(crowdControlAt(p, 9.99)).toBeUndefined();
    expect(crowdControlAt(p, 10)).toBe("Disarmed");
    expect(crowdControlAt(p, 10.5)).toBe("Silenced");
    expect(crowdControlAt(p, 10.8)).toBe("Stunned");
    expect(crowdControlAt(p, 11)).toBe("Silenced");
    expect(crowdControlAt(p, 11.5)).toBe("Disarmed");
    expect(crowdControlAt(p, 12)).toBeUndefined();
  });
  it("needs no source attribution and ignores unsupported states", () => {
    expect(crowdControlAt({ cc: [[0, 100, 81, 255, 0]] }, 5)).toBeUndefined();
    expect(crowdControlAt({}, 10)).toBeUndefined();
    expect(crowdControlAt(p, 10)).toBe("Disarmed");
  });
  it("pause and seeking recompute the same frame without remembered effects", () => {
    expect(crowdControlAt(p, 10.9)).toBe("Stunned");
    expect(crowdControlAt(p, 10.9)).toBe("Stunned");
    expect(crowdControlAt(p, 30)).toBeUndefined();
    expect(crowdControlAt(p, 10.9)).toBe("Stunned");
  });
});
