// Sessions, the client (sessions.md §7, §8, §10 phase 2): a board becomes a session with
// "+ Add game"; boards are added from Your boards or a pasted link; tabs switch, are removed and
// brought back with Undo (the toast's, and the app's one undo), renamed, reordered; `?tab=` names
// the open tab across a reload; a second device on the session link sees the same tabs, and a
// view link can't edit them. Also `Ready.kind`: a session's link on a board page is refused.

import { type Page, expect, test } from "./fixtures";
import { dragToken, joinNew, tokenAt } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
const tabs = (page: Page) => page.getByTestId("game-tab");
const tabNames = (page: Page) => page.getByTestId("game-tab").getByTestId("tab-name").allInnerTexts();
const activeBoard = (page: Page) => page.locator('[data-testid="board"]').getAttribute("data-board");
const tabParam = (page: Page) => new URL(page.url()).searchParams.get("tab");

/** Visit a board on this device so it's in Your boards, then come back. */
async function visit(page: Page, url: string, title: string) {
  await page.goto(url);
  await expect(page.getByTestId("board-title")).toHaveText(title);
  // The name is known on this device: the join card asks once per board, with it filled in.
  if (await page.getByTestId("join-card").isVisible()) {
    await page.locator("#join-name").press("Enter");
    await expect(page.getByTestId("join-card")).toBeHidden();
  }
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
}

/** A session made from board `a` with `+ Add game`, then `b` added from Your boards and `c` by
 * pasting its link. */
