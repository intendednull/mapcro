// A session's tab list as the strip shows it (sessions.md §2.2, §7): its live `Tab` records in
// `order`, and the pure rules for which tab is open, where one goes when it's removed, and the
// ops that add, rename, reorder and remove one. No state here: the session document holds it.

import type { Entry } from "../gen/Entry";
import type { Op } from "../gen/Op";
import type { RecordId } from "../gen/RecordId";
import { LIMITS } from "../gen/limits";
import type { Via } from "../gen/Via";
import { keyBetween } from "../core/order";
import type { KnownBoard } from "../core/device";
import type { Connection } from "../core/session";

export interface TabRow {
  id: RecordId;
  board: string;
  grant: string;
  name: string;
  order: string;
}

/** The live tabs, by `order`, ties by id (as the server would sort them: the same everywhere). */
export function liveTabs(records: Iterable<[RecordId, Entry]>): TabRow[] {
  const out: TabRow[] = [];
  for (const [id, e] of records) {
    if (e.deleted || !("Tab" in e.record)) continue;
    const t = e.record.Tab;
    out.push({ id, board: t.board, grant: t.grant, name: t.name, order: t.order });
  }
  return out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The session's meta record: its id (for renaming) and title. */
export function sessionMeta(records: Iterable<[RecordId, Entry]>): { id: RecordId; title: string } | undefined {
  for (const [id, e] of records) if (!e.deleted && "SessionMeta" in e.record) return { id, title: e.record.SessionMeta.title };
  return undefined;
}

/** The tab to open: the one asked for (`?tab=`) if it's live, else the first; none if empty. */
export function pickTab(tabs: TabRow[], wanted: RecordId | undefined): RecordId | undefined {
  return (wanted !== undefined && tabs.some((t) => t.id === wanted) ? wanted : tabs[0]?.id);
}

/**
 * Where to go when the open tab `gone` stopped being live (removed, here or by a peer): its left
 * neighbour in the order as it was (`before`), the nearest one still live; with none to the left,
 * the nearest to its right (§7.2: "you move to its left neighbour").
 */
export function neighbourOf(before: RecordId[], gone: RecordId, live: TabRow[]): RecordId | undefined {
  const alive = new Set(live.map((t) => t.id));
  const i = before.indexOf(gone);
  if (i < 0) return live[0]?.id;
  for (let j = i - 1; j >= 0; j--) if (alive.has(before[j]!)) return before[j];
  for (let j = i + 1; j < before.length; j++) if (alive.has(before[j]!)) return before[j];
  return live[0]?.id;
}

/** A tab name: the board's title, cut to the schema's cap (`TabName`, `max_name`). */
export function tabName(title: string): string {
  const t = title.trim() || "Game";
  return [...t].slice(0, LIMITS.max_name).join("");
}

/** A key after every tab: a new tab goes last. */
export const lastKey = (tabs: TabRow[]) => keyBetween(tabs[tabs.length - 1]?.order, undefined);

/** The ops making a tab for a granted board, last in the strip. */
export function addTabOps(id: RecordId, tabs: TabRow[], board: string, grant: string, name: string): Op[] {
  return [{ Create: { id, record: { Tab: { board, grant, name: tabName(name), order: lastKey(tabs) } } } }];
}

/** The ops renaming a tab, or none if the name is empty or the same. */
export function renameOps(tab: TabRow, name: string): Op[] {
  const n = tabName(name);
  return !name.trim() || n === tab.name ? [] : [{ Set: { id: tab.id, value: { TabName: n } } }];
}

/**
 * The op moving tab `id` to index `to` of the strip as it'll read after (0 = first): a key between
 * its new neighbours. None if it stays where it is.
 */
export function moveOps(tabs: TabRow[], id: RecordId, to: number): Op[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return [];
  const rest = tabs.filter((t) => t.id !== id);
  const at = Math.max(0, Math.min(rest.length, to));
  if (at === from) return [];
  const lo = rest[at - 1]?.order;
  const hi = rest[at]?.order;
  // Two tabs can share a key (concurrent adds): between equal neighbours there's no room, so
  // the move takes the room on the open side of them.
  const key = lo !== undefined && hi !== undefined && lo >= hi ? keyBetween(lo, undefined) : keyBetween(lo, hi);
  return [{ Set: { id, value: { TabOrder: key } } }];
}

/** The op removing a tab: a delete, so undo restores it with its grant (§2.2). */
export const removeOps = (id: RecordId): Op[] => [{ Delete: { id } }];

/** How a tab's board is opened (§3.4): this device's own link for it when that can edit (never
 * less than the session gives), else the session's token through the tab's grant. */
export function credentialFor(tab: TabRow, session: string, token: string, known: KnownBoard[]): { token: string; via?: Via } {
  const own = known.find((k) => k.kind !== "session" && k.board === tab.board && k.edit === true);
  return own ? { token: own.token } : { token, via: { session, grant: tab.grant } };
}

/** The session's link is dead (refused for good, or the wrong kind of room); an outdated build
 * isn't: it reloads, as a board does. */
export const linkDead = (c: Connection): boolean => c.kind === "closed" && c.reason !== "outdated";
