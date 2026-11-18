// Synthetic replay and tooltip assets; no game art or player identities.
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

import { pack, timeline, INFUSER, ABILITY, EXTRA_ITEM } from "./tooltip-fixture";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-tooltips-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  writeFileSync(join(queue, "feedback-token"), "synthetic-test-only", { mode: 0o600 });
  // The viewport matrix creates about 40 boards; leave headroom above the production cap of 30.
  server = new Server(pack({ cards: true, items: 12 }), { CREATE_PER_HOUR: "60", FEEDBACK_GITHUB_TOKEN_FILE: join(queue, "feedback-token"), FEEDBACK_GITHUB_API: `http://127.0.0.1:${port}`, MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "60" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const answered = new Set<string>();
async function open(p: Page, id: string) {
  await p.getByTestId("mode-player").click();
  if (await p.locator(".phone-player").count()) {
    // The phone: the match source is in More.
    await p.getByTestId("phone-more").tap();
    await p.getByTestId("phone-match").tap();
  } else await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  // Landscape: the source sheet keeps to the map's side, clear of the dock (which covered Load).
  const vp = p.viewportSize()!;
  if (vp.width > vp.height && await p.locator(".phone-player").count()) {
    const sheet = (await p.locator(".pl-source[open]").boundingBox())!, map = (await p.locator(".p-map-wrap").boundingBox())!;
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(map.x + map.width + 1);
    for (const id of ["match-id", "match-load"]) {
      const b = (await p.getByTestId(id).boundingBox())!;
      expect(b.x + b.width, id).toBeLessThanOrEqual(sheet.x + sheet.width);
    }
  }
  // The whole id shows in its field (it was cut at seven digits on a phone).
  expect(await p.getByTestId("match-id").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
  const tl = timeline(id);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify({
    ...tl,
    // Sapphire 5 holds a late game's twelve items; the rest keep their one.
    players: tl.players.map((q) => (q.team === "sapphire" && q.slot === 5 ? { ...q, items: Array.from({ length: 12 }, (_, i) => [50, EXTRA_ITEM + i, 0]), casts: [] } : q)),
    // Several events, so the Events sheet's density can be judged.
    events: [30, 32, 34, 36, 38, 39].map((t, i) => ({ t, kind: "death", team: i % 2 ? "sapphire" : "amber", slot: i ? 2 + (i % 3) : 1, hero_id: i ? 3 + (i % 3) : 2, x: -2500, y: -3000 })),
    troopers: { every_s: 1, amber: Array(41).fill(Buffer.from([1, 0, 0, 0, 0, 0]).toString("base64")), sapphire: Array(41).fill("") },
  }));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

const column = (p: Page) => p.locator(".phone-build-sheet [data-testid=hero-build]");
const float = (p: Page) => p.getByTestId("game-tooltip-float");

/** The build sheet: a title row (hero, ×), then items, abilities, stats; items and all four
 *  abilities in view without scrolling. Geometry and counts only. */
async function checkBuildSheet(p: Page) {
  const sheet = p.locator(".phone-build-sheet");
  const head = sheet.locator(".p-sheet-head");
  const vp0 = p.viewportSize()!;
  const wide = vp0.width > vp0.height;
  await expect(head.locator("b")).toHaveText("Testhero 1");
  const box = async (sel: string) => (await sheet.locator(sel).first().boundingBox())!;
  let h: { y: number; height: number };
  if (wide) {
    // Landscape: the dock's tab row is the sheet's head (Events closes the build).
    await expect(head).toBeHidden();
    h = (await p.locator(".p-dock-tabs").boundingBox())!;
  } else {
    await expect(head.getByRole("button", { name: "Close" })).toBeVisible();
    h = await box(".p-sheet-head");
  }
  expect(h.height).toBeLessThanOrEqual(52);
  const items = await box(".tb-build-items");
  const abilities = await box(".tb-build-abilities");
  const stats = await box(".tb-build-investment");
  expect(items.y).toBeGreaterThanOrEqual(h.y + h.height - 1);
  expect(abilities.y).toBeGreaterThanOrEqual(items.y + items.height - 1);
  expect(stats.y).toBeGreaterThanOrEqual(abilities.y + abilities.height - 1);
  const view = (await sheet.boundingBox())!;
  const inView = (r: { y: number; height: number }) => r.y >= view.y - 1 && r.y + r.height <= view.y + view.height + 1;
  expect(inView((await box(".tb-build-item")))).toBe(true);
  const abs = sheet.locator(".tb-build-ability");
  await expect(abs).toHaveCount(4);
  for (let i = 0; i < 4; i++) expect(inView((await abs.nth(i).boundingBox())!)).toBe(true);
  // Compact in portrait: at most ~320 px, so at least 70% of the map shows above it.
  const vp = p.viewportSize()!;
  await p.screenshot({ path: `/tmp/mapcro-build-sheet-${vp.width}-${vp.height}.png` });
  if (vp.width < vp.height && vp.width < 500) {
    expect(view.height).toBeLessThanOrEqual(320);
    if (vp.height >= 844) expect(view.y).toBeGreaterThanOrEqual(420);
  }
  // Close (landscape: Events) shuts the sheet; the portrait opens it again.
  await (wide ? p.getByTestId("dock-events") : head.getByRole("button", { name: "Close" })).tap();
  await expect(sheet).toHaveCount(0);
  await p.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').tap();
  await expect(sheet).toHaveCount(1);
}

/** A late game's build (Sapphire 5: twelve items) shows every item and all four abilities in the
 *  sheet without scrolling: at 615 × 344 the dock had 65 px, the items alone. Then back to Amber 0. */
async function checkFullBuild(p: Page) {
  await p.locator('.tb-player[data-slot="Sapphire-5"] [data-testid=focus-hero]').tap();
  const sheet = p.locator(".phone-build-sheet");
  await expect(sheet.locator(".tb-build-item")).toHaveCount(12);
  await expect(sheet.locator(".tb-build-ability")).toHaveCount(4);
  const cut = await sheet.evaluate((el) => {
    const view = el.getBoundingClientRect();
    return [...el.querySelectorAll(".tb-build-item, .tb-build-ability")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width < 43.9 || r.height < 43.9 || r.top < view.top - 1 || r.bottom > view.bottom + 1 || r.left < view.left - 1 || r.right > view.right + 1;
    }).length;
  });
  expect(cut).toBe(0);
  await checkPhoneLayout(p);
  await p.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').tap();
  await expect(sheet.locator(".tb-build-item")).toHaveCount(1);
}

/** The roster reads like the HUD's bar: souls under each portrait, the team totals, and the
 *  dead greyed with their respawn seconds; cells stay 44 × 44. Counts and numbers only. */
async function checkRoster(p: Page) {
  const roster = p.locator(".phone-roster");
  const souls = roster.getByTestId("souls");
  await expect(souls).toHaveCount(12);
  for (let i = 0; i < 12; i++) {
    await expect(souls.nth(i)).toHaveAttribute("data-souls", "500");
    await expect(souls.nth(i)).toBeVisible();
    expect(parseFloat(await souls.nth(i).evaluate((e) => getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(12);
  }
  await checkRosterArt(p);
  const totals = roster.getByTestId("team-souls");
  await expect(totals).toHaveCount(2);
  for (let i = 0; i < 2; i++) await expect(totals.nth(i)).toHaveAttribute("data-souls", "3000");
  const cell = roster.locator('.tb-player[data-slot="Amber-1"]');
  await expect(cell).not.toHaveClass(/\bdead\b/);
  await scrubTo(p, 32);
  await expect(cell).toHaveClass(/\bdead\b/);
  await expect(cell.getByTestId("tb-respawn")).toHaveAttribute("data-respawn", "3");
  await expect(cell.getByTestId("tb-respawn")).toBeVisible();
  const cells = roster.locator(".phone-team .tb-player");
  await expect(cells).toHaveCount(12);
  for (let i = 0; i < 12; i++) {
    const b = (await cells.nth(i).boundingBox())!;
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(43.9);   // 43.99999 at a fractional pixel ratio
  }
  await checkPhoneLayout(p);
  await scrubTo(p, 20);
  await expect(cell).not.toHaveClass(/\bdead\b/);
}

/** Each cell shows its hero: the pack's card, drawn (not `display: none`: the roster once missed
 *  the pack's art rule and showed twelve empty boxes) with the head over the souls; a hero the
 *  pack doesn't have keeps its letters, clear of the souls. Geometry and styles only. */
async function checkRosterArt(p: Page) {
  const cells = await p.locator(".phone-roster").evaluate((root) => [...root.querySelectorAll(".phone-team .tb-player")].map((c) => {
    const cell = c.getBoundingClientRect(), souls = c.querySelector(".phone-souls")!.getBoundingClientRect();
    const img = c.querySelector(".tb-img"), disc = c.querySelector(".tb-disc")!;
    const range = document.createRange();
    range.selectNodeContents(disc);
    const letters = range.getBoundingClientRect();
    const st = img && getComputedStyle(img), ir = img?.getBoundingClientRect();
    return {
      art: !!st && st.display !== "none" && st.backgroundImage !== "none" && st.maskImage !== "none",
      // What shows of the art in the cell, over the souls.
      artH: ir ? Math.min(ir.bottom, souls.top) - Math.max(ir.top, cell.top) : 0,
      artW: ir ? Math.min(ir.right, cell.right) - Math.max(ir.left, cell.left) : 0,
      letters: letters.width > 0 && getComputedStyle(disc).color !== "rgba(0, 0, 0, 0)",
      lettersClear: letters.top >= cell.top - .5 && letters.bottom <= souls.top + .5 && letters.left >= cell.left - .5 && letters.right <= cell.right + .5,
    };
  }));
  expect(cells.length).toBe(12);
  // Heroes 1 to 5 have cards; the sixth of each team is not in the pack.
  expect(cells.filter((c) => c.art).length).toBe(10);
  for (const c of cells) {
    if (c.art) {
      expect(c.artH).toBeGreaterThanOrEqual(28);
      expect(c.artW).toBeGreaterThanOrEqual(40);
      expect(c.letters).toBe(false);
    } else expect(c).toMatchObject({ letters: true, lettersClear: true });
  }
}

/** Events: search, lead and chips in one row of at most 48 px; at least four events in view;
 *  the current one marked for assistive tech; the source credit not in the sheet. */
async function checkEvents(p: Page) {
  const side = p.getByTestId("player-side");
  await p.screenshot({ path: `/tmp/mapcro-events-${p.viewportSize()!.width}-${p.viewportSize()!.height}.png` });
  const head = (await side.locator(".pl-events-head").boundingBox())!;
  const chips = (await side.locator(".pl-chips").boundingBox())!;
  const top = Math.min(head.y, chips.y), bottom = Math.max(head.y + head.height, chips.y + chips.height);
  expect(bottom - top).toBeLessThanOrEqual(48);
  const list = (await side.locator(".pl-list").boundingBox())!;
  // What shows: the sheet's scroller cuts the list (615 × 344 showed one row of it).
  const body = p.locator("[data-testid=phone-events-sheet] .p-sheet-body");
  const pane = (await body.boundingBox())!;
  const vp = p.viewportSize()!;
  // A short phone in landscape: the search row scrolls away with the list, for the rows' sake.
  const short = vp.width > vp.height && vp.height <= 400;
  const rows = side.getByTestId("event");
  await expect(rows).toHaveCount(6);
  const count = async () => {
    const floor = Math.min(list.y + list.height, pane.y + pane.height);
    let n = 0;
    for (let i = 0; i < 6; i++) { const r = (await rows.nth(i).boundingBox())!; if (r.y >= Math.max(list.y, pane.y) - 1 && r.y + r.height <= floor + 1) n++; }
    return n;
  };
  if (short) {
    await body.evaluate((e) => e.scrollTo(0, 0));
    expect(await count()).toBeGreaterThanOrEqual(1);
    await expect(side.locator('[data-testid=event][aria-current="true"]')).toHaveAttribute("data-t", "30");
    await side.locator('[data-testid=event][aria-current="true"]').evaluate((e) => e.scrollIntoView({ block: "start" }));
    list.y = (await side.locator(".pl-list").boundingBox())!.y;
    expect(await count()).toBeGreaterThanOrEqual(3);
    await expect(side.getByTestId("match-credit")).toBeHidden();
    await body.evaluate((e) => e.scrollTo(0, 0));
    return;
  }
  expect(await count()).toBeGreaterThanOrEqual(4);
  await expect(side.locator('[data-testid=event][aria-current="true"]')).toHaveAttribute("data-t", "30");
  await expect(side.getByTestId("match-credit")).toBeHidden();
  // The search and chips stay at the sheet's head however far the list is scrolled (it opens at
  // the current event, which late in a match left them thousands of px above).
  const now = (await side.locator('[data-testid=event][aria-current="true"]').boundingBox())!;
  expect(now.y).toBeGreaterThanOrEqual(bottom - 1);
  await body.evaluate((e) => e.scrollTo(0, e.scrollHeight));
  const view = (await body.boundingBox())!;
  for (const sel of [".pl-events-head", ".pl-chips"]) {
    const r = (await side.locator(sel).boundingBox())!;
    expect(r.y, sel).toBeGreaterThanOrEqual(view.y - 1);
    expect(r.y + r.height, sel).toBeLessThanOrEqual(view.y + 49);
  }
  await body.evaluate((e) => e.scrollTo(0, 0));
}

/** Landscape's dock: Events, Build and Scenes tabs (and All builds on a tablet) in one row; a
 *  portrait tap selects Build; the roster block is two rows, at most 96 px. */
async function checkDock(p: Page) {
  const vp = p.viewportSize()!;
  const tab = (id: string) => p.getByTestId(`dock-${id}`);
  await p.screenshot({ path: `/tmp/mapcro-dock-${vp.width}-${vp.height}.png` });
  for (const id of ["events", "build", "scenes"]) {
    await expect(tab(id)).toBeVisible();
    expect((await tab(id).boundingBox())!.height, id).toBeGreaterThanOrEqual(43.9);
  }
  await expect(tab("build")).toHaveAttribute("aria-selected", "true");
  await expect(tab("events")).toHaveAttribute("aria-selected", "false");
  if (Math.min(vp.width, vp.height) > 500) {
    await expect(tab("all-builds")).toBeVisible();
    await expect(p.getByTestId("phone-all-builds")).toBeHidden();
  }
  // A pane too narrow for the totals' column (a 4:3 tablet) heads each row with its total.
  const roster = (await p.locator(".phone-roster").boundingBox())!;
  // A narrow phone turned tightens the cells, so the totals keep their column from 312 px.
  expect(roster.height).toBeLessThanOrEqual(roster.width >= (vp.height <= 500 && vp.width <= 700 ? 312 : 320) ? 96 : 132);
  await tab("events").tap();
  await expect(tab("events")).toHaveAttribute("aria-selected", "true");
  await expect(p.locator(".phone-build-sheet")).toHaveCount(0);
  await expect(p.getByTestId("player-side")).toBeVisible();
  await tab("build").tap();
  await expect(p.locator(".phone-build-sheet")).toHaveCount(1);
  await expect(tab("build")).toHaveAttribute("aria-selected", "true");
  await checkPhoneLayout(p);
}

import { checkPhoneLayout, hasCdp, phoneContext, touchDrag } from "./phone-layout";

// 344 × 615 is the operator's phone (a 1440 × 3120 screen at display zoom, the browser's bars
// taken off): narrower and shorter than the rest.
// Turned, it is 615 × 344: with 667 × 375, the short landscape phones (the dock under the roster).
const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 800 }, { width: 390, height: 664 }, { width: 344, height: 615 }, { width: 844, height: 390 }, { width: 615, height: 344 }, { width: 667, height: 375 }];
const TABLETS = [{ width: 768, height: 1024 }, { width: 820, height: 1180 }, { width: 1024, height: 768 }, { width: 1180, height: 820 }, { width: 1366, height: 1024 }];
for (const viewport of [...PHONES, ...TABLETS]) {
  test(`phone Player at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const ctx = await phoneContext(browser, viewport);
    const phone = await ctx.newPage();
    await phone.goto(await newBoardUrl(server, "Phone Player"));
    await phone.locator("#join-name").fill("Coach");
    await phone.keyboard.press("Enter");
    await open(phone, String(129001000 + viewport.width));
    await scrubTo(phone, 20);
    await expect(phone.locator(".p-map .tok")).toHaveCount(12);
    // Landscape docks a panel beside the map, Events until a build is picked.
    if (viewport.width > viewport.height) await expect(phone.getByTestId("player-side")).toBeVisible();
    else await expect(phone.getByTestId("player-side")).toHaveCount(0);
    await expect(phone.getByTestId("trooper")).toHaveCount(1);
    await phone.screenshot({ path: `/tmp/mapcro-phone-${viewport.width}-${viewport.height}.png` });
    await checkPhoneLayout(phone);
    await checkRoster(phone);
    // The shell never scrolls: the scrubber takes a finger in every direction.
    await expect(phone.locator(".pl-scrub")).toHaveCSS("touch-action", "none");
    await phone.getByTestId("match-play").tap();
    await expect(phone.getByTestId("match-play")).toHaveText("Pause");
    await phone.getByTestId("match-play").tap();
    // A finger along the scrubber seeks: the far end is the match's last second. (CDP touch:
    // Chromium only.)
    if (hasCdp(browser)) {
      const range = (await phone.getByTestId("match-time").boundingBox())!;
      const y = range.y + range.height / 2;
      await touchDrag(phone, [{ x: range.x + range.width / 2, y }, { x: range.x + range.width * .8, y }, { x: range.x + range.width - 1, y }]);
      await expect(phone.getByTestId("match-clock")).toContainText("0:40 /");
    }
    await scrubTo(phone, 20);
    const mapBefore = await phone.locator(".p-map").boundingBox();
    await phone.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').tap();
    await expect(column(phone)).toBeVisible();
    // Landscape: the build docks beside the map, which keeps its rect and stays uncovered.
    if (viewport.width > viewport.height) expect(await phone.locator(".p-map").boundingBox()).toEqual(mapBefore);
    await checkPhoneLayout(phone);
    await checkBuildSheet(phone);
    await checkFullBuild(phone);
    if (viewport.width > viewport.height) await checkDock(phone);
    await column(phone).locator(`.tb-build-item[data-item-id="${INFUSER}"]`).tap();
    await expect(float(phone)).toBeVisible();
    await column(phone).locator(`[data-ability-id="${ABILITY}"]`).tap();
    await expect(float(phone).getByTestId("game-tooltip")).toHaveAttribute("data-kind", "ability");
    // The tooltip is clamped between the roster and the transport.
    const tip = (await float(phone).boundingBox())!;
    const roster = (await phone.locator(".phone-roster").boundingBox())!;
    const bar = (await phone.getByTestId("player").boundingBox())!;
    expect(tip.y).toBeGreaterThanOrEqual(roster.y + roster.height - 1);
    expect(tip.y + tip.height).toBeLessThanOrEqual(bar.y + 1);
    expect(tip.x).toBeGreaterThanOrEqual(0);
    expect(tip.x + tip.width).toBeLessThanOrEqual(viewport.width + 1);
    // A tablet's All builds (Tab's stand-in): twelve rows; a row opens that hero's build.
    if (Math.min(viewport.width, viewport.height) > 500) {
      await expect(phone.getByText("Hold Tab")).toHaveCount(0);
      // Portrait: at the roster's end; landscape: in the dock's tab row.
      const all = phone.locator("[data-testid=phone-all-builds]:visible, [data-testid=dock-all-builds]:visible");
      await expect(all).toHaveCount(1);
      const b = (await all.boundingBox())!;
      expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(43.9);
      await all.tap();
      await expect(all).toHaveAttribute("aria-pressed", "true");
      await expect(phone.locator(".phone-build-sheet .p-sheet-head b")).toHaveText("All builds");
      await expect(phone.getByTestId("all-builds-row")).toHaveCount(12);
      // One header row names the columns, in the scoreboard's words.
      const heads = phone.getByTestId("all-builds-head");
      await expect(heads).toHaveCount(1);
      await expect(heads).toBeVisible();
      await expect(heads.locator("span")).toHaveText(["", "K / D / A", "Souls", ""]);
      // Every item shows in its row, wrapped where the row is narrow: twelve for Sapphire 5, one
      // for the rest (a tablet in landscape showed three and clipped the others).
      const icons = await phone.getByTestId("all-builds-list").evaluate((list) => {
        const view = list.getBoundingClientRect();
        return [...list.querySelectorAll("[data-testid=all-builds-row]")].map((row) => {
          const box = row.getBoundingClientRect(), cell = row.querySelector(".phone-row-items")!.getBoundingClientRect();
          const imgs = [...row.querySelectorAll(".phone-row-items img")].map((e) => e.getBoundingClientRect());
          const inside = (r: DOMRect, o: DOMRect) => r.left >= o.left - 1 && r.right <= o.right + 1 && r.top >= o.top - 1 && r.bottom <= o.bottom + 1;
          return { n: imgs.length, shown: imgs.filter((r) => r.width >= 24 && inside(r, cell) && inside(r, box) && r.left >= view.left - 1 && r.right <= view.right + 1).length, lines: new Set(imgs.map((r) => Math.round(r.top))).size, h: Math.round(box.height) };
        });
      });
      expect(icons.map((r) => r.n)).toEqual([...Array(11).fill(1), 12]);
      expect(icons.map((r) => r.shown)).toEqual(icons.map((r) => r.n));
      for (const r of icons) expect(r.h).toBeGreaterThanOrEqual(48);
      await checkPhoneLayout(phone);
      // A row's items are the build at this moment: at 8 s Test Lifesteal, by 20 s the Infuser
      // it became at 12 s (TD-97).
      const items = () => phone.getByTestId("all-builds-row").first().locator(".phone-row-items img").evaluateAll((imgs) => imgs.map((i) => i.getAttribute("src")));
      const now = await items();
      expect(now).toHaveLength(1);
      await scrubTo(phone, 8);
      await expect.poll(items).not.toEqual(now);
      expect(await items()).toHaveLength(1);
      await scrubTo(phone, 20);
      await expect.poll(items).toEqual(now);
      await phone.getByTestId("all-builds-row").first().tap();
      await expect(phone.getByTestId("all-builds-list")).toHaveCount(0);
      await expect(column(phone)).toHaveCount(1);
      await expect(all).toHaveAttribute("aria-pressed", "false");
    } else await expect(phone.getByTestId("phone-all-builds")).toBeHidden();
    // One sheet at a time: a second portrait swaps the hero in place; Events replaces the build.
    await phone.locator('.tb-player[data-slot="Sapphire-0"] [data-testid=focus-hero]').tap();
    await expect(phone.locator(".phone-build-sheet")).toHaveCount(1);
    await expect(phone.locator('.tb-player[data-slot="Sapphire-0"] [data-testid=focus-hero]')).toHaveAttribute("aria-expanded", "true");
    await phone.getByTestId("phone-events").tap();
    await expect(phone.locator(".phone-build-sheet")).toHaveCount(0);
    await expect(phone.getByTestId("player-side")).toBeVisible();
    await phone.getByTestId("events-lead").fill("0");
    await phone.getByTestId("event-jump").first().tap();
    await expect(phone.getByTestId("match-clock")).toContainText("0:30 /");
    await checkPhoneLayout(phone);
    await checkEvents(phone);
    await phone.getByTestId(viewport.width > viewport.height ? "dock-events" : "p-sheet-close").tap();
    // Landscape's dock falls back to Events, with no close of its own.
    if (viewport.width > viewport.height) {
      await expect(phone.getByTestId("player-side")).toBeVisible();
      await expect(phone.getByTestId("p-sheet-close")).toHaveCount(0);
    } else await expect(phone.getByTestId("player-side")).toHaveCount(0);
    // Map layers and Vision: a sheet from the transport.
    await phone.getByTestId("phone-layers").tap();
    await expect(phone.getByTestId("vision-select")).toBeVisible();
    await phone.getByTestId("vision-select").selectOption("amber");
    await expect(phone.getByTestId("vision-mark")).toHaveAttribute("data-team", "amber");
    await phone.getByTestId("troopers-toggle").tap();
    await expect(phone.getByTestId("trooper")).toHaveCount(0);
    await phone.getByTestId("troopers-toggle").tap();
    await expect(phone.getByTestId("trooper")).toHaveCount(1);
    await checkPhoneLayout(phone);
    // Edit in More swaps transport row 2 for the tool rail; Done brings row 2 back, and Look.
    const barH = async () => (await phone.getByTestId("player").boundingBox())!.height;
    const before = await barH();
    await phone.getByTestId("phone-more").tap();
    await phone.getByTestId("phone-edit").tap();
    await expect(phone.getByTestId("tool-draw")).toBeVisible();
    await expect(phone.getByTestId("phone-events")).toHaveCount(0);
    // Done and the ink swatch are pinned: fully on screen without scrolling the rail.
    for (const id of ["phone-done", "palette"]) {
      const r = (await phone.locator(`.p-rail [data-testid=${id}]`).boundingBox())!;
      expect(r.x, id).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, id).toBeLessThanOrEqual(viewport.width);
      expect(r.y + r.height, id).toBeLessThanOrEqual(viewport.height);
    }
    expect(Math.abs(await barH() - before)).toBeLessThanOrEqual(1);
    await checkPhoneLayout(phone);
    await phone.getByTestId("phone-done").tap();
    await expect(phone.getByTestId("phone-events")).toBeVisible();
    await expect(phone.getByTestId("tool-draw")).toHaveCount(0);
    // More: Feedback, Scenes, Laser and Edit.
    await phone.getByTestId("phone-more").tap();
    await expect(phone.getByTestId("phone-layers-sheet")).toHaveCount(0);
    await checkPhoneLayout(phone);
    await phone.getByTestId("feedback-open").tap();
    await expect(phone.getByTestId("feedback-title")).toBeVisible();
  });
}

// Other common sizes, both ways up, at a phone's pixel ratio: the layout only. The synthetic match
// is 40 s long, so the clock is also checked holding what a real match puts in it.
const SIZES = [{ width: 320, height: 568 }, { width: 360, height: 640 }, { width: 360, height: 780 }, { width: 375, height: 667 }, { width: 412, height: 915 }, { width: 430, height: 932 }, { width: 932, height: 430 }];
for (const viewport of SIZES) {
  test(`phone Player layout at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const ctx = await phoneContext(browser, viewport, { deviceScaleFactor: 3 });
    const phone = await ctx.newPage();
    await phone.goto(await newBoardUrl(server, "Phone sizes"));
    await phone.locator("#join-name").fill("Coach");
    await phone.keyboard.press("Enter");
    await open(phone, String(129002000 + viewport.width + viewport.height));
    await scrubTo(phone, 20);
    await checkPhoneLayout(phone);
    await checkRosterArt(phone);
    const wide = viewport.width > viewport.height;
    for (const id of ["phone-events", "phone-layers", "phone-more"]) {
      await phone.getByTestId(id).tap();
      await expect(phone.getByTestId(id)).toHaveAttribute("aria-expanded", "true");
      await checkPhoneLayout(phone);
    }
    await phone.locator('.tb-player[data-slot="Sapphire-5"] [data-testid=focus-hero]').tap();
    await expect(phone.locator(".phone-build-sheet")).toHaveCount(1);
    await checkPhoneLayout(phone);
    if (!wide) await phone.locator(".phone-build-sheet .p-build-close").tap();
    // Last (the text is the page's own from here): a long match's clock still fits its place.
    for (const [now, of] of [["59:59", " / 59:59"], ...(viewport.width >= 344 ? [["1:59:59", " / 1:59:59"]] : [])] as const) {
      await phone.getByTestId("match-clock").evaluate((el, [now, of]) => {
        el.querySelector(".clock-now")!.textContent = now;
        el.querySelector(".clock-of")!.textContent = of;
      }, [now, of] as const);
      await checkPhoneLayout(phone);
    }
  });
}

test("phone follows the presenter's replay time", async ({ browser }) => {
  const url = await newBoardUrl(server, "Phone follow");
  const lead = await joinNew(browser, url, "Coach");
  await open(lead, "129001999");
  const witness = await joinNew(browser, url, "Guest");
  await witness.getByTestId("follow-Coach").click();
  const ctx = await phoneContext(browser, { width: 390, height: 844 });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Viewer");
  await phone.keyboard.press("Enter");
  await phone.getByTestId("follow-presenter").tap();
  await scrubTo(lead, 20);
  await expect(phone.getByTestId("match-clock")).toContainText("0:20 /");
  await checkPhoneLayout(phone);
});

// Mouse-first screens keep the desktop layout, tablet-sized or not.
for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  test(`no touch at ${viewport.width}×${viewport.height} is the desktop layout`, async ({ browser }) => {
    // The Firefox project's pointer is coarse by pref, whatever the context.
    test.skip(!hasCdp(browser), "the Firefox project is touch-first throughout");
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(await newBoardUrl(server, "Desktop"));
    await page.locator("#join-name").fill("Coach");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("board")).toBeVisible();
    await expect(page.locator(".phone")).toHaveCount(0);
  });
}

