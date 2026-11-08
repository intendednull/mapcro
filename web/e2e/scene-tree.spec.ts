// Scenes as a tree in the left sidebar: add as child, drag to nest and reorder (one step per
// drop), the same tree for everyone, collapse that's yours, and ← → walking the tree in order.

import { type Page, expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const rows = (p: Page) => p.getByTestId("scene-card");
/** The tree as "name@depth", top to bottom, as shown. */
const tree = (p: Page) =>
  rows(p).evaluateAll((els) => els.map((e) => `${(e.querySelector(".name")?.textContent ?? "").trim()}@${e.getAttribute("data-depth")}`));
const current = (p: Page) => p.locator('[data-testid="scene-card"][aria-current="true"] .name').textContent();
async function rename(p: Page, name: string) {
  await p.getByTestId("scene-name").click();
  await p.getByTestId("scene-name-input").fill(name);
  await p.keyboard.press("Enter");
}

test("nest, reorder and collapse scenes; everyone sees the same tree; ← → walk it", async ({ browser }) => {
  const url = await newBoardUrl(server, "tree");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await rename(a, "Early");
  // Early ─ Rotate (child) ─ Bridge (its sibling); then Late at the top level. The header's "+"
  // adds a scene after the current one; nesting is a drag onto a row.
  await a.getByTestId("scene-add").click();
  await rename(a, "Rotate");
  await rows(a).filter({ hasText: "Rotate" }).dragTo(rows(a).filter({ hasText: "Early" }), { targetPosition: { x: 80, y: 15 } });
  await expect.poll(() => tree(a)).toEqual(["Early@0", "Rotate@1"]);
  await a.getByTestId("scene-add").click(); // after Rotate, its sibling
  await rename(a, "Bridge");
  await rows(a).first().click();
  await a.getByTestId("scene-add").click(); // after Early: its next sibling, after its children
  await rename(a, "Late");
  await expect.poll(() => tree(a)).toEqual(["Early@0", "Rotate@1", "Bridge@1", "Late@0"]);
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Rotate@1", "Bridge@1", "Late@0"]);

  // Drag Late onto the middle of Rotate: it nests there. Then Bridge above Rotate: a reorder.
  await rows(a).filter({ hasText: "Late" }).dragTo(rows(a).filter({ hasText: "Rotate" }), { targetPosition: { x: 80, y: 15 } });
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Rotate@1", "Late@2", "Bridge@1"]);
  await rows(a).filter({ hasText: "Bridge" }).dragTo(rows(a).filter({ hasText: "Rotate" }), { targetPosition: { x: 80, y: 2 } });
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Bridge@1", "Rotate@1", "Late@2"]);
  // A scene can't go under its own child: nothing changes.
  await rows(a).filter({ hasText: "Rotate" }).dragTo(rows(a).filter({ hasText: "Late" }), { targetPosition: { x: 80, y: 15 } });
  await a.waitForTimeout(300);
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Bridge@1", "Rotate@1", "Late@2"]);
  // One undo takes back one drop.
  await a.keyboard.press("Control+z");
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Rotate@1", "Late@2", "Bridge@1"]);
  await a.keyboard.press("Control+y");
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Bridge@1", "Rotate@1", "Late@2"]);

  // ← → walk the tree depth-first.
  await rows(b).first().click();
  const seen = [await current(b)];
  for (let i = 0; i < 3; i++) {
    await b.keyboard.press("ArrowRight");
    await expect.poll(() => current(b)).not.toBe(seen.at(-1));
    seen.push(await current(b));
  }
  expect(seen.map((x) => x?.trim())).toEqual(["Early", "Bridge", "Rotate", "Late"]);

  // Collapse is yours: B folds Early; A still sees it all; B's survives a reload.
  await rows(b).filter({ hasText: "Early" }).getByTestId("scene-caret").click();
  await expect.poll(() => tree(b)).toEqual(["Early@0"]);
  await expect.poll(() => tree(a)).toEqual(["Early@0", "Bridge@1", "Rotate@1", "Late@2"]);
  await b.reload();
  await expect.poll(() => tree(b)).toEqual(["Early@0"]);
  await rows(b).filter({ hasText: "Early" }).getByTestId("scene-caret").click();
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Bridge@1", "Rotate@1", "Late@2"]);

  // Deleting a parent moves its children up a level, in one step.
  await rows(a).filter({ hasText: "Rotate" }).hover();
  await rows(a).filter({ hasText: "Rotate" }).getByTestId("scene-delete").click();
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Bridge@1", "Late@1"]);
  await a.keyboard.press("Control+z");
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Bridge@1", "Rotate@1", "Late@2"]);

  // Rename in place: double-click a row's name.
  await rows(a).filter({ hasText: "Bridge" }).locator(".name").dblclick();
  await a.getByTestId("scene-row-name-input").fill("Bridge fight");
  await a.keyboard.press("Enter");
  await expect.poll(() => tree(b)).toEqual(["Early@0", "Bridge fight@1", "Rotate@1", "Late@2"]);

  // A hover shows the scene's minimap.
  await rows(a).filter({ hasText: "Late" }).hover();
  await expect(a.getByTestId("scene-peek")).toBeVisible();
  await a.screenshot({ path: "shots/scene-tree.png" });
  await rows(a).filter({ hasText: "Bridge fight" }).hover();
  await a.getByTestId("scene-tree").screenshot({ path: "shots/scene-sidebar-sandbox.png" });
  await expect(a.getByTestId("scene-from-match")).toHaveCount(0);
  await a.getByTestId("scene-tree-fold").click();
  await expect(rows(a)).toHaveCount(0);
  await a.screenshot({ path: "shots/scene-tree-folded.png" });
});

test("on a phone the scenes are a drawer", async ({ browser }) => {
  const url = await newBoardUrl(server, "drawer");
  const a = await joinNew(browser, url, "Coach");
  await a.getByTestId("scene-add").click();
  const rowsA = a.getByTestId("scene-card");
  await rowsA.nth(1).dragTo(rowsA.nth(0), { targetPosition: { x: 80, y: 15 } });
  await expect(rowsA.nth(1)).toHaveAttribute("data-depth", "1");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Fan");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("scene-tree")).toHaveCount(0);
  await phone.getByTestId("scene-drawer").click();
  await expect(rows(phone)).toHaveCount(2);
  await expect(rows(phone).nth(1)).toHaveAttribute("data-depth", "1");
  // The drawer's header has the same "+" (for editors; this phone joined with the owner link).
  await expect(phone.getByTestId("scene-add")).toBeVisible();
  await phone.screenshot({ path: "shots/scene-drawer-phone.png" });
  await rows(phone).nth(1).click();
  await expect(phone.getByTestId("scene-tree")).toHaveCount(0); // a flip closes it
});
