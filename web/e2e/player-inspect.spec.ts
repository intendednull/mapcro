// The single-hero dropdown's build order and the map skull's death recap, on a synthetic replay
// timeline handed to the server as the worker would:
// - the build order lists the inspected hero's buys, sales and upgrades in time order, and a row
//   seeks the replay to its moment;
// - a skull whose death has a recap opens it with the Move tool; the recap closes when a Vision
//   whose team didn't see the death is picked, and that view draws no skull to open it from.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000083";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-inspect-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const NO_HERO = 255;

/**
 * - Every hero buys at 5 s and 12 s, upgrades the first into a third item at 30 s (the first
 *   used up then), and sells the second at 50 s.
 * - Amber 1 dies at 20 (back at 30), seen by Sapphire 10–19.8 s; Sapphire 2 dies at 40 (back at
 *   50), never seen by Amber. Both deaths have recaps.
 */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const a1 = team === "amber" && slot === 1;
        const s2 = team === "sapphire" && slot === 2;
        const dead = (s: number) => (a1 && s >= 20 && s < 30) || (s2 && s >= 40 && s < 50);
        const at = { x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 };
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : at.x)),
          y: range((s) => (dead(s) ? null : at.y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: a1 ? [20] : s2 ? [40] : [],
          respawn: a1 ? [[20, 30]] : s2 ? [[40, 50]] : [],
          souls: [[0, 500]], ult: range(() => 0),
          seen: a1 ? [[100, 198]] : [],
          items: [[50, 715_762_406, 0], [120, 1_009_965_641, 0], [300, 715_762_406, 2], [300, 3_000_000_001, 0], [500, 1_009_965_641, 1]],
          abilities: [], casts: [], charges: [], cc: [], effects: [],
          recaps: a1 ? [{ t: 200, damage: [[7, 0, 640], [NO_HERO, 0, 120]], cc: [] }] : s2 ? [{ t: 400, damage: [[1, 0, 900]], cc: [] }] : [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    events: [
      { t: 20, kind: "death", team: "amber", slot: 1, hero_id: 2, x: -2500, y: -3000 },
      { t: 40, kind: "death", team: "sapphire", slot: 2, hero_id: 3, x: -1000, y: 3000 },
    ],
  };
}

const answered = new Set<string>();
async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

test("the inspected hero's build order lists buys, sales and upgrades in order, and a row seeks there", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Build order"), "Coach");
  await open(a);
  await scrubTo(a, 20);
  await a.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').click();
  const order = a.getByTestId("build-order");
  await expect(order).toHaveCount(1);
  // Only in the single-hero dropdown, as Effects.
  await expect(a.getByTestId("hero-build")).toHaveCount(1);
  await order.locator("summary").click();
  const rows = order.getByTestId("build-order-row");
  // The upgrade's used-up component rides with its buy: four rows, not five.
  expect(await rows.evaluateAll((els) => els.map((el) => `${el.getAttribute("data-t")} ${el.getAttribute("data-kind")} ${el.getAttribute("data-item-id")}`))).toEqual([
    "5 bought 715762406", "12 bought 1009965641", "30 bought 3000000001", "50 sold 1009965641",
  ]);
  await expect(rows.nth(2)).toHaveClass(/\blater\b/);
  await expect(rows.nth(1)).not.toHaveClass(/\blater\b/);
  await expect(rows.nth(3)).toContainText("0:50");
  await rows.nth(3).click();
  await expect(a.getByTestId("match-clock")).toContainText("0:50 /");
  await expect(rows.nth(3)).not.toHaveClass(/\blater\b/);
  // Opening the build order closes Effects, and the other way: one popover at a time.
  await a.getByTestId("active-effects").locator("summary").click();
  await expect(order).not.toHaveAttribute("open");
  // All builds (Tab's view) has no build order.
  await a.locator(".tb-all-builds").click();
  await expect(a.getByTestId("build-order")).toHaveCount(0);
});

const skull = (p: Page, slot: string) => p.locator(`[data-testid=death-skull][data-slot="${slot}"]`);

test("a skull opens its death's recap; a Vision that didn't see the death closes it and shows no skull", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Skull recap"), "Coach");
  await open(a);
  await scrubTo(a, 41);
  const sk = skull(a, "sapphire-2");
  await expect(sk).toHaveAttribute("data-recap", "");
  expect(await sk.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("auto");
  await sk.click();
  const card = a.getByTestId("skull-recap");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Died at 0:40");
  await expect(card.getByTestId("death-recap")).toHaveAttribute("open", "");
  await expect(card).toContainText("Death recap · 900 damage");
  // The press opened the recap, not a drawing or a selection.
  await expect(a.locator("[data-testid=map] [data-stroke]")).toHaveCount(0);
  // Watch lead-up: the 10 s before.
  await card.getByRole("button", { name: "Watch lead-up" }).click();
  await expect(a.getByTestId("match-clock")).toContainText("0:30 /");
  await expect(card).toBeVisible();
  // The King's view didn't see Sapphire 2 die: the recap closes, and no skull offers it.
  await a.getByTestId("vision-select").selectOption("amber");
  await expect(card).toHaveCount(0);
  await scrubTo(a, 41);
  await expect(skull(a, "sapphire-2")).toHaveCount(0);
  // The Archmother's view saw Amber 1 die: its skull opens; Escape closes it.
  await a.getByTestId("vision-select").selectOption("sapphire");
  await scrubTo(a, 21);
  await skull(a, "amber-1").click();
  await expect(card).toContainText("Death recap · 760 damage");
  await a.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
  // With a drawing tool the skull doesn't take the press.
  await a.keyboard.press("e");
  expect(await skull(a, "amber-1").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
});
