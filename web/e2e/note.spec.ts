// Two people in one scene note: whoever else is in it is tagged, an incoming save doesn't wipe
// what you've typed and not saved, and on blur the last writer wins.

import { expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
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
  await expect(b.getByTestId("scene-note-edit")).toHaveValue("Hold the west stairs");
});
