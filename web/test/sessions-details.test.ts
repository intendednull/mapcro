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
import { type DetailsSource, QUIET_MAX_MS, REASK_MS, type TabDetails, createTabDetails, quietFor, subLine, tierChip, wantsAgain } from "../src/session/details";

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
  let now = 1_000_000;
  const { d, dispose } = createRoot((dispose) => ({ d: createTabDetails(f.src, () => now), dispose }));
  return { f, d, dispose, tick: (ms: number) => void (now += ms) };
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
  it("a tab someone is on is asked again now and then, as its match may change there; one nobody is on is not", async () => {
    const { f, d, dispose, tick } = make();
    d.seen("A");
    d.seen("B");
    await f.answer("matches A", []);
    await f.answer("matches B", []);
    const on = new Set(["A"]);
    d.again(["A", "B"], on);
    expect(f.pending()).toEqual([]);
    tick(REASK_MS - 1);
    d.again(["A", "B"], on);
    expect(f.pending()).toEqual([]);
    tick(1);
    d.again(["A", "B"], on);
    expect(f.pending()).toEqual(["matches A"]);
    // Someone loaded a match there meanwhile.
    await f.answer("matches A", [52001]);
    expect(d.get("A")?.match).toBe("52001");
    await f.answer("job A 52001", job("uploading"));
    await f.answer("preview 52001", { kind: "none" });
    expect(tierChip(d.get("A"))?.text).toBe("Uploading…");
    // Out of view, nothing is asked, someone there or not.
    tick(REASK_MS);
    d.again([], on);
    expect(f.pending()).toEqual([]);
    // The open tab says its own, someone there or not.
    d.shown("B", { match: undefined, tier: undefined, job: undefined, duration: undefined });
    tick(REASK_MS);
    d.again(["B"], new Set(["B"]));
    expect(f.pending()).toEqual([]);
    dispose();
  });
  it("the open tab's board, its match not drawn yet, says its job: an upload under way", async () => {
    const { f, d, dispose } = make();
    d.shown("A", { match: "7", tier: undefined, job: job("uploading"), duration: undefined });
    expect(tierChip(d.get("A"))?.text).toBe("Uploading…");
    d.again(["A"]);
    expect(f.pending()).toEqual(["preview 7"]);
    d.shown("A", { match: "7", tier: undefined, job: job("done"), duration: undefined });
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    dispose();
  });
  it("an ask from before the tab was opened here doesn't take the place of what its board says", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    d.shown("A", { match: "7", tier: "summary", job: job("none"), duration: 60 });
    await f.answer("matches A", [6]);
    expect(d.get("A")?.match).toBe("7");
    expect(tierChip(d.get("A"))?.text).toBe("API summary");
    dispose();
  });
  it("another newest match: its own preview, not the old one's", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", [1]);
    await f.answer("preview 1", preview("amber", 600));
    await f.answer("job A 1", job("done"));
    expect(subLine(d.get("A"))?.text).toBe("Amber · 10:00");
    d.left("A");
    await f.answer("matches A", [2, 1]);
    expect(subLine(d.get("A"))).toBeUndefined();
    expect(f.pending().sort()).toEqual(["job A 2", "preview 2"]);
    await f.answer("preview 2", preview("sapphire", 60));
    expect(subLine(d.get("A"))?.text).toBe("Sapphire · 1:00");
    dispose();
  });
  it("the open board's length is kept while its timeline is drawn again", async () => {
    const { d, dispose } = make();
    d.shown("A", { match: "7", tier: "summary", job: job("none"), duration: 300 });
    d.shown("A", { match: "7", tier: undefined, job: job("fetching"), duration: undefined });
    expect(subLine(d.get("A"))?.text).toBe("5:00");
    // Another match: no length of the old one's.
    d.shown("A", { match: "8", tier: undefined, job: job("fetching"), duration: undefined });
    expect(subLine(d.get("A"))).toBeUndefined();
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

describe("a late job answer and the open tab's own (TD-118)", () => {
  const own = { match: "52001", tier: "replay", job: job("done"), duration: 2052 } as const;
  it("an ask under way as the tab opens here: its job answer doesn't replace what the board says", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", [52001]);
    expect(f.pending()).toContain("job A 52001");
    d.shown("A", own);
    await f.answer("job A 52001", job("fetching"));
    expect(d.get("A")?.job).toEqual(job("done"));
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    dispose();
  });
  it("the same for the job alone, asked while it was under way", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", [52001]);
    await f.answer("job A 52001", job("fetching"));
    d.again(["A"]);
    expect(f.pending()).toContain("job A 52001");
    d.shown("A", own);
    await f.answer("job A 52001", job("parsing"));
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    dispose();
  });
  it("the open tab still takes its preview, and a job answer counts again once it's left", async () => {
    const { f, d, dispose } = make();
    d.shown("A", own);
    await f.answer("preview 52001", preview("amber"));
    expect(subLine(d.get("A"))?.text).toBe("Amber · 34:12");
    d.left("A");
    await f.answer("matches A", [52001]);
    await f.answer("job A 52001", job("parsing"));
    expect(tierChip(d.get("A"))?.text).toBe("Parsing…");
    dispose();
  });
  it("a failed job request inside load keeps the previous job so polling continues (TD-150)", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    await f.answer("matches A", [52001]);
    await f.answer("preview 52001", preview("amber"));
    await f.answer("job A 52001", job("fetching"));
    expect(tierChip(d.get("A"))?.text).toBe("Fetching…");
    expect(wantsAgain(d.get("A"))).toBe(true);
    // Tab left triggers `load`; matches answers, but `job` fails (`undefined`).
    d.left("A");
    await f.answer("matches A", [52001]);
    await f.answer("job A 52001", undefined);
    expect(d.get("A")?.job).toEqual(job("fetching"));
    expect(tierChip(d.get("A"))?.text).toBe("Fetching…");
    expect(wantsAgain(d.get("A"))).toBe(true);
    // Next tick still polls the job.
    d.again(["A"]);
    expect(f.pending()).toEqual(["job A 52001"]);
    dispose();
  });
  it("a stale pre-open refusal does not replace the open tab's own details or notify opened(false) (TD-151)", async () => {
    const { f, d, dispose } = make();
    d.seen("A");
    d.shown("A", own);
    expect(f.opened).toEqual([["A", true]]);
    await f.answer("matches A", "refused");
    expect(d.get("A")?.kind).toBe("ready");
    expect(d.get("A")?.own).toBe(true);
    expect(tierChip(d.get("A"))?.text).toBe("Full replay");
    expect(f.opened).toEqual([["A", true]]);
    dispose();
  });
});

