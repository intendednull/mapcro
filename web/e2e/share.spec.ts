// Slice 6: share and clone on the real server. The owner mints an edit link, the editor shares
// a view link onward, the owner sees both as a tree, and a viewer clones the board into its own.

import { expect, test } from "@playwright/test";
import { dragToken, joinNew, tokenAt } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("mint, share onward, see the tree, clone", async ({ browser }) => {
  const url = await newBoardUrl(server, "Scrim prep");
  const a = await joinNew(browser, url, "Coach");
  await dragToken(a, "Amber-0", 0.5, 0.6);
  const moved = await tokenAt(a, "Amber-0");

  // The owner mints an edit link.
  await a.getByTestId("share").click();
  const dlg = a.getByTestId("share-dialog");
  await expect(dlg.getByTestId("link-list")).toContainText("All links"); // the owner's view: every link
  await dlg.getByLabel("Label").fill("Marrow's laptop");
  await dlg.getByRole("button", { name: "Can edit" }).click();
  await dlg.getByTestId("mint").click();
  await expect(dlg.getByTestId("minted-role")).toHaveText("Can edit");
  const editUrl = (await dlg.getByTestId("minted-url").textContent())!;
  expect(editUrl).toMatch(/\/b\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/);
  await a.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);

  // The editor can edit and share onward, and sees only its own links.
  const b = await joinNew(browser, editUrl, "Marrow");
  await expect(b.getByTestId("share")).toBeVisible();
  await b.getByTestId("share").click();
  const bd = b.getByTestId("share-dialog");
  await expect(bd.getByTestId("link-list")).toContainText("Your links"); // an editor's view: its own
  await expect(bd.locator(".link-row")).toHaveCount(0);
  await bd.getByLabel("Label").fill("VOD watchers");
  await bd.getByTestId("mint").click();
  await expect(bd.getByTestId("minted-role")).toHaveText("View only");
  const viewUrl = (await bd.getByTestId("minted-url").textContent())!;
  await expect(bd.locator('[data-link="VOD watchers"]')).toContainText("you ·");

  // The owner sees the tree: the view link nested under the edit link it came from. Only the
  // link minted on this device can be copied again (the server keeps hashes, not tokens).
  await a.getByTestId("share").click();
  const rowE = dlg.locator('[data-link="Marrow\'s laptop"]');
  const rowV = dlg.locator('[data-link="VOD watchers"]');
  await expect(rowE).toContainText("you ·");
  await expect(rowV).toHaveClass(/child/);
  await expect(rowV).toContainText("from “Marrow's laptop”");
  await expect(rowE.getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(rowV.getByRole("button", { name: "Copy" })).toHaveCount(0);
  await a.screenshot({ path: "shots/slice6-share-owner.png" });
  await a.keyboard.press("Escape");

  // A viewer has no Share, but can clone: it lands on the copy as its owner, Share ready.
  const v = await joinNew(browser, viewUrl, "Guest");
  await expect(v.getByTestId("share")).toHaveCount(0);
  await v.getByTestId("clone").click();
  await expect(v.locator("#clone-title")).toHaveValue("Scrim prep (copy)");
  await v.getByTestId("clone-go").click();
  await v.waitForURL((u) => !u.href.includes(new URL(viewUrl).pathname));
  await expect(v.getByTestId("board-title")).toHaveText("Scrim prep (copy)");
  await expect(v.getByTestId("join-card")).toHaveCount(0);
  await expect(v.getByTestId("owner-note")).toContainText("You own this copy");
  await expect(v.getByTestId("share")).toBeVisible();
  await expect.poll(() => tokenAt(v, "Amber-0")).toEqual(moved);
  await v.screenshot({ path: "shots/slice6-cloned.png" });

  // The copy is independent: a drag there doesn't reach the original.
  await dragToken(v, "Amber-0", 0.3, 0.3);
  await expect(v.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  expect(await tokenAt(a, "Amber-0")).toEqual(moved);
});
