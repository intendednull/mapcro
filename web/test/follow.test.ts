import { describe, expect, it } from "vitest";
import { FIT, RECONNECT_MS, REJOIN_MS, clampView, followable, fromViewport, locate, presenters, sideOf, toViewport, zoomAt } from "../src/board/follow";
import { MAX_SEAT, newSeat, pageSeat } from "../src/core/seat";
import type { PeerPresence } from "../src/gen/PeerPresence";
import type { Presence } from "../src/gen/Presence";

const st = (following: number | null = null): Presence => ({
  name: "x", color: 0, scene: null, floor: "surface", view: null, cursor: null, laser: [], drag: null, drag_group: [], focus: null, following,
});
const peer = (id: number, role: PeerPresence["role"], following: number | null = null): PeerPresence => ({ peer: id, role, state: st(following) });

const seated = (id: number, seat: number | undefined, role: PeerPresence["role"] = "edit"): PeerPresence => ({ peer: id, role, state: seat === undefined ? st() : { ...st(), seat } });

describe("re-finding a presenter (spec §8: a seat survives a reconnect)", () => {
  const J = { n: 1, at: 1000 };
  const later = { n: 2, at: 5000 };
  it("on the same join, the peer itself", () => {
    expect(locate({ peer: 3, seat: 77, joins: 1 }, [seated(3, 77)], 9, J, 1000)).toEqual({ kind: "here", peer: seated(3, 77) });
    // An older presenter, without a seat: by peer, as before.
    expect(locate({ peer: 3, joins: 1 }, [seated(3, undefined)], 9, J, 1000)).toEqual({ kind: "here", peer: seated(3, undefined) });
  });
  it("after this page's own reconnect, by seat only: old peer ids name someone else now", () => {
    // The server restarted: ids start again, and 3 is now another person.
    const peers = [seated(3, 12), seated(5, 77)];
    expect(locate({ peer: 3, seat: 77, joins: 1 }, peers, 9, later, 5000)).toEqual({ kind: "here", peer: seated(5, 77) });
    // Without a seat there is no telling: the follow ends, as it did.
    expect(locate({ peer: 3, joins: 1 }, peers, 9, later, 5000)).toEqual({ kind: "gone" });
  });
  it("on the same join, a peer id with another seat is someone else", () => {
    expect(locate({ peer: 3, seat: 77, joins: 1 }, [seated(3, 12), seated(4, 77)], 9, J, 1000)).toEqual({ kind: "here", peer: seated(4, 77) });
  });
  it("the newest editor with the seat, never me or a viewer", () => {
    const peers = [seated(4, 77), seated(8, 77), seated(9, 77), seated(10, 77, "view")];
    expect(locate({ peer: 1, seat: 77, joins: 1 }, peers, 9, J, 1000)).toEqual({ kind: "here", peer: seated(8, 77) });
  });
  it("away after this page's reconnect: waits REJOIN_MS from the join, then gone", () => {
    const t = { peer: 3, seat: 77, joins: 1 };
    expect(locate(t, [], 9, later, 5000)).toEqual({ kind: "wait", until: 5000 + REJOIN_MS });
    expect(locate(t, [], 9, later, 5000 + REJOIN_MS - 1)).toEqual({ kind: "wait", until: 5000 + REJOIN_MS });
    expect(locate(t, [], 9, later, 5000 + REJOIN_MS)).toEqual({ kind: "gone" });
  });
  it("the presenter alone gone: waits RECONNECT_MS from when it was missed, then gone", () => {
    expect(locate({ peer: 3, seat: 77, joins: 1 }, [], 9, J, 2000)).toEqual({ kind: "wait", until: 2000 + RECONNECT_MS });
    const t = { peer: 3, seat: 77, joins: 1, lostAt: 2000 };
    expect(locate(t, [], 9, J, 2000 + RECONNECT_MS - 1)).toEqual({ kind: "wait", until: 2000 + RECONNECT_MS });
    expect(locate(t, [], 9, J, 2000 + RECONNECT_MS)).toEqual({ kind: "gone" });
    // An older presenter, without a seat, can't be found again: gone at once, as before.
    expect(locate({ peer: 3, joins: 1 }, [], 9, J, 2000)).toEqual({ kind: "gone" });
  });
  it("a seat is random, a JavaScript integer, and one per page", () => {
    const seats = new Set(Array.from({ length: 1000 }, newSeat));
    expect(seats.size).toBe(1000);
    for (const s of seats) expect(Number.isSafeInteger(s) && s >= 1 && s <= MAX_SEAT).toBe(true);
    expect(Math.max(...seats)).toBeGreaterThan(2 ** 52); // the top bits are used
    expect(pageSeat()).toBe(pageSeat());
  });
});

describe("follow", () => {
  it("nobody follows a viewer", () => {
    expect(followable(peer(1, "edit"))).toBe(true);
    expect(followable(peer(1, "owner"))).toBe(true);
    expect(followable(peer(1, "view"))).toBe(false);
  });
  it("presenters are followed editors, counted", () => {
    const peers = [peer(1, "owner"), peer(2, "edit", 1), peer(3, "view", 1), peer(4, "view", 3), peer(5, "edit")];
    const ps = presenters(peers, 9, 5);
    expect(ps.map((p) => [p.peer.peer, p.followers])).toEqual([[1, 2], [5, 1]]);
  });
  it("a viewport survives the trip through presence, in either viewpoint", () => {
    const v = { x: 200, y: 300, w: 400 };
    const back = fromViewport(toViewport(v, "amber"), "amber");
    for (const k of ["x", "y", "w"] as const) expect(back[k]).toBeCloseTo(v[k], 0);
    // A Sapphire viewer sees the same world area, mirrored.
    const s = fromViewport(toViewport(v, "amber"), "sapphire");
    expect(s.w).toBeCloseTo(400);
    expect(s.x).toBeCloseTo(1000 - 200 - 400, 0);
    expect(fromViewport(null, "amber")).toEqual(FIT);
  });
  it("zooms about the pointer and stays on the map and its notes margin", () => {
    const z = zoomAt({ x: 0, y: 0, w: 1000 }, { x: 250, y: 250 }, 0.5);
    expect(z).toEqual({ w: 500, x: 125, y: 125 });
    // Out past fit to the whole board: the map and a quarter of it all round.
    expect(zoomAt(z, { x: 0, y: 0 }, 10)).toEqual({ w: 1500, x: -250, y: -250 });
    expect(clampView({ x: 900, y: -50, w: 300 })).toEqual({ x: 900, y: -50, w: 300 });
    expect(clampView({ x: 1100, y: -400, w: 300 })).toEqual({ x: 950, y: -250, w: 300 });
    expect(clampView({ x: 0, y: 0, w: 4000 })).toEqual({ x: -250, y: -250, w: 1500 });
  });
  it("carries the presenter's side, and older peers without one are Amber", () => {
    expect(toViewport(FIT, "sapphire").side).toBe("Sapphire");
    expect(toViewport(FIT, "amber").side).toBe("Amber");
    expect(sideOf(toViewport(FIT, "sapphire"))).toBe("sapphire");
    expect(sideOf({ center: { x: 0, y: 0 }, zoom: 1000 } as never)).toBe("amber");
    expect(sideOf(null)).toBeUndefined();
  });
});
