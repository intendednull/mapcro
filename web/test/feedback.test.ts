// The feedback form's Retry-After wording, and the match it offers to attach (core/feedback.ts).
import { describe, expect, it } from "vitest";
import { feedbackMatchOf, matchLine, waitText } from "../src/core/feedback";
import type { Timeline } from "../src/match/timeline";

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

describe("the match it attaches", () => {
  const tl = (tier: string) => ({ match_id: 134570618, tier }) as unknown as Timeline;
  it("is the open match, at the whole second, in the tier's wire word", () => {
    expect(feedbackMatchOf(true, "134570618", tl("replay"), 542.9)).toEqual({ id: "134570618", t_s: 542, tier: "replay" });
    expect(feedbackMatchOf(true, "134570618", tl("metadata"), 0)).toEqual({ id: "134570618", t_s: 0, tier: "summary" });
  });
  it("is none in the sandbox, with nothing open, or while another match loads", () => {
    expect(feedbackMatchOf(false, "134570618", tl("replay"), 10)).toBeUndefined();
    expect(feedbackMatchOf(true, undefined, tl("replay"), 10)).toBeUndefined();
    expect(feedbackMatchOf(true, "134570618", undefined, 10)).toBeUndefined();
    expect(feedbackMatchOf(true, "999", tl("replay"), 10)).toBeUndefined();
  });
  it("reads in m:ss and the tier's user-facing words", () => {
    expect(matchLine({ id: "134570618", t_s: 542, tier: "replay" })).toBe("match 134570618 at 9:02 (Full replay)");
    expect(matchLine({ id: "7", t_s: 3725, tier: "summary" })).toBe("match 7 at 62:05 (API summary)");
  });
});
