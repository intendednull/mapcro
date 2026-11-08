// Slice 3: the in-game top bar, edited in place, on the real server with two browsers.

import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const col = (p: Page, slot: string) => p.locator(`.tb-player[data-slot="${slot}"]`);
const souls = (p: Page, slot: string) => col(p, slot).getByTestId("souls");
const ult = (p: Page, slot: string) => col(p, slot).getByTestId("ult");

async function typeSouls(p: Page, slot: string, text: string) {
  await souls(p, slot).click();
  await p.getByTestId("souls-input").fill(text);
  await p.keyboard.press("Enter");
}

test("souls, totals, clock and ult edited in place and seen by everyone", async ({ browser }) => {
  const url = await newBoardUrl(server, "topbar");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");

  await typeSouls(a, "Amber-0", "9040");
  await typeSouls(a, "Amber-1", "7.3k");
  await expect(souls(b, "Amber-0")).toHaveText("9.0k");
  await expect(souls(b, "Amber-1")).toHaveText("7.3k");
  // Totals are sums, truncated: 16,340 is "16k".
  await expect(b.getByTestId("total-Amber")).toHaveText("16k");
  await expect(b.getByTestId("total-Sapphire")).toHaveText("0");
  // Friendly total left of centre, enemy right (a class clash once stacked them).
  const [fa, fs] = [(await b.getByTestId("total-Amber").boundingBox())!, (await b.getByTestId("total-Sapphire").boundingBox())!];
  expect(fa.x + fa.width).toBeLessThanOrEqual(fs.x + 1);

  // Not a number: the editor stays open and nothing is sent.
  await souls(a, "Amber-2").click();
  await a.getByTestId("souls-input").fill("lots");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("souls-input")).toHaveClass(/bad/);
  await a.keyboard.press("Escape");
  await expect(souls(b, "Amber-2")).toHaveText("–");

  // The clock in the bar is the scene's clock.
  await a.getByTestId("tb-clock").click();
  await a.getByTestId("tb-clock-input").fill("8:00");
  await a.keyboard.press("Enter");
  await expect(b.getByTestId("tb-clock")).toHaveText("8:00");
  await expect(b.getByTestId("scene-clock")).toHaveText("8:00");

  // Ult: untracked until clicked; a click is ready; a drag around the ring sets the cooldown.
  await expect(ult(b, "Amber-3")).toHaveAttribute("data-ult", "untracked");
  await ult(a, "Amber-3").click();
  await expect(ult(b, "Amber-3")).toHaveAttribute("data-ult", "0");
  const box = (await ult(a, "Amber-3").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await a.mouse.move(cx, cy);
  await a.mouse.down();
  await a.mouse.move(cx, cy - 20, { steps: 3 });
  await a.mouse.move(cx + 20, cy - 20, { steps: 3 });
  await a.mouse.move(cx + 20, cy, { steps: 3 }); // 3 o'clock: a quarter of the cooldown left
  await expect(ult(a, "Amber-3")).toHaveClass(/adjusting/);
  await a.mouse.up();
  await expect(ult(b, "Amber-3")).toHaveAttribute("data-ult", "25");
  // Scrolling steps by 5%, and a burst of ticks lands as one edit.
  await a.mouse.move(cx, cy);
  await a.mouse.wheel(0, 100);
  await a.mouse.wheel(0, 100);
  await expect(ult(b, "Amber-3")).toHaveAttribute("data-ult", "35");

  // Per scene: a new scene starts from these numbers, and edits there leave scene 1 alone.
  await a.getByTestId("scene-add").click();
  await expect(souls(a, "Amber-0")).toHaveText("9.0k");
  await typeSouls(a, "Amber-0", "12000");
  await expect(souls(a, "Amber-0")).toHaveText("12k");
  await expect(souls(b, "Amber-0")).toHaveText("9.0k");

  // The viewer's team sits on the left.
  await expect(b.locator(".tb-team").first()).toHaveClass(/friend amber/);
  await b.getByTestId("viewpoint-flip").click();
  await expect(b.locator(".tb-team.friend")).toHaveClass(/sapphire/);

  await b.reload();
  await expect(souls(b, "Amber-0")).toHaveText("9.0k");
  await expect(ult(b, "Amber-3")).toHaveAttribute("data-ult", "35");
  await a.screenshot({ path: "shots/slice3-topbar.png" });
});

test("a viewer sees the bar but can't edit it", async ({ browser }) => {
  const url = await newBoardUrl(server, "topbar-view");
  const owner = await joinNew(browser, url, "Coach");
  await typeSouls(owner, "Sapphire-0", "9040");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const r = await fetch(`${server.url}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: "view", label: "guest" }),
  });
  const { token: view } = (await r.json()) as { token: string };
  const v = await joinNew(browser, `${server.url}/b/${board}#${view}`, "Guest");
  await expect(souls(v, "Sapphire-0")).toHaveText("9.0k");
  await souls(v, "Sapphire-0").click();
  await expect(v.getByTestId("souls-input")).toHaveCount(0);
  await v.getByTestId("total-Sapphire").click();
  await expect(v.getByTestId("total-edit-Sapphire-input")).toHaveCount(0);
  // Untracked rings stay hidden for viewers, as in game.
  await expect(ult(v, "Sapphire-1")).toBeHidden();
});

test("a team total set by hand is shared out evenly, in one undoable step", async ({ browser }) => {
  const url = await newBoardUrl(server, "net worth");
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Marrow");
  await typeSouls(a, "Amber-0", "9040");
  await expect(b.getByTestId("total-Amber")).toHaveText("9.0k");

  // Click the total and type: while A edits, B sees who.
  await a.getByTestId("total-Amber").click();
  await expect(b.getByTestId("total-Amber").locator('.tb-tag[data-tag="Coach"]')).toContainText("Coach · editing");
  await a.getByTestId("total-edit-Amber-input").fill("40"); // 40k
  await a.keyboard.press("Enter");
  // 40,000 over six: 6,667 for the first four in roster order, 6,666 for the last two.
  const want = ["6.6k", "6.6k", "6.6k", "6.6k", "6.6k", "6.6k"];
  await expect(b.locator('.tb-player.amber [data-testid="souls"]')).toHaveText(want);
  await expect(b.getByTestId("total-Amber")).toHaveText("40k");
  await expect(b.getByTestId("total-Amber").locator(".tb-tag")).toHaveCount(0);
  await expect(b.getByTestId("total-Sapphire")).toHaveText("0");
  // Exact parts: the souls editor shows the raw number.
  for (const [i, n] of [6667, 6667, 6667, 6667, 6666, 6666].entries()) {
    await b.locator(`.tb-player[data-slot="Amber-${i}"]`).getByTestId("souls").click();
    await expect(b.getByTestId("souls-input")).toHaveValue(String(n));
    await b.keyboard.press("Escape");
  }

  // One undo puts every hero back.
  await a.keyboard.press("Control+z");
  await expect(b.locator('.tb-player.amber [data-testid="souls"]')).toHaveText(["9.0k", "–", "–", "–", "–", "–"]);
  await expect(b.getByTestId("total-Amber")).toHaveText("9.0k");
});
