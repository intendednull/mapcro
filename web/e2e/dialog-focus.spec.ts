// The dialogs' keyboard contract (ui/modal.ts, ui/ModalScrim.tsx), shared with Feedback's
// (feedback.spec.ts): Share, Clone, the hero picker and the join card are aria-modal, the board
// behind is inert, Tab and Shift+Tab wrap inside, Escape closes (not the join card: joining is
// how you enter), and focus goes back to the control that opened the dialog.

import { type Locator, type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

/** Whether the board's top-level element (under <body>) is inert. */
const boardInert = (p: Page) => p.evaluate(() => (document.querySelector('[data-testid="board"]')!.closest("body > *") as HTMLElement).inert);
const focusIn = (dlg: Locator) => dlg.evaluate((el) => el.contains(document.activeElement));
const focusedTestId = (p: Page) => p.evaluate(() => document.activeElement?.getAttribute("data-testid"));

/** The modal checks every dialog shares: aria-modal, inert behind, Tab and Shift+Tab wrap. */
async function holdsFocus(p: Page, scrim: Locator) {
  await expect(scrim.locator('[role="dialog"]')).toHaveAttribute("aria-modal", "true");
  expect(await boardInert(p)).toBe(true);
  // A press anywhere first puts focus in the dialog; from there Tab never leaves it.
  await p.keyboard.press("Tab");
  for (let i = 0; i < 25; i++) {
    expect(await focusIn(scrim), `Tab ${i + 1}`).toBe(true);
    await p.keyboard.press("Tab");
  }
  for (let i = 0; i < 25; i++) {
    expect(await focusIn(scrim), `Shift+Tab ${i + 1}`).toBe(true);
    await p.keyboard.press("Shift+Tab");
  }
  // No key reaches the board: a tool key typed in the dialog leaves the tool alone.
  const tool = await p.locator("[data-testid=map] svg[data-tool]").first().getAttribute("data-tool");
  await p.keyboard.press("e");
  expect(await p.locator("[data-testid=map] svg[data-tool]").first().getAttribute("data-tool")).toBe(tool);
}

test("Share and Clone hold the focus, Escape closes them, and focus goes back to the opener", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Dialogs"), "Coach");
  await a.getByTestId("share").focus();
  await a.keyboard.press("Enter");
  const share = a.getByTestId("share-dialog");
  await expect(share).toBeVisible();
  await holdsFocus(a, share);
  await a.keyboard.press("Escape");
  await expect(share).toHaveCount(0);
  expect(await boardInert(a)).toBe(false);
  expect(await focusedTestId(a)).toBe("share");

  // Clone from Share: Clone holds the focus; closing it goes back to Share's opener.
  await a.getByTestId("share").click();
  await share.getByTestId("share-clone").click();
  const clone = a.getByTestId("clone-dialog");
  await expect(clone).toBeVisible();
  await expect(share).toHaveCount(0);
  await holdsFocus(a, clone);
  await a.keyboard.press("Escape");
  await expect(clone).toHaveCount(0);
  expect(await boardInert(a)).toBe(false);
  expect(await focusedTestId(a)).toBe("share");

  // Clone from the header.
  await a.getByTestId("clone").focus();
  await a.keyboard.press("Enter");
  await expect(clone).toBeVisible();
  await holdsFocus(a, clone);
  await a.keyboard.press("Escape");
  await expect(clone).toHaveCount(0);
  expect(await focusedTestId(a)).toBe("clone");
});

test("the hero picker holds the focus; Escape closes it back to the portrait", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Picker"), "Coach");
  const portrait = a.locator('.tb-player[data-slot="Amber-3"]:visible').first();
  await portrait.click({ button: "right" });
  await a.getByTestId("hero-menu").getByRole("menuitem", { name: /Change hero|Pick hero/ }).click();
  const picker = a.getByTestId("hero-picker");
  await expect(picker).toBeVisible();
  await holdsFocus(a, picker);
  await a.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  expect(await boardInert(a)).toBe(false);
  expect(await a.evaluate(() => document.activeElement?.closest(".tb-player")?.getAttribute("data-slot"))).toBe("Amber-3");
});

test("the join card holds the focus and stays up on Escape", async ({ browser }) => {
  const url = await newBoardUrl(server, "Join");
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await p.goto(url);
  const card = p.getByTestId("join-card");
  await expect(card).toBeVisible();
  await expect(card.locator('[role="dialog"]')).toHaveAttribute("aria-modal", "true");
  expect(await boardInert(p)).toBe(true);
  for (let i = 0; i < 20; i++) {
    await p.keyboard.press("Tab");
    expect(await focusIn(card), `Tab ${i + 1}`).toBe(true);
  }
  await p.keyboard.press("Escape");
  await expect(card).toBeVisible();
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(card).toHaveCount(0);
  expect(await boardInert(p)).toBe(false);
});
