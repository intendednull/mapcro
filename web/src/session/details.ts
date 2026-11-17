// The strip's details for each tab (sessions.md §8): under its name, the board's newest match
// (the winner's colour dot, "Amber" or "Sapphire", the length) and the tier chip ("Full replay",
// "API summary", or the replay job under way); "Sandbox" with no match. Loaded lazily: only for
// tabs in view, with the credential the tab opens with, and kept for the page's life. The strip
// never opens a board's room. The open tab's board says its own (its match, tier and job), so
// it costs no request; a tab is asked about again once it is left, as its match may have
// changed there, and while its job is under way.

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
}

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
 * board without a match, or while not known. */
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
 * `left` forgets one, to be asked again; `shown` takes the open tab's from its board.
 */
export function createTabDetails(src: DetailsSource) {
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
  const asking = new Set<string>();
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
      const m = await src.matches(key);
      if (m === undefined) {
        // No answer: not known; asked again while in view.
        if (all().get(key)?.kind === "loading") put(key, undefined);
        return;
      }
      src.opened?.(key, m !== "refused");
      if (m === "refused") return void put(key, { kind: "refused" });
      const match = m[0] === undefined ? undefined : String(m[0]);
      const before = all().get(key);
      const same = before?.kind === "ready" && before.match === match;
      put(key, { kind: "ready", match, ...(same ? { preview: before.preview, duration: before.duration } : {}) });
      if (match === undefined) return;
      const duration = src.held?.(key, match);
      if (duration !== undefined) patch(key, match, { duration });
      preview(key, match);
      const job = await src.job(key, match);
      patch(key, match, { job });
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
      const j = await src.job(key, match);
      if (j) patch(key, match, { job: j });
    } finally {
      asking.delete(key);
    }
  };
  return {
    get: (key: string) => all().get(key),
    /** In view: asked for once. */
    seen(key: string) {
      if (!all().has(key)) void load(key);
    },
    /** For each tab in view that wants it: asked again. */
    again(keys: Iterable<string>) {
      for (const key of keys) {
        const d = all().get(key);
        if (!wantsAgain(d)) continue;
        // The open tab's board says its own job (`shown`): nothing to ask.
        if (d?.kind === "ready") {
          if (d.match !== undefined && d.tier === undefined) void job(key, d.match);
        } else void load(key);
      }
    },
    /** Its board was left here: what it shows may have changed, so it's asked about again. */
    left(key: string) {
      const d = all().get(key);
      if (d?.kind === "ready") put(key, { ...d, tier: undefined, kind: "ready" });
      void load(key);
    },
    /** The open tab's board says what it has: its match, tier, job and length. */
    shown(key: string, s: { match: string | undefined; tier: "replay" | "summary" | undefined; job: JobState | undefined; duration: number | undefined }) {
      const d = all().get(key);
      const same = d?.kind === "ready" && d.match === s.match;
      const next: TabDetails = { kind: "ready", match: s.match, tier: s.tier, job: s.job, duration: s.duration ?? (same ? d.duration : undefined), ...(same && d.preview ? { preview: d.preview } : {}) };
      if (d && JSON.stringify(d) === JSON.stringify(next)) return;
      put(key, next);
      src.opened?.(key, true);
      if (s.match !== undefined) preview(key, s.match);
    },
  };
}

export type TabDetailsStore = ReturnType<typeof createTabDetails>;
