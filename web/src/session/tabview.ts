// What a tab's board showed when it was left (sessions.md §4.2): the scene, the viewport and
// side, Player or Sandbox, the match and where it was, the sidebar tab, and what its user set
// there of Vision and the map layers (operator decision 7: per tab). Kept per browser tab in sessionStorage, under
// `mapcro.tabview.<session>.<board>`, so it outlasts a reload and is never synced: §4a's local
// view. It's restored only into the board it names, and only what the board still has: a scene
// that's gone or a match no longer attached is dropped with what hung on it, and the board opens
// there as it would cold. Pure, but for the storage handed in.

import type { RecordId } from "../gen/RecordId";

/** The map layers a tab remembers, by their view-state key's last part (`layer.<name>`). */
export const TAB_LAYERS = ["troopers", "health", "pings", "cc", "movement", "heals", "crates"] as const;
export type TabLayer = (typeof TAB_LAYERS)[number];

export interface TabView {
  /** The board it's of: it restores into no other (§4.2). */
  board: string;
  /** When it was stored (ms): the oldest go first past `MAX_TAB_VIEWS`. */
  at: number;
  scene?: RecordId;
  /** The viewport, as the map's view rectangle, and the side it's seen from. */
  view?: { x: number; y: number; w: number };
  viewpoint?: "amber" | "sapphire" | "neutral";
  side?: "events" | "notes";
  mode?: "player" | "sandbox";
  /** The open match, and its playback as the screen showed it. */
  match?: string;
  t?: number;
  playing?: boolean;
  speed?: number;
  /** Of the map layers, Vision and Show last seen, only what the user set on this tab
   * (`withOwn`); the rest show this browser's choice, as on a board alone. */
  layers?: Partial<Record<TabLayer, boolean>>;
  vision?: "all" | "amber" | "sapphire";
  lastSeen?: boolean;
}

/** At most this many are kept in one browser tab; the oldest are dropped (§4.2). */
export const MAX_TAB_VIEWS = 200;

const PREFIX = "mapcro.tabview.";
export const tabViewKey = (session: string, board: string) => `${PREFIX}${session}.${board}`;

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T extends string>(v: unknown, all: readonly T[]): v is T => typeof v === "string" && (all as readonly string[]).includes(v);

/**
 * A stored value read as a `TabView` of `board`, or nothing: another board's (never restored
 * elsewhere), or not one at all. Each field is taken only in its own shape, so a damaged or
 * hand-edited entry can restore nothing the app wouldn't have stored.
 */
export function parseTabView(raw: string | null, board: string): TabView | undefined {
  if (!raw) return undefined;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (v === null || typeof v !== "object" || v.board !== board) return undefined;
  const out: TabView = { board, at: num(v.at) ? v.at : 0 };
  if (typeof v.scene === "string" && /^[0-9a-f]{32}$/.test(v.scene)) out.scene = v.scene;
  const r = v.view as Record<string, unknown> | null | undefined;
  if (r && typeof r === "object" && num(r.x) && num(r.y) && num(r.w) && r.w > 0) out.view = { x: r.x, y: r.y, w: r.w };
  if (oneOf(v.viewpoint, ["amber", "sapphire", "neutral"] as const)) out.viewpoint = v.viewpoint;
  if (oneOf(v.side, ["events", "notes"] as const)) out.side = v.side;
  if (oneOf(v.mode, ["player", "sandbox"] as const)) out.mode = v.mode;
  if (typeof v.match === "string" && /^[1-9]\d{0,11}$/.test(v.match)) {
    out.match = v.match;
    if (num(v.t) && v.t >= 0) out.t = v.t;
    if (typeof v.playing === "boolean") out.playing = v.playing;
    if (num(v.speed) && v.speed > 0) out.speed = v.speed;
  }
  const l = v.layers as Record<string, unknown> | null | undefined;
  if (l && typeof l === "object") {
    const layers: Partial<Record<TabLayer, boolean>> = {};
    for (const k of TAB_LAYERS) if (typeof l[k] === "boolean") layers[k] = l[k];
    out.layers = layers;
  }
  if (oneOf(v.vision, ["all", "amber", "sapphire"] as const)) out.vision = v.vision;
  if (typeof v.lastSeen === "boolean") out.lastSeen = v.lastSeen;
  return out;
}

