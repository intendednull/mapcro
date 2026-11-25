// Two people in one scene note: whoever else is in it is tagged, an incoming save doesn't wipe
// what you've typed and not saved, and on blur the last writer wins.

import { expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("two people typing in the note: tagged, no lost words while typing, last writer wins", async ({ browser }) => {
  const url = await newBoardUrl(server, "notes");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Juno");
  const noteA = a.getByTestId("scene-note-edit");
  const noteB = b.getByTestId("scene-note-edit");
  await revealControls(a, "scene-note-edit");
  await revealControls(b, "scene-note-edit");

  // Coach starts the scene's first note: Juno sees who is in it.
  await noteA.fill("Boss at 8:00");
  await expect(b.getByTestId("note-editing")).toHaveText("Coach · editing");
  await expect(a.getByTestId("note-editing")).toHaveCount(0);

  // Juno types too, before Coach saves.
  await noteB.fill("Hold the west stairs");
  await expect(a.getByTestId("note-editing")).toHaveText("Juno · editing");

  // Coach's save arrives while Juno is still typing: Juno keeps her unsaved text.
  await noteA.blur();
  await expect(b.getByTestId("note-editing")).toHaveCount(0);
  await expect(a.getByTestId("scene-note-edit")).toHaveValue("Boss at 8:00");
  await b.waitForTimeout(400); // time for the save to reach Juno
  await expect(noteB).toHaveValue("Hold the west stairs");

  // Coach is back in the note without typing: Juno's save shows up there live. Last writer wins.
  await noteA.focus();
  await expect(b.getByTestId("note-editing")).toHaveText("Coach · editing");
  await noteB.blur();
  await expect(noteA).toHaveValue("Hold the west stairs");
  await expect(a.getByTestId("note-editing")).toHaveCount(0);
  await noteA.blur();

  // A reload agrees.
  await b.reload();
  await revealControls(b, "scene-note-edit");
  await expect(b.getByTestId("scene-note-edit")).toHaveValue("Hold the west stairs");
});

test("typing in a scene note when the scene switches saves the draft to the scene it was typed on", async ({ browser }) => {
  const url = await newBoardUrl(server, "notes on flip");
  const presenter = await joinNew(browser, url, "Coach");
  const follower = await joinNew(browser, url, "Juno");

  // Add Scene 2, switch back to Scene 1, and have Juno follow Coach.
  await presenter.getByTestId("scene-add").click();
  await presenter.getByTestId("scene-card").nth(0).click();
  await expect(presenter.getByTestId("scene-card").nth(0)).toHaveAttribute("aria-current", "true");
  await follower.getByTestId("follow-Coach").click();
  await expect(follower.getByTestId("follow-chip")).toContainText("Following Coach");

  // Juno starts typing in Scene 1's note without blurring; Coach flips to Scene 2.
  const noteF = follower.getByTestId("scene-note-edit");
  await revealControls(follower, "scene-note-edit");
  await noteF.focus();
  await noteF.fill("Contest urn at 10:00");
  await presenter.getByTestId("scene-card").nth(1).click();

  // Juno lands on Scene 2 cleanly (Scene 2's note stays empty, never receiving Scene 1's text).
  await expect(follower.getByTestId("scene-card").nth(1)).toHaveAttribute("aria-current", "true");
  await expect(noteF).toHaveValue("");
  // Juno stayed in the note field, so Coach sees her editing Scene 2's note now.
  await expect(presenter.getByTestId("note-editing")).toHaveText("Juno · editing");

  // Switching back to Scene 1 shows Juno's draft was saved on Scene 1 (for both peers).
  await presenter.getByTestId("scene-card").nth(0).click();
  await revealControls(presenter, "scene-note-edit");
  await expect(presenter.getByTestId("scene-note-edit")).toHaveValue("Contest urn at 10:00");
  await expect(noteF).toHaveValue("Contest urn at 10:00");
});
