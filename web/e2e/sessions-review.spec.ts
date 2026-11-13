// Sessions, the review fixes (2026-11-12, sessions.md §10 phase 2): Ctrl+Z reaches the strip
// whatever the tab can do, a toast's Undo is for its own step, Remove and revoke withdraws the
// grant first, and a switch held for a lost pointerup never lands later. Its own server: each
// spec file's boards count against the server's creations per hour.

import { type Page, expect, test } from "./fixtures";
import { dragToken, gesture, joinNew, tokenAt } from "./helpers";
import { Server } from "./server";
import { activeBoard, boardOf, tabNames, tabs, threeTabs as three } from "./session-helpers";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const threeTabs = (browser: Parameters<typeof joinNew>[0]) => three(server, browser);

const sessionOf = (url: string) => /\/s\/([^?#]+)\?[^#]*#(.+)$/.exec(url)!.slice(1) as [string, string];
const strokes = (p: Page) => p.locator(".mapbox [data-stroke]");

test("Ctrl+Z takes back a strip edit on a view-only tab, and with no games left", async ({ browser }) => {
  const { page, b } = await threeTabs(browser);
  // A device that holds no board link: every tab goes through its grant.
  const other = await joinNew(browser, page.url(), "Peer");
  await page.getByTestId("add-game").click();
  await page.getByTestId("add-view").check();
  await page.getByTestId("add-paste").fill(b);
  await page.getByTestId("add-paste-go").click();
  await expect(tabs(other)).toHaveCount(4);
  await tabs(other).nth(3).click();
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-can-edit", "false");
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await tabs(other).nth(0).getByTestId("tab-remove").click();
  await expect(tabs(other)).toHaveCount(3);
  await other.keyboard.press("Control+z");
  await expect(tabs(other)).toHaveCount(4);
  await other.keyboard.press("Control+Shift+z");
  await expect(tabs(other)).toHaveCount(3);
  await other.keyboard.press("Control+y"); // nothing left to redo
  await other.keyboard.press("Control+z");
  await expect(tabs(other)).toHaveCount(4);
  // Every tab removed: "No games", and Ctrl+Z brings the last one back.
  for (let n = 4; n > 0; n--) {
    await tabs(other).nth(0).getByTestId("tab-remove").click();
    await expect(tabs(other)).toHaveCount(n - 1);
  }
  await expect(other.getByTestId("session-empty")).toHaveText("No games");
  await other.keyboard.press("Control+z");
  await expect(tabs(other)).toHaveCount(1);
});

test("a toast's Undo is for its own step: it goes once anything else is done", async ({ browser }) => {
  const { page } = await threeTabs(browser);
  // The strip's toast, then a board edit: its Undo goes (it would take back the move).
  await tabs(page).nth(2).getByTestId("tab-remove").click();
  await expect(page.getByTestId("session-toast-undo")).toBeVisible();
  const home = await tokenAt(page, "Amber-0");
  await dragToken(page, "Amber-0", 0.3, 0.3);
  await expect.poll(() => tokenAt(page, "Amber-0")).not.toEqual(home);
  await expect(page.getByTestId("session-toast")).toBeVisible();
  await expect(page.getByTestId("session-toast-undo")).toHaveCount(0);
  // Clear's toast: its Undo takes back the clear while nothing else was done...
  await page.keyboard.press("e");
  await gesture(page, [[0.3, 0.3], [0.4, 0.35], [0.5, 0.3]]);
  await expect(strokes(page)).toHaveCount(1);
  await page.getByTestId("clear-menu").click();
  await page.getByTestId("clear-ink").click();
  await expect(strokes(page)).toHaveCount(0);
  await page.getByTestId("toast-action").click();
  await expect(strokes(page)).toHaveCount(1);
  // ...and goes once a strip edit comes after it.
  await page.getByTestId("clear-menu").click();
  await page.getByTestId("clear-ink").click();
  await expect(strokes(page)).toHaveCount(0);
  await expect(page.getByTestId("toast-action")).toBeVisible();
  await tabs(page).nth(0).getByTestId("tab-remove").click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.getByTestId("toast-action")).toHaveCount(0);
});

test("Remove and revoke withdraws the grant first: refused, the tab stays; done, it can't be undone", async ({ browser }) => {
  const { page } = await threeTabs(browser);
  const [session, owner] = sessionOf(page.url());
  const r = await fetch(`${server.url}/api/sessions/${session}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
    body: JSON.stringify({ role: "edit", label: "coach" }),
  });
  const { token } = (await r.json()) as { token: string };
  // A session editor who is neither its owner nor the grant's adder: the server refuses.
  const editor = await joinNew(browser, `${server.url}/s/${session}#${token}`, "Editor");
  await expect(tabs(editor)).toHaveCount(3);
  await tabs(editor).nth(1).click({ button: "right" });
  await editor.getByTestId("tab-revoke").click();
  await expect(editor.getByTestId("session-toast")).toHaveText("No access");
  await expect(tabs(editor)).toHaveCount(3);
  await expect(tabs(page)).toHaveCount(3);
  // The owner: the grant goes, then the tab, with no Undo anywhere.
  await tabs(page).nth(1).click({ button: "right" });
  await page.getByTestId("tab-revoke").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.getByTestId("session-toast")).toHaveText("Removed Game two");
  await expect(page.getByTestId("session-toast-undo")).toHaveCount(0);
  // Ctrl+Z takes back the step before it (the paste of Game 3), never the dead tab.
  await page.keyboard.press("Control+z");
  await expect.poll(() => tabNames(page)).toEqual(["Game one"]);
});

test("a switch held for a pointerup that never came doesn't land later on another tab", async ({ browser }) => {
  const { page, a, b, c } = await threeTabs(browser);
  await tabs(page).nth(0).click();
  await expect.poll(() => activeBoard(page)).toBe(boardOf(a));
  const lostPress = () => page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerdown", { buttons: 1 })));
  // The window loses focus: the press is over, and the switch held for it runs.
  await lostPress();
  await page.keyboard.press("Control+PageDown");
  await page.waitForTimeout(200);
  expect(await activeBoard(page)).toBe(boardOf(a));
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect.poll(() => activeBoard(page)).toBe(boardOf(b));
  // A held switch, then a click on a tab: that tab, and nothing after it.
  await lostPress();
  await page.keyboard.press("Control+PageDown");
  await tabs(page).nth(0).click();
  await expect.poll(() => activeBoard(page)).toBe(boardOf(a));
  await page.waitForTimeout(300);
  expect(await activeBoard(page)).toBe(boardOf(a));
  // A move with no button down ends a press too: the next switch goes at once.
  await lostPress();
  await page.mouse.move(5, 5);
  await page.mouse.move(9, 9);
  await page.keyboard.press("Control+PageDown");
  await expect.poll(() => activeBoard(page)).toBe(boardOf(b));
  void c;
});
