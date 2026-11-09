// The tools sit on keys close together under the left hand (operator, 2026-11-09: "lets have the
// tools be bound to keys that are close to each other, like qertasdf"): Move Q, Draw E, Arrow R,
// Comment T, Laser A, Erase S. W is unbound. The toolbar shows each key; typing in a field
// doesn't switch tools.

import { expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const KEYS = [
  ["e", "draw"],
  ["r", "arrow"],
  ["t", "callout"],
  ["a", "laser"],
  ["s", "erase"],
  ["q", "move"],
] as const;

test("each tool's key picks it, the toolbar shows the keys, and typing in a field picks nothing", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "tool keys"), "Coach");
  const on = a.locator('[data-testid=toolbar] [aria-pressed="true"]');
  for (const [key, tool] of KEYS) {
    await a.keyboard.press(key);
    await expect(on, key).toHaveAttribute("data-testid", `tool-${tool}`);
    await expect(a.getByTestId(`tool-${tool}`).locator(".k")).toHaveText(key.toUpperCase());
  }
  // W is left unbound, and the old keys pick nothing they used to (V was Move, L Laser, C Comment).
  await a.keyboard.press("e");
  for (const key of ["w", "v", "l", "c"]) {
    await a.keyboard.press(key);
    await expect(on, key).toHaveAttribute("data-testid", "tool-draw");
  }
  await a.getByTestId("toolbar").screenshot({ path: "shots/tool-keys.png" });
  // In the scene note, the keys are text.
  const note = a.getByTestId("scene-note-edit");
  await note.click();
  await a.keyboard.type("qrtas");
  await expect(on).toHaveAttribute("data-testid", "tool-draw");
});
