// Tabs left with changes that were never sent (docs/tech-debt.md TD-101): an edit made as a
// tab is left goes out within two seconds or stays pending in this browser's storage until
// that board is opened here again, and one made offline, or held through a view link, waits
// the same way. The strip marks such a tab, so its user knows the others don't have the change
// yet. Kept per browser tab in sessionStorage under `mapcro.unsent.<session>`, as what a tab
// showed is (tabview.ts), so the mark outlasts a reload. It is a note, not the truth: the
// pending work itself is in the board's stored copy, and goes when the board next opens.
// Pure, but for the storage handed in.

const PREFIX = "mapcro.unsent.";
export const unsentKey = (session: string) => `${PREFIX}${session}`;

/** At most this many boards are noted; past it the oldest notes go (a session has 64 tabs). */
export const MAX_UNSENT = 64;

/** The boards of `session` this browser tab left with changes not sent. */
export function loadUnsent(store: Pick<Storage, "getItem">, session: string): ReadonlySet<string> {
  try {
    const v: unknown = JSON.parse(store.getItem(unsentKey(session)) ?? "[]");
    if (!Array.isArray(v)) return new Set();
    return new Set(v.filter((b): b is string => typeof b === "string" && /^[A-Za-z0-9_-]{22}$/.test(b)).slice(-MAX_UNSENT));
  } catch {
    return new Set(); // storage refused, or not a list: nothing noted
  }
}

export function saveUnsent(store: Pick<Storage, "setItem" | "removeItem">, session: string, boards: ReadonlySet<string>): void {
  try {
    if (boards.size) store.setItem(unsentKey(session), JSON.stringify([...boards]));
    else store.removeItem(unsentKey(session));
  } catch {
    // full or refused: the mark lasts until the page goes
  }
}

/** `boards` after `board` was left with `unsent` changes not sent: noted (newest last), or
 * no longer. The same set when nothing changes, and when the page couldn't tell (`undefined`:
 * nothing of the board loaded, or a copy that never connected and holds nothing pending), so a
 * mark made before stays. */
export function withUnsent(boards: ReadonlySet<string>, board: string, unsent: number | undefined): ReadonlySet<string> {
  if (unsent === undefined) return boards;
  const noted = unsent > 0;
  if (noted === boards.has(board)) return boards;
  const next = new Set(boards);
  if (noted) next.add(board);
  else next.delete(board);
  return new Set([...next].slice(-MAX_UNSENT));
}
