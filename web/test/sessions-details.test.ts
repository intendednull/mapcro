// The strip's details (sessions.md §8, §10 phase 5; src/session/details.ts): what a tab says
// under its name (the winner and the length, "Sandbox"), its tier chip (the job under way, "Full
// replay", "API summary"), and when they're asked for: once in view, again while a job is under
// way or there was no answer, again once the tab is left; the open tab's from its board, with
// no request. The browser rows are e2e/sessions-polish.spec.ts.

import { describe, expect, it, vi } from "vitest";
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));
import { createRoot } from "solid-js";
import type { JobState } from "../src/player/api";
import type { CardData, Preview } from "../src/player/picker";
import { type DetailsSource, type TabDetails, createTabDetails, subLine, tierChip, wantsAgain } from "../src/session/details";

const preview = (winner: "amber" | "sapphire" | null, duration_s = 2052): CardData => ({
  kind: "preview",
  preview: { match_id: 1, start_time: 0, duration_s, game_mode: 1, winner, teams: [] } as Preview,
});
const ready = (more: Partial<TabDetails> = {}): TabDetails => ({ kind: "ready", match: "52001", ...more });
const job = (state: JobState["state"], more: Partial<JobState> = {}): JobState => ({ state, ...more });

describe("what a tab says (§8)", () => {
  it("under its name: Sandbox with no match; else the winner and the length; nothing while not known", () => {
    expect(subLine(undefined)).toBeUndefined();
    expect(subLine({ kind: "loading" })).toBeUndefined();
    expect(subLine({ kind: "refused" })).toBeUndefined();
    expect(subLine({ kind: "ready" })).toEqual({ text: "Sandbox" });
    expect(subLine(ready({ preview: preview("amber") }))).toEqual({ winner: "amber", text: "Amber · 34:12" });
    expect(subLine(ready({ preview: preview("sapphire", 61) }))).toEqual({ winner: "sapphire", text: "Sapphire · 1:01" });
    // No winner known: the length alone; from a timeline this page holds when there's no preview.
    expect(subLine(ready({ preview: preview(null) }))).toEqual({ text: "34:12" });
    expect(subLine(ready({ preview: { kind: "none" }, duration: 600 }))).toEqual({ text: "10:00" });
    expect(subLine(ready({ preview: { kind: "loading" } }))).toBeUndefined();
    expect(subLine(ready({ duration: 0 }))).toBeUndefined();
    // The preview's length wins over a held timeline's.
    expect(subLine(ready({ preview: preview("amber", 120), duration: 600 }))?.text).toBe("Amber · 2:00");
  });
  it("the chip: the job under way, else Full replay, else API summary where the match has one", () => {
    expect(tierChip(undefined)).toBeUndefined();
    expect(tierChip({ kind: "ready" })).toBeUndefined(); // Sandbox
    expect(tierChip({ kind: "refused" })).toBeUndefined();
    expect(tierChip(ready({ job: job("done") }))).toEqual({ text: "Full replay", tier: "replay", busy: false });
    expect(tierChip(ready({ job: job("fetching") }))).toEqual({ text: "Fetching…", tier: "summary", busy: true });
    expect(tierChip(ready({ job: job("parsing") }))?.text).toBe("Parsing…");
    expect(tierChip(ready({ job: job("queued", { ahead: 2 }) }))?.text).toBe("Queued");
    expect(tierChip(ready({ job: job("uploading") }))?.text).toBe("Uploading…");
    expect(tierChip(ready({ job: job("waiting") }))?.text).toBe("Waiting");
    // A stale replay fetched again: under way, at the replay tier meanwhile.
    expect(tierChip(ready({ tier: "replay", job: job("fetching") }))).toEqual({ text: "Fetching…", tier: "replay", busy: true });
    // No replay: the summary only where there is one (the board's tier, or the match's metadata).
    expect(tierChip(ready({ job: job("failed", { reason: "no_replay" }), preview: preview("amber") }))).toEqual({ text: "API summary", tier: "summary", busy: false });
    expect(tierChip(ready({ tier: "summary", job: job("none") }))?.text).toBe("API summary");
    expect(tierChip(ready({ job: job("none"), preview: { kind: "none" } }))).toBeUndefined();
    expect(tierChip(ready({ job: job("off") }))).toBeUndefined();
    // The board's own tier wins over a job that says done (its timeline not upgraded yet).
    expect(tierChip(ready({ tier: "summary", job: job("done") }))?.text).toBe("API summary");
  });
  it("asked again while its job is under way, or with no answer; not once settled", () => {
    expect(wantsAgain(undefined)).toBe(true);
    expect(wantsAgain(ready({ job: job("fetching") }))).toBe(true);
    expect(wantsAgain(ready({ job: job("done") }))).toBe(false);
    expect(wantsAgain(ready())).toBe(false);
    expect(wantsAgain({ kind: "refused" })).toBe(false);
    expect(wantsAgain({ kind: "loading" })).toBe(false);
  });
});