/** What this browser tab remembers of `board` in `session`, if anything. */
export function loadTabView(store: Pick<Storage, "getItem">, session: string, board: string): TabView | undefined {
  try {
    return parseTabView(store.getItem(tabViewKey(session, board)), board);
  } catch {
    return undefined; // storage refused (private mode): nothing remembered
  }
}

/** Remember `view` for its board in `session`, and drop the oldest past the cap. */
export function saveTabView(store: Storage, session: string, view: TabView): void {
  try {
    store.setItem(tabViewKey(session, view.board), JSON.stringify(view));
    const all: Array<{ key: string; at: number }> = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (!key?.startsWith(PREFIX)) continue;
      let at = 0;
      try {
        const stored = (JSON.parse(store.getItem(key) ?? "") as { at?: unknown }).at;
        if (num(stored)) at = stored;
      } catch {
        // not one of ours any more: the oldest of all
      }
      all.push({ key, at });
    }
    if (all.length <= MAX_TAB_VIEWS) return;
    all.sort((a, b) => a.at - b.at);
    for (const { key } of all.slice(0, all.length - MAX_TAB_VIEWS)) store.removeItem(key);
  } catch {
    // full or refused: this view just isn't remembered
  }
}

/**
 * The map part of a view, once the board's scenes are known: a scene that no longer exists
 * takes its viewport and side with it (they were of that scene), and the board opens on its
 * first scene, fitted, as it would cold.
 */
export function withScenes(view: TabView, live: (id: RecordId) => boolean): TabView {
  if (view.scene === undefined || live(view.scene)) return view;
  const { scene: _scene, view: _view, viewpoint: _viewpoint, ...rest } = view;
  return rest;
}

/**
 * The Player part of a view, once the board's matches are known: a match no longer attached
 * takes its playback and the mode with it, and the board opens as it would cold (on its newest
 * match, if it has one).
 */
export function withMatches(view: TabView, attached: readonly number[]): TabView {
  if (view.match === undefined || attached.includes(Number(view.match))) return view;
  const { match: _match, t: _t, playing: _playing, speed: _speed, mode: _mode, ...rest } = view;
  return rest;
}

/** A tab's own of the map layers, Vision and Show last seen: what its user set there. */
export type TabOwn = Pick<TabView, "layers" | "vision" | "lastSeen">;

/** What a remembered view holds of them: the tab's own so far. */
export function tabOwn(view: TabOwn | undefined): TabOwn {
  const out: TabOwn = {};
  if (view?.layers && Object.keys(view.layers).length) out.layers = { ...view.layers };
  if (view?.vision !== undefined) out.vision = view.vision;
  if (view?.lastSeen !== undefined) out.lastSeen = view.lastSeen;
  return out;
}

/**
 * `own` after the user's own change to a view-state key on this tab (player/viewstate.ts
 * `onOwn`): a map layer, Vision or Show last seen set here is the tab's own from then on, and
 * comes back with the tab. One never set here isn't held, so the tab shows this browser's
 * choice of it, as a board alone does (§4.2; operator decision 7 as the lead read it,
 * 2026-11-14: a tab only passed through pins nothing).
 */
export function withOwn(own: TabOwn, key: string, value: unknown): TabOwn {
  if (key === "vision.team") return oneOf(value, ["all", "amber", "sapphire"] as const) ? { ...own, vision: value } : own;
  if (key === "vision.last_seen") return typeof value === "boolean" ? { ...own, lastSeen: value } : own;
  const layer = key.startsWith("layer.") ? key.slice("layer.".length) : undefined;
  if (!oneOf(layer, TAB_LAYERS) || typeof value !== "boolean") return own;
  return { ...own, layers: { ...own.layers, [layer]: value } };
}

/** The Player part of a view, as the Player host takes it (player/host.ts `PlayerRemembered`). */
export function playerPart(view: TabView | undefined): Pick<TabView, "mode" | "match" | "t" | "playing" | "speed" | "layers" | "vision" | "lastSeen"> {
  if (!view) return {};
  const { board: _board, at: _at, scene: _scene, view: _view, viewpoint: _viewpoint, side: _side, ...player } = view;
  return player;
}
