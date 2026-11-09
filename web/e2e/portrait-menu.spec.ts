// A hero's controls live on its portrait (operator, 2026-11-09: "for controls we can move the
// kill and hide controls for heros to right clicking the hero portrait"). An editor's right click
// on a top-bar portrait opens a menu at the pointer: Kill / Revive, Mark not seen / Mark in
// vision, Change hero…; arrows, Enter and Escape work it, a press outside closes it. Viewers get
// no menu. The map tokens show the state (dead, unseen) but carry no eye or skull button.

import { type Page, expect, test } from "./fixtures";
import { joinNew, viewLink } from "./helpers";
import { Server, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

let server: Server;
test.beforeAll(async () => {
  server = new Server(heroPack(14));
  await server.start();
});
test.afterAll(() => server.stop());

const tok = (p: Page, slot: string) => p.locator(`.mapbox .tok[data-slot="${slot}"]`);
// The first top bar on the page: the desktop one (the compact one is for small screens).
const portrait = (p: Page, slot: string) => p.locator(`.tb-player[data-slot="${slot}"]:visible`).first();
const menu = (p: Page) => p.getByTestId("hero-menu");
/** Right-click the middle of a hero's top-bar column: its portrait (or, with no hero, its picker). */
async function openMenu(p: Page, slot: string) {
  await portrait(p, slot).click({ button: "right" });
  await expect(menu(p)).toBeVisible();
}

test("right-click a portrait: kill, revive and vision, seen by another editor; tokens have no buttons", async ({ browser }) => {
  const url = await newBoardUrl(server, "portrait menu");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");

  // The tokens carry no eye or skull to click, even hovered by an editor.
  await tok(a, "Amber-1").hover();
  await expect(a.locator(".mapbox .tok [data-testid=vision], .mapbox .tok [data-testid=life], .mapbox .tok .life")).toHaveCount(0);
  await expect(a.locator(".mapbox .tok .vis")).toHaveCount(0); // every hero is in vision

  // With no hero yet the last item picks one; with one, it changes it.
  await openMenu(a, "Amber-1");
  await expect(menu(a).getByRole("menuitem")).toHaveText(["Kill", "Mark not seen", "Pick hero…"]);
  await a.keyboard.press("Escape");
  await a.getByTestId("hero-pick-Amber-1").selectOption({ index: 1 });
  await a.getByTestId("hero-pick-Amber-3").selectOption({ index: 2 });
  await expect(portrait(a, "Amber-1").getByTestId("focus-hero")).toHaveCount(1);
  await openMenu(a, "Amber-1");
  await expect(menu(a).getByRole("menuitem")).toHaveText(["Kill", "Mark not seen", "Change hero…"]);
  // At the pointer (the column's middle), inside the window.
  const pb = (await portrait(a, "Amber-1").boundingBox())!;
  const mb = (await menu(a).boundingBox())!;
  expect(Math.abs(mb.x - (pb.x + pb.width / 2))).toBeLessThan(4);
  expect(Math.abs(mb.y - (pb.y + pb.height / 2))).toBeLessThan(4);
  await a.screenshot({ path: "shots/portrait-menu.png" });
  await menu(a).getByRole("menuitem", { name: "Kill" }).click();
  await expect(menu(a)).toHaveCount(0);
  await expect(tok(b, "Amber-1")).toHaveClass(/dead/);
  await expect(tok(b, "Amber-1").locator(".dead-badge")).toHaveCount(1);
  await expect(portrait(b, "Amber-1")).toHaveClass(/dead/);

  // The menu names what it would do now: Revive.
  await openMenu(a, "Amber-1");
  await expect(menu(a).getByRole("menuitem").first()).toHaveText("Revive");
  await a.screenshot({ path: "shots/portrait-menu-dead.png" });
  await menu(a).getByRole("menuitem", { name: "Revive" }).click();
  await expect(tok(b, "Amber-1")).not.toHaveClass(/dead/);
  await expect(tok(b, "Amber-1").locator(".dead-badge")).toHaveCount(0);

  // Vision, the same way: a ghost with the eye-slash for everyone, and back.
  await openMenu(a, "Amber-2");
  await menu(a).getByRole("menuitem", { name: "Mark not seen" }).click();
  await expect(tok(b, "Amber-2")).toHaveAttribute("data-visible", "false");
  await expect(tok(b, "Amber-2")).toHaveClass(/ghost/);
  await expect(tok(b, "Amber-2").getByTestId("unseen-mark")).toHaveCount(1);
  await expect(portrait(b, "Amber-2")).toHaveClass(/unseen/);
  await openMenu(a, "Amber-2");
  await menu(a).getByRole("menuitem", { name: "Mark in vision" }).click();
  await expect(tok(b, "Amber-2")).toHaveAttribute("data-visible", "true");
  await expect(tok(b, "Amber-2").getByTestId("unseen-mark")).toHaveCount(0);

  // Change hero… opens the picker for that slot.
  await openMenu(a, "Amber-3");
  await menu(a).getByRole("menuitem", { name: "Change hero…" }).click();
  await expect(a.getByTestId("hero-picker")).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("hero-picker")).toHaveCount(0);

  // A press outside closes it, and does nothing else.
  await openMenu(a, "Amber-4");
  await a.mouse.click(5, 450);
  await expect(menu(a)).toHaveCount(0);
  await expect(tok(b, "Amber-4")).not.toHaveClass(/dead/);
});

