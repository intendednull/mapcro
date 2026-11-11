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
  const map = (await page.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width * fx, map.y + map.height * fy, { steps: 8 });
  await page.mouse.up();
}

/** A point on the main map, as a fraction of its box, in page pixels. */
export async function mapPoint(page: Page, fx: number, fy: number) {
  const map = (await page.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  return { x: map.x + map.width * fx, y: map.y + map.height * fy };
}

/** Press, move through the given map fractions, release. */
export async function gesture(page: Page, path: Array<[number, number]>, steps = 5) {
  const [first, ...rest] = path;
  const p0 = await mapPoint(page, ...first!);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  for (const f of rest) {
    const p = await mapPoint(page, ...f);
    await page.mouse.move(p.x, p.y, { steps });
  }
  await page.mouse.up();
}

/** A view link for a board, from its owner link. */
export async function viewLink(serverUrl: string, ownerUrl: string): Promise<string> {
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(ownerUrl)!;
  const r = await fetch(`${serverUrl}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: "view", label: "guest" }),
  });
  const { token: view } = (await r.json()) as { token: string };
  return `${serverUrl}/b/${board}#${view}`;
}

/** An edit link for a board, from its owner link. */
export async function editLink(serverUrl: string, ownerUrl: string): Promise<string> {
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(ownerUrl)!;
  const r = await fetch(`${serverUrl}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: "edit", label: "teammate" }),
  });
  const { token: edit } = (await r.json()) as { token: string };
  return `${serverUrl}/b/${board}#${edit}`;
}

/** The main map's view rectangle, "x y w" in view units. */
export const viewOf = async (page: Page) => (await page.getByTestId("map").getAttribute("data-view"))!.split(" ").map(Number) as [number, number, number];

/** Close the full-replay prompt (spec §6b) that a Load opens when Valve has no replay, as a
 * coach who goes on with the API summary does: Use API summary. */
export async function useSummary(page: Page) {
  await page.getByTestId("replay-prompt-summary").click();
  await expect(page.getByTestId("replay-prompt")).toHaveCount(0);
}

/** Pick a slot's hero from its top-bar portrait's picker (the side roster is gone). */
export async function pickHero(page: Page, slot: string, hero: string) {
  const col = page.locator(`.tb-player[data-slot="${slot}"]:visible`).first();
  await col.hover();
  await col.getByTestId("pick-hero").click();
  await page.locator(`.hero-cell[data-hero="${hero}"]`).click();
  await expect(page.getByTestId("hero-picker")).toHaveCount(0);
}

/** Reveal a control the layout keeps out of sight until asked for: the scene note behind the
 * sidebar's Scene Notes tab, or one grouped in the replay source or map layers disclosure. */
export async function revealControls(page: Page, id: string) {
  if (id === "scene-note-edit") {
    await page.locator("#notes-tab").click();
    await expect(page.locator("#notes-panel")).toBeVisible();
    return;
  }
  const source = ["match-id", "match-load", "match-upload", "match-fetch", "mode-sandbox"].includes(id);
  const details = page.locator(source ? ".pl-source" : ".map-layers");
  if (!(await details.evaluate(el => (el as HTMLDetailsElement).open))) await details.locator("summary").click();
}
