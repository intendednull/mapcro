// Dragging on the board never selects page text; fields still select (QA 2026-11-07).

import { expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";
import { heroPack } from "./synthetic";

let server: Server;
test.beforeAll(async () => {
  server = new Server(heroPack(14));
  await server.start();
});
test.afterAll(() => server.stop());

test("dragging on the empty stage beside the map selects no page text", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "no select"), "Coach");
  const stage = (await a.locator(".stage").boundingBox())!;
  const map = (await a.getByTestId("map").boundingBox())!;
  // From the empty strip left of the map, across the map and the top bar, to the right side.
  await a.mouse.move(stage.x + 6, map.y + map.height / 2);
  await a.mouse.down();
  await a.mouse.move(stage.x + stage.width - 6, stage.y + 8, { steps: 10 });
  await a.mouse.up();
  expect(await a.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  // Text fields still select.
  await a.getByLabel("Scene note").fill("keep this selectable");
  await a.getByLabel("Scene note").selectText();
  expect(await a.evaluate(() => (document.activeElement as HTMLTextAreaElement).selectionEnd)).toBeGreaterThan(5);
});
