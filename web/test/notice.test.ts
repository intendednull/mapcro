// The honest messages (operator, 2026-11-08): each failure reads as an outcome and an action,
// and offers the right buttons.
import { describe, expect, it } from "vitest";
import { PROMPT, canRetry, idFromName, isDem, noticeFor, sizeLabel, unavailableFor } from "../src/player/notice";

describe("noticeFor", () => {
  it("says a match deadlock-api doesn't know yet is not found yet, with Try again and Upload", () => {
    expect(noticeFor("not_found", "load")).toEqual({
      text: "Match not found yet.",
      line: "New matches can take a while to reach deadlock-api. Try again later.",
      actions: ["retry", "upload"],
    });
  });
  it("says busy for every backoff", () => {
    for (const c of ["upstream_limited", "rate_limited", "busy", "queue_full"]) expect(noticeFor(c, "load")?.text).toBe("Busy. Try again in a few minutes.");
    expect(noticeFor("busy", "upload")?.actions).toEqual(["upload"]);
  });
  it("gives every parse failure an action after its outcome", () => {
    for (const c of ["not_a_replay", "too_large", "corrupt", "timeout", "parse_failed", "old_map", "brawl", "unsupported_mode"]) {
      const n = noticeFor(c, "upload")!;
      expect(n.text.split(". ").length, `${c}: ${n.text}`).toBeGreaterThanOrEqual(2);
    }
    expect(noticeFor("corrupt", "upload")?.text).toBe("Corrupt. Download the replay again in Deadlock, then upload it.");
  });
});

describe("unavailableFor", () => {
  it("gives each fetch failure the prompt's reason, and an expired one no Try again", () => {
    const want: Record<string, string> = {
      no_replay: "Valve doesn't have the replay yet.",
      not_found: "Valve doesn't have the replay yet.",
      expired: "Valve keeps replays about 3 weeks, and this one has expired.",
      upstream_limited: "Replay downloads are busy right now.",
      rate_limited: "Replay downloads are busy right now.",
      busy: "Replay downloads are busy right now.",
      queue_full: "Replay downloads are busy right now.",
      upstream_down: "deadlock-api is down right now.",
      upstream_shape: "deadlock-api is down right now.",
      parse_failed: "The download couldn't be read.",
      corrupt: "The download couldn't be read.",
      timeout: "The download couldn't be read.",
    };
    for (const [code, line] of Object.entries(want)) expect(PROMPT.reason[unavailableFor(code)!], code).toBe(line);
    expect(canRetry("expired")).toBe(false);
    for (const u of ["not_yet", "busy", "down", "unreadable"] as const) expect(canRetry(u)).toBe(true);
  });
  it("leaves the failures that keep their notice alone", () => {
    for (const c of ["old_map", "brawl", "unsupported_mode", "offline", "view_only", "replays_off", "in_progress"]) expect(unavailableFor(c), c).toBeUndefined();
  });
});

describe("replay files", () => {
  it("reads the match id from the game's file name and checks the extension", () => {
    expect(idFromName("129738985.dem")).toBe("129738985");
    expect(idFromName("00129738985.dem")).toBe("129738985");
    expect(idFromName("replay.dem")).toBeUndefined();
    expect(isDem("129738985.DEM")).toBe(true);
    expect(isDem("129738985.dem.bz2")).toBe(false);
  });
  it("sizes in decimal MB, as the file manager does", () => {
    expect(sizeLabel(212_000_000, 504_444_628)).toBe("212 / 504 MB");
  });
});
