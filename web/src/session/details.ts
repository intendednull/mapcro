// The strip's details for each tab (sessions.md §8): under its name, the board's newest match
// (the winner's colour dot, "Amber" or "Sapphire", the length) and the tier chip ("Full replay",
// "API summary", or the replay job under way); "Sandbox" with no match. Loaded lazily: only for
// tabs in view, with the credential the tab opens with, and kept for the page's life. The strip
// never opens a board's room. The open tab's board says its own (its match, tier and job), so
// it costs no request. A tab is asked about again once it is left here (its match may have
// changed), while its job is under way, and every `REASK_MS` while someone in the session is on
// it (only the people on a board change its match). A tab the server doesn't answer is asked less
// and less often (`quietFor`), until an answer says the server is back.

import { createSignal } from "solid-js";
import { type JobState, busy } from "../player/api";
import { type CardData, type Team, lengthLabel } from "../player/picker";

/** What the strip knows of a tab's board. */
export interface TabDetails {
  /** `refused`: the board doesn't open with the tab's credential (§6.3: "No access"). */
  kind: "loading" | "refused" | "ready";
  /** Its newest match; none: a board without one (§7.4). */
  match?: string | undefined;
  job?: JobState | undefined;
  /** The tier its timeline is at, where this page has it (the open tab's board). */
  tier?: "replay" | "summary" | undefined;
  /** The match's preview: the winner and the length. */
  preview?: CardData | undefined;
  /** The length from a timeline this page holds, for when the preview has none. */
  duration?: number | undefined;
  /** Said by the open tab's board (`shown`): nothing to ask while it's open. */
  own?: boolean | undefined;
}

/** How often a tab in view that someone is on is asked about again. */
export const REASK_MS = 10_000;

/** The longest a tab with no answer waits to be asked again. */
export const QUIET_MAX_MS = 60_000;

/** How long a tab waits after `misses` asks in a row with no answer: one is a blip, asked again
 * at the next tick; then 10 s, doubling up to `QUIET_MAX_MS`. */
export const quietFor = (misses: number) => (misses < 2 ? 0 : Math.min(QUIET_MAX_MS, 5_000 * 2 ** (misses - 1)));

export const TEAM_LABEL: Record<Team, string> = { amber: "Amber", sapphire: "Sapphire" };

/** The sub-line under a tab's name: "Sandbox", or the winner and the length; none while not
 * known (the tab shows its name alone). */
export function subLine(d: TabDetails | undefined): { winner?: Team; text: string } | undefined {
  if (d?.kind !== "ready") return undefined;
  if (d.match === undefined) return { text: "Sandbox" };
  const p = d.preview?.kind === "preview" ? d.preview.preview : undefined;
  const length = p ? p.duration_s : d.duration;
  const len = length !== undefined && length > 0 ? lengthLabel(length) : undefined;
  if (p?.winner) return { winner: p.winner, text: [TEAM_LABEL[p.winner], len].filter(Boolean).join(" · ") };
  return len ? { text: len } : undefined;
}

/** The tier chip: the job under way, else the tier ("Full replay", "API summary"); none for a
 * board without a match, or while not known. `tier` is the board's own where it's open here;
 * else a job done means the replay. */
export function tierChip(d: TabDetails | undefined): { text: string; tier: "replay" | "summary"; busy: boolean } | undefined {
  if (d?.kind !== "ready" || d.match === undefined) return undefined;
  const j = d.job;
  const replay = d.tier === "replay" || (d.tier === undefined && j?.state === "done");
  const tier = replay ? "replay" : "summary";
  const doing = JOB_LABEL[j?.state ?? ""];
  if (doing) return { text: doing, tier, busy: true };
  if (replay) return { text: "Full replay", tier, busy: false };
  // The summary only where the board has one: its tier said so, or the match has metadata.
  if (d.tier === "summary" || d.preview?.kind === "preview") return { text: "API summary", tier, busy: false };
  return undefined;
}

/** A job under way, as the tier chip says it, short (§4b). */
const JOB_LABEL: Record<string, string> = { uploading: "Uploading…", waiting: "Waiting", fetching: "Fetching…", queued: "Queued", parsing: "Parsing…" };

/** Whether a tab's details want asking again while it's in view: its job is under way, or the
 * server gave no answer. */
export const wantsAgain = (d: TabDetails | undefined) => d === undefined || (d.kind === "ready" && busy(d.job));

export interface DetailsSource {
  /** The board's matches, newest first: `refused` (401, 403, 404); none: no answer. */
  matches(key: string): Promise<number[] | "refused" | undefined>;
  job(key: string, match: string): Promise<JobState | undefined>;
  preview(match: string): Promise<CardData>;
  /** The length of a timeline this page holds for the board's match. */
  held?(key: string, match: string): number | undefined;
  /** The board answered: it opens, or it doesn't (what a follow asks before it moves, §6.3). */
  opened?(key: string, ok: boolean): void;
}

/**
 * The strip's details, by tab key (a board and the grant it opens through). `seen` asks for a
 * tab's once; `again` asks again for those in view that want it (a job under way, no answer);
 * `left` forgets one, to be asked again; `shown` takes the open tab's from its board; `wake` ends
 * the waits of tabs that had no answer.
 */