/** A source the test answers by hand: each call waits for the test's `answer`. */
function fake() {
  const calls: string[] = [];
  const waiting: Array<{ what: string; done: (v: unknown) => void }> = [];
  const ask = <T,>(what: string) =>
    new Promise<T>((done) => {
      calls.push(what);
      waiting.push({ what, done: done as (v: unknown) => void });
    });
  const opened: Array<[string, boolean]> = [];
  const held = new Map<string, number>();
  const src: DetailsSource = {
    matches: (key) => ask(`matches ${key}`),
    job: (key, m) => ask(`job ${key} ${m}`),
    preview: (m) => ask(`preview ${m}`),
    held: (key, m) => held.get(`${key} ${m}`),
    opened: (key, ok) => void opened.push([key, ok]),
  };
  const answer = async (what: string, v: unknown) => {
    const i = waiting.findIndex((w) => w.what === what);
    if (i < 0) throw new Error(`nothing asked: ${what} (asked: ${waiting.map((w) => w.what).join(", ")})`);
    waiting.splice(i, 1)[0]!.done(v);
    for (let k = 0; k < 5; k++) await Promise.resolve();
  };
  return { src, calls, opened, held, answer, pending: () => waiting.map((w) => w.what) };
}

const make = () => {
  const f = fake();
  const { d, dispose } = createRoot((dispose) => ({ d: createTabDetails(f.src), dispose }));
  return { f, d, dispose };
};

