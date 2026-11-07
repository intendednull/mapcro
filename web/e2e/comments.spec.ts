// Comments (operator, 2026-11-07): bubbles by default, opened in place, a per-device
// "Comments" toggle, followers see the presenter's open one; drag and erase still work.

import { type Page, expect, test } from "@playwright/test";
import { editLink, joinNew, mapPoint } from "./helpers";
import { Server, newBoardUrl, translate } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const comment = (p: Page) => p.locator(".mapbox [data-callout]");
async function place(p: Page, f: [number, number], text: string) {
  await p.keyboard.press("c");
  const at = await mapPoint(p, ...f);
  await p.mouse.click(at.x, at.y);
  // A new comment is open, and editing.
  await expect(p.getByTestId("comment-input")).toBeFocused();
  await p.getByTestId("comment-input").fill(text);
  await p.keyboard.press("Enter");
  await p.keyboard.press("v");
}

test("a new comment edits open, then collapses to a bubble; a click opens it, a click outside closes it", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "comments"), "Coach");
  await place(a, [0.62, 0.3], "Smoke on the bridge");
  await expect(comment(a)).toHaveAttribute("data-open", "false");
  await expect(comment(a).locator(".bubble-body")).toBeVisible();
  // Hover previews the text.
  const off = await mapPoint(a, 0.2, 0.5);
  await a.mouse.move(off.x, off.y);
  await expect(comment(a).getByTestId("comment-preview")).toBeHidden();
  await comment(a).locator(".bubble-body").hover();
  await expect(comment(a).getByTestId("comment-preview")).toBeVisible();
  await expect(comment(a).getByTestId("comment-preview")).toHaveText("Smoke on the bridge");
  // Click: open in place. Click outside: closed. Esc closes too.
  await comment(a).locator(".bubble-body").click();
  await expect(comment(a)).toHaveAttribute("data-open", "true");
  await a.screenshot({ path: "shots/comments-open.png" });
  const away = await mapPoint(a, 0.3, 0.45);
  await a.mouse.click(away.x, away.y);
  await expect(comment(a)).toHaveAttribute("data-open", "false");
  await comment(a).locator(".bubble-body").click();
  await expect(comment(a)).toHaveAttribute("data-open", "true");
  await a.keyboard.press("Escape");
  await expect(comment(a)).toHaveAttribute("data-open", "false");
  await a.screenshot({ path: "shots/comments-bubble.png" });
});

test("Comments opens every comment in one browser only, and stays on after a reload", async ({ browser }) => {
  const url = await newBoardUrl(server, "all open");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await place(a, [0.62, 0.3], "One");
  await place(a, [0.35, 0.6], "Two");
  await expect(comment(b)).toHaveCount(2);
  await a.getByTestId("comments-toggle").click();
  await expect(a.getByTestId("comments-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(comment(a).and(a.locator('[data-open="true"]'))).toHaveCount(2);
  await expect(comment(b).and(b.locator('[data-open="false"]'))).toHaveCount(2);
  await a.reload();
  await expect(comment(a).and(a.locator('[data-open="true"]'))).toHaveCount(2);
  await a.getByTestId("comments-toggle").click();
  await expect(comment(a).and(a.locator('[data-open="false"]'))).toHaveCount(2);
});

test("a follower sees the presenter's open comment open", async ({ browser }) => {
  const url = await newBoardUrl(server, "follow");
  const a = await joinNew(browser, url, "Coach");
  await place(a, [0.62, 0.3], "Watch this");
  const b = await joinNew(browser, await editLink(server.url, url), "Marrow");
  await b.getByTestId("follow-Coach").click();
  await expect(comment(b)).toHaveAttribute("data-open", "false");
  await comment(a).locator(".bubble-body").click();
  await expect(comment(b)).toHaveAttribute("data-open", "true");
  await a.keyboard.press("Escape");
  await expect(comment(b)).toHaveAttribute("data-open", "false");
  // Not following: the presenter's open comment stays a bubble here.
  await b.getByTestId("stop-following").click();
  await comment(a).locator(".bubble-body").click();
  await expect(comment(a)).toHaveAttribute("data-open", "true");
  await b.waitForTimeout(300);
  await expect(comment(b)).toHaveAttribute("data-open", "false");
});

test("a bubble drags with Move and erases with Erase", async ({ browser }) => {
  const url = await newBoardUrl(server, "drag");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await place(a, [0.62, 0.3], "Rotate here");
  const spot = async (p: Page) => translate(await comment(p).locator("g[transform]").first().getAttribute("transform"));
  const before = await spot(b);
  const bb = (await comment(a).locator(".bubble-body").boundingBox())!;
  const dest = await mapPoint(a, 0.4, 0.35);
  await a.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await a.mouse.down();
  await a.mouse.move(dest.x, dest.y, { steps: 8 });
  await a.mouse.up();
  await expect.poll(async () => (await spot(b)).x).toBeLessThan(before.x - 50);
  await expect(comment(a)).toHaveAttribute("data-open", "false"); // a drag doesn't open it
  await a.keyboard.press("e");
  const nb = (await comment(a).locator(".bubble-body").boundingBox())!;
  await a.mouse.click(nb.x + nb.width / 2, nb.y + nb.height / 2);
  await expect(comment(b)).toHaveCount(0);
});
