// The Windows app's replay picker (spec §6b, The Windows app): its list (the open match first,
// then newest first, settled files only), the card labels, the preview's shape, and the preview
// cache (asked once per match; a miss asked again only after a while).
import { describe, expect, it } from "vitest";
import { MODE_LABELS, ago, lengthLabel, modeLabel, parsePreview, pickerList, previewCache } from "../src/player/picker";

const NOW = 1_800_000_000_000;
const r = (id: string, agoMs: number) => ({ id, lastModified: NOW - agoMs, size: 1 });

describe("pickerList", () => {
  it("puts the open match first, then newest first, and leaves out a file still downloading", () => {
    const list = [r("300", 1_000), r("200", 60_000), r("100", 3_600_000), r("50", 7_200_000)];
    expect(pickerList(list, "100", NOW).map((x) => x.id)).toEqual(["100", "200", "50"]);
    expect(pickerList(list, undefined, NOW).map((x) => x.id)).toEqual(["200", "100", "50"]);
    // The open match's file, still downloading, isn't offered either.
    expect(pickerList(list, "300", NOW).map((x) => x.id)).toEqual(["200", "100", "50"]);
  });
});

describe("labels", () => {
  it("says when, relative, then the date", () => {
    expect(ago(NOW - 10_000, NOW)).toBe("just now");
    expect(ago(NOW - 5 * 60_000, NOW)).toBe("5 min ago");
    expect(ago(NOW - 2 * 3_600_000 - 59_000, NOW)).toBe("2 h ago");
    expect(ago(NOW - 3 * 86_400_000, NOW)).toBe("3 d ago");
    expect(ago(NOW - 30 * 86_400_000, NOW)).toBe(new Date(NOW - 30 * 86_400_000).toLocaleDateString());
    expect(ago(NOW + 5_000, NOW)).toBe("just now");
  });
  it("writes the length as the game's clock", () => {
    expect(lengthLabel(2052)).toBe("34:12");
    expect(lengthLabel(65)).toBe("1:05");
  });
});

const PREVIEW = {
  match_id: 111,
  start_time: 1_793_753_219,
  duration_s: 2052,
  game_mode: 1,
  winner: "sapphire",
  teams: [
    { team: "amber", heroes: [[0, 11], [1, 12]], kills: 30, souls: 210_000 },
    { team: "sapphire", heroes: [[0, 17]], kills: 28, souls: 190_000 },
  ],
};

describe("parsePreview", () => {
  it("takes the server's shape and nothing else", () => {
    expect(parsePreview(PREVIEW)).toEqual(PREVIEW);
    // Extra fields (a name, were one ever sent) don't come through.
    const named = { ...PREVIEW, teams: PREVIEW.teams.map((t) => ({ ...t, name: "x" })) };
    expect(JSON.stringify(parsePreview(named))).not.toContain("name");
    expect(parsePreview({ ...PREVIEW, winner: null })?.winner).toBeNull();
    for (const bad of [null, {}, { ...PREVIEW, winner: "red" }, { ...PREVIEW, teams: [PREVIEW.teams[0]] }, { ...PREVIEW, duration_s: -1 }, { ...PREVIEW, teams: [{ ...PREVIEW.teams[0], kills: "9" }, PREVIEW.teams[1]] }]) {
      expect(parsePreview(bad)).toBeUndefined();
    }
  });
  it("names a mode the board doesn't take", () => {
    expect(modeLabel(parsePreview(PREVIEW)!)).toBeUndefined();
    expect(modeLabel(parsePreview({ ...PREVIEW, game_mode: 4 })!)).toBe("Street Brawl");
    expect(modeLabel(parsePreview({ ...PREVIEW, game_mode: 7 })!)).toBe(MODE_LABELS.unsupported_mode);
  });
});

describe("previewCache", () => {
  /** A server answering per id, counting calls. */
  function server(answers: Record<string, { status: number; body: unknown } | undefined>) {
    const calls: string[] = [];
    return { calls, get: async (id: string) => (calls.push(id), answers[id]) };
  }

  it("asks once per match, even when asked twice at once", async () => {
    const s = server({ "111": { status: 200, body: PREVIEW } });
    const c = previewCache(s.get, () => NOW);
    const [a, b] = await Promise.all([c.ask("111"), c.ask("111")]);
    expect(a).toEqual({ kind: "preview", preview: PREVIEW });
    expect(b).toBe(a);
    expect(await c.ask("111")).toBe(a);
    expect(c.peek("111")).toBe(a);
    expect(s.calls).toEqual(["111"]);
  });

  it("no metadata is Not recorded, asked again only after a while", async () => {
    let now = NOW;
    const s = server({ "404": { status: 404, body: { error: "not_found" } }, "429": { status: 429, body: { error: "upstream_limited" } } });
    const c = previewCache(s.get, () => now);
    expect(await c.ask("404")).toEqual({ kind: "none" });
    expect(await c.ask("429")).toEqual({ kind: "none" });
    now += 59_000;
    await c.ask("404");
    await c.ask("429");
    expect(s.calls).toEqual(["404", "429"]);
    now += 2_000; // a busy upstream: a minute
    await c.ask("429");
    await c.ask("404");
    expect(s.calls).toEqual(["404", "429", "429"]);
    now += 10 * 60_000; // no metadata yet: ten minutes
    await c.ask("404");
    expect(s.calls).toEqual(["404", "429", "429", "404"]);
  });

  it("a Brawl match shows its mode; no answer at all is Not recorded", async () => {
    const s = server({ "4": { status: 422, body: { error: "brawl" } } });
    const c = previewCache(s.get, () => NOW);
    expect(await c.ask("4")).toEqual({ kind: "mode", label: "Street Brawl" });
    expect(await c.ask("9")).toEqual({ kind: "none" });
    expect(await previewCache(async () => { throw new Error("offline"); }, () => NOW).ask("1")).toEqual({ kind: "none" });
  });
});
