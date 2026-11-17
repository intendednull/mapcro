// Slice 7: the phone layout (design/v1-board/phone-following.html): a viewer on a phone
// following a presenter on a desktop, against the real server.

import { devices, expect, test } from "./fixtures";
import { joinNew, mapPoint, revealControls, viewLink } from "./helpers";
import { checkPhoneLayout, hasCdp, phoneContext, touchDrag, touchMapGesture } from "./phone-layout";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("a phone viewer follows, reads the callouts and note, flips on its own, and follows again", async ({ browser }) => {
  const url = await newBoardUrl(server, "Scrim prep vs Night Owls");
  const a = await joinNew(browser, url, "Coach");
  // Desktop: a second scene with two callouts and a note.
  await a.getByTestId("scene-add").click();
  await a.keyboard.press("s");
  for (const [f, text] of [[0.4, "Smoke on the bridge"], [0.6, "Dome when boss is low"]] as const) {
    const p = await mapPoint(a, f, 0.5);
    await a.mouse.click(p.x, p.y);
    await a.getByTestId("comment-input").fill(text);
    await a.keyboard.press("Enter");
  }
  await revealControls(a, "scene-note-edit");
  await a.getByTestId("scene-note-edit").fill("Boss at 8:00. Haze and Vindicta hold the west stairs.");
  await a.getByTestId("scene-name").click(); // blur the note: it saves
  await a.keyboard.press("Escape");

  const iphone = devices["iPhone 13"];
  const ctx = await phoneContext(browser, iphone.viewport, iphone);
  const phone = await ctx.newPage();
  await phone.goto(await viewLink(server.url, url));
  await phone.locator("#join-name").fill("Guest");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
  await expect(phone.getByTestId("role-chip")).toContainText("View only");
  await expect(phone.getByTestId("scene-strip")).toHaveCount(0);
  // One flip control on the phone: the desktop's round button over the map is hidden.
  await expect(phone.locator(".mm-flip")).toHaveCount(0);
  await expect(phone.getByTestId("viewpoint-flip")).toHaveCount(1);

  // Someone follows Coach so Coach is presenting; the phone offers Follow in one tap.
  const b = await joinNew(browser, url, "Marrow");
  await b.getByTestId("follow-Coach").click();
  await phone.getByTestId("follow-presenter").tap();
  await expect(phone.getByTestId("follow-chip")).toContainText("Following Coach");
  await expect(phone.locator(".p-title")).toContainText("Scene 2 of 2");
  // The presenter turns the map; the phone turns with it, and back.
  await a.getByTestId("viewpoint-flip").click();
  await expect(phone.locator(".p-map .mm-host")).toHaveClass(/vp-sapphire/);
  await a.getByTestId("viewpoint-flip").click();
  await expect(phone.locator(".p-map .mm-host")).toHaveClass(/vp-amber/);

  // Callouts are numbered pins with their text listed; the note shows below.
  await expect(phone.locator(".p-map .co-pin")).toHaveCount(2);
  await expect(phone.getByTestId("callout-list").locator("li")).toHaveText([/Smoke on the bridge|Dome when boss is low/, /Smoke on the bridge|Dome when boss is low/]);
  await expect(phone.getByTestId("scene-note")).toContainText("hold the west stairs");

  // Flipping on your own stops following; Follow comes back in one tap.
  await phone.getByTestId("p-prev").tap();
  await expect(phone.locator(".p-title")).toContainText("Scene 1 of 2");
  await expect(phone.getByTestId("toast")).toContainText("Stopped following Coach");
  await phone.getByTestId("toast-action").tap();
  await expect(phone.locator(".p-title")).toContainText("Scene 2 of 2");

  // The laser works from the phone too. (CDP touch: Chromium only.)
  await phone.getByTestId("tool-laser").tap();
  if (hasCdp(browser)) {
    await touchMapGesture(phone, [[0.3, 0.3], [0.6, 0.6]]);
    await expect(a.locator('.laser[data-laser="Guest"]')).toHaveCount(1);
  }
  // Nothing on the page is wider than the phone.
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await checkPhoneLayout(phone);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }, { width: 344, height: 615 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
  test(`phone layout and editing at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const ctx = await phoneContext(browser, viewport);
    const phone = await ctx.newPage();
    await phone.goto(await newBoardUrl(server, "Phone"));
    await phone.locator("#join-name").fill("Coach");
    await phone.keyboard.press("Enter");
    await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
    await checkPhoneLayout(phone);
    await phone.getByTestId("phone-edit").tap();
    await phone.getByTestId("tool-select").tap();
    await phone.getByTestId("map").scrollIntoViewIfNeeded();
    // The gestures are CDP touch input (Chromium only): elsewhere, the layout with Edit open.
    if (!hasCdp(browser)) {
      await expect(phone.getByTestId("tool-draw")).toBeVisible();
      await checkPhoneLayout(phone);
      return;
    }
    const token = phone.locator(".p-map .tok").first();
    const before = await token.getAttribute("transform");
    const box = (await token.boundingBox())!;
    const dest = await mapPoint(phone, .5, .5);
    await touchDrag(phone, [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }, dest]);
    await expect(token).not.toHaveAttribute("transform", before!);
    await phone.getByTestId("tool-draw").tap();
    await touchMapGesture(phone, [[.3, .3], [.6, .6]]);
    await expect(phone.locator(".p-map [data-stroke]")).toHaveCount(1);
    await phone.getByTestId("phone-undo").tap();
    await expect(phone.locator(".p-map [data-stroke]")).toHaveCount(0);
    await phone.getByTestId("phone-redo").tap();
    await expect(phone.locator(".p-map [data-stroke]")).toHaveCount(1);
    await phone.getByTestId("tool-arrow").tap();
    await touchMapGesture(phone, [[.2, .4], [.7, .4]]);
    await expect(phone.locator(".p-map [data-arrow]")).toHaveCount(1);
    await phone.getByTestId("tool-erase").tap();
    await phone.locator(".p-map [data-stroke]").first().tap();
    await expect(phone.locator(".p-map [data-stroke]")).toHaveCount(0);
    await phone.getByTestId("phone-edit").tap();
    await expect(phone.getByTestId("tool-draw")).toHaveCount(0);
    await checkPhoneLayout(phone);
  });
}

// Sessions on a phone (sessions.md §8): the strip doesn't fit, so the header's session title is a
// button that opens the Games sheet: the tab list with each tab's details, Add game, and the same
// tab menu (Rename, Move left and Move right in place of a drag, Remove). Picking a tab closes
// the sheet and returns to the map.
for (const viewport of [{ width: 390, height: 844 }, { width: 344, height: 615 }]) {
  test(`a session on a phone at ${viewport.width}×${viewport.height}: the Games sheet switches, renames, reorders and adds`, async ({ browser }) => {
    const links = [await newBoardUrl(server, "Phone A"), await newBoardUrl(server, "Phone B"), await newBoardUrl(server, "Phone C")];
    const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(links[0]!)!;
    const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Scrim review", board, board_token: token }) });
    const s = (await r.json()) as { session: string; owner_token: string };
    const url = `${server.url}/s/${s.session}#${s.owner_token}`;
    // The owner adds the other two on a desktop, by pasting their links.
    const desk = await joinNew(browser, url, "Coach");
    for (const [i, l] of links.slice(1).entries()) {
      await desk.getByTestId("add-game").click();
      await desk.getByTestId("add-paste").fill(l);
      await desk.getByTestId("add-paste-go").click();
      await expect(desk.getByTestId("game-tab")).toHaveCount(i + 2);
    }
    const ctx = await phoneContext(browser, viewport, { hasTouch: true });
    const phone = await ctx.newPage();
    await phone.goto(url);
    await phone.locator("#join-name").fill("Student");
    await phone.keyboard.press("Enter");
    await expect(phone.getByTestId("join-card")).toBeHidden();
    await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
    const mounted = () => phone.locator('[data-testid="board"]').getAttribute("data-board");
    const boards = links.map((l) => /\/b\/([^#]+)#/.exec(l)![1]!);
    await expect.poll(mounted).toBe(boards[0]);
    // No strip: the session's title, with its count of games, in the header.
    await expect(phone.getByTestId("game-strip")).toHaveCount(0);
    const open = phone.getByTestId("games-open");
    await expect(open).toContainText("Scrim review");
    await expect(open.locator(".games-count")).toHaveText("3");
    await checkPhoneLayout(phone);
    // The sheet: every tab, the open one marked, each with its details.
    await open.tap();
    const sheet = phone.getByTestId("games-sheet");
    await expect(sheet).toBeVisible();
    const rows = sheet.getByTestId("games-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).getByTestId("games-pick")).toHaveAttribute("aria-selected", "true");
    await expect(rows.nth(1).getByTestId("tab-line")).toHaveText("Sandbox");
    // Each row and control is a finger's size.
    for (const box of await sheet.locator("[data-testid=games-pick], [data-testid=games-menu], [data-testid=games-add], [data-testid=games-close]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect)))
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    // Pick the third: the sheet closes, and its board is open.
    await rows.nth(2).getByTestId("games-pick").tap();
    await expect(sheet).toHaveCount(0);
    await expect.poll(mounted).toBe(boards[2]);
    // The tab menu, from a row's ⋯: Move right, then Rename.
    await open.tap();
    const names = () => sheet.getByTestId("games-row").getByTestId("tab-name").allInnerTexts();
    const before = await names();
    await rows.nth(0).getByTestId("games-menu").tap();
    await expect(phone.getByTestId("tab-menu")).toBeVisible();
    await expect(phone.getByTestId("tab-move-left")).toHaveCount(0);
    await phone.getByTestId("tab-move-right").tap();
    await expect.poll(names).toEqual([before[1], before[0], before[2]]);
    await rows.nth(2).getByTestId("games-menu").tap();
    await phone.getByTestId("tab-rename").tap();
    const input = sheet.getByTestId("tab-name-input");
    await expect(input).toBeFocused();
    await input.fill("Game three");
    await input.press("Enter");
    await expect.poll(names).toEqual([before[1], before[0], "Game three"]);
    // The desktop sees it.
    await expect.poll(() => desk.getByTestId("game-tab").getByTestId("tab-name").allInnerTexts()).toEqual([before[1], before[0], "Game three"]);
    // Add game: the add menu, the sheet closed.
    await sheet.getByTestId("games-add").tap();
    await expect(sheet).toHaveCount(0);
    await expect(phone.getByTestId("add-menu")).toBeVisible();
    await phone.keyboard.press("Escape");
    await expect(phone.getByTestId("add-menu")).toHaveCount(0);
    // Close: the sheet goes, the tab stays.
    await open.tap();
    await sheet.getByTestId("games-close").tap();
    await expect(sheet).toHaveCount(0);
    await expect.poll(mounted).toBe(boards[2]);
    await checkPhoneLayout(phone);
    await ctx.close();
  });
}
