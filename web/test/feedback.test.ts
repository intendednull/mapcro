// The feedback form's Retry-After wording (core/feedback.ts).
import { describe, expect, it } from "vitest";
import { waitText } from "../src/core/feedback";

describe("waitText", () => {
  it("says roughly when to try again", () => {
    expect(waitText(30)).toBe("in a minute");
    expect(waitText(61)).toBe("in about 2 minutes");
    expect(waitText(3600)).toBe("in about 60 minutes");
    expect(waitText(5400)).toBe("in about 2 hours");
    expect(waitText(86_400)).toBe("in about 24 hours");
  });
  it("falls back when the header is missing or odd", () => {
    expect(waitText(Number(null))).toBe("later");
    expect(waitText(Number("soon"))).toBe("later");
    expect(waitText(-5)).toBe("later");
  });
});
