// The map drawn from an asset pack. CI has no game art, so the pack here is synthetic: tiny
// generated PNGs and a handful of entities in the extractor's schema. With MAPCRO_SHOT_PACKS
// pointing at a real PACKS_DIR (outside the repo), the last test also screenshots the real art.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { Server, translate } from "./server";
import { pickHero, revealControls } from "./helpers";

// A 1×1 PNG (not game art).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

type Ent = { key: string; kind: string; team: string; lane: string; world: number[]; tier?: string; src?: { classname: string; hammeruniqueid: string; targetname: string } };
const DEFAULT_ENTITIES: Ent[] = [
  { key: "walker:amber:lane1:1", kind: "walker", team: "amber", lane: "lane1", world: [-6272, -4736, 384] },
  { key: "walker:sapphire:lane6:1", kind: "walker", team: "sapphire", lane: "lane6", world: [6444, 4776, 376] },
  { key: "mid_boss:neutral:lane4:1", kind: "mid_boss", team: "neutral", lane: "lane4", world: [0, 0, -832] },
];

function syntheticPack(entities: Ent[] = DEFAULT_ENTITIES, icons: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-packs-"));
  const dir = join(root, "synthetic");
  const blobs: Record<string, unknown> = {};
  for (const key of ["map/minimap_midtown_mid", "icons/boss_health_t2_psd", "icons/boss_health_fill_t2_psd", "heroes/7", ...icons]) {
    const file = `${key}.png`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), PNG);
    blobs[key] = { sha256: createHash("sha256").update(PNG).digest("hex"), w: 1, h: 1, mime: "image/png", file };
  }
  const manifest = {
    schema: 3,
    game: { client_version: 9001, source_revision: 1, date: "Nov 07 2026" },
    blobs,
    // A top-bar portrait makes it playable (schema 3), so the portrait's picker offers it.
    heroes: [{ hero_id: 7, class_name: "hero_test", name: "Testhero", disabled: false, minimap_blob: "heroes/7", topbar_blob: "heroes/7" }],
    entities,
    icons: icons.map((key) => ({ key, source: `panorama/images/minimap/${key.slice(6)}.vtex_c`, format: "BGRA8888", blob: key })),
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
    const host = a.locator(".mapbox .mm-host");
    await expect(host).toHaveClass(/\bpack-art\b/);
    // Visible, not just styled: a class clash once hid the whole map (journal).
    await expect(host).toBeVisible();
    expect((await a.locator(".mapbox .mm-rot .terrain").boundingBox())?.width).toBeGreaterThan(400);
    const packId = (await (await fetch(`${server.url}/api/packs`)).json())[0].pack_id as string;
    await expect(host).toHaveAttribute("data-pack", packId);
    const bg = await a.locator(".mapbox .mm-rot .terrain").evaluate((e) => getComputedStyle(e).backgroundImage);
    expect(bg).toContain(`/packs/${packId}/map/minimap_midtown_mid.png`);
    // The pack's objectives only: two walkers and the mid boss, at their transformed positions.
    // A pack without shops or teleporters (one from before 2026-11-09) borrows the built-in
    // map's, and the healing pickups wait for the Heals toggle.
    await expect(a.locator(".mapbox .mk:not(.shop):not(.teleporter)")).toHaveCount(3);
    await expect(a.locator(".mapbox .mk.shop")).toHaveCount(8);
    await expect(a.locator(".mapbox .mk.teleporter")).toHaveCount(4);
    await expect(a.locator(".mapbox .mk.heal")).toHaveCount(0);
    // Nor tough crates (a pack from before the Heavy boxes): the toggle borrows the built-in
    // map's, and our box shows with the pack's art on, where the fallback shapes don't.
    await expect(a.locator(".mapbox .mk.crate")).toHaveCount(0);
    await revealControls(a, "crates-toggle");
    await a.getByTestId("crates-toggle").click();
    await expect(a.locator(".mapbox .mk.crate")).toHaveCount(78);
    await expect(a.locator(".mapbox .mk.crate .fb.crate").first()).toBeVisible();
    await expect(a.locator(".mapbox .mk.shop .fb").first()).toBeHidden();
    await revealControls(a, "crates-toggle");
    await a.getByTestId("crates-toggle").click();
    const walker = a.locator('.mapbox .mk[data-key="walker:amber:lane1:1"]');
    await expect(walker).toHaveAttribute("style", /left: 20\.83\d*%; top: 72\.02\d*%/);

    // Flipping the view keeps the art (a dynamic class once wiped the pack-art class).
    await a.getByTestId("viewpoint-flip").click();
    await expect(host).toHaveClass(/vp-sapphire/);
    await expect(host).toHaveClass(/\bpack-art\b/);
    await a.getByTestId("viewpoint-flip").click();

    // Picking a hero puts the pack's portrait on the token, in every browser.
    const b = await joinNew(browser, url, "Marrow");
    await pickHero(a, "Amber-0", "Testhero");
    for (const p of [a, b]) {
      await expect(p.locator('.tok[data-slot="Amber-0"] image')).toHaveAttribute("href", `/packs/${packId}/heroes/7.png`);
    }
  });
});