test("the menu by keyboard: focus on the first item, arrows move and wrap, Enter runs, Escape closes", async ({ browser }) => {
  const url = await newBoardUrl(server, "portrait keys");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  const focused = () => a.evaluate(() => document.activeElement?.getAttribute("data-testid"));

  await openMenu(a, "Sapphire-0");
  expect(await focused()).toBe("hero-menu-life");
  await a.keyboard.press("ArrowDown");
  expect(await focused()).toBe("hero-menu-vision");
  await a.keyboard.press("ArrowDown");
  await a.keyboard.press("ArrowDown"); // past the last: back to the first
  expect(await focused()).toBe("hero-menu-life");
  await a.keyboard.press("ArrowUp"); // before the first: the last
  expect(await focused()).toBe("hero-menu-hero");
  // Escape closes, changes nothing, and gives focus back to the portrait it came from.
  await a.keyboard.press("Escape");
  await expect(menu(a)).toHaveCount(0);
  expect(await a.evaluate(() => document.activeElement?.closest(".tb-player")?.getAttribute("data-slot"))).toBe("Sapphire-0");
  await expect(a.getByTestId("hero-picker")).toHaveCount(0);

  // Enter on the first item: killed, for the other editor too.
  await openMenu(a, "Sapphire-0");
  await a.keyboard.press("Enter");
  await expect(menu(a)).toHaveCount(0);
  await expect(tok(b, "Sapphire-0")).toHaveClass(/dead/);
  // Down, Enter: vision. Space runs an item too: revive.
  await openMenu(a, "Sapphire-0");
  await a.keyboard.press("ArrowDown");
  await a.keyboard.press("Enter");
  await expect(tok(b, "Sapphire-0")).toHaveAttribute("data-visible", "false");
  await openMenu(a, "Sapphire-0");
  await a.keyboard.press(" ");
  await expect(tok(b, "Sapphire-0")).not.toHaveClass(/dead/);
  await expect(tok(b, "Sapphire-0")).toHaveAttribute("data-visible", "false");

  // K stays the map's kill key for the hero under the pointer.
  const t = (await tok(a, "Sapphire-1").boundingBox())!;
  await a.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await a.keyboard.press("k");
  await expect(tok(b, "Sapphire-1")).toHaveClass(/dead/);
});

test("a viewer gets no menu and no token buttons, but sees dead and unseen", async ({ browser }) => {
  const url = await newBoardUrl(server, "portrait viewer");
  const a = await joinNew(browser, url, "Coach");
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  await openMenu(a, "Amber-0");
  await menu(a).getByRole("menuitem", { name: "Kill" }).click();
  await openMenu(a, "Amber-5");
  await menu(a).getByRole("menuitem", { name: "Mark not seen" }).click();
  await expect(tok(v, "Amber-0")).toHaveClass(/dead/);
  await expect(tok(v, "Amber-5").getByTestId("unseen-mark")).toHaveCount(1);

  await portrait(v, "Amber-0").click({ button: "right" });
  await v.waitForTimeout(300);
  await expect(menu(v)).toHaveCount(0);
  await tok(v, "Amber-0").hover();
  await expect(v.locator(".mapbox .tok [data-testid=vision], .mapbox .tok [data-testid=life]")).toHaveCount(0);
  await v.mouse.move(5, 450);
  await v.locator("[data-testid=map]").screenshot({ path: "shots/portrait-menu-viewer-map.png" });
});