// The transport's layout at each shell and tier (spec §6b): the keys mirrored around Play on the
// bar's centre line, every key its size, and nothing outside the bar or the stage.
const within1 = (a: number, b: number, what: string) => expect(Math.abs(a - b), what).toBeLessThanOrEqual(1);
const middle = (b: { x: number; width: number }) => b.x + b.width / 2;
for (const [width, height, touch] of [[1920, 1080, false], [1440, 900, false], [1280, 768, false], [1100, 768, false], [1024, 768, false], [900, 768, false], [820, 768, false], [800, 768, false], [760, 768, false], [720, 768, false], [1024, 768, true], [768, 1024, true], [600, 900, true], [344, 615, true], [360, 740, true], [390, 844, true], [412, 915, true], [844, 390, true], [615, 344, true]] as const) {
  test(`transport layout ${width}×${height}${touch ? " touch" : ""}`, async ({ browser }) => {
    const viewport = { width, height };
    const ctx = touch ? await phoneContext(browser, viewport) : await browser.newContext({ viewport });
    const p = await ctx.newPage();
    await p.goto(await newBoardUrl(server, "Transport"));
    await p.locator("#join-name").fill("Coach");
    await p.keyboard.press("Enter");
    await open(p, String(129002000 + width + height));
    await scrubTo(p, 20);
    const box = async (id: string) => (await p.getByTestId(id).boundingBox())!;
    const landscape = width > height;
    const upright = touch && !landscape && width <= 480;
    const skips = !touch || (landscape ? width >= 780 : width >= 600);

    const track = await box("match-time");
    expect(track.width).toBeGreaterThan(touch && landscape ? 130 : !touch && width < 800 ? 120 : !touch && width <= 820 ? 200 : 250);

    // Play on the bar's centre line; Back and Forward, and − and +, the same distance either side.
    const bar = await box("player");
    const centre = middle(await box("match-play"));
    within1(centre, middle(bar), "Play on the bar's centre");
    if (skips) within1(centre - middle(await box("match-back")), middle(await box("match-forward")) - centre, "Back and Forward");
    if (!upright) {
      within1(centre - middle(await box("speed-down")), middle(await box("speed-up")) - centre, "− and +");
      expect(middle(await box("speed-down"))).toBeLessThan(skips ? middle(await box("match-back")) : centre);
      await expect(p.getByTestId("speed-now")).toBeVisible();
      within1(middle(await box("speed-now")), centre, "the speed on the centre line");
    } else await expect(p.getByTestId("match-speed-list")).toBeVisible();

    // Touch keys are 44 px or more: Play, the speed, and Back and Forward where they show.
    if (touch) for (const id of ["match-play", upright ? "match-speed-list" : "speed-up", ...(upright ? [] : ["speed-down"]), ...(skips ? ["match-back", "match-forward"] : [])]) {
      const b = await box(id);
      expect(Math.min(b.width, b.height), id).toBeGreaterThanOrEqual(43.9);
    }
    if (!touch) {
      // Inside the bar and inside the stage: the bar runs under the side panels' edges.
      const stage = (await p.locator(".stage").boundingBox())!;
      for (const id of ["match-time", "match-play", "match-back", "match-forward", "speed-down", "speed-up", "match-speed", "match-clock", "match-save"]) {
        const b = await box(id);
        expect(b.x, id).toBeGreaterThanOrEqual(Math.max(bar.x, stage.x));
        expect(b.x + b.width, id).toBeLessThanOrEqual(Math.min(bar.x + bar.width, stage.x + stage.width));
        expect(b.y + b.height, id).toBeLessThanOrEqual(bar.y + bar.height);
      }
      // Desktop keys: Play 56 px, Back and Forward 44, − and + 40 (narrower docks scale them to fit).
      if (width >= 800) for (const [id, min] of [["match-play", 55.9], ["match-back", 43.9], ["match-forward", 43.9], ["speed-up", 39.9], ["speed-down", 39.9]] as const) {
        const b = await box(id);
        expect(Math.min(b.width, b.height), id).toBeGreaterThanOrEqual(min);
      }
      // The tools stay on the stage, and it never scrolls sideways (TD-121).
      const tools = await box("toolbar");
      expect(tools.x).toBeGreaterThanOrEqual(stage.x);
      expect(tools.x + tools.width).toBeLessThanOrEqual(stage.x + stage.width);
      await p.getByTestId("toolbar").locator("button").last().focus();
      expect(await p.locator(".stage").evaluate((e) => [e.scrollLeft, e.scrollWidth - e.clientWidth])).toEqual([0, 0]);
      // The source opens on screen, clear of the panels.
      await p.locator(".pl-source > summary").click();
      const pop = (await p.locator(".pl-source .pl-head").boundingBox())!;
      expect(pop.x).toBeGreaterThanOrEqual(stage.x);
      expect(pop.x + pop.width).toBeLessThanOrEqual(stage.x + stage.width);
      expect(pop.y).toBeGreaterThanOrEqual(0);
    }
    expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await ctx.close();
  });
}
