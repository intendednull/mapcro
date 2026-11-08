// Screenshots for review: the board, the share dialog and the phone layout. Run with
// MAPCRO_SHOTS=<name> (e.g. before / after) to write web/shots/<name>-*.png.
import { devices, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

test("screenshots", async ({ browser }) => {
  const name = process.env.MAPCRO_SHOTS;
  test.skip(!name, "set MAPCRO_SHOTS to write screenshots");
  const server = new Server();
  await server.start();
  try {
    const url = await newBoardUrl(server, "Scrim prep vs Night Owls");
    const a = await joinNew(browser, url, "Coach");
    await a.keyboard.press("d");
    await a.screenshot({ path: `shots/${name}-board.png` });
    await a.getByTestId("share").click();
    await expect(a.getByTestId("share-dialog")).toBeVisible();
    await a.screenshot({ path: `shots/${name}-share.png` });
    const ctx = await browser.newContext({ ...devices["iPhone 13"] } as never);
    const phone = await ctx.newPage();
    await phone.goto(url);
    await phone.screenshot({ path: `shots/${name}-phone-join.png` });
    await phone.locator("#join-name").fill("Guest");
    await phone.keyboard.press("Enter");
    await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");
    await phone.screenshot({ path: `shots/${name}-phone.png`, fullPage: true });
  } finally {
    server.stop();
  }
});
