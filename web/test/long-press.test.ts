// Where a held finger looks for a placed thing (TD-107): nearest first, never past the reach,
// and detached cancel target fallback in touchGestures (TD-134).
import { describe, expect, it } from "vitest";
import { LONG_PRESS_REACH, reachPoints } from "../src/board/longPress";
import { touchGestures } from "../src/board/touchGestures";

it("starts at the finger's centre, goes outward, and stays inside the reach", () => {
  const pts = reachPoints(100, 200);
  expect(pts[0]).toEqual({ x: 100, y: 200 });
  const dist = pts.map((q) => Math.hypot(q.x - 100, q.y - 200));
  for (let i = 1; i < dist.length; i++) expect(dist[i]!).toBeGreaterThanOrEqual(dist[i - 1]! - 1e-9);
  expect(Math.max(...dist)).toBeCloseTo(LONG_PRESS_REACH);
});

it("leaves no gap a phone's pin (10 px across) could sit in on the outer ring", () => {
  const ring = reachPoints(0, 0).slice(-12);
  const gap = Math.hypot(ring[0]!.x - ring[1]!.x, ring[0]!.y - ring[1]!.y);
  expect(gap).toBeLessThan(12);
});

describe("touchGestures cancel target (TD-134)", () => {
  it("dispatches pointercancel on svg when the pressed node is detached mid-gesture, and on the node while connected", () => {
    class FakeNode extends EventTarget {
      isConnected = true;
    }
    class FakePointerEvent extends Event {
      pointerId: number;
      pointerType: string;
      clientX: number;
      clientY: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
        this.pointerType = init.pointerType ?? "";
        this.clientX = init.clientX ?? 0;
        this.clientY = init.clientY ?? 0;
      }
    }
    const g = globalThis as Record<string, unknown>;
    const prev = { Node: g.Node, PointerEvent: g.PointerEvent, window: g.window };
    const win = new EventTarget();
    g.Node = FakeNode;
    g.PointerEvent = FakePointerEvent;
    g.window = win;
    try {
      for (const connected of [false, true]) {
        const svg = new FakeNode();
        const child = new FakeNode();
        const cancelled: string[] = [];
        svg.addEventListener("pointercancel", () => cancelled.push("svg"));
        child.addEventListener("pointercancel", () => cancelled.push("child"));
        const stop = touchGestures(svg as unknown as SVGSVGElement, {
          onPan: () => {},
          onZoom: () => {},
          isPan: () => false,
          toView: (x, y) => ({ x, y }),
        });
        const down1 = new FakePointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 50, clientY: 50 });
        Object.defineProperty(down1, "target", { value: child });
        svg.dispatchEvent(down1);
        child.isConnected = connected;
        const down2 = new FakePointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 90, clientY: 90 });
        Object.defineProperty(down2, "target", { value: svg });
        svg.dispatchEvent(down2);
        stop();
        expect(cancelled).toEqual([connected ? "child" : "svg"]);
      }
    } finally {
      g.Node = prev.Node;
      g.PointerEvent = prev.PointerEvent;
      g.window = prev.window;
    }
  });
});
