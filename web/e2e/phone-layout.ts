import { expect, type Page } from "./fixtures";

/** Geometry only: never return DOM text, titles or player names. */
export async function checkPhoneLayout(page: Page) {
  const report = await page.evaluate(() => {
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || e.closest("[hidden]")) return false;
      if (!e.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
      // Content scrolled under the fixed transport, a sheet or an open menu is out of reach until
      // scrolled clear, not overlapped (the page reserves the transport's height: checked below).
      for (const cover of document.querySelectorAll(".phone-player .pl-bar, .phone-build-sheet, .p-events-sheet, .map-layers[open] .map-layers-pop")) {
        const c = cover.getBoundingClientRect();
        if (!cover.contains(e) && !e.contains(cover) && r.left < c.right && c.left < r.right && r.top < c.bottom && c.top < r.bottom) return false;
      }
      for (let parent: Element | null = e; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.visibility === "hidden" || style.opacity === "0") return false;
        if (parent !== e && /auto|scroll|hidden|clip/.test(style.overflowY)) {
          const clip = parent.getBoundingClientRect();
          if (r.bottom <= clip.top || r.top >= clip.bottom) return false;
        }
      }
      return true;
    };
    const controls = [...document.querySelectorAll(".phone button, .phone summary, .phone select, .phone input:not([type=hidden]), .phone a[href], .phone [role=button]")].filter(visible);
    const sheets = [...document.querySelectorAll(".phone-build-sheet, .p-events-sheet")].map(e => e.getBoundingClientRect());
    const transport = document.querySelector(".phone-player .pl-bar")?.getBoundingClientRect();
    const rects = controls.map(e => e.getBoundingClientRect());
    const overlaps: string[] = [];
    const tag = (e: Element) => e.tagName + "." + e.getAttribute("class") + (e.getAttribute("data-testid") ? "#" + e.getAttribute("data-testid") : "");
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      if (controls[i]!.contains(controls[j]!) || controls[j]!.contains(controls[i]!)) continue;
      const a = rects[i]!, b = rects[j]!;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(tag(controls[i]!) + " / " + tag(controls[j]!));
    }
    const smallText = [...document.querySelectorAll(".phone *")].filter(e =>
      visible(e) && [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) &&
      parseFloat(getComputedStyle(e).fontSize) < 12).map(e => tag(e) + " in " + tag(e.parentElement!));
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      smallControls: controls.filter(e => { const r = e.getBoundingClientRect(); return r.width < 43.9 || r.height < 43.9; }).map(tag),
      overlaps, smallText,
      sheetOverTransport: !!transport && sheets.some(sheet => sheet.bottom > transport.top + 1),
      mapHeight: document.querySelector(".p-map")?.getBoundingClientRect().height ?? 0,
      // Everything scrolls clear of the fixed transport: the page's end is padded by its height.
      transportHeight: transport?.height ?? 0,
      scrubShare: transport ? (document.querySelector(".phone-player .match-range")?.getBoundingClientRect().width ?? 0) / innerWidth : 1,
      reserve: transport ? parseFloat(getComputedStyle(document.querySelector(".phone-player")!).paddingBottom) - transport.height : 0,
      height: innerHeight,
    };
  });
  expect(report.sheetOverTransport).toBe(false);
  expect(report.overflow).toBe(false);
  expect(report.reserve).toBeGreaterThanOrEqual(-1);
  // A two-row transport, the scrubber most of the width.
  expect(report.transportHeight).toBeLessThanOrEqual(120);
  expect(report.scrubShare).toBeGreaterThanOrEqual(.6);
  expect(report.smallControls).toEqual([]);
  expect(report.overlaps).toEqual([]);
  expect(report.smallText).toEqual([]);
  expect(report.mapHeight).toBeGreaterThanOrEqual(report.height / 2);
}

/** Real touch input (including pointer capture), not mouse drag on a mobile viewport. One CDP
 * session per page: detaching it right after the gesture leaves Chrome's next tap without a click. */
const sessions = new WeakMap<Page, Promise<import("@playwright/test").CDPSession>>();
export async function touchDrag(page: Page, points: Array<{ x: number; y: number }>) {
  if (!sessions.has(page)) sessions.set(page, page.context().newCDPSession(page));
  const session = await sessions.get(page)!;
  await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]!] });
  for (const point of points.slice(1)) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
  // Rest the finger before lifting it: a lift at speed is a fling, and the next tap only stops it.
  await new Promise((ok) => setTimeout(ok, 150));
  await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [points.at(-1)!] });
  await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

export async function touchMapGesture(page: Page, path: Array<[number, number]>) {
  await page.getByTestId("map").scrollIntoViewIfNeeded();
  const map = (await page.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  await touchDrag(page, path.map(([x, y]) => ({ x: map.x + x * map.width, y: map.y + y * map.height })));
}