async function threeTabs(browser: Parameters<typeof joinNew>[0]) {
  const a = await newBoardUrl(server, "Game one");
  const b = await newBoardUrl(server, "Game two");
  const c = await newBoardUrl(server, "Game three");
  const page = await joinNew(browser, b, "Coach");
  await visit(page, a, "Game one");
  await page.getByTestId("add-game").click();
  await expect(page).toHaveURL(/\/s\/[A-Za-z0-9_-]{22}\?tab=[0-9a-f]{32}#/);
  // The session opens on its one tab, the board, with the add menu up.
  await expect(tabs(page)).toHaveCount(1);
  expect(await activeBoard(page)).toBe(boardOf(a));
  await expect(page.getByTestId("session-title")).toHaveText("Game one");
  await expect(page.getByTestId("add-menu")).toBeVisible();
  // From Your boards: the device's boards, never sessions.
  await expect(page.getByTestId("add-known-board")).toHaveCount(2);
  await page.locator(`[data-testid="add-known-board"][data-board="${boardOf(b)}"]`).click();
  await expect(page.getByTestId("add-menu")).toHaveCount(0);
  await expect(tabs(page)).toHaveCount(2);
  await expect.poll(() => activeBoard(page)).toBe(boardOf(b));
  // Paste link.
  await page.getByTestId("add-game").click();
  await page.getByTestId("add-paste").fill("not a link");
  await page.getByTestId("add-paste-go").click();
  await expect(page.getByTestId("add-error")).toHaveText("Not a board link");
  await page.getByTestId("add-paste").fill(c);
  await page.getByTestId("add-paste-go").click();
  await expect(tabs(page)).toHaveCount(3);
  await expect.poll(() => activeBoard(page)).toBe(boardOf(c));
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return { page, a, b, c };
}

test("a board becomes a session; boards are added, switched, removed and undone, renamed, reordered", async ({ browser }) => {
  const { page, a, b, c } = await threeTabs(browser);
  // A pasted board this device doesn't know is named for its place until renamed.
  expect(await tabNames(page)).toEqual(["Game one", "Game two", "Game 3"]);

  // Switch: the board mounts, and the address names the tab.
  await tabs(page).nth(0).click();
  await expect.poll(() => activeBoard(page)).toBe(boardOf(a));
  expect(tabParam(page)).toBe(await tabs(page).nth(0).getAttribute("data-tab"));
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await expect(tabs(page).nth(0)).toHaveAttribute("aria-label", "Game tab, Game one");

  // Remove the open last tab: you move to its left neighbour (not the first); the toast's Undo
  // brings it back.
  await tabs(page).nth(2).click();
  await expect.poll(() => activeBoard(page)).toBe(boardOf(c));
  await tabs(page).nth(2).getByTestId("tab-remove").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect.poll(() => activeBoard(page)).toBe(boardOf(b));
  await expect(page.getByTestId("session-toast")).toContainText("Removed Game 3");
  await page.getByTestId("session-toast-undo").click();
  await expect(tabs(page)).toHaveCount(3);
  expect(await tabNames(page)).toEqual(["Game one", "Game two", "Game 3"]);

  // Remove again, then the app's Undo button (one history): it re-links it too.
  await tabs(page).nth(2).getByTestId("tab-remove").click();
  await expect(tabs(page)).toHaveCount(2);
  await expect(page.getByTestId("undo")).toBeEnabled();
  await page.getByTestId("undo").click();
  await expect(tabs(page)).toHaveCount(3);
  // One history: remove a tab, then move a hero on the board; Ctrl+Z takes the move back first,
  // then re-links the tab. Redo mirrors it.
  await tabs(page).nth(2).getByTestId("tab-remove").click();
  await expect(tabs(page)).toHaveCount(2);
  const home = await tokenAt(page, "Amber-0");
  await dragToken(page, "Amber-0", 0.3, 0.3);
  await expect.poll(() => tokenAt(page, "Amber-0")).not.toEqual(home);
  const moved = await tokenAt(page, "Amber-0");
  await page.keyboard.press("Control+z");
  await expect.poll(() => tokenAt(page, "Amber-0")).toEqual(home);
  await expect(tabs(page)).toHaveCount(2);
  await page.keyboard.press("Control+z");
  await expect(tabs(page)).toHaveCount(3);
  await page.keyboard.press("Control+Shift+z");
  await expect(tabs(page)).toHaveCount(2);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => tokenAt(page, "Amber-0")).toEqual(moved);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  await expect(tabs(page)).toHaveCount(3);
  await expect.poll(() => tokenAt(page, "Amber-0")).toEqual(home);

  // Rename: double-click, type, Enter. The board's own title is unchanged.
  await tabs(page).nth(2).dblclick();
  const input = page.getByTestId("tab-name-input");
  await expect(input).toBeFocused();
  await input.fill("Scrim 3");
  await input.press("Enter");
  expect(await tabNames(page)).toEqual(["Game one", "Game two", "Scrim 3"]);
  // From the menu too.
  await tabs(page).nth(0).click({ button: "right" });
  await page.getByTestId("tab-rename").click();
  await page.getByTestId("tab-name-input").fill("Scrim 1");
  await page.getByTestId("tab-name-input").press("Enter");
  expect(await tabNames(page)).toEqual(["Scrim 1", "Game two", "Scrim 3"]);

  // Reorder: drag the last tab onto the first, then Move right from the menu.
  await tabs(page).nth(2).dragTo(tabs(page).nth(0));
  await expect.poll(() => tabNames(page)).toEqual(["Scrim 3", "Scrim 1", "Game two"]);
  await tabs(page).nth(0).click({ button: "right" });
  await page.getByTestId("tab-move-right").click();
  await expect.poll(() => tabNames(page)).toEqual(["Scrim 1", "Scrim 3", "Game two"]);

  // Reload on ?tab=: the same tab opens.
  await tabs(page).nth(1).click();
  await expect.poll(() => activeBoard(page)).toBe(boardOf(c));
  const tab = tabParam(page);
  await page.reload();
  await expect.poll(() => activeBoard(page)).toBe(boardOf(c));
  expect(tabParam(page)).toBe(tab);
  expect(await tabNames(page)).toEqual(["Scrim 1", "Scrim 3", "Game two"]);
  // A tab that's gone opens the first, and the address says so.
  const url = new URL(page.url());
  url.searchParams.set("tab", "0".repeat(32));
  await page.goto(url.href);
  await expect.poll(() => activeBoard(page)).toBe(boardOf(a));
  await expect.poll(() => tabParam(page)).toBe(await tabs(page).nth(0).getAttribute("data-tab"));

  // Your boards lists the session, with its games.
  await page.goto(server.url);
  const row = page.locator('[data-testid="known-board"][data-kind="session"]');
  await expect(row.getByTestId("known-title")).toHaveText("Game one");
  await expect(row.getByTestId("known-games")).toHaveText("3 games");
  await row.getByTestId("known-title").click();
  await expect(tabs(page)).toHaveCount(3);
});

