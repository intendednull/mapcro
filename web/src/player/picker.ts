// The Windows app's replay picker (spec §6b, "The Windows app"): the pure parts. The list the
// picker shows (the open match's replay first, then newest first, a page at a time), the labels on
// each card, and the preview cards' data, asked once per match and kept for the tab: read from the
// demo by the app (`replay_preview`), and from `GET /api/matches/{id}/preview` only when the app
// has none. `ReplayPicker.tsx` draws it; `picker.test.ts` drives this.

import { type Replay, settled } from "./folder";
import { bridge, desktopSource } from "./desktop";
import { clockLabel } from "../match/timeline";

/** Cards shown at first, and how many more each "More" adds. */
export const PAGE = 10;

/** How often the picker lists the folder again while it's open (also on focus). */
export const PICKER_POLL_MS = 5_000;

/** Match ids rise over time: the later match first (by length, then digits; ids are plain digits). */
const laterFirst = (a: Replay, b: Replay) => b.id.length - a.id.length || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The picker's list: settled files only (a younger one may still be downloading), the open
 * match's first, then the most recently played first, by match id (operator, 2026-11-11: not by
 * the file's time, which is when it was downloaded). */
export function pickerList(list: readonly Replay[], current: string | undefined, now: number): Replay[] {
  const done = list.filter((r) => settled(r, now)).sort(laterFirst);
  const mine = done.filter((r) => r.id === current);
  return [...mine, ...done.filter((r) => r.id !== current)];
}

/** "just now", "5 min ago", "2 h ago", "3 d ago", then the date. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(at).toLocaleDateString();
}

/** A card's time: when the match was played ("Played 2 d ago") when a preview says (the demo
 * doesn't record it; the server's preview does), else the file's time ("2 h ago", "Downloaded"
 * on hover). */
export function whenLabel(startS: number | undefined, fileAt: number, now: number): { text: string; title?: string } {
  return startS && startS > 0 ? { text: `Played ${ago(startS * 1000, now)}` } : { text: ago(fileAt, now), title: "Downloaded" };
}

/** A match's length as the game's clock writes it ("34:12"). */
export const lengthLabel = (s: number) => clockLabel(s);

export type Team = "amber" | "sapphire";

/** One team on a card: heroes as `[slot, hero_id]`, kills and souls at the end. */
export interface PreviewTeam {
  team: Team;
  heroes: Array<[number, number]>;
  kills: number;
  souls: number;
}

/** A match's preview (no names, no ids): the app's, read from the demo, or the server's. */
export interface Preview {
  match_id: number;
  start_time: number;
  duration_s: number;
  game_mode: number;
  winner: Team | null;
  teams: PreviewTeam[];
}

/** What a card shows below its id and time: still loading, the preview, nothing recorded, or a
 * mode the board doesn't take (its name). */
export type CardData = { kind: "loading" } | { kind: "preview"; preview: Preview } | { kind: "none" } | { kind: "mode"; label: string };

const nat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isTeam = (v: unknown): v is Team => v === "amber" || v === "sapphire";

/** A preview as the server sent it, or nothing if it isn't one. */
export function parsePreview(v: unknown): Preview | undefined {
  const o = v as Preview | null;
  if (!o || typeof o !== "object" || !nat(o.match_id) || !nat(o.start_time) || !nat(o.duration_s) || typeof o.game_mode !== "number") return undefined;
  if (o.winner !== null && !isTeam(o.winner)) return undefined;
  if (!Array.isArray(o.teams) || o.teams.length !== 2) return undefined;
  const teams: PreviewTeam[] = [];
  for (const t of o.teams) {
    if (!t || !isTeam(t.team) || !nat(t.kills) || !nat(t.souls) || !Array.isArray(t.heroes)) return undefined;
    const heroes = t.heroes.filter((h): h is [number, number] => Array.isArray(h) && nat(h[0]) && nat(h[1])).slice(0, 6);
    teams.push({ team: t.team, heroes: heroes.map(([s, h]) => [s, h]), kills: t.kills, souls: t.souls });
  }
  return { match_id: o.match_id, start_time: o.start_time, duration_s: o.duration_s, game_mode: o.game_mode, winner: o.winner, teams };
}

/** The game's names for modes the board doesn't take (`ECitadelGameMode`). */
export const MODE_LABELS: Record<string, string> = { brawl: "Street Brawl", unsupported_mode: "Other mode" };

/** A preview's mode label when it isn't the standard 6v6. */
export const modeLabel = (p: Preview) => (p.game_mode === 1 ? undefined : p.game_mode === 4 ? MODE_LABELS.brawl : MODE_LABELS.unsupported_mode);

/** Codes worth asking again for later (the server or deadlock-api was busy), and after how long. */
const AGAIN_MS: Record<string, number> = { upstream_limited: 60_000, busy: 60_000, rate_limited: 10 * 60_000, upstream_down: 60_000, offline: 30_000, failed: 60_000, not_found: 10 * 60_000 };

type Fetcher = (id: string) => Promise<{ status: number; body: unknown } | undefined>;

const http: Fetcher = async (id) => {
  const r = await fetch(`/api/matches/${id}/preview`).catch(() => undefined);
  if (!r) return undefined;
  return { status: r.status, body: await r.json().catch(() => undefined) };
};

/**
 * The app's preview first (read from the demo: every replay in the folder has one, fresh or old,
 * with no server call), the server's only when the app has none (a broken file, an older app).
 */
export function localFirst(local: (id: string) => Promise<unknown>, server: Fetcher = http): Fetcher {
  return async (id) => {
    const v = await local(id).catch(() => undefined);
    return parsePreview(v) ? { status: 200, body: v } : server(id);
  };
}

/** In the app's window, local first; in a browser, the server. */
const tabFetcher: Fetcher = (id) => {
  const invoke = bridge();
  return invoke ? localFirst((i) => desktopSource(invoke).preview(i))(id) : http(id);
};

/**
 * The previews for the tab: each match asked for once; a miss (no metadata, a busy upstream) is
 * asked again only after a while (`AGAIN_MS`), so a picker that stays open doesn't poll the server.
 */
export function previewCache(get: Fetcher = tabFetcher, clock: () => number = Date.now) {
  const kept = new Map<string, { data: CardData; at: number; again: number | undefined }>();
  const asking = new Map<string, Promise<CardData>>();
  const peek = (id: string): CardData | undefined => kept.get(id)?.data;
  const ask = (id: string): Promise<CardData> => {
    const k = kept.get(id);
    if (k && (k.again === undefined || clock() - k.at < k.again)) return Promise.resolve(k.data);
    const going = asking.get(id);
    if (going) return going;
    const p = (async (): Promise<CardData> => {
      const r = await get(id).catch(() => undefined);
      let data: CardData;
      let again: number | undefined;
      const code = r ? ((r.body as { error?: string } | undefined)?.error ?? (r.status === 200 ? undefined : "failed")) : "offline";
      const preview = r?.status === 200 ? parsePreview(r.body) : undefined;
      if (preview) data = { kind: "preview", preview };
      else if (code && MODE_LABELS[code]) data = { kind: "mode", label: MODE_LABELS[code]! };
      else {
        data = { kind: "none" };
        again = AGAIN_MS[code ?? "failed"] ?? AGAIN_MS.failed;
      }
      kept.set(id, { data, at: clock(), again });
      return data;
    })().finally(() => asking.delete(id));
    asking.set(id, p);
    return p;
  };
  return { peek, ask };
}

/** The tab's previews. */
export const previews = previewCache();
