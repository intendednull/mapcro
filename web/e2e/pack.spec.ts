// The map drawn from an asset pack. CI has no game art, so the pack here is synthetic: tiny
// generated PNGs and a handful of entities in the extractor's schema. With MAPCRO_SHOT_PACKS
// pointing at a real PACKS_DIR (outside the repo), the last test also screenshots the real art.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Browser, type Page, expect, test } from "@playwright/test";
import { Server, translate } from "./server";

// A 1×1 PNG (not game art).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function syntheticPack(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-packs-"));
  const dir = join(root, "synthetic");
  const blobs: Record<string, unknown> = {};
  for (const key of ["map/minimap_midtown_mid", "icons/boss_health_t2_psd", "icons/boss_health_fill_t2_psd", "heroes/7"]) {
    const file = `${key}.png`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), PNG);
    blobs[key] = { sha256: createHash("sha256").update(PNG).digest("hex"), w: 1, h: 1, mime: "image/png", file };
  }
  const manifest = {
    schema: 3,
    game: { client_version: 9001, source_revision: 1, date: "Nov 07 2026" },
    blobs,
    heroes: [{ hero_id: 7, class_name: "hero_test", name: "Testhero", disabled: false, minimap_blob: "heroes/7", topbar_blob: null }],
    entities: [
      { key: "walker:amber:lane1:1", kind: "walker", team: "amber", lane: "lane1", world: [-6272, -4736, 384] },
      { key: "walker:sapphire:lane6:1", kind: "walker", team: "sapphire", lane: "lane6", world: [6444, 4776, 376] },
      { key: "mid_boss:neutral:lane4:1", kind: "mid_boss", team: "neutral", lane: "lane4", world: [0, 0, -832] },
    ],
  };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
  return root;
}

async function joinNew(browser: Browser, url: string, name: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(url);
  await page.locator("#join-name").fill(name);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("join-card")).toBeHidden();
  return page;
}

async function newBoard(server: Server, title: string) {
  const r = await fetch(`${server.url}/api/boards`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}

test.describe("with a synthetic pack", () => {
  let server: Server;
  test.beforeAll(async () => {
    server = new Server(syntheticPack());
    await server.start();
  });
  test.afterAll(() => server.stop());

  test("terrain, markers and portraits come from the pack", async ({ browser }) => {
    const url = await newBoard(server, "packed");
    const a = await joinNew(browser, url, "Coach");
    const host = a.locator(".mm-host");
    await expect(host).toHaveClass(/\bpack-art\b/);
    // Visible, not just styled: a class clash once hid the whole map (journal).
    await expect(host).toBeVisible();
    expect((await a.locator(".mm-rot .terrain").boundingBox())?.width).toBeGreaterThan(400);
    const packId = (await (await fetch(`${server.url}/api/packs`)).json())[0].pack_id as string;
    await expect(host).toHaveAttribute("data-pack", packId);
    await expect(a.getByTestId("placeholder-note")).toHaveCount(0);
    const bg = await a.locator(".mm-rot .terrain").evaluate((e) => getComputedStyle(e).backgroundImage);
    expect(bg).toContain(`/packs/${packId}/map/minimap_midtown_mid.png`);
    // Only the pack's entities: two walkers and the mid boss, at their transformed positions.
    await expect(a.locator(".mk")).toHaveCount(3);
    const walker = a.locator('.mk[data-key="walker:amber:lane1:1"]');
    await expect(walker).toHaveAttribute("style", /left: 20\.83\d*%; top: 72\.02\d*%/);

    // Picking a hero puts the pack's portrait on the token, in every browser.
    const b = await joinNew(browser, url, "Marrow");
    await a.getByTestId("hero-pick-Amber-0").selectOption({ label: "Testhero" });
    for (const p of [a, b]) {
      await expect(p.locator('.tok[data-slot="Amber-0"] image')).toHaveAttribute("href", `/packs/${packId}/heroes/7.png`);
    }
  });
});

test("screenshot with the real pack", async ({ browser }) => {
  const packs = process.env.MAPCRO_SHOT_PACKS;
  test.skip(!packs, "set MAPCRO_SHOT_PACKS to a PACKS_DIR to screenshot real art");
  const server = new Server(packs);
  await server.start();
  try {
    const url = await newBoard(server, "Scrim prep vs Night Owls");
    const a = await joinNew(browser, url, "Coach");
    const b = await joinNew(browser, url, "Marrow");
    const heroes = ["Haze", "Abrams", "Dynamo", "Vindicta", "Seven", "Lady Geist", "Infernus", "Bebop", "Grey Talon", "Kelvin", "Paradox", "Wraith"];
    for (const [i, h] of heroes.entries()) {
      const sel = a.getByTestId(`hero-pick-${i < 6 ? "Amber" : "Sapphire"}-${i % 6}`);
      await sel.selectOption({ label: h }).catch(() => undefined);
    }
    await a.screenshot({ path: "test-results/slice1-board-pack-before.png" });
    const box = (await a.locator('.tok[data-slot="Amber-2"]').boundingBox())!;
    const map = (await a.locator(".mm-overlay.map").boundingBox())!;
    await b.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await b.mouse.down();
    await b.mouse.move(map.x + map.width * 0.45, map.y + map.height * 0.6, { steps: 10 });
    await expect(a.locator('.p-tag[data-tag="Marrow"]')).toBeVisible();
    await a.waitForTimeout(300);
    await a.screenshot({ path: "test-results/slice1-board-pack.png" });
    await b.mouse.up();
    const t = translate(await a.locator('.tok[data-slot="Amber-2"]').getAttribute("transform"));
    expect(t.y).toBeLessThan(700);
  } finally {
    server.stop();
  }
});
