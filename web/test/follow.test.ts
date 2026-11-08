import { describe, expect, it } from "vitest";
import { FIT, clampView, followable, fromViewport, presenters, sideOf, toViewport, zoomAt } from "../src/board/follow";
import type { PeerPresence } from "../src/gen/PeerPresence";
import type { Presence } from "../src/gen/Presence";

const st = (following: number | null = null): Presence => ({
  name: "x", color: 0, scene: null, floor: "surface", view: null, cursor: null, laser: [], drag: null, drag_group: [], focus: null, following,
});
const peer = (id: number, role: PeerPresence["role"], following: number | null = null): PeerPresence => ({ peer: id, role, state: st(following) });

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