// Camps as today's packs carry them (no tier: extracted before 2026-11-09) and as new ones do.
// docs/research/map-objectives-audit.md: five of the eleven Sinner's Sacrifice camps don't say
// "vault" in their names, and the mid boss has a camp of its own.
const camp = (key: string, world: number[], name: string, tier?: string): Ent => ({
  key,
  kind: "camp",
  team: "neutral",
  lane: key.split(":")[2]!,
  world,
  src: { classname: "info_neutral_trooper_camp", hammeruniqueid: key, targetname: `[PR#]${name}` },
  ...(tier ? { tier } : {}),
});
const SINNERS = [
  camp("camp:neutral:lane4:5", [3248, -1888, 2499], "1380394_chinatown_bell_1"),
  camp("camp:neutral:lane6:14", [4160, 2784, 1008], "theater_balcony_camp"),
  camp("camp:neutral:lane4:1", [-3264, -1600, 564], "slums_garage_up_camp"),
  camp("camp:neutral:lane4:7", [2208, -960, 400], "drug_store_camp"),
  camp("camp:neutral:lane4:12", [-2220, 1024, 392], "hotel_01_camp", "vaults"),
];
const CAMP_ICONS = ["icons/neutral_small_psd", "icons/neutral_medium_psd", "icons/neutral_large_psd", "icons/neutral_vault_psd"];

test.describe("with a pack's camps", () => {
  let server: Server;
  test.beforeAll(async () => {
    server = new Server(
      syntheticPack(
        [
          DEFAULT_ENTITIES[2]!,
          ...SINNERS,
          camp("camp:neutral:lane4:9", [-1.5, -0.8, -832], "mid_neutrals"),
          camp("camp:neutral:lane1:10", [-7168, -1280, 264], "dock_authority_camp"),
          camp("camp:neutral:lane6:8", [9184, 0, 256], "park_gate_camp"),
          camp("camp:neutral:lane4:2", [-3318, -1260, 256], "slums_garage_down_camp", "medium"),
        ],
        CAMP_ICONS,
      ),
    );
    await server.start();
  });
  test.afterAll(() => server.stop());

  test("every Sinner's Sacrifice camp wears the vault icon, and each camp its tier's", async ({ browser }) => {
    const a = await joinNew(browser, await newBoard(server, "camps"), "Coach");
    await expect(a.locator(".mapbox .mm-host")).toHaveClass(/\bpack-art\b/);
    for (const c of SINNERS) {
      const m = a.locator(`.mapbox .mk.camp[data-key="${c.key}"]`);
      await expect(m, c.src!.targetname).toBeVisible();
      await expect(m).toHaveAttribute("aria-label", "Sinner's Sacrifice");
      await expect(m.locator('[data-pimg="neutral-vault"]')).toHaveCount(1);
    }
    const icon = (key: string) => a.locator(`.mapbox .mk.camp[data-key="${key}"] [data-pimg]`);
    await expect(icon("camp:neutral:lane1:10")).toHaveAttribute("data-pimg", "neutral-small");
    await expect(icon("camp:neutral:lane6:8")).toHaveAttribute("data-pimg", "neutral-large");
    await expect(icon("camp:neutral:lane4:2")).toHaveAttribute("data-pimg", "neutral-medium");
    // The vault art is the pack's own image.
    const bg = await a.locator('.mapbox .mk[data-key="camp:neutral:lane4:5"] [data-pimg]').evaluate((e) => getComputedStyle(e).backgroundImage);
    expect(bg).toMatch(/\/packs\/[0-9a-f]+\/icons\/neutral_vault_psd\.png/);
    // The mid boss's own camp is left to the mid boss marker: 8 camps of 9, and the boss.
    await expect(a.locator('.mapbox .mk[data-key="camp:neutral:lane4:9"]')).toHaveCount(0);
    await expect(a.locator(".mapbox .mk.camp")).toHaveCount(8);
    await expect(a.locator(".mapbox .mk.midboss")).toHaveCount(1);
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
      await pickHero(a, `${i < 6 ? "Amber" : "Sapphire"}-${i % 6}`, h).catch(() => a.keyboard.press("Escape"));
    }
    const souls = [9040, 7310, 6120, 7100, 5480, 4790, 8800, 7700, 6900, 6200, 5100, 4400];
    const ults = [0, 60, 25, null, 90, 0, 40, 0, 75, 10, null, 100];
    for (const [i, n] of souls.entries()) {
      const slot = `${i < 6 ? "Amber" : "Sapphire"}-${i % 6}`;
      await a.locator(`.tb-player[data-slot="${slot}"]`).getByTestId("souls").click();
      await a.getByTestId("souls-input").fill(String(n));
      await a.keyboard.press("Enter");
      const u = ults[i];
      const ring = a.locator(`.tb-player[data-slot="${slot}"]`).getByTestId("ult");
      if (u === 0) await ring.click();
      else if (u != null) {
        const r = (await ring.boundingBox())!;
        const [x, y] = [r.x + r.width / 2, r.y + r.height / 2];
        const t = (u / 100) * 2 * Math.PI;
        await a.mouse.move(x, y);
        await a.mouse.down();
        await a.mouse.move(x, y - 20, { steps: 2 });
        await a.mouse.move(x + 20 * Math.sin(t), y - 20 * Math.cos(t), { steps: 2 });
        await a.mouse.up();
      }
    }
    await a.getByTestId("tb-clock").click();
    await a.getByTestId("tb-clock-input").fill("8:00");
    await a.keyboard.press("Enter");
    const box = (await a.locator('.tok[data-slot="Amber-2"]').boundingBox())!;
    const map = (await a.locator(".mm-overlay.map").boundingBox())!;
    await b.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await b.mouse.down();
    await b.mouse.move(map.x + map.width * 0.45, map.y + map.height * 0.6, { steps: 10 });
    await expect(a.locator('.p-tag[data-tag="Marrow"]')).toBeVisible();
    await a.waitForTimeout(300);
    await a.screenshot({ path: "shots/board-pack.png" });
    await b.mouse.up();
    const t = translate(await a.locator('.tok[data-slot="Amber-2"]').getAttribute("transform"));
    expect(t.y).toBeLessThan(700);
  } finally {
    server.stop();
  }
});