export function createTabDetails(src: DetailsSource, clock: () => number = Date.now) {
  const [all, setAll] = createSignal<ReadonlyMap<string, TabDetails>>(new Map());
  const put = (key: string, d: TabDetails | undefined) =>
    setAll((m) => {
      const next = new Map(m);
      if (d) next.set(key, d);
      else next.delete(key);
      return next;
    });
  const patch = (key: string, match: string | undefined, more: Partial<TabDetails>) => {
    const d = all().get(key);
    // Only onto the same match's details: a newer answer about another match replaced them.
    if (d?.kind === "ready" && d.match === match) put(key, { ...d, ...more });
  };
  /** A job's answer. The open tab's board says its own job: an answer from before it opened
   * here is older than that. */
  const jobSaid = (key: string, match: string, job: JobState | undefined) => {
    if (!all().get(key)?.own) patch(key, match, { job });
  };
  /** The tabs the server gave no answer for: how many asks in a row, and when to ask next. */
  const quiet = new Map<string, { misses: number; until: number }>();
  const unheard = (key: string, askedAt: number) => {
    const misses = (quiet.get(key)?.misses ?? 0) + 1;
    quiet.set(key, { misses, until: askedAt + quietFor(misses) });
  };
  /** An answer. From a tab that had none, the server is back: no tab waits any longer. A tab that
   * always answered says nothing of the others, one failing alone keeps its wait. */
  const heard = (key: string) => {
    if (quiet.delete(key)) quiet.clear();
  };
  const asking = new Set<string>();
  /** When each tab's matches were last asked for. */
  const askedAt = new Map<string, number>();
  /** Asked again while an ask was under way (the tab left meanwhile): asked once it's done. */
  const redo = new Set<string>();
  const preview = (key: string, match: string) => {
    if (all().get(key)?.preview) return;
    void src.preview(match).then((p) => patch(key, match, { preview: p }));
  };
  const load = async (key: string): Promise<void> => {
    if (asking.has(key)) return void redo.add(key);
    asking.add(key);
    try {
      const had = all().get(key);
      if (!had) put(key, { kind: "loading" });
      const at = clock();
      askedAt.set(key, at);
      const m = await src.matches(key);
      if (m === undefined) {
        // No answer: not known; asked again while in view.
        unheard(key, at);
        if (all().get(key)?.kind === "loading") put(key, undefined);
        return;
      }
      heard(key);
      src.opened?.(key, m !== "refused");
      if (m === "refused") return void put(key, { kind: "refused" });
      const match = m[0] === undefined ? undefined : String(m[0]);
      const before = all().get(key);
      // The board opened here meanwhile says its own.
      if (before?.own) return;
      const same = before?.kind === "ready" && before.match === match;
      put(key, { kind: "ready", match, ...(same ? { preview: before.preview, duration: before.duration, job: before.job } : {}) });
      if (match === undefined) return;
      const duration = src.held?.(key, match);
      if (duration !== undefined) patch(key, match, { duration });
      preview(key, match);
      jobSaid(key, match, await src.job(key, match));
    } finally {
      asking.delete(key);
      if (redo.delete(key)) void load(key);
    }
  };
  /** Job only: the match is known, its job under way. */
  const job = async (key: string, match: string) => {
    if (asking.has(key)) return;
    asking.add(key);
    try {
      const at = clock();
      const j = await src.job(key, match);
      if (j) {
        heard(key);
        jobSaid(key, match, j);
      } else unheard(key, at);
    } finally {
      asking.delete(key);
      // A load asked for meanwhile (the tab was left) runs now.
      if (redo.delete(key)) void load(key);
    }
  };
  return {
    get: (key: string) => all().get(key),
    /** In view: asked for once. */
    seen(key: string) {
      if (!all().has(key)) void load(key);
    },
    /** For each tab in view that wants it: asked again. `occupied`: the tabs someone is on,
     * whose match may change; asked again every `REASK_MS`. */
    again(keys: Iterable<string>, occupied: ReadonlySet<string> = new Set()) {
      for (const key of keys) {
        const d = all().get(key);
        // The open tab's board says its own (`shown`): nothing to ask.
        if (d?.own) continue;
        // No answer lately: it waits its turn.
        if (clock() < (quiet.get(key)?.until ?? -Infinity)) continue;
        if (occupied.has(key) && d?.kind !== "loading" && clock() - (askedAt.get(key) ?? -Infinity) >= REASK_MS) void load(key);
        else if (!wantsAgain(d)) continue;
        else if (d?.kind === "ready") {
          if (d.match !== undefined) void job(key, d.match);
        } else void load(key);
      }
    },
    /** The server is back (the session's own connection is live): the tabs that had no answer
     * are asked at the next tick, whatever they were waiting for. */
    wake: () => quiet.clear(),
    /** Its board was left here: what it shows may have changed, so it's asked about again. */
    left(key: string) {
      const d = all().get(key);
      if (d?.kind === "ready") put(key, { ...d, own: undefined, tier: undefined });
      void load(key);
    },
    /** The open tab's board says what it has: its match, tier, job and length. */
    shown(key: string, s: { match: string | undefined; tier: "replay" | "summary" | undefined; job: JobState | undefined; duration: number | undefined }) {
      const d = all().get(key);
      const same = d?.kind === "ready" && d.match === s.match;
      const next: TabDetails = { kind: "ready", own: true, match: s.match, tier: s.tier, job: s.job, duration: s.duration ?? (same ? d.duration : undefined), ...(same && d.preview ? { preview: d.preview } : {}) };
      if (d && JSON.stringify(d) === JSON.stringify(next)) return;
      put(key, next);
      src.opened?.(key, true);
      if (s.match !== undefined) preview(key, s.match);
    },
  };
}

export type TabDetailsStore = ReturnType<typeof createTabDetails>;
