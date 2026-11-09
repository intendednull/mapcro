// The teams go by their patrons' names since Old Gods, New Blood: the Amber Hand is the Hidden
// King's, the Sapphire Flame the Archmother's (map/model.ts teamName). The wire keys stay.

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

test("teams are named for their patrons: roster headings, the top bar and the tokens", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "team names"), "Coach");
  // The side roster's headings and slot tags.
  await expect(a.locator(".team-head.amber")).toHaveText("Hidden King");
  await expect(a.locator(".team-head.sapphire")).toHaveText("Archmother");
  await expect(a.locator(".slot .chip.amber").first()).toHaveText("K1");
  await expect(a.locator(".slot .chip.sapphire").first()).toHaveText("A1");
  await expect(a.getByTestId("hero-pick-Sapphire-1")).toHaveAttribute("aria-label", "Hero for Archmother player 2");
  // An unnamed slot's placeholder: the short form, in the top bar and on its token.
  await expect(a.locator('.tb-player[data-slot="Amber-1"]')).toHaveAttribute("title", "King 2");
  await expect(a.locator('.tb-player[data-slot="Sapphire-1"]')).toHaveAttribute("title", "Archmother 2");
  await expect(a.locator('.tok[data-slot="Sapphire-2"]')).toHaveAttribute("aria-label", /^Archmother 3(, |$)/);
  // And no old name anywhere a user reads.
  const text = await a.locator("body").innerText();
  expect(text).not.toMatch(/\b(Amber|Sapphire)\b/);
  await a.screenshot({ path: "shots/team-names.png" });
});