describe("while the server doesn't answer (TD-118)", () => {
  /** `n` asks about `key` in a row with no answer, each once the last one's wait is over. The
   * last one's wait has just begun. */
  const miss = async (m: ReturnType<typeof make>, n: number, key = "A") => {
    for (let i = 0; i < n; i++) {
      if (i > 0) m.tick(QUIET_MAX_MS);
      m.d.again([key]);
      await m.f.answer(`matches ${key}`, undefined);
    }
  };
  it("one miss is a blip; then 10 s, doubling, up to a minute", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(quietFor)).toEqual([0, 0, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(QUIET_MAX_MS).toBe(60_000);
  });
  it("a tab with no answer waits longer after each ask, and is asked when its wait is over", async () => {
    const m = make();
    const { f, d, tick, dispose } = m;
    await miss(m, 1);
    // The second ask, straight after the first miss.
    d.again(["A"]);
    await f.answer("matches A", undefined);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    tick(9_999);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    tick(1);
    d.again(["A"]);
    expect(f.pending()).toEqual(["matches A"]);
    await f.answer("matches A", undefined);
    tick(19_999);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    tick(1);
    d.again(["A"]);
    expect(f.pending()).toEqual(["matches A"]);
    dispose();
  });
  it("the wait is counted from when it was asked, not from when the answer gave up", async () => {
    const m = make();
    const { f, d, tick, dispose } = m;
    await miss(m, 1);
    d.again(["A"]);
    tick(4_000); // The ask hangs for 4 s.
    await f.answer("matches A", undefined);
    tick(5_999);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    tick(1);
    d.again(["A"]);
    expect(f.pending()).toEqual(["matches A"]);
    dispose();
  });
  it("a tab someone is on waits too, and so does a job under way", async () => {
    const m = make();
    const { f, d, tick, dispose } = m;
    d.seen("A");
    await f.answer("matches A", [52001]);
    await f.answer("preview 52001", { kind: "none" });
    await f.answer("job A 52001", job("fetching"));
    for (let i = 0; i < 2; i++) {
      d.again(["A"]);
      await f.answer("job A 52001", undefined);
    }
    tick(9_999);
    d.again(["A"], new Set(["A"]));
    expect(f.pending()).toEqual([]);
    tick(1);
    d.again(["A"]);
    expect(f.pending()).toEqual(["job A 52001"]);
    // A job's answer ends the wait.
    await f.answer("job A 52001", job("parsing"));
    d.again(["A"]);
    expect(f.pending()).toEqual(["job A 52001"]);
    dispose();
  });
  /** A tab whose job is under way, as far as the strip has heard. */
  const busyTab = async (m: ReturnType<typeof make>) => {
    m.d.seen("A");
    await m.f.answer("matches A", [52001]);
    await m.f.answer("preview 52001", { kind: "none" });
    await m.f.answer("job A 52001", job("fetching"));
  };
  it("a job's answer starts the count again: the next miss is a blip", async () => {
    const m = make();
    const { f, d, tick, dispose } = m;
    await busyTab(m);
    for (let i = 0; i < 3; i++) {
      tick(QUIET_MAX_MS);
      d.again(["A"]);
      await f.answer("job A 52001", undefined);
    }
    tick(QUIET_MAX_MS);
    d.again(["A"]);
    await f.answer("job A 52001", job("parsing"));
    d.again(["A"]);
    await f.answer("job A 52001", undefined);
    d.again(["A"]);
    expect(f.pending()).toEqual(["job A 52001"]);
    dispose();
  });
  it("a job's wait is counted from when it was asked too", async () => {
    const m = make();
    const { f, d, tick, dispose } = m;
    await busyTab(m);
    d.again(["A"]);
    await f.answer("job A 52001", undefined);
    d.again(["A"]);
    tick(4_000); // The ask hangs for 4 s.
    await f.answer("job A 52001", undefined);
    tick(5_999);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    tick(1);
    d.again(["A"]);
    expect(f.pending()).toEqual(["job A 52001"]);
    dispose();
  });
  it("a refusal is an answer: the wait is over", async () => {
    const m = make();
    const { f, d, tick, dispose } = m;
    await miss(m, 4); // A wait of 40 s.
    d.left("A");
    await f.answer("matches A", "refused");
    // Someone is on it: asked at the usual 10 s, not when the 40 s are over.
    tick(REASK_MS);
    d.again(["A"], new Set(["A"]));
    expect(f.pending()).toEqual(["matches A"]);
    dispose();
  });
  it("a tab that had no answer answering: the others are asked at once, their waits over", async () => {
    const m = make();
    const { f, d, tick, dispose } = m;
    await miss(m, 3, "A");
    tick(QUIET_MAX_MS);
    await miss(m, 3, "B");
    d.again(["B"]);
    expect(f.pending()).toEqual([]);
    d.again(["A"]);
    await f.answer("matches A", []);
    expect(d.get("A")).toEqual({ kind: "ready", match: undefined });
    d.again(["B"]);
    expect(f.pending()).toEqual(["matches B"]);
    dispose();
  });
  it("a tab that always answered says nothing of one failing alone", async () => {
    const m = make();
    const { f, d, dispose } = m;
    d.seen("B");
    await f.answer("matches B", []);
    await miss(m, 3);
    d.left("B");
    await f.answer("matches B", []);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    dispose();
  });
  it("the session's room coming back ends every wait", async () => {
    const m = make();
    const { f, d, dispose } = m;
    await miss(m, 3);
    d.again(["A"]);
    expect(f.pending()).toEqual([]);
    d.wake();
    d.again(["A"]);
    expect(f.pending()).toEqual(["matches A"]);
    dispose();
  });
  it("what the person does isn't held back: a tab left is asked at once", async () => {
    const m = make();
    const { f, d, dispose } = m;
    await miss(m, 3);
    d.left("A");
    expect(f.pending()).toEqual(["matches A"]);
    dispose();
  });
});
