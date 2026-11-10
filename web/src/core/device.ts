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

/** Dark or light ink for marks drawn on a colour, whichever reads better (WCAG luminance). */
export function inkOn(hex: string): string {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  // Contrast against near-black (#14100c, L≈0.005) vs white (L=1).
  return (l + 0.05) / 0.055 >= 1.05 / (l + 0.05) ? "#14100c" : "#ffffff";
}

/** The colour a person last picked on a board (Draw, Arrow, Comment, Laser), if any. */
export function loadColour(board: string): number | undefined {
  try {
    const v = localStorage.getItem(`mapcro.colour.${board}`);
    return v === null ? undefined : Number(v);
  } catch {
    return undefined;
  }
}
export function saveColour(board: string, i: number) {
  try {
    localStorage.setItem(`mapcro.colour.${board}`, String(i));
  } catch {}
}

const ME = "mapcro.me";
const BOARDS = "mapcro.boards";
const JOINED = "mapcro.joined";
const COMMENTS = "mapcro.commentsOpen";
const NAMES = "mapcro.playerNames";

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

/** Whether this browser shows players' names in Player (the Names toggle, spec §6b): for every
 * board, on unless turned off here. Never shared with other viewers. */
export function playerNamesShown(): boolean {
  return read<boolean>(NAMES, true) !== false;
}

export function setPlayerNamesShown(on: boolean) {
  write(NAMES, on);
}

const VISION = "mapcro.playerVision";

/** Whose vision this browser's Player draws (the Vision control, spec §6b): "all", "amber" or
 * "sapphire", for every board. Presence carries what's drawn so followers see it (spec §6b); this
 * is your own, which a presenter's replaces only while you follow them. */
export function playerVision(): "all" | "amber" | "sapphire" {
  const v = read<string>(VISION, "all");
  return v === "amber" || v === "sapphire" ? v : "all";
}

export function setPlayerVision(v: "all" | "amber" | "sapphire") {
  write(VISION, v);
}

const LAST_SEEN = "mapcro.playerLastSeen";

/** Whether this browser's Player, in one team's Vision, draws an enemy out of its sight as a
 * ghost where last seen ("Show last seen location", spec §6b); off by default: not drawn. */
export function playerLastSeenShown(): boolean {
  return read<boolean>(LAST_SEEN, false) === true;
}

export function setPlayerLastSeenShown(on: boolean) {
  write(LAST_SEEN, on);
}

const HEALS = "mapcro.mapHeals";

/** Whether this browser draws the map's healing pickups (the Heals toggle, spec §6b), on the
 * board and in Player alike: 36 icons would crowd the map, so off unless turned on here. Never
 * shared with other viewers. */
export function mapHealsShown(): boolean {
  return read<boolean>(HEALS, false) === true;
}

export function setMapHealsShown(on: boolean) {
  write(HEALS, on);
}

const CRATES = "mapcro.mapCrates";

/** Whether this browser draws the map's tough crates (the Heavy boxes toggle, spec §6b), on the
 * board and in Player alike: 78 of them, so off unless turned on here. Never shared. */
export function mapCratesShown(): boolean {
  return read<boolean>(CRATES, false) === true;
}

export function setMapCratesShown(on: boolean) {
  write(CRATES, on);
}

const SUMMARY = "mapcro.summaryChosen";
const OPENED = "mapcro.opened";

/** Whether this browser chose "Use API summary" for a match (spec §6b, the replay prompt): its
 * prompt doesn't come back on its own. */
export function summaryChosen(id: string): boolean {
  return read<string[]>(SUMMARY, []).includes(id);
}

export function chooseSummary(id: string) {
  const all = read<string[]>(SUMMARY, []).filter((x) => x !== id);
  write(SUMMARY, [...all, id].slice(-200));
}

/** This tab opened (or attached) the match on the board: the landing's Open match or Player's
 * Load. Tab-local (sessionStorage), so a reload keeps it and nobody else on the board has it. */
export function markOpened(board: string, id: string) {
  try {
    const all = (JSON.parse(sessionStorage.getItem(OPENED) ?? "[]") as string[]).filter((x) => x !== `${board}/${id}`);
    sessionStorage.setItem(OPENED, JSON.stringify([...all, `${board}/${id}`].slice(-50)));
  } catch {}
}

export function openedHere(board: string, id: string): boolean {
  try {
    return (JSON.parse(sessionStorage.getItem(OPENED) ?? "[]") as string[]).includes(`${board}/${id}`);
  } catch {
    return false;
  }
}
