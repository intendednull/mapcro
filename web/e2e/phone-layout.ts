import { expect, type Page } from "./fixtures";

/** Geometry only: never return DOM text, titles or player names. */
export async function checkPhoneLayout(page: Page) {
  const report = await page.evaluate(() => {
    const SEL = ".phone button, .phone summary, .phone select, .phone input:not([type=hidden]), .phone a[href], .phone [role=button]";
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !e.closest("[hidden]") &&
        e.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true });
    };
    /** Inside a scroller of its own (a sheet's body, the tool rail): it may scroll out of view. */
    const scrolls = (e: Element) => {
      for (let q = e.parentElement; q && !q.classList.contains("phone"); q = q.parentElement)
        if (/auto|scroll|hidden|clip/.test(getComputedStyle(q).overflowY + getComputedStyle(q).overflowX)) return true;
      return false;
    };
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      if (!shown(e) || r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) return false;
      // Content under a sheet or an open menu is out of reach, not overlapped.
      for (const cover of document.querySelectorAll(".phone-build-sheet, .p-sheet, .map-layers[open] .map-layers-pop")) {
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
    const tag = (e: Element) => e.tagName + "." + e.getAttribute("class") + (e.getAttribute("data-testid") ? "#" + e.getAttribute("data-testid") : "");
    const all = [...document.querySelectorAll(SEL)];
    const controls = all.filter(visible);
    /** What shows of a control: its box cut by every scroller round it. */
    const clipped = (e: Element) => {
      const r = e.getBoundingClientRect();
      let { left, top, right, bottom } = r;
      for (let q = e.parentElement; q; q = q.parentElement) {
        const st = getComputedStyle(q);
        if (!/auto|scroll|hidden|clip/.test(st.overflowY + st.overflowX)) continue;
        const c = q.getBoundingClientRect();
        left = Math.max(left, c.left); top = Math.max(top, c.top); right = Math.min(right, c.right); bottom = Math.min(bottom, c.bottom);
      }
      return { left, top, right, bottom };
    };
    const rects = controls.map(clipped);
    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      if (controls[i]!.contains(controls[j]!) || controls[j]!.contains(controls[i]!)) continue;
      const a = rects[i]!, b = rects[j]!;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(tag(controls[i]!) + " / " + tag(controls[j]!));
    }
    const smallText = [...document.querySelectorAll(".phone *")].filter(e =>
      visible(e) && [...e.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) &&
      parseFloat(getComputedStyle(e).fontSize) < 12).map(e => tag(e) + " in " + tag(e.parentElement!));
    const shell = !!document.querySelector(".phone.phone-player");
    const transport = document.querySelector(".phone-player .pl-bar")?.getBoundingClientRect();
    const roster = document.querySelector(".phone-player .phone-roster")?.getBoundingClientRect();
    const pane = document.querySelector(".p-map")!.getBoundingClientRect();
    const art = document.querySelector(".p-map .mm-rot")?.getBoundingClientRect() ?? pane;
    const sheets = [...document.querySelectorAll(".phone-build-sheet, .p-sheet")].map(e => e.getBoundingClientRect());
    const r1 = (v: number) => Math.round(v);
    return {
      shell, landscape: innerWidth > innerHeight, width: innerWidth, height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
      pageScroll: shell && document.documentElement.scrollHeight > innerHeight,
      // Every control of the shell is on screen (Feedback was clipped off the right edge).
      offscreen: shell ? all.filter(e => shown(e) && !scrolls(e)).filter(e => { const r = e.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; }).map(tag) : [],
      smallControls: controls.filter(e => { const r = e.getBoundingClientRect(); return r.width < 43.9 || r.height < 43.9; }).map(tag),
      overlaps, smallText,
      // The pane is full-bleed; the art inside it (inset by the map's frame) is what must be square.
      map: { w: r1(pane.width), h: r1(pane.height), top: r1(pane.top), right: r1(pane.right), artW: r1(art.width), artH: r1(art.height) },
      transport: transport && { h: r1(transport.height), top: r1(transport.top) },
      rosterBottom: roster ? r1(roster.bottom) : 0, rosterLeft: roster ? r1(roster.left) : 0,
      sheets: sheets.map(r => ({ left: r1(r.left), right: r1(r.right), top: r1(r.top), bottom: r1(r.bottom) })),
      portraits: [...document.querySelectorAll(".phone-player .phone-roster .tb-player")].map(e => { const r = e.getBoundingClientRect(); return { top: r1(r.top), w: r.width }; }),
      play: (() => { const b = document.querySelector(".phone-player [data-testid=match-play]"); return !!b && visible(b); })(),
      scrubShare: transport ? (document.querySelector(".phone-player .match-range")?.getBoundingClientRect().width ?? 0) / innerWidth : 1,
    };
  });
  expect(report.overflow).toBe(false);
  expect(report.smallControls).toEqual([]);
  expect(report.overlaps).toEqual([]);
  expect(report.smallText).toEqual([]);
  if (!report.shell) {
    // The board (not Player) still scrolls: the map is at least half the height.
    expect(report.map.h).toBeGreaterThanOrEqual(report.height / 2);
    return;
  }
  expect(report.pageScroll).toBe(false);
  expect(report.offscreen).toEqual([]);
  // A square map, never stretched: full width in portrait, the full height over the transport
  // in landscape.
  expect(Math.abs(report.map.artW - report.map.artH)).toBeLessThanOrEqual(1);
  expect(Math.abs(report.map.w - report.map.h)).toBeLessThanOrEqual(1);
  const t = report.transport!;
  // A tablet: the shell's other side over 500 px (tablet direction).
  const tablet = Math.min(report.width, report.height) > 500;
  expect(report.portraits.length).toBe(12);
  expect(report.play).toBe(true);
  if (report.landscape) {
    expect(t.h).toBeLessThanOrEqual(60);
    expect(report.map.h).toBeGreaterThanOrEqual(report.height - (tablet ? 64 : 60));
    expect(report.rosterLeft).toBeGreaterThanOrEqual(report.map.right - 1);
    if (tablet) {
      expect(report.width - report.map.right).toBeGreaterThanOrEqual(300);
      expect(report.scrubShare).toBeGreaterThanOrEqual(.4);
    }
  } else if (tablet) {
    // Tablet portrait: the roster is one row of 12; sheets take at most half the height.
    expect(t.h).toBeLessThanOrEqual(104);
    expect(new Set(report.portraits.map(q => q.top)).size).toBe(1);
    for (const q of report.portraits) expect(q.w).toBeGreaterThanOrEqual(44);
    for (const sh of report.sheets) expect(sh.bottom - sh.top).toBeLessThanOrEqual(report.height / 2 + 1);
    if (report.height - t.h - report.rosterBottom >= report.width) expect(report.map.w).toBeGreaterThanOrEqual(report.width - 1);
  } else {
    expect(t.h).toBeLessThanOrEqual(104);
    expect(report.scrubShare).toBeGreaterThanOrEqual(.6);
    if (report.height - t.h - report.rosterBottom >= report.width) expect(report.map.w).toBeGreaterThanOrEqual(report.width - 1);
    if (report.width >= 390) expect(report.map.top).toBeLessThanOrEqual(140);
  }
  // Sheets: edge to edge (landscape: the right pane), on the transport, below the roster.
  for (const sh of report.sheets) {
    expect(Math.abs(sh.bottom - t.top)).toBeLessThanOrEqual(1);
    expect(sh.top).toBeGreaterThanOrEqual(report.rosterBottom - 1);
    expect(sh.right).toBe(report.width);
    expect(sh.left).toBe(report.landscape ? report.map.right : 0);
  }
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
