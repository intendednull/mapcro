// Slice 7: the phone layout (design/v1-board/phone-following.html): a viewer on a phone
// following a presenter on a desktop, against the real server.

import { devices, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint, viewLink } from "./helpers";
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
  await a.keyboard.press("t");
  for (const [f, text] of [[0.4, "Smoke on the bridge"], [0.6, "Dome when boss is low"]] as const) {
    const p = await mapPoint(a, f, 0.5);
    await a.mouse.click(p.x, p.y);
    await a.getByTestId("comment-input").fill(text);
    await a.keyboard.press("Enter");
  }
  await a.getByTestId("scene-note-edit").fill("Boss at 8:00. Haze and Vindicta hold the west stairs.");
  await a.getByTestId("scene-name").click(); // blur the note: it saves
  await a.keyboard.press("Escape");

  const ctx = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined } as never);
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

  // The laser works from the phone too.
  await phone.getByTestId("tool-laser").tap();
  await gesture(phone, [[0.3, 0.3], [0.6, 0.6]]);
  await expect(a.locator('.laser[data-laser="Guest"]')).toHaveCount(1);
  // Nothing on the page is wider than the phone.
  expect(await phone.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await phone.screenshot({ path: "shots/slice7-phone-following.png", fullPage: true });
});
