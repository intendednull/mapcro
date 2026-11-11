// This page's seat (spec §8, sessions.md §6.1): a random number, made once per page load and
// sent in presence, the same across reconnects and across every board the page opens. Peer ids
// are per connection, so a follower finds its presenter again by seat after a reconnect (a
// server restart: every deploy). Random only: never derived from a name or anything else.

/** The largest seat (engine wire.rs `MAX_SEAT`): a JavaScript number holds it exactly. */
export const MAX_SEAT = 2 ** 53 - 1;

/** A random seat in 1..=MAX_SEAT. */
export function newSeat(): number {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return ((hi! & 0x1f_ffff) * 2 ** 32 + lo!) || 1;
}

let page: number | undefined;
/** This page load's seat. */
export const pageSeat = (): number => (page ??= newSeat());
