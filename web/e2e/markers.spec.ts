// Map markers: icons stay on their points at any zoom, in either viewpoint; the Patron has two
// stages and each team's is its own.

import { type Page, expect, test } from "@playwright/test";
import { joinNew, mapPoint } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  // MAPCRO_SHOT_PACKS: run on real art (and screenshot it); otherwise the fallback map.
  server = new Server(process.env.MAPCRO_SHOT_PACKS);
  await server.start();
});
test.afterAll(() => server.stop());

/** How far each marker's drawn centre is from its point on the map, in screen pixels. */
const drift = (p: Page, keys: string[]) =>
  p.evaluate((keys) => {
    const svg = document.querySelector<SVGSVGElement>("[data-testid=map] .mm-overlay.map")!;
    const m = svg.getScreenCTM()!;
    const sapphire = document.querySelector("[data-testid=map] .mm-host")!.classList.contains("vp-sapphire");
    return keys.map((k) => {
      const el = document.querySelector<HTMLElement>(`[data-testid=map] .mk[data-key="${k}"]`)!;
      // The marker's point in map units (its `left`/`top`), turned into view units by the viewpoint.
      const at = { x: parseFloat(el.style.left) * 10, y: parseFloat(el.style.top) * 10 };
      const v = sapphire ? { x: 1000 - at.x, y: 1000 - at.y } : at;
      const want = { x: m.a * v.x + m.c * v.y + m.e, y: m.b * v.x + m.d * v.y + m.f };
      const r = el.getBoundingClientRect();
      return Math.hypot(r.x + r.width / 2 - want.x, r.y + r.height / 2 - want.y);
    });
  }, keys);

test("markers stay on their points as you zoom, in both viewpoints", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "markers"), "Coach");
  const keys = ["mid_boss:neutral:lane0:1", "patron:amber:lane0:1", "camp:neutral:lane0:5", "walker:amber:lane1:1", "rift:neutral:lane1:1", "powerup:neutral:lane1:1"];
  for (const side of ["amber", "sapphire"]) {
    if (side === "sapphire") await a.getByTestId("viewpoint-flip").click();
    await expect(a.locator("[data-testid=map] .mm-host")).toHaveClass(new RegExp(`vp-${side}`));
    const centre = await mapPoint(a, 0.52, 0.48);
    await a.mouse.move(centre.x, centre.y);
    const widths: number[] = [];
    for (const step of [0, -150, -150, -150, 300, 300]) {
      if (step) await a.mouse.wheel(0, step);
      await a.waitForTimeout(150);
      widths.push(Number((await a.getByTestId("map").getAttribute("data-view"))!.split(" ")[2]));
      for (const [i, d] of (await drift(a, keys)).entries()) expect(d, `${keys[i]} at view width ${widths.at(-1)}, ${side}`).toBeLessThan(1.5);
    }
    expect(new Set(widths.slice(0, 4)).size).toBe(4); // it really zoomed in each time, then out past fit
    expect(widths.at(-1)).toBeGreaterThan(1000);
  }
});

test("each team's Patron is its own, and goes stage 1 → stage 2 → destroyed → stage 1", async ({ browser }) => {
  const url = await newBoardUrl(server, "patrons");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const amber = (p: Page) => p.locator('[data-testid=map] .mk[data-key="patron:amber:lane0:1"]');
  const sapphire = (p: Page) => p.locator('[data-testid=map] .mk[data-key="patron:sapphire:lane0:1"]');
  // Click the marker where no hero covers it (heroes start by the bases, near the Patrons).
  const click = async (p: Page, m: ReturnType<typeof amber>) => {
    const bb = (await m.boundingBox())!;
    const at = await p.evaluate((b) => {
      const pts: Array<{ x: number; y: number; d: number }> = [];
      for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) pts.push({ x: b.x + (b.width * i) / 10, y: b.y + (b.height * j) / 10, d: Math.hypot(i - 5, j - 5) });
      pts.sort((u, v) => u.d - v.d);
      return pts.find((q) => !document.elementFromPoint(q.x, q.y)?.closest(".tok, .co, [data-arrow], [data-stroke]"));
    }, bb);
    await p.mouse.click(at!.x, at!.y);
  };
  await expect(amber(a)).toHaveAttribute("data-status", "Active");
  for (const [i, want] of ["Stage2", "Destroyed", "Active"].entries()) {
    await click(a, amber(a));
    for (const p of [a, b]) {
      await expect(amber(p)).toHaveAttribute("data-status", want);
      await expect(sapphire(p)).toHaveAttribute("data-status", "Active");
    }
    if (i === 0) {
      // Stage 2 looks different: the shield is gone.
      await expect(amber(a)).toHaveClass(/stage2/);
      await expect(sapphire(a)).not.toHaveClass(/stage2/);
      await a.locator("[data-testid=map]").screenshot({ path: "shots/patron-stage2.png" });
      await click(a, sapphire(a));
      await expect(sapphire(b)).toHaveAttribute("data-status", "Stage2");
      await expect(amber(b)).toHaveAttribute("data-status", "Stage2");
      await click(a, sapphire(a));
      await expect(sapphire(b)).toHaveAttribute("data-status", "Destroyed");
      await click(a, sapphire(a));
      await expect(sapphire(b)).toHaveAttribute("data-status", "Active");
      await expect(amber(b)).toHaveAttribute("data-status", "Stage2");
    }
    if (i === 1) await a.locator("[data-testid=map]").screenshot({ path: "shots/patron-destroyed.png" });
  }
  // One undo takes back one step.
  await a.keyboard.press("Control+z");
  await expect(amber(b)).toHaveAttribute("data-status", "Destroyed");
  await expect(sapphire(b)).toHaveAttribute("data-status", "Active");
});

test("on a fresh board the Patron can be clicked: no heroes on it, and its whole icon takes the click", async ({ browser }) => {
  const url = await newBoardUrl(server, "fresh patron");
  const a = await joinNew(browser, url, "Coach");
  for (const team of ["amber", "sapphire"]) {
    const m = a.locator(`[data-testid=map] .mk[data-key="patron:${team}:lane0:1"]`);
    const bb = (await m.boundingBox())!;
    // Its middle, where heroes used to stand, then the arch's side, off-centre.
    await a.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await expect(m).toHaveAttribute("data-status", "Stage2");
    await a.mouse.click(bb.x + bb.width * 0.2, bb.y + bb.height / 2);
    await expect(m).toHaveAttribute("data-status", "Destroyed");
  }
  await a.locator("[data-testid=map]").screenshot({ path: "shots/patron-fresh-board.png" });
});
