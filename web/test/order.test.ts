// The TypeScript port of `OrderKey::between`, held to the Rust tests' cases.
import { describe, expect, it } from "vitest";
import { FIRST_KEY, isValidKey, keyBetween } from "../src/core/order";

describe("scene order keys", () => {
  it("are strictly between their neighbours and valid (the Rust test's cases)", () => {
    const cases: Array<[string | undefined, string | undefined]> = [
      [undefined, undefined],
      ["i", undefined],
      [undefined, "i"],
      ["i", "j"],
      ["i", "i1"],
      ["a", "b"],
      ["zz", undefined],
      [undefined, "01"],
      ["i", "ii"],
    ];
    for (const [lo, hi] of cases) {
      const m = keyBetween(lo, hi);
      expect(isValidKey(m), `${m} for ${lo}..${hi}`).toBe(true);
      if (lo !== undefined) expect(m > lo, `${m} > ${lo}`).toBe(true);
      if (hi !== undefined) expect(m < hi, `${m} < ${hi}`).toBe(true);
    }
  });

  it("match the Rust midpoint on simple cases", () => {
    expect(keyBetween(undefined, undefined)).toBe("i");
    expect(keyBetween("i", undefined)).toBe("r");
    expect(keyBetween(undefined, "i")).toBe("9");
    expect(keyBetween("i", "j")).toBe("ii");
  });

  it("stay ordered over repeated inserts at one spot", () => {
    let lo = FIRST_KEY;
    for (let i = 0; i < 40; i++) {
      const m = keyBetween(lo, "j");
      expect(m > lo && m < "j" && isValidKey(m)).toBe(true);
      lo = m;
    }
  });
});
