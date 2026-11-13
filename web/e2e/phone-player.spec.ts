// Synthetic replay and tooltip assets; no game art or player identities.
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, newBoardUrl } from "./server";

import { pack, timeline, INFUSER, ABILITY } from "./tooltip-fixture";
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-tooltips-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  writeFileSync(join(queue, "feedback-token"), "synthetic-test-only", { mode: 0o600 });
  server = new Server(pack(), { FEEDBACK_GITHUB_TOKEN_FILE: join(queue, "feedback-token"), FEEDBACK_GITHUB_API: `http://127.0.0.1:${port}`, MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const answered = new Set<string>();
async function open(p: Page, id: string) {
  await p.getByTestId("mode-player").click();
  if (await p.locator(".phone-player").count()) {
    // The phone: the match source is in More.
    await p.getByTestId("phone-more").tap();
    await p.getByTestId("phone-match").tap();
  } else await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify({
    ...timeline(id),
    troopers: { every_s: 1, amber: Array(41).fill(Buffer.from([1, 0, 0, 0, 0, 0]).toString("base64")), sapphire: Array(41).fill("") },
  }));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

const column = (p: Page) => p.locator(".phone-build-sheet [data-testid=hero-build]");
const float = (p: Page) => p.getByTestId("game-tooltip-float");


import { checkPhoneLayout, touchDrag } from "./phone-layout";

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }, { width: 390, height: 664 }, { width: 844, height: 390 }]) {
  test(`phone Player at ${viewport.width}×${viewport.height}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
    const phone = await ctx.newPage();
    await phone.goto(await newBoardUrl(server, "Phone Player"));
    await phone.locator("#join-name").fill("Coach");
    await phone.keyboard.press("Enter");
    await open(phone, String(129001000 + viewport.width));
    await scrubTo(phone, 20);
    await expect(phone.locator(".p-map .tok")).toHaveCount(12);
    await expect(phone.getByTestId("trooper")).toHaveCount(1);
    await phone.screenshot({ path: `/tmp/mapcro-phone-${viewport.width}-${viewport.height}.png` });
    await checkPhoneLayout(phone);
    await phone.getByTestId("match-play").tap();
    await expect(phone.getByTestId("match-play")).toHaveText("Pause");
    await phone.getByTestId("match-play").tap();
    // A finger along the scrubber seeks: the far end is the match's last second.
    const range = (await phone.getByTestId("match-time").boundingBox())!;
    const y = range.y + range.height / 2;
    await touchDrag(phone, [{ x: range.x + range.width / 2, y }, { x: range.x + range.width * .8, y }, { x: range.x + range.width - 1, y }]);
    await expect(phone.getByTestId("match-clock")).toContainText("0:40 /");
    await scrubTo(phone, 20);
    await phone.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').tap();
    await expect(column(phone)).toBeVisible();
    await checkPhoneLayout(phone);
    await column(phone).locator(`.tb-build-item[data-item-id="${INFUSER}"]`).tap();
    await expect(float(phone)).toBeVisible();
    await column(phone).locator(`[data-ability-id="${ABILITY}"]`).tap();
    await expect(float(phone).getByTestId("game-tooltip")).toHaveAttribute("data-kind", "ability");
    // One sheet at a time: a second portrait swaps the hero in place; Events replaces the build.
    await phone.locator('.tb-player[data-slot="Sapphire-0"] [data-testid=focus-hero]').tap();
    await expect(phone.locator(".phone-build-sheet")).toHaveCount(1);
    await expect(phone.locator('.tb-player[data-slot="Sapphire-0"] [data-testid=focus-hero]')).toHaveAttribute("aria-expanded", "true");
    await phone.getByTestId("phone-events").tap();
    await expect(phone.locator(".phone-build-sheet")).toHaveCount(0);
    await expect(phone.getByTestId("player-side")).toBeVisible();
    await phone.getByTestId("events-lead").fill("0");
    await phone.getByTestId("event-jump").first().tap();
    await expect(phone.getByTestId("match-clock")).toContainText("0:30 /");
    await checkPhoneLayout(phone);
    await phone.getByTestId("p-sheet-close").tap();
    await expect(phone.getByTestId("player-side")).toHaveCount(0);
    // Map layers and Vision: a sheet from the transport.
    await phone.getByTestId("phone-layers").tap();
    await expect(phone.getByTestId("vision-select")).toBeVisible();
    await phone.getByTestId("vision-select").selectOption("amber");
    await expect(phone.getByTestId("vision-mark")).toHaveAttribute("data-team", "amber");
    await phone.getByTestId("troopers-toggle").tap();
    await expect(phone.getByTestId("trooper")).toHaveCount(0);
    await phone.getByTestId("troopers-toggle").tap();
    await expect(phone.getByTestId("trooper")).toHaveCount(1);
    await checkPhoneLayout(phone);
    // Edit in More swaps transport row 2 for the tool rail; Done brings row 2 back, and Look.
    const barH = async () => (await phone.getByTestId("player").boundingBox())!.height;
    const before = await barH();
    await phone.getByTestId("phone-more").tap();
    await phone.getByTestId("phone-edit").tap();
    await expect(phone.getByTestId("tool-draw")).toBeVisible();
    await expect(phone.getByTestId("phone-events")).toHaveCount(0);
    expect(Math.abs(await barH() - before)).toBeLessThanOrEqual(1);
    await checkPhoneLayout(phone);
    await phone.getByTestId("phone-done").tap();
    await expect(phone.getByTestId("phone-events")).toBeVisible();
    await expect(phone.getByTestId("tool-draw")).toHaveCount(0);
    // More: Feedback, Scenes, Laser and Edit.
    await phone.getByTestId("phone-more").tap();
    await expect(phone.getByTestId("phone-layers-sheet")).toHaveCount(0);
    await checkPhoneLayout(phone);
    await phone.getByTestId("feedback-open").tap();
    await expect(phone.getByTestId("feedback-title")).toBeVisible();
  });
}

test("phone follows the presenter's replay time", async ({ browser }) => {
  const url = await newBoardUrl(server, "Phone follow");
  const lead = await joinNew(browser, url, "Coach");
  await open(lead, "129001999");
  const witness = await joinNew(browser, url, "Guest");
  await witness.getByTestId("follow-Coach").click();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Viewer");
  await phone.keyboard.press("Enter");
  await phone.getByTestId("follow-presenter").tap();
  await scrubTo(lead, 20);
  await expect(phone.getByTestId("match-clock")).toContainText("0:20 /");
  await checkPhoneLayout(phone);
});
