import { expect, test } from "./fixtures";
import { Server } from "./server";

let server: Server;
test.beforeAll(async () => { server = new Server(); await server.start(); });
test.afterAll(() => server.stop());

test("landing replay picker is reachable and opens with the keyboard", async ({ page }) => {
  await page.goto(server.url);
  await page.getByRole("textbox", { name: "Match id", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Select replay file" })).toBeFocused();
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  await (await chooser).setFiles({ name: "123456.dem", mimeType: "application/octet-stream", buffer: Buffer.from("PBDEMS2\0") });
  await expect(page.getByRole("button", { name: "123456.dem" })).toBeFocused();
  await expect(page.getByTestId("open-match-go")).toHaveText("Open match");
});