test("a second device on the session link sees the same tabs, live; a view link can't edit them", async ({ browser }) => {
  const { page, a, b } = await threeTabs(browser);
  const sessionLink = page.url();
  const [, session, owner] = /\/s\/([^?#]+)\?[^#]*#(.+)$/.exec(sessionLink)!;
  const other = await joinNew(browser, sessionLink, "Peer");
  expect(await tabNames(other)).toEqual(await tabNames(page));
  // It opens the tab its link names, through the session (no board link on this device).
  await expect.poll(() => activeBoard(other)).toBe(await activeBoard(page));
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-can-edit", "true");
  // No board link leaks to it: no Share or Open in app for the board, and Your boards on its
  // landing holds only the session.
  await expect(other.getByTestId("share")).toHaveCount(0);
  // Live: a rename and a removal on one show on the other.
  await tabs(page).nth(0).dblclick();
  await page.getByTestId("tab-name-input").fill("Renamed");
  await page.getByTestId("tab-name-input").press("Enter");
  await expect.poll(() => tabNames(other)).toEqual(["Renamed", "Game two", "Game 3"]);
  // A peer removes the tab the other is on: it moves to the left neighbour.
  await tabs(other).nth(1).click();
  await expect.poll(() => activeBoard(other)).toBe(boardOf(b));
  await tabs(page).nth(1).getByTestId("tab-remove").click();
  await expect.poll(() => tabNames(other)).toEqual(["Renamed", "Game 3"]);
  await expect.poll(() => activeBoard(other)).toBe(boardOf(a));
  await page.getByTestId("session-toast-undo").click();
  await expect.poll(() => tabNames(other)).toEqual(["Renamed", "Game two", "Game 3"]);
  await other.goto(server.url);
  await expect(other.locator('[data-testid="known-board"]')).toHaveCount(1);
  await expect(other.locator('[data-testid="known-board"]')).toHaveAttribute("data-kind", "session");

  // A view link: the tabs, read only.
  const r = await fetch(`${server.url}/api/sessions/${session}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
    body: JSON.stringify({ role: "view", label: "guest" }),
  });
  const { token } = (await r.json()) as { token: string };
  const viewer = await joinNew(browser, `${server.url}/s/${session}#${token}`, "Viewer");
  await expect(viewer.getByTestId("game-strip")).toHaveAttribute("data-can-edit", "false");
  expect(await tabNames(viewer)).toEqual(["Renamed", "Game two", "Game 3"]);
  await expect(viewer.getByTestId("tab-remove")).toHaveCount(0);
  await expect(viewer.getByTestId("add-game")).toHaveCount(0);
  await expect(viewer.getByTestId("session-share")).toHaveCount(0);
  await tabs(viewer).nth(0).dblclick();
  await expect(viewer.getByTestId("tab-name-input")).toHaveCount(0);
  await tabs(viewer).nth(0).click({ button: "right" });
  await expect(viewer.getByTestId("tab-menu")).toHaveCount(0);
  await expect(viewer.getByTestId("session-title")).not.toHaveAttribute("role", "button");
  // It can switch tabs, and each board is view only for it.
  await tabs(viewer).nth(1).click();
  await expect.poll(() => activeBoard(viewer)).toBe(boardOf(b));
  await expect(viewer.getByTestId("save-status")).toHaveAttribute("data-can-edit", "false");
  expect(await tabNames(page)).toEqual(["Renamed", "Game two", "Game 3"]);
});

test("the same board twice, once with Can view: each tab opens it at its own grant", async ({ browser }) => {
  const { page, b } = await threeTabs(browser);
  // On a fresh device, so the tabs open through their grants (not this device's own link).
  const other = await joinNew(browser, page.url(), "Peer");
  await page.getByTestId("add-game").click();
  await page.getByTestId("add-view").check();
  await page.getByTestId("add-paste").fill(b);
  await page.getByTestId("add-paste-go").click();
  await expect(tabs(page)).toHaveCount(4);
  await expect(tabs(other)).toHaveCount(4);
  await tabs(other).nth(1).click();
  await expect.poll(() => activeBoard(other)).toBe(boardOf(b));
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-can-edit", "true");
  await tabs(other).nth(3).click();
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-can-edit", "false");
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await tabs(other).nth(1).click();
  await expect(other.getByTestId("save-status")).toHaveAttribute("data-can-edit", "true");
});

test("the session's Share mints session links; a board's own link still opens it alone", async ({ browser }) => {
  const { page, b } = await threeTabs(browser);
  await page.getByTestId("session-share").click();
  await expect(page.getByTestId("share-dialog")).toBeVisible();
  await expect(page.getByTestId("share-clone")).toHaveCount(0);
  await page.locator("#mint-label").fill("Team");
  await page.locator("#mint-label").press("Enter");
  await expect(page.getByTestId("minted-url")).toContainText(`/s/${new URL(page.url()).pathname.split("/")[2]}#`);
  await page.keyboard.press("Escape");
  // The board alone, by its own link: no strip, its own title and Share.
  const alone = await joinNew(browser, b, "Alone");
  await expect(alone.getByTestId("game-strip")).toHaveCount(0);
  await expect(alone.getByTestId("board-title")).toHaveText("Game two");
  await expect(alone.getByTestId("share")).toBeVisible();
  await expect(alone.getByTestId("add-game")).toBeVisible();
});

test("Ready.kind: a session's token on a board page, or a board's on a session page, opens nothing", async ({ browser }) => {
  const a = await newBoardUrl(server, "Kind check");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(a)!;
  const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Kinds" }) });
  const s = (await r.json()) as { session: string; owner_token: string };
  const page = await (await browser.newContext()).newPage();
  await page.goto(`${server.url}/b/${s.session}#${s.owner_token}`);
  await expect(page.getByTestId("dead-link")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-connection", "closed");
  await page.goto(`${server.url}/s/${board}#${token}`);
  await expect(page.getByTestId("dead-link")).toBeVisible();
  await expect(page.getByTestId("game-tab")).toHaveCount(0);
  // An empty session opens on its strip alone.
  await page.goto(`${server.url}/s/${s.session}#${s.owner_token}`);
  await expect(page.getByTestId("session-empty")).toHaveText("No games");
  await expect(page.getByTestId("add-game")).toBeVisible();
});
