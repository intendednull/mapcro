// Unnamed scenes are named by their place in the list (QA 2026-11-07).

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

test("unnamed scenes are named by their place, so a reorder keeps Scene 1 first", async ({ browser }) => {
  const url = await newBoardUrl(server, "scene names");
  const a = await joinNew(browser, url, "Coach");
  const rows = a.getByTestId("scene-card");
  const names = () => rows.locator(".name").allInnerTexts();
  await a.getByTestId("scene-add").click();
  await a.getByTestId("scene-add").click();
  await expect.poll(names).toEqual(["Scene 1", "Scene 2", "Scene 3"]);
  // The last one dragged to the top: still Scene 1, 2, 3 from the top.
  await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 60, y: 3 } });
  await expect(rows.nth(0)).toHaveAttribute("aria-current", "true");
  await expect.poll(names).toEqual(["Scene 1", "Scene 2", "Scene 3"]);
  await expect(a.getByText("Scene 1 of 3")).toBeVisible();
  // A renamed scene keeps its name wherever it goes.
  await a.getByTestId("scene-name").click();
  await a.getByTestId("scene-name-input").fill("Push mid");
  await a.keyboard.press("Enter");
  await rows.nth(0).dragTo(rows.nth(2), { targetPosition: { x: 60, y: 27 } });
  await expect.poll(names).toEqual(["Scene 1", "Scene 2", "Push mid"]);
  await a.getByTestId("scene-tree").screenshot({ path: "shots/scene-names-by-place.png" });
});
