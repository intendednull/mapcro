// The honest messages (operator, 2026-11-08): each failure reads as an outcome and an action,
// and offers the right buttons.
import { describe, expect, it } from "vitest";
import { idFromName, isDem, noticeFor, sizeLabel } from "../src/player/notice";

describe("noticeFor", () => {
  it("says a match deadlock-api doesn't know yet is not found yet, with Try again and Upload", () => {
    expect(noticeFor("not_found", "load")).toEqual({
      text: "Match not found yet.",
      line: "New matches can take a while to reach deadlock-api. Try again later.",
      actions: ["retry", "upload"],
    });
  });
  it("says a replay Valve hasn't got is not found yet, and an old one expired", () => {
    expect(noticeFor("no_replay", "fetch")).toEqual({ text: "Replay not found yet. Try again later, or upload the replay file.", actions: ["retry", "upload"] });
    expect(noticeFor("expired", "fetch")).toEqual({ text: "Replay expired. Upload the replay file.", actions: ["upload"] });
  });
  it("says busy for every backoff", () => {
    for (const c of ["upstream_limited", "rate_limited", "busy", "queue_full"]) expect(noticeFor(c, "fetch")?.text).toBe("Busy. Try again in a few minutes.");
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
