// The operator's first playtest (2026-11-07), on the real server: hero select, random heroes on
// new boards, vision, souls, drag-select and group moves, panning, and lane splits.

import { type Page, expect, test } from "@playwright/test";
import { joinNew, mapPoint, tokenAt, viewLink, viewOf } from "./helpers";
import { Server, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

test.describe("with a hero pack", () => {
  let server: Server;
  test.beforeAll(async () => {
    server = new Server(heroPack(14));
    await server.start();
  });
  test.afterAll(() => server.stop());

  test("a new board rolls twelve different heroes; the picker searches and picks by keyboard", async ({ browser }) => {
    const a = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await a.goto(server.url);
    await a.getByLabel("Board title").fill("Random");
    await a.getByRole("button", { name: "New board" }).click();
    await a.locator("#join-name").fill("Coach");
    await a.keyboard.press("Enter");
    const portraits = (p: Page) => p.locator(".tb-player .tb-img").evaluateAll((els) => els.map((e) => (e as HTMLElement).style.backgroundImage));
    await expect.poll(async () => new Set(await portraits(a)).size).toBe(12);
    expect((await portraits(a)).some((u) => /heroes\/9[01]\./.test(u))).toBe(false); // only playable heroes
    const b = await joinNew(browser, a.url(), "Marrow");
    await expect.poll(async () => (await portraits(b)).sort()).toEqual((await portraits(a)).sort());

    // Click a portrait: the picker opens with the search focused.
    const col = (p: Page) => p.locator('.tb-player[data-slot="Amber-0"]');
    await col(a).getByTestId("pick-hero").click();
    await expect(a.getByTestId("hero-search")).toBeFocused();
    await expect(a.locator(".hero-cell")).toHaveCount(14); // every playable hero, nothing else
    await a.keyboard.type("testhero c");
    await expect(a.locator(".hero-cell")).toHaveCount(1);
    await a.keyboard.press("Backspace");
    await a.keyboard.press("Backspace");
    await expect(a.locator(".hero-cell")).toHaveCount(14);
    await a.keyboard.press("ArrowRight");
    await a.keyboard.press("ArrowDown"); // index 7: "Testhero H"
    await a.keyboard.press("Enter");
    await expect(a.getByTestId("hero-picker")).toHaveCount(0);
    await expect(col(b).locator(".tb-img")).toHaveAttribute("style", /topbar\/heroes\/8\.png/);
    // Esc closes without changing anything.
    await col(a).getByTestId("pick-hero").click();
    await a.keyboard.press("Escape");
    await expect(a.getByTestId("hero-picker")).toHaveCount(0);
    await expect(col(b).locator(".tb-img")).toHaveAttribute("style", /topbar\/heroes\/8\.png/);

    // Viewers can't pick.
    const v = await joinNew(browser, await viewLink(server.url, a.url()), "Guest");
    await expect(v.getByTestId("pick-hero")).toHaveCount(0);
    await a.screenshot({ path: "shots/playtest-random-heroes.png" });
  });
});

test.describe("on the fallback map", () => {
  let server: Server;
  test.beforeAll(async () => {
    server = new Server();
    await server.start();
  });
  test.afterAll(() => server.stop());

  test("vision: a hero not in vision is a ghost for everyone, toggled on the token or the top bar", async ({ browser }) => {
    const url = await newBoardUrl(server, "vision");
    const a = await joinNew(browser, url, "Coach");
    const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
    const tok = (p: Page) => p.locator('.mapbox .tok[data-slot="Amber-2"]');
    await tok(a).hover();
    await tok(a).getByTestId("vision").click();
    await expect(tok(v)).toHaveAttribute("data-visible", "false");
    await expect(tok(v)).toHaveClass(/ghost/);
    await expect(v.locator('.tb-player[data-slot="Amber-2"]')).toHaveClass(/unseen/);
    // The same toggle on the top bar brings it back.
    await a.locator('.tb-player[data-slot="Amber-2"]').hover();
    await a.locator('.tb-player[data-slot="Amber-2"]').getByTestId("tb-vision").click();
    await expect(tok(v)).toHaveAttribute("data-visible", "true");
    await expect(tok(v)).not.toHaveClass(/ghost/);
  });

  test("souls: a click anywhere on the banner edits, and a bare number is thousands", async ({ browser }) => {
    const a = await joinNew(browser, await newBoardUrl(server, "souls"), "Coach");
    const banner = a.locator('.tb-player[data-slot="Sapphire-1"]').getByTestId("souls-banner");
    const box = (await banner.boundingBox())!;
    await a.mouse.click(box.x + 3, box.y + box.height - 3); // the banner's corner, not its number
    await a.getByTestId("souls-input").fill("8");
    await a.keyboard.press("Enter");
    await expect(banner).toHaveText("8.0k");
  });

  test("drag-select heroes, move them as one, undo once; Space-drag and right-drag pan", async ({ browser }) => {
    const url = await newBoardUrl(server, "select");
    const a = await joinNew(browser, url, "Coach");
    const b = await joinNew(browser, url, "Marrow");
    const amber = ["Amber-0", "Amber-1", "Amber-2", "Amber-3", "Amber-4", "Amber-5"];
    const before = await Promise.all(amber.map((s) => tokenAt(a, s)));

    // A rectangle around Amber's starting row (bottom of the map) selects all six.
    const p0 = await mapPoint(a, 0.3, 0.83);
    const p1 = await mapPoint(a, 0.7, 0.92);
    await a.mouse.move(p0.x, p0.y);
    await a.mouse.down();
    await a.mouse.move(p1.x, p1.y, { steps: 6 });
    await expect(a.getByTestId("marquee")).toBeVisible();
    await a.mouse.up();
    await expect(a.locator(".mapbox .tok.selected")).toHaveCount(6);
    // Shift-click adds one more, and takes it out again.
    await a.locator('.mapbox .tok[data-slot="Sapphire-0"]').click({ modifiers: ["Shift"] });
    await expect(a.locator(".mapbox .tok.selected")).toHaveCount(7);
    await a.locator('.mapbox .tok[data-slot="Sapphire-0"]').click({ modifiers: ["Shift"] });
    await expect(a.locator(".mapbox .tok.selected")).toHaveCount(6);

    // Drag one: all six move together, live for B with name tags, and land as one transaction.
    const grab = (await a.locator('.mapbox .tok[data-slot="Amber-2"]').boundingBox())!;
    const to = await mapPoint(a, 0.5, 0.6);
    await a.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
    await a.mouse.down();
    await a.mouse.move(to.x, to.y, { steps: 10 });
    await expect(b.locator('.mapbox .p-tag[data-tag="Coach"]')).toHaveCount(6);
    await expect.poll(async () => (await tokenAt(b, "Amber-5")).y).toBeLessThan(before[5]!.y - 100);
    await a.mouse.up();
    const after = await Promise.all(amber.map((s) => tokenAt(a, s)));
    const dy = after[0]!.y - before[0]!.y;
    expect(dy).toBeLessThan(-100);
    for (const [i, p] of after.entries()) expect(p.y - before[i]!.y).toBeCloseTo(dy, 0);
    await expect.poll(async () => Promise.all(amber.map((s) => tokenAt(b, s)))).toEqual(after);
    // The group stays selected after the move, ready for another.
    await expect(a.locator(".mapbox .tok.selected")).toHaveCount(6);
    await a.keyboard.press("Control+z");
    await expect.poll(async () => Promise.all(amber.map((s) => tokenAt(b, s)))).toEqual(before);
    // Esc clears the selection.
    await a.keyboard.press("Escape");
    await expect(a.locator(".mapbox .tok.selected")).toHaveCount(0);

    // Pan: zoom in, then Space-drag and right-drag move the view, never a hero.
    const mid = await mapPoint(a, 0.5, 0.5);
    await a.mouse.move(mid.x, mid.y);
    await a.mouse.wheel(0, -400);
    await expect.poll(async () => (await viewOf(a))[2]).toBeLessThan(700);
    const v0 = await viewOf(a);
    await a.keyboard.down("Space");
    await a.mouse.down();
    await a.mouse.move(mid.x + 80, mid.y + 40, { steps: 5 });
    await a.mouse.up();
    await a.keyboard.up("Space");
    const v1 = await viewOf(a);
    expect(v1[0]).toBeLessThan(v0[0]);
    await a.mouse.move(mid.x, mid.y);
    await a.mouse.down({ button: "right" });
    await a.mouse.move(mid.x - 80, mid.y, { steps: 5 });
    await a.mouse.up({ button: "right" });
    expect((await viewOf(a))[0]).toBeGreaterThan(v1[0]);
    await expect(a.locator(".mapbox .tok.selected")).toHaveCount(0);
    expect(await Promise.all(amber.map((s) => tokenAt(a, s)))).toEqual(before);
    await a.screenshot({ path: "shots/playtest-select.png" });
  });

  test("lane equilibrium: drag the split along the lane, click to jump it, both browsers agree", async ({ browser }) => {
    const url = await newBoardUrl(server, "waves");
    const a = await joinNew(browser, url, "Coach");
    const b = await joinNew(browser, url, "Marrow");
    const lane = (p: Page) => p.locator('.mapbox .lanes g[data-key="lane4"]');
    const tOf = async (p: Page) => Number(await lane(p).getAttribute("data-t"));
    /** A point on the lane's drawn line, as a fraction of one half, in page pixels. */
    const onLane = (p: Page, half: "amber" | "sapphire", f: number) =>
      lane(p)
        .locator(`path[data-half="${half}"]`)
        .evaluate((el, f) => {
          const path = el as SVGPathElement;
          const q = path.getPointAtLength(path.getTotalLength() * f);
          const m = path.getScreenCTM()!;
          return { x: q.x * m.a + q.y * m.c + m.e, y: q.x * m.b + q.y * m.d + m.f };
        }, f);
    const amberEnd = async (p: Page) => {
      const d = (await lane(p).locator('path[data-half="amber"]').getAttribute("d"))!;
      const n = d.split(/[ML ]+/).filter(Boolean).map(Number);
      return { x: n[n.length - 2]!, y: n[n.length - 1]! };
    };
    const t0 = await tOf(a);
    expect(t0).toBeGreaterThan(300); // the default: where the lane crosses the centre line
    expect(t0).toBeLessThan(700);
    const end0 = await amberEnd(b);

    // Drag the gap toward the Sapphire end.
    const gap = (await a.getByTestId("wave-gap-lane4").boundingBox())!;
    const dest = await onLane(a, "sapphire", 0.5);
    await a.mouse.move(gap.x + gap.width / 2, gap.y + gap.height / 2);
    await a.mouse.down();
    await a.mouse.move(dest.x, dest.y, { steps: 10 });
    // Only the dragger raises the lane above the icons; the other browser sees it move, tagged.
    await expect(a.locator('.lane-raised[data-raised="lane4"]')).toHaveCount(1);
    await expect(b.locator(".lane-raised")).toHaveCount(0);
    await expect.poll(() => tOf(b)).toBeGreaterThan(t0 + 100);
    await expect(b.locator('.p-tag[data-tag="Coach"]')).toContainText("moving the wave");
    await a.mouse.up();
    await expect(a.locator(".lane-raised")).toHaveCount(0);
    const t1 = await tOf(a);
    expect(t1).toBeGreaterThan(t0 + 100);
    await expect.poll(() => tOf(b)).toBe(t1);
    // The colour boundary itself moved: Amber's half now reaches further up the map.
    expect((await amberEnd(b)).y).toBeLessThan(end0.y - 20);

    // A click on the lane jumps the split there: on a stretch of the lane clear of icons and heroes.
    const icons = await a.locator(".mapbox .mk, .mapbox .tok").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, r: r.width / 2 };
      }),
    );
    let jump = await onLane(a, "amber", 0.5);
    let room = -Infinity;
    for (let f = 0.1; f < 0.9; f += 0.05) {
      const q = await onLane(a, "amber", f);
      const clear = Math.min(...icons.map((i) => Math.hypot(i.x - q.x, i.y - q.y) - i.r));
      if (clear > room) [jump, room] = [q, clear];
    }
    await a.mouse.click(jump.x, jump.y);
    await expect.poll(() => tOf(b)).toBeLessThan(t0);
    const t2 = await tOf(a);
    // Erase leaves it alone.
    await a.keyboard.press("e");
    const g2 = (await a.locator('.mapbox .lanes g[data-key="lane4"] path[data-half="amber"]').boundingBox())!;
    await a.mouse.click(g2.x + g2.width / 2, g2.y + g2.height - 4);
    expect(await tOf(a)).toBe(t2);

    // Viewpoint: Sapphire's view has the same split, with their half in the lane colour.
    await b.getByTestId("viewpoint-flip").click();
    expect(await tOf(b)).toBe(t2);
    await expect(lane(b).locator('path[data-half="sapphire"]')).toHaveAttribute("stroke", "#2EC7E6");
    await expect(lane(b).locator('path[data-half="amber"]')).toHaveAttribute("stroke", "#DC4C2F");
    await b.reload();
    await expect.poll(() => tOf(b)).toBe(t2);
    // A new scene starts from this split.
    await a.keyboard.press("v");
    await a.getByTestId("scene-add").click();
    await expect.poll(() => tOf(a)).toBe(t2);
    await a.screenshot({ path: "shots/playtest-lanes.png" });
  });
});
