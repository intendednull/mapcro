// The board's keys under the left hand, ordered by use (feedback #28, operator 2026-11-11): Q
// Select, W Laser, E Draw, A Arrow, S Comment, D Erase. C opens the Clear menu and Shift+C clears
// the scene at once (one undo step); T adds a scene after this one (#30). The toolbar shows each
// key, and its hover names it ("Select [Q]"). None of them fire while typing, in a dialog or a
// menu, or with Ctrl, Cmd or Alt held; Clear and T are an editor's only.

import { type Page, expect, test } from "./fixtures";
import { gesture, joinNew, mapPoint, revealControls, viewLink } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const KEYS = [
  ["q", "select", "Select"],
  ["w", "laser", "Laser"],
  ["e", "draw", "Draw"],
  ["a", "arrow", "Arrow"],
  ["s", "callout", "Comment"],
  ["d", "erase", "Erase"],
] as const;

const strokes = (p: Page) => p.locator(".mapbox [data-stroke]");
const arrows = (p: Page) => p.locator(".mapbox [data-arrow]");
const callouts = (p: Page) => p.locator(".mapbox [data-callout]");
/** A stroke, an arrow and a comment on the scene; the pointer left off the map. */
async function place(a: Page) {
  await a.keyboard.press("e");
  await gesture(a, [[0.3, 0.3], [0.42, 0.3]]);
  await a.keyboard.press("a");
  await gesture(a, [[0.55, 0.55], [0.7, 0.62]]);
  await a.keyboard.press("s");
  const at = await mapPoint(a, 0.62, 0.78);
  await a.mouse.click(at.x, at.y);
  await a.getByTestId("comment-input").fill("Ward here");
  await a.keyboard.press("Enter");
  await a.mouse.move(2, 2);
  await expect(strokes(a)).toHaveCount(1);
  await expect(arrows(a)).toHaveCount(1);
  await expect(callouts(a)).toHaveCount(1);
}

test("each tool's key picks it, in the toolbar's order, with the key on its hover; typing in a field picks nothing", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "tool keys"), "Coach");
  const on = a.locator('[data-testid=toolbar] [aria-pressed="true"]');
  await expect(a.locator("[data-testid=toolbar] [data-testid^=tool-]")).toHaveText(KEYS.map(([k, , label]) => `${label}${k.toUpperCase()}`));
  for (const [key, tool, label] of KEYS) {
    await a.keyboard.press(key);
    await expect(on, key).toHaveAttribute("data-testid", `tool-${tool}`);
    const button = a.getByTestId(`tool-${tool}`);
    await expect(button.locator(".k")).toHaveText(key.toUpperCase());
    await expect(button).toHaveAttribute("title", `${label} [${key.toUpperCase()}]`);
    await expect(button).toHaveAttribute("aria-keyshortcuts", key.toUpperCase());
  }
  // The old keys pick nothing now: R was Arrow (T was Comment: it adds a scene, below).
  await a.keyboard.press("e");
  await a.keyboard.press("r");
  await expect(on).toHaveAttribute("data-testid", "tool-draw");
  // Shift is no modifier for a tool key; Alt is.
  await a.keyboard.press("Shift+Q");
  await expect(on).toHaveAttribute("data-testid", "tool-select");
  await a.keyboard.press("Alt+e");
  await expect(on).toHaveAttribute("data-testid", "tool-select");
  await a.getByTestId("toolbar").screenshot({ path: "shots/tool-keys.png" });
  // In the scene note, the keys are text.
  const note = a.getByTestId("scene-note-edit");
  await revealControls(a, "scene-note-edit");
  await note.click();
  await a.keyboard.type("wedas");
  await expect(on).toHaveAttribute("data-testid", "tool-select");
});

