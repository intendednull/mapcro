// A hero is unique in a match, across both teams (QA 2026-11-07).

import { expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

let server: Server;
test.beforeAll(async () => {
  server = new Server(heroPack(14));
  await server.start();
});
test.afterAll(() => server.stop());

test("a hero is unique across both teams: taken heroes are disabled, with who has them", async ({ browser }) => {
  const url = await newBoardUrl(server, "unique heroes");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("hero-pick-Amber-0").selectOption({ label: "Testhero C" });
  // The side roster's picker for another slot: C is taken.
  const opt = a.getByTestId("hero-pick-Sapphire-1").locator("option", { hasText: "Testhero C" });
  await expect(opt).toBeDisabled();
  await expect(opt).toContainText("Player 1");
  // The top-bar picker too: disabled, says who, and Enter on it does nothing.
  await a.locator('.tb-player[data-slot="Sapphire-1"]').getByTestId("pick-hero").click();
  const cell = a.locator('.hero-cell[data-hero="Testhero C"]');
  await expect(cell).toBeDisabled();
  await expect(cell).toContainText("Amber");
  await a.keyboard.type("testhero c");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("hero-picker")).toBeVisible();
  await a.locator("#hp-h").screenshot({ path: "shots/hero-picker-taken.png" });
  await a.getByTestId("hero-picker").screenshot({ path: "shots/hero-picker-taken.png" });
  // The slot that has it can still see it as its own.
  await a.keyboard.press("Escape");
  await a.locator('.tb-player[data-slot="Amber-0"]').getByTestId("pick-hero").click();
  await expect(a.locator('.hero-cell[data-hero="Testhero C"]')).toBeEnabled();
});
