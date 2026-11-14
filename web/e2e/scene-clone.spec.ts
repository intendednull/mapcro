// Clone a scene from its row (operator, 2026-11-08): the copy lands right after that row, as its
// sibling, with that scene's heroes, in one undoable step; on the phone the row's buttons show.

import { expect, test } from "./fixtures";
import { dragToken, gesture, joinNew, revealControls, tokenAt } from "./helpers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("cloning row 2 of 3 puts the copy at position 3, with row 2's heroes; one undo removes it", async ({ browser }) => {
  const url = await newBoardUrl(server, "clone");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const rows = a.getByTestId("scene-card");
  await a.getByTestId("scene-add").click();
  await dragToken(a, "Amber-0", 0.62, 0.38); // scene 2's own spot
  const spot = await tokenAt(a, "Amber-0");
  await a.getByTestId("scene-add").click();
  await expect(rows).toHaveCount(3);
  await rows.first().click(); // look at scene 1: the clone is of row 2, not the current scene
  await rows.nth(1).hover();
  await rows.nth(1).getByTestId("scene-clone").click();
  await expect(rows).toHaveCount(4);
  await expect(b.getByTestId("scene-card")).toHaveCount(4);
  await expect(rows.nth(2)).toHaveAttribute("aria-current", "true"); // the copy, at position 3
  await expect.poll(() => tokenAt(a, "Amber-0")).toEqual(spot);
  await a.getByTestId("scene-tree").screenshot({ path: "shots/scene-clone.png" });
  await a.keyboard.press("Control+z");
  await expect(b.getByTestId("scene-card")).toHaveCount(3);
});

test("a copy keeps what is drawn on the scene and its note; a new scene starts without them (#54)", async ({ browser }) => {
  const url = await newBoardUrl(server, "clone ink");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const rows = a.getByTestId("scene-card");
  const drawn = (p: typeof a) => Promise.all([p.locator(".mapbox [data-stroke]").count(), p.locator(".mapbox [data-arrow]").count()]);
  await a.getByTestId("tool-draw").click();
  await gesture(a, [[0.3, 0.3], [0.6, 0.6]]);
  await a.getByTestId("tool-arrow").click();
  await gesture(a, [[0.2, 0.4], [0.7, 0.4]]);
  await expect.poll(() => drawn(a)).toEqual([1, 1]);
  await revealControls(a, "scene-note-edit");
  await a.getByTestId("scene-note-edit").fill("Hold the west stairs.");
  await a.getByTestId("scene-note-edit").blur();
  await rows.first().hover();
  await rows.first().getByTestId("scene-clone").click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect.poll(() => drawn(a)).toEqual([1, 1]);
  await expect(a.getByTestId("scene-note-edit")).toHaveValue("Hold the west stairs.");
  // The other person sees the copy's ink too, on the copy.
  await b.getByTestId("scene-card").nth(1).click();
  await expect.poll(() => drawn(b)).toEqual([1, 1]);
  // The copy's ink is its own: erasing it leaves the first scene's.
  await a.getByTestId("tool-erase").click();
  await a.locator(".mapbox [data-stroke]").first().click();
  await expect.poll(() => drawn(a)).toEqual([0, 1]);
  await rows.first().click();
  await expect.poll(() => drawn(a)).toEqual([1, 1]);
  // Add scene: the next frame of the play, from the heroes' places, with nothing drawn.
  await a.getByTestId("scene-add").click();
  await expect(rows).toHaveCount(3);
  await expect.poll(() => drawn(a)).toEqual([0, 0]);
  await expect(a.getByTestId("scene-note-edit")).toHaveValue("");
});

test("a copy the board refuses makes nothing and leaves the scene shown (review F1)", async ({ browser }) => {
  // A board five records short of its 5,000: a copy's first transaction (the scene and its
  // twelve heroes) is refused whole.
  const file = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/board-file-v1-oldest-records.mapcro.json")).toString()) as { records: [string, Record<string, unknown>][] };
  const hex = (n: number) => n.toString(16).padStart(32, "0");
  const first = file.records.find(([, r]) => r.Scene)![0];
  // A second scene, the one shown: a flip to a scene that doesn't exist would fall back to the first.
  const second = hex(0xaaa);
  const slots = file.records.filter(([, r]) => r.RosterSlot);
  file.records.push([second, { Scene: { name: "Second", order: "s", clock: null } }]);
  slots.forEach(([slot], i) => file.records.push([hex(0xb00 + i), { PlayerState: { scene: second, slot, pos: { x: -4000 + i * 700, y: i < 6 ? -2500 : 2500 }, alive: true, placed: true, souls: null, ult_cooldown: null, visible: true } }]));
  for (let i = 0; file.records.length < 4995; i++) file.records.push([hex(0xf0000 + i), { Stroke: { scene: first, points: [{ x: i, y: 0 }, { x: i, y: 9 }], color: 1, width: 30 } }]);
  const r = await fetch(`${server.url}/api/boards/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file) });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  const a = await joinNew(browser, `${server.url}/b/${board}#${owner_token}`, "Coach");
  const rows = a.getByTestId("scene-card");
  await expect(rows).toHaveCount(2);
  await rows.nth(1).click();
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  // Duplicate, then Add scene: nothing is made, and the page still shows the scene it was on.
  await rows.nth(1).getByTestId("scene-clone").click();
  await expect(a.getByTestId("toast")).toHaveText("Board full");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await a.getByTestId("scene-add").click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
});

test("on the phone drawer, a row's clone and delete are always there", async ({ browser }) => {
  const url = await newBoardUrl(server, "clone phone");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Coach");
  await phone.keyboard.press("Enter");
  await phone.getByTestId("scene-drawer").click();
  await phone.getByTestId("scene-add").click();
  const rows = phone.getByTestId("scene-card");
  await expect(rows).toHaveCount(2);
  for (const id of ["scene-clone", "scene-delete"]) await expect(rows.nth(0).getByTestId(id)).toBeVisible();
  await expect.poll(() => rows.nth(0).getByTestId("scene-clone").evaluate((e) => getComputedStyle(e).opacity)).toBe("1");
  await phone.screenshot({ path: "shots/scene-drawer-buttons.png" });
});
