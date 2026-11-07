// Browser helpers shared by the e2e specs.
import { type Browser, type Page, expect } from "@playwright/test";
import { translate } from "./server";

/** A fresh browser context (a separate device: its own storage) that joins `url` as `name`. */
export async function joinNew(browser: Browser, url: string, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(url);
  await page.locator("#join-name").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("join-card")).toBeHidden();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return page;
}

export const tokenAt = async (page: Page, slot: string) => translate(await page.locator(`.tok[data-slot="${slot}"]`).getAttribute("transform"));

/** Drag a token to a fraction of the map's box with the mouse. */
export async function dragToken(page: Page, slot: string, fx: number, fy: number) {
  const box = (await page.locator(`.tok[data-slot="${slot}"]`).boundingBox())!;
  const map = (await page.locator(".mapbox .mm-overlay.map").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width * fx, map.y + map.height * fy, { steps: 8 });
  await page.mouse.up();
}