describe("when a tab's details are asked for", () => {
  it("once in view: the matches, then the newest one's preview and job", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    d.seen("A");
    expect(f.calls).toEqual(["matches A"]);
    expect(d.get("A")).toEqual({ kind: "loading" });
    await f.answer("matches A", [52001, 51000]);
    expect(f.opened).toEqual([["A", true]]);
    expect(d.get("A")).toEqual({ kind: "ready", match: "52001" });
    expect(f.pending().sort()).toEqual(["job A 52001", "preview 52001"]);
    await f.answer("preview 52001", preview("amber"));
    await f.answer("job A 52001", job("done"));
    expect(subLine(d.get("A"))?.text).toBe("Amber · 34:12");
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    // Kept: in view again, nothing is asked.
    d.seen("A");
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    dispose();
  });
  it("a board with no match is Sandbox, with nothing more to ask; a held timeline gives the length", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", []);
    expect(subLine(d.get("A"))).toEqual({ text: "Sandbox" });
    expect(f.pending()).toEqual([]);
    f.held.set("B 7", 600);
    d.seen("B");
    await f.answer("matches B", [7]);
    expect(d.get("B")?.duration).toBe(600);
    await f.answer("preview 7", { kind: "none" });
    expect(subLine(d.get("B"))).toEqual({ text: "10:00" });
    dispose();
  });
  it("a board that doesn't open is refused, and the follow learns so; one with no answer is asked again", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", "refused");
    expect(d.get("A")).toEqual({ kind: "refused" });
    expect(f.opened).toEqual([["A", false]]);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    d.seen("B");
    await f.answer("matches B", undefined);
    expect(d.get("B")).toBeUndefined();
    expect(f.opened).toEqual([["A", false]]);
    d.again(["B"]);
    expect(f.pending()).toEqual(["matches B"]);
    dispose();
  });
  it("while its job is under way, the job alone is asked again, until it's done", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", [52001]);
    await f.answer("preview 52001", preview("sapphire"));
    await f.answer("job A 52001", job("fetching"));
    expect(tierChip(d.get("A"))?.text).toBe("Fetching…");
    d.again(["A"]);
    d.again(["A"]);
    expect(f.pending()).toEqual(["job A 52001"]);
    await f.answer("job A 52001", job("parsing"));
    expect(tierChip(d.get("A"))?.text).toBe("Parsing…");
    d.again(["A"]);
    await f.answer("job A 52001", job("done"));
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    // The preview was not asked again.
    expect(f.calls.filter((c) => c.startsWith("preview"))).toHaveLength(1);
    dispose();
  });
  it("a tab left is asked again; another newest match there replaces what it said", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", []);
    d.left("A");
    await f.answer("matches A", [9]);
    expect(d.get("A")).toEqual({ kind: "ready", match: "9" });
    await f.answer("preview 9", preview("amber"));
    await f.answer("job A 9", job("queued"));
    d.left("A");
    await f.answer("matches A", [9]);
    // The same match: its preview is kept, and not asked for again.
    expect(subLine(d.get("A"))?.text).toBe("Amber · 34:12");
    expect(f.pending()).toEqual(["job A 9"]);
    await f.answer("job A 9", job("done"));
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    dispose();
  });
  it("left while it was being asked about: asked again once that's done", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", [1]);
    d.left("A");
    expect(f.pending().filter((x) => x.startsWith("matches"))).toEqual([]);
    await f.answer("job A 1", job("done"));
    expect(f.pending().filter((x) => x.startsWith("matches"))).toEqual(["matches A"]);
    await f.answer("matches A", [2]);
    expect(d.get("A")?.match).toBe("2");
    dispose();
  });
  it("an answer about a match the tab no longer has changes nothing", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", [1]);
    d.shown("A", { match: "2", tier: "summary", job: job("none"), duration: 300 });
    await f.answer("job A 1", job("done"));
    await f.answer("preview 1", preview("amber"));
    expect(d.get("A")?.match).toBe("2");
    expect(tierChip(d.get("A"))?.text).toBe("API summary");
    expect(subLine(d.get("A"))?.text).toBe("5:00");
    dispose();
  });
  it("the open tab's board says its own: no request but the preview; its job isn't asked about", async () => {
    const { f, d, dispose } = make();
    d.shown("A", { match: "52001", tier: "summary", job: job("fetching"), duration: 2052 });
    expect(f.calls).toEqual(["preview 52001"]);
    expect(f.opened).toEqual([["A", true]]);
    expect(tierChip(d.get("A"))?.text).toBe("Fetching…");
    expect(subLine(d.get("A"))?.text).toBe("34:12");
    d.seen("A");
    d.again(["A"]);
    expect(f.pending()).toEqual(["preview 52001"]);
    await f.answer("preview 52001", preview("amber"));
    d.shown("A", { match: "52001", tier: "replay", job: job("done"), duration: 2052 });
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    expect(subLine(d.get("A"))?.text).toBe("Amber · 34:12");
    expect(f.calls).toEqual(["preview 52001"]);
    // Sandbox on its board: no preview.
    d.shown("B", { match: undefined, tier: undefined, job: undefined, duration: undefined });
    expect(subLine(d.get("B"))).toEqual({ text: "Sandbox" });
    expect(f.calls).toEqual(["preview 52001"]);
    // Left: asked about as any other tab, and its job polled from then on.
    d.left("A");
    await f.answer("matches A", [52001]);
    expect(f.pending()).toEqual(["job A 52001"]);
    dispose();
  });
});
