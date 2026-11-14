// Recent boards kept warm (sessions.md §5): when a tab is left, its board's sync session is
// parked here, not ended: the replica, its pending edits and its undo stack, which are that
// board's alone. Coming back, the board's new mount takes it out, draws at once from the replica
// and reconnects. Nothing of the board's UI is kept, and a parked board holds no socket once its
// edits are flushed (core/session.ts `park`).
//
// A parked session is found again only by its own board and credential. Another credential for
// the same board (a stronger own link found, another grant) ends the parked one first: a board
// has one session in this page at a time, since they'd share its stored copy and its client id.
// The pool is bounded by count, by the replicas' size and by time parked (§4.3); what it drops
// is ended, and its board opens cold the next time, from storage.

import type { Via } from "../gen/Via";

/** What the pool needs of a session (core/session.ts `BoardSession`). */
export interface Parkable {
  park(): void;
  end(): void;
  approxBytes(): number;
  readonly connection: { kind: string };
}

export interface PoolLimits {
  /** At most this many boards parked. */
  max: number;
  /** At most this many bytes of replicas parked (the WASM's estimate). */
  bytes: number;
  /** A board parked this long is dropped. */
  ageMs: number;
}

/** §4.3: 3 boards and 40 MiB, whichever comes first; dropped after 10 minutes parked. */
export const POOL_LIMITS: PoolLimits = { max: 3, bytes: 40 * 1024 * 1024, ageMs: 10 * 60 * 1000 };

interface Parked<S> {
  board: string;
  session: S;
  bytes: number;
  at: number;
}

/**
 * A parked session's key: its board and the whole credential it was opened with (the link's
 * token, and for a tab the session and grant it came through). Kept in memory only, as the
 * session itself keeps them.
 */
export function poolKey(board: string, token: string, via?: Via): string {
  return via ? `${board}\u0000${token}\u0000${via.session}\u0000${via.grant}` : `${board}\u0000${token}`;
}

export class RoomPool<S extends Parkable> {
  /** Oldest parked first. */
  private readonly parked = new Map<string, Parked<S>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private settling = false;

  constructor(
    private readonly limits: PoolLimits = POOL_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The session parked for this board and credential, taken out of the pool for the board's new
   * mount; none if there's none. A session of this board parked under any other credential is
   * ended: the mount about to open is the board's one session.
   */
  take(board: string, token: string, via?: Via): S | undefined {
    const key = poolKey(board, token, via);
    let hit: S | undefined;
    for (const [k, p] of [...this.parked]) {
      if (p.board !== board) continue;
      this.parked.delete(k);
      if (k === key && this.now() - p.at < this.limits.ageMs) hit = p.session;
      else p.session.end();
    }
    this.arm();
    return hit;
  }

  /** The board was left: keep its session, and drop what's past the limits, oldest first. */
  park(board: string, token: string, via: Via | undefined, session: S): void {
    // A link refused for good has nothing to keep warm; nor has a pool whose page is going.
    if (this.closed || session.connection.kind === "closed") return session.end();
    const key = poolKey(board, token, via);
    const was = this.parked.get(key);
    if (was && was.session !== session) was.session.end();
    this.parked.delete(key);
    session.park();
    const bytes = session.approxBytes();
    // One larger than the whole budget isn't kept at all.
    if (bytes > this.limits.bytes) return session.end();
    this.parked.set(key, { board, session, bytes, at: this.now() });
    this.settle();
  }

  /**
   * Hold to the limits once this switch is over. The board being opened mounts right after the
   * one left is parked, in the same task, and takes its own session out first: so the limits
   * count the boards parked beside the open one, and a board isn't dropped just as it's asked for.
   */
  private settle(): void {
    if (this.settling) return;
    this.settling = true;
    queueMicrotask(() => {
      this.settling = false;
      if (this.closed) return;
      this.trim();
      this.arm();
    });
  }

  private trim(): void {
    const total = () => [...this.parked.values()].reduce((n, p) => n + p.bytes, 0);
    for (const [k, p] of [...this.parked]) {
      const old = this.now() - p.at >= this.limits.ageMs;
      if (!old && this.parked.size <= this.limits.max && total() <= this.limits.bytes) break;
      this.parked.delete(k);
      p.session.end();
    }
  }

  /** One timer, for the oldest parked board's time. */
  private arm(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const oldest = this.parked.values().next().value;
    if (!oldest) return;
    this.timer = setTimeout(
      () => {
        this.trim();
        this.arm();
      },
      Math.max(0, oldest.at + this.limits.ageMs - this.now()),
    );
  }

  /** The page's session view is going: every parked session ends. */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const p of this.parked.values()) p.session.end();
    this.parked.clear();
  }

  /** How many boards are parked, and their replicas' bytes. */
  size(): { n: number; bytes: number } {
    return { n: this.parked.size, bytes: [...this.parked.values()].reduce((n, p) => n + p.bytes, 0) };
  }
}
