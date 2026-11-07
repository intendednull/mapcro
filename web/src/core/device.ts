// What this device remembers: who you are (presence name and colour) and the boards you hold
// links to. No accounts (spec §11): a board's capability lives only here and in its link.

export interface Me {
  name: string;
  color: number;
}

export interface KnownBoard {
  board: string;
  token: string;
  title: string;
  /** Last opened, ms since the epoch. */
  seen: number;
}

/** The presence palette (join card swatches); `Presence.color` indexes it. */
export const PALETTE = [
  { name: "Parchment", hex: "#ece4d0" },
  { name: "Rose", hex: "#f08fb0" },
  { name: "Lilac", hex: "#b6a2ff" },
  { name: "Lime", hex: "#c5e07a" },
  { name: "Ice", hex: "#7fe0e8" },
  { name: "Brass", hex: "#c4a062" },
  { name: "Cinnabar", hex: "#e0664f" },
] as const;

export const colorOf = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length]!.hex;

const ME = "mapcro.me";
const BOARDS = "mapcro.boards";
const JOINED = "mapcro.joined";
const COMMENTS = "mapcro.commentsOpen";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // Private mode or full storage: the app still works, it just won't remember.
  }
}

export function loadMe(): Me | undefined {
  const m = read<Me | null>(ME, null);
  return m && typeof m.name === "string" && typeof m.color === "number" ? m : undefined;
}

export function saveMe(me: Me) {
  write(ME, me);
}

export function knownBoards(): KnownBoard[] {
  return read<KnownBoard[]>(BOARDS, []).sort((a, b) => b.seen - a.seen);
}

export function rememberBoard(b: Omit<KnownBoard, "seen">) {
  const rest = knownBoards().filter((k) => k.board !== b.board);
  write(BOARDS, [{ ...b, seen: Date.now() }, ...rest].slice(0, 50));
}

/** Whether this device shows a board's comments expanded (the Comments toggle). */
export function commentsOpen(board: string): boolean {
  return read<string[]>(COMMENTS, []).includes(board);
}

export function setCommentsOpen(board: string, open: boolean) {
  const all = read<string[]>(COMMENTS, []).filter((b) => b !== board);
  write(COMMENTS, open ? [...all, board].slice(-200) : all);
}

/** The join card shows once per board on a device; later visits go straight in. */
export function hasJoined(board: string): boolean {
  return read<string[]>(JOINED, []).includes(board);
}

export function markJoined(board: string) {
  const j = read<string[]>(JOINED, []);
  if (!j.includes(board)) write(JOINED, [...j, board].slice(-200));
}
