// The page's timeline cache (sessions.md §4.3): decoded timelines, frozen, kept by where they
// came from, so a board opened again in this page (a tab switched back to, §5) draws its match
// at once. The server still decides: each open asks it for the timeline with the validators held
// (`If-None-Match`), after the same access check as ever, and answers "the same" or sends the
// one that replaced it. So nothing here is ever shown that the server wouldn't send again, past
// the moment before its answer.
//
// Where a timeline came from is in its validator (crates/server/src/replays.rs
// `timeline_etag`): the replay fetched from Valve is one file for every board, kept by match
// alone; a board's own upload is kept by board and match, and no other board reads it. The
// metadata summary has no validator and isn't kept.

import type { Timeline } from "../match/timeline";

export interface HeldTimeline {
  etag: string;
  tl: Timeline;
  /** Its decoded size, estimated from its JSON's length. */
  bytes: number;
}

/**
 * Decoded bytes per character of a timeline's JSON. Measured on the reference replay (a 44
 * minute match, 1.50 MiB of JSON): 0.99 to 1.60 of its length on the heap (sessions.md §10
 * phase 3). Taken a little over, so the cap is never passed.
 */
export const DECODED_PER_CHAR = 1.75;

/** The cap, decoded (§4.3): about twenty long matches. */
export const TIMELINE_CACHE_BYTES = 48 * 1024 * 1024;

const FETCHED = '"cdn-';

/** Freeze a decoded timeline all the way down: what's shared across mounts can't be changed by one. */
export function freezeDeep<T>(v: T): T {
  if (v === null || typeof v !== "object" || Object.isFrozen(v)) return v;
  Object.freeze(v);
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (x !== null && typeof x === "object") freezeDeep(x);
  return v;
}

/** Whether a validator names the replay fetched from Valve: one file, the same for every board. */
export const isFetched = (etag: string) => etag.startsWith(FETCHED);

export class TimelineCache {
  /** Oldest first: a hit moves to the end. */
  private readonly held = new Map<string, HeldTimeline>();
  private total = 0;

  constructor(private readonly cap = TIMELINE_CACHE_BYTES) {}

  private static keyOf(board: string, match: string, etag: string): string {
    return isFetched(etag) ? `\u0000${match}` : `${board}\u0000${match}`;
  }

  /** What `board` may hold for `match`, the richest first: its own upload, then the fetched replay. */
  candidates(board: string, match: string): HeldTimeline[] {
    const own = this.held.get(`${board}\u0000${match}`);
    const fetched = this.held.get(`\u0000${match}`);
    return [own, fetched].filter((h): h is HeldTimeline => h !== undefined);
  }

  /** The one of `board`'s candidates the server named as current; it's the most recently used now. */
  confirm(board: string, match: string, etag: string): HeldTimeline | undefined {
    const key = TimelineCache.keyOf(board, match, etag);
    const h = this.held.get(key);
    if (!h || h.etag !== etag) return undefined;
    this.held.delete(key);
    this.held.set(key, h);
    return h;
  }

  /** Keep a timeline the server just sent, frozen; the least recently used go to make room. */
  put(board: string, match: string, etag: string, tl: Timeline, chars: number): Timeline {
    const key = TimelineCache.keyOf(board, match, etag);
    this.remove(key);
    const bytes = Math.ceil(chars * DECODED_PER_CHAR);
    freezeDeep(tl);
    // One larger than the whole cap is shown, not kept.
    if (bytes > this.cap) return tl;
    this.held.set(key, { etag, tl, bytes });
    this.total += bytes;
    for (const k of this.held.keys()) {
      if (this.total <= this.cap) break;
      if (k !== key) this.remove(k);
    }
    return tl;
  }

  /**
   * The server refused `board` this match, or its upload is no longer what it answers with:
   * the board's own goes. The fetched replay stays: it's every board's, and still what the
   * server sends the others.
   */
  drop(board: string, match: string): void {
    this.remove(`${board}\u0000${match}`);
  }

  private remove(key: string): void {
    const h = this.held.get(key);
    if (!h) return;
    this.held.delete(key);
    this.total -= h.bytes;
  }

  /** Decoded bytes held, and how many timelines. */
  size(): { bytes: number; n: number } {
    return { bytes: this.total, n: this.held.size };
  }

  clear(): void {
    this.held.clear();
    this.total = 0;
  }
}

/** This page's. */
export const timelines = new TimelineCache();