test("C opens and closes the Clear menu; Shift+C clears the scene at once, one undo step; Ctrl+C and a dialog do neither", async ({ browser }) => {
  const url = await newBoardUrl(server, "clear keys");
  const a = await joinNew(browser, url, "Coach");
  const menu = a.getByTestId("clear-menu");
  await expect(menu).toHaveAttribute("title", "Clear [C]");
  await expect(menu).toHaveAttribute("aria-keyshortcuts", "C Shift+C");
  await place(a);
  // C toggles the menu; Escape closes it too.
  await a.keyboard.press("c");
  await expect(a.getByTestId("clear-pop")).toBeVisible();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await a.keyboard.press("c");
  await expect(a.getByTestId("clear-pop")).toHaveCount(0);
  await a.keyboard.press("c");
  await expect(a.getByTestId("clear-pop")).toBeVisible();
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("clear-pop")).toHaveCount(0);
  // Ctrl+C copies: no menu, nothing cleared.
  await a.keyboard.press("Control+c");
  await a.keyboard.press("Control+Shift+C");
  await expect(a.getByTestId("clear-pop")).toHaveCount(0);
  await expect(callouts(a)).toHaveCount(1);
  // In a dialog the keys are the dialog's.
  await a.getByTestId("share").click();
  const share = a.getByTestId("share-dialog");
  await expect(share).toBeVisible();
  await a.keyboard.press("Tab");
  await a.keyboard.press("Shift+C");
  await a.keyboard.press("Escape");
  await expect(share).toHaveCount(0);
  await expect(strokes(a)).toHaveCount(1);
  // Shift+C: everything on the scene goes, as the menu's All does, and one undo brings it back.
  await a.keyboard.press("Shift+C");
  await expect(strokes(a)).toHaveCount(0);
  await expect(arrows(a)).toHaveCount(0);
  await expect(callouts(a)).toHaveCount(0);
  await expect(a.getByTestId("toast")).toContainText("Scene cleared");
  await expect(a.getByTestId("clear-pop")).toHaveCount(0);
  await a.keyboard.press("Control+z");
  await expect(strokes(a)).toHaveCount(1);
  await expect(arrows(a)).toHaveCount(1);
  await expect(callouts(a)).toHaveCount(1);
  // A view link has no Clear, and its C clears nothing.
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  await expect(callouts(v)).toHaveCount(1);
  await expect(v.getByTestId("clear-menu")).toHaveCount(0);
  await v.keyboard.press("Shift+C");
  await v.keyboard.press("d");
  await expect(v.locator('[data-testid=toolbar] [aria-pressed="true"]')).toHaveAttribute("data-testid", "tool-select");
  await expect(callouts(a)).toHaveCount(1);
});

test("T adds a scene after this one, as the + does; not repeated, while typing, in a dialog, with Alt, or for a viewer", async ({ browser }) => {
  const url = await newBoardUrl(server, "split keys");
  const a = await joinNew(browser, url, "Coach");
  const cards = a.getByTestId("scene-card");
  await expect(a.getByTestId("scene-add")).toHaveAttribute("title", "Add scene [T]");
  await a.keyboard.press("t");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(a.getByText("Scene 2 of 2")).toBeVisible();
  // A held T's autorepeat adds nothing more.
  await a.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "t", code: "KeyT", repeat: true })));
  await a.keyboard.press("Alt+t");
  await revealControls(a, "scene-note-edit");
  await a.getByTestId("scene-note-edit").click();
  await a.keyboard.type("t");
  await a.getByTestId("share").click();
  await expect(a.getByTestId("share-dialog")).toBeVisible();
  await a.keyboard.press("Tab");
  await a.keyboard.press("t");
  await a.keyboard.press("Escape");
  await expect(a.getByTestId("share-dialog")).toHaveCount(0);
  await expect(cards).toHaveCount(2);
  // Then once more, from the second: a third, after it.
  await a.keyboard.press("t");
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(2)).toHaveAttribute("aria-current", "true");
  const v = await joinNew(browser, await viewLink(server.url, url), "Guest");
  await expect(v.getByTestId("scene-card")).toHaveCount(3);
  await v.keyboard.press("t");
  await expect(cards).toHaveCount(3);
  await expect(v.getByTestId("scene-card")).toHaveCount(3);
});
