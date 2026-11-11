// "Your boards" on the landing, and the board's name (2026-11-11, operator): the bin takes a board
// off this device's list (Undo puts it back, a reload keeps it gone, reopening its link adds it
// back); editors rename the board in its header or from the list, live for everyone and undoable;
// a viewer has no rename.

import { type Page, expect, test } from "./fixtures";
import { joinNew, viewLink } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
const row = (page: Page, url: string) => page.locator(`[data-testid="known-board"][data-board="${boardOf(url)}"]`);

/** Open a board on the page's device, joining it the first time, so it lands in "Your boards". */
async function visit(page: Page, url: string, title: string, first = false) {
  await page.goto(url);
  if (first) {
    await page.locator("#join-name").fill("Coach");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("join-card")).toBeHidden();
  }
  await expect(page.getByTestId("board-title")).toHaveText(title);
}

async function rename(page: Page, to: string) {
  await page.getByTestId("board-title").click();
  const input = page.getByTestId("board-title-input");
  await expect(input).toBeFocused();
  await input.fill(to);
  await input.press("Enter");
  await expect(page.getByTestId("board-title")).toHaveText(to);
}

test("the bin takes a board off this device's list, with Undo; a reload keeps it gone, its link brings it back", async ({ browser }) => {
  const a = await newBoardUrl(server, "Bin me");
  const b = await newBoardUrl(server, "Keep me");
  const page = await joinNew(browser, a, "Coach");
  await visit(page, b, "Keep me", true);
  await page.goto(server.url);
  await expect(row(page, a).getByTestId("known-title")).toHaveText("Bin me");
  await expect(row(page, b)).toBeVisible();
  // Reachable without hover (touch): the button is there and named.
  await expect(row(page, a).getByTestId("known-remove")).toHaveAttribute("title", "Remove");

  await row(page, a).getByTestId("known-remove").click();
  await expect(row(page, a)).toHaveCount(0);
  await expect(page.getByTestId("toast")).toContainText("Removed Bin me");
  await page.getByTestId("toast-action").click();
  await expect(row(page, a)).toHaveCount(1);
  await expect(page.getByTestId("toast")).toHaveCount(0);
  // Back in its place: newest first, so after "Keep me".
  await expect(page.getByTestId("known-board")).toHaveCount(2);
  await expect(page.getByTestId("known-board").nth(1)).toHaveAttribute("data-board", boardOf(a));

  await row(page, a).getByTestId("known-remove").click();
  await expect(row(page, a)).toHaveCount(0);
  await page.reload();
  await expect(row(page, b)).toBeVisible();
  await expect(row(page, a)).toHaveCount(0);

  // The board itself is untouched: its link opens it, and it's listed again.
  await visit(page, a, "Bin me");
  await page.goto(server.url);
  await expect(row(page, a)).toHaveCount(1);
});

test("a match board shows its match id beside a name it was given, not beside its default", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto(server.url);
  await page.evaluate(() =>
    localStorage.setItem(
      "mapcro.boards",
      JSON.stringify([
        { board: "renamed000000000000000", token: "t", title: "Lane review", seen: 2, match: "4242", edit: true },
        { board: "default000000000000000", token: "t", title: "Match 77", seen: 1, match: "77", edit: true },
      ]),
    ),
  );
  await page.reload();
  const rows = page.getByTestId("known-board");
  await expect(rows.nth(0).getByTestId("known-title")).toHaveText("Lane review");
  await expect(rows.nth(0).getByTestId("known-match")).toHaveText("4242");
  await expect(rows.nth(1).getByTestId("known-title")).toHaveText("Match 77");
  await expect(rows.nth(1).getByTestId("known-match")).toHaveCount(0);
});

test("rename in the header: live in a second browser, and both devices' lists follow", async ({ browser }) => {
  const url = await newBoardUrl(server, "Scrim prep");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await expect(a.getByTestId("board-title")).toHaveAttribute("role", "button");
  await rename(a, "Scrim prep vs Night Owls");
  await expect(b.getByTestId("board-title")).toHaveText("Scrim prep vs Night Owls");
  await expect(b).toHaveTitle("Scrim prep vs Night Owls · mapcro");
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  for (const p of [a, b]) {
    await p.goto(server.url);
    await expect(row(p, url).getByTestId("known-title")).toHaveText("Scrim prep vs Night Owls");
  }
  // The server has it: a fresh device sees the new name.
  const c = await joinNew(browser, url, "Juno");
  await expect(c.getByTestId("board-title")).toHaveText("Scrim prep vs Night Owls");
});

test("a rename is undoable, for everyone; an empty name changes nothing", async ({ browser }) => {
  const url = await newBoardUrl(server, "Before");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await a.getByTestId("board-title").click();
  await a.getByTestId("board-title-input").fill("   ");
  await a.getByTestId("board-title-input").press("Enter");
  await expect(a.getByTestId("board-title")).toHaveText("Before");
  await expect(a.getByTestId("undo")).toBeDisabled();

  await rename(a, "After");
  await expect(b.getByTestId("board-title")).toHaveText("After");
  await a.getByTestId("undo").click();
  await expect(a.getByTestId("board-title")).toHaveText("Before");
  await expect(b.getByTestId("board-title")).toHaveText("Before");
  await a.goto(server.url);
  await expect(row(a, url).getByTestId("known-title")).toHaveText("Before");
});

test("rename from the list opens the board with its name's editor open", async ({ browser }) => {
  const url = await newBoardUrl(server, "Listed");
  const page = await joinNew(browser, url, "Coach");
  const other = await joinNew(browser, url, "Marrow");
  await page.goto(server.url);
  await row(page, url).getByTestId("known-rename").click();
  await page.waitForURL(url);
  const input = page.getByTestId("board-title-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Listed");
  await input.fill("Listed and renamed");
  await input.press("Enter");
  await expect(page.getByTestId("board-title")).toHaveText("Listed and renamed");
  await expect(other.getByTestId("board-title")).toHaveText("Listed and renamed");
  // The ask is used up: a reload opens the board as usual.
  await page.reload();
  await expect(page.getByTestId("board-title")).toHaveText("Listed and renamed");
  await expect(page.getByTestId("board-title-input")).toHaveCount(0);
  await page.goto(server.url);
  await expect(row(page, url).getByTestId("known-title")).toHaveText("Listed and renamed");
});

test("a viewer can't rename: no editor in the header, no Rename in the list", async ({ browser }) => {
  const url = await newBoardUrl(server, "Look only");
  const view = await viewLink(server.url, url);
  const page = await joinNew(browser, view, "Guest");
  const title = page.getByTestId("board-title");
  await expect(title).toHaveText("Look only");
  await expect(title).not.toHaveAttribute("role", "button");
  await title.click();
  await expect(page.getByTestId("board-title-input")).toHaveCount(0);
  await page.goto(server.url);
  await expect(row(page, view).getByTestId("known-title")).toHaveText("Look only");
  await expect(row(page, view).getByTestId("known-rename")).toHaveCount(0);
  await expect(row(page, view).getByTestId("known-remove")).toBeVisible();
});
