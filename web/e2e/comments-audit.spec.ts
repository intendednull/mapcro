// Visual audit of every comment state with real art (operator, 2026-11-07). Writes
// shots/comments-audit/<name>.png. Needs MAPCRO_SHOT_PACKS (a PACKS_DIR outside the repo).
import { type Page, devices, expect, test } from "./fixtures";
import { editLink, joinNew, mapPoint } from "./helpers";
import { Server, newBoardUrl } from "./server";

const dir = process.env.AUDIT_DIR ?? "shots/comments-audit";
const LONG = "Smoke the bridge, then rotate east through the vault and hold the walker until 9:30";

async function place(p: Page, f: [number, number], text: string) {
  await p.keyboard.press("s");
  const at = await mapPoint(p, ...f);
  await p.mouse.click(at.x, at.y);
  await p.getByTestId("comment-input").fill(text);
  await p.keyboard.press("Enter");
  await p.keyboard.press("q");
}
const shot = (p: Page, name: string) => p.locator(".mapbox, .p-map").first().screenshot({ path: `${dir}/${name}.png` });
const NAMES = ["Smoke on the bridge", "Smoke the bridge, then", "Right edge", "Top left corner", "On the mid boss", "Overlapping", "On a hero"];
const bubble = (p: Page, i: number) => p.locator(".mapbox [data-callout]").filter({ hasText: NAMES[i]! });

test("comment states", async ({ browser }) => {
  const packs = process.env.MAPCRO_SHOT_PACKS;
  test.skip(!packs, "set MAPCRO_SHOT_PACKS");
  test.setTimeout(180_000);
  const server = new Server(packs);
  await server.start();
  try {
    const url = await newBoardUrl(server, "audit");
    const a = await joinNew(browser, url, "Coach");
    const b = await joinNew(browser, await editLink(server.url, url), "Marrow");
    // Placing: the editor open on a new comment.
    await a.keyboard.press("s");
    const at = await mapPoint(a, 0.62, 0.42);
    await a.mouse.click(at.x, at.y);
    await a.getByTestId("comment-input").fill("Smoke on the bridge");
    await shot(a, "01-placing");
    await a.keyboard.press("Enter");
    await a.keyboard.press("q");
    await place(a, [0.3, 0.55], LONG); // long
    await place(a, [0.97, 0.5], "Right edge"); // near the frame
    await place(a, [0.05, 0.05], "Top left corner");
    await place(a, [0.5, 0.5], "On the mid boss");
    await place(a, [0.505, 0.505], "Overlapping");
    await place(a, [0.36, 0.87], "On a hero");
    for (const vp of ["amber", "sapphire"] as const) {
      if (vp === "sapphire") await a.getByTestId("viewpoint-flip").click();
      for (const zoom of ["fit", "zoom"] as const) {
        if (zoom === "zoom") {
          const m = await mapPoint(a, 0.55, 0.45);
          await a.mouse.move(m.x, m.y);
          await a.mouse.wheel(0, -500);
          await a.waitForTimeout(200);
        }
        const k = `${vp}-${zoom}`;
        await a.mouse.move(5, 5);
        await shot(a, `02-bubbles-${k}`);
        await bubble(a, 0).locator(".bubble-body").hover();
        await shot(a, `03-hover-${k}`);
        await a.mouse.move(5, 5);
        await bubble(a, zoom === "zoom" ? 0 : 1).locator(".bubble-body").click();
        await shot(a, `04-open-${k}`);
        await a.keyboard.press("Escape");
        await a.getByTestId("comments-toggle").click();
        await shot(a, `05-all-open-${k}`);
        await a.getByTestId("comments-toggle").click();
        if (zoom === "zoom") {
          const m = await mapPoint(a, 0.5, 0.5);
          await a.mouse.move(m.x, m.y);
          await a.mouse.wheel(0, 2000);
          await a.waitForTimeout(200);
        }
      }
    }
    await a.getByTestId("viewpoint-flip").click();
    // Edit mode on an open card.
    await bubble(a, 0).locator(".bubble-body").click();
    await bubble(a, 0).locator("text").dblclick();
    await expect(a.getByTestId("comment-input")).toBeVisible();
    await shot(a, "06-editing");
    await shot(b, "07-someone-else-editing");
    await a.keyboard.press("Escape");
    // Dragging a bubble: the dragger and the remote preview.
    const bb = (await bubble(a, 0).locator(".bubble-body").boundingBox())!;
    await a.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await a.mouse.down();
    await a.mouse.move(bb.x + 80, bb.y + 60, { steps: 6 });
    await shot(a, "08-dragging-bubble");
    await shot(b, "09-remote-drag");
    await a.mouse.up();
    // Dragging an open card.
    await bubble(a, 0).locator(".bubble-body").click();
    const tb = (await bubble(a, 0).locator("text").boundingBox())!;
    await a.mouse.move(tb.x + 10, tb.y + tb.height / 2);
    await a.mouse.down();
    await a.mouse.move(tb.x - 60, tb.y + 40, { steps: 6 });
    await shot(a, "10-dragging-card");
    await a.mouse.up();
    // A follower sees the presenter's open comment.
    await b.getByTestId("follow-Coach").click();
    await a.keyboard.press("Escape");
    await bubble(a, 2).locator(".bubble-body").click();
    await expect(bubble(b, 2)).toHaveAttribute("data-open", "true");
    await shot(b, "11-follower-sees-open");
    // Erase hover.
    await a.keyboard.press("Escape");
    await a.keyboard.press("d");
    await bubble(a, 4).locator(".bubble-body").hover();
    await shot(a, "12-erase-hover");
    await a.keyboard.press("q");
    // Phone, both sides.
    const ctx = await browser.newContext({ ...devices["iPhone 13"] } as never);
    const phone = await ctx.newPage();
    await phone.goto(url);
    await phone.locator("#join-name").fill("Phone");
    await phone.keyboard.press("Enter");
    await phone.locator(".p-map").first().screenshot({ path: `${dir}/13-phone-amber.png` });
    await phone.getByTestId("viewpoint-flip").click();
    await phone.locator(".p-map").first().screenshot({ path: `${dir}/14-phone-sapphire.png` });
  } finally {
    server.stop();
  }
});
