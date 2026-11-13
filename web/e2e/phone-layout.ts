import { expect, type Page } from "./fixtures";

/** Geometry only: never return DOM text, titles or player names. */
export async function checkPhoneLayout(page: Page) {
  const report = await page.evaluate(() => {
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0 || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth || e.closest("[hidden]")) return false;
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
    const sheet = document.querySelector(".phone-build-sheet")?.getBoundingClientRect();
    const transport = document.querySelector(".phone-player .pl-bar")?.getBoundingClientRect();
    const rects = controls.map(e => e.getBoundingClientRect());
    const overlaps: string[] = [];
    const tag = (e: Element) => e.tagName + "." + e.getAttribute("class");
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      if (controls[i]!.contains(controls[j]!) || controls[j]!.contains(controls[i]!)) continue;
      const a = rects[i]!, b = rects[j]!;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(tag(controls[i]!) + " / " + tag(controls[j]!));
    }
    const smallText = [...document.querySelectorAll(".phone *")].filter(e =>
      visible(e) && [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) &&
      parseFloat(getComputedStyle(e).fontSize) < 12).map(tag);
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      smallControls: controls.filter(e => { const r = e.getBoundingClientRect(); return r.width < 43.9 || r.height < 43.9; }).map(tag),
      overlaps, smallText,
      sheetOverTransport: !!sheet && !!transport && sheet.bottom > transport.top,
      mapHeight: document.querySelector(".p-map")?.getBoundingClientRect().height ?? 0,
      height: innerHeight,
    };
  });
  expect(report.sheetOverTransport).toBe(false);
  expect(report.overflow).toBe(false);
  expect(report.smallControls).toEqual([]);
  expect(report.overlaps).toEqual([]);
  expect(report.smallText).toEqual([]);
  expect(report.mapHeight).toBeGreaterThanOrEqual(report.height / 2);
}

/** Real touch input (including pointer capture), not mouse drag on a mobile viewport. */
export async function touchDrag(page: Page, points: Array<{ x: number; y: number }>) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [points[0]!] });
    for (const point of points.slice(1)) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}

export async function touchMapGesture(page: Page, path: Array<[number, number]>) {
  await page.getByTestId("map").scrollIntoViewIfNeeded();
  const map = (await page.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  await touchDrag(page, path.map(([x, y]) => ({ x: map.x + x * map.width, y: map.y + y * map.height })));
}
