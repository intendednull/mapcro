// Shared by the sessions specs: a session of three tabs made the way a user does (sessions.md §7),
// and the strip's locators.

import type { Page } from "./fixtures";
import { expect } from "./fixtures";
import { joinNew } from "./helpers";
import { type Server, newBoardUrl } from "./server";

export const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
export const tabs = (page: Page) => page.getByTestId("game-tab");
export const tabNames = (page: Page) => page.getByTestId("game-tab").getByTestId("tab-name").allInnerTexts();
export const activeBoard = (page: Page) => page.locator('[data-testid="board"]').getAttribute("data-board");
export const tabParam = (page: Page) => new URL(page.url()).searchParams.get("tab");

/** Visit a board on this device so it's in Your boards, then come back. */
export async function visit(page: Page, url: string, title: string) {
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
export async function threeTabs(server: Server, browser: Parameters<typeof joinNew>[0]) {
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

