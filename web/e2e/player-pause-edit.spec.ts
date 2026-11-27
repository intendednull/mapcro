// Player Pause Edit Behavior (GitHub #61; docs/specs/player-pause-edit.md):
// Covers paused hero editing (move, HeroCard click, #16 tracking coexistence, kill/respawn,
// revive, UltRing, vision, souls, rename, hero swap), paused map editing (1-click objective
// toggle, #55 vertical health drag & obj-menu presets, wave drag, Doorman doorway edit),
// Reset + Ctrl+Z recovery, Save as scene baking + Scene.clock, Space+drag pan protection,
// Play & scrub D1 discard (keeping live ink) + clean Ctrl+Z / Ctrl+Y undo stack, multi-user
// peer sync & independent-timestamp isolation, view-only protection, and phone portrait/landscape.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Locator, type Page, expect, test } from "./fixtures";
import { dragToken, gesture, joinNew, mapPoint, revealControls, tokenAt, viewLink, viewOf } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000611";
const N = 60;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-pauseedit-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

/** Synthetic schema-3 pack with Doorman (hero_id 69), 12 test heroes, and doorway icon (zero game art). */
function syntheticPausePack(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-pause-pack-"));
  const dir = join(root, "pause");
  const blobs: Record<string, unknown> = {};
  const blob = (key: string) => {
    const file = `${key}.png`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), PNG);
    blobs[key] = { sha256: createHash("sha256").update(PNG).digest("hex"), w: 1, h: 1, mime: "image/png", file };
    return key;
  };
  blob("icons/doorman_doorway_psd");
  const heroes = [
    {
      hero_id: 69,
      class_name: "hero_doorman",
      name: "The Doorman",
      disabled: false,
      minimap_blob: blob("heroes/69"),
      topbar_blob: blob("topbar/heroes/69"),
    },
    ...Array.from({ length: 14 }, (_, i) => ({
      hero_id: i + 1,
      class_name: `hero_test${i + 1}`,
      name: `Testhero ${String.fromCharCode(65 + i)}`,
      disabled: false,
      minimap_blob: blob(`heroes/${i + 1}`),
      topbar_blob: blob(`topbar/heroes/${i + 1}`),
    })),
  ];
  const manifest = {
    schema: 3,
    game: { client_version: 6865, source_revision: 1, date: "Nov 25 2026" },
    blobs,
    heroes,
    entities: [],
  };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
  return root;
}

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

function replayTimeline() {
  const stand = (team: string, slot: number) => ({
    x: slot * 1200 - 3000,
    y: team === "amber" ? -2600 : 2600,
  });
  return {
    match_id: Number(ID),
    start_time: 0,
    duration_s: N,
    source: "replay",
    tier: "replay",
    build: 6865,
    reanchored: 0,
    format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const isDoorman = team === "amber" && slot === 0;
        const isDeadAt20 = team === "amber" && slot === 1;
        const hero_id = isDoorman ? 69 : 1 + slot + (team === "sapphire" ? 6 : 0);
        const pos = isDoorman ? { x: -1600, y: -1400 } : stand(team, slot);
        return {
          team,
          slot,
          hero_id,
          name: null,
          x: range((s) => (isDeadAt20 && s >= 18 && s <= 35 ? null : pos.x + (isDoorman ? s * 10 : 0))),
          y: range((s) => (isDeadAt20 && s >= 18 && s <= 35 ? null : pos.y)),
          health: range((s) => (isDeadAt20 && s >= 18 && s <= 35 ? 0 : 100)),
          deaths: isDeadAt20 ? [18] : [],
          respawn: isDeadAt20 ? [[18, 36]] : [],
          souls: [[0, 2000 + slot * 500]],
          ult: range(() => 0),
          seen: [[0, N * 10]],
        };
      }),
    ),
    objectives: [],
    mid_boss: [],
    rifts: [],
    powerups: [],
    zips: [],
    camps: [],
    events: [],
    objective_health: [
      { key: "walker:sapphire:lane6:1", at: [[0, 100], [10, 80]] },
    ],
    doors: [
      { id: 0, team: "amber", x: -1200, y: -800, start_ds: 100, end_ds: 500, seen: [[100, 500]] },
    ],
  };
}

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(syntheticPausePack(), {
    MATCH_API_BASE: `http://127.0.0.1:${port}`,
    REPLAY_DIR: queue,
    REPLAY_PER_CLIENT_PER_HOUR: "60",
    CREATE_PER_HOUR: "60",
  });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const answered = new Set<string>();
async function openReplay(p: Page) {
  await p.getByTestId("mode-player").click();
  if (await p.locator(".phone-player").count()) {
    await p.getByTestId("phone-more").tap();
    await p.getByTestId("phone-match").tap();
  } else {
    await revealControls(p, "match-id");
  }
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({
    name: `${ID}.dem`,
    mimeType: "application/octet-stream",
    buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]),
  });
  let job = "";
  await expect
    .poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !answered.has(f)) ?? ""))
    .not.toBe("");
  answered.add(job);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(replayTimeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, sec: number) {
  await p.getByTestId("match-time").evaluate((el, s) => {
    (el as HTMLInputElement).value = String(s);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, sec);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(sec).padStart(2, "0")}`);
}

const marker = (p: Page, key: string) => p.locator(`.mapbox .mk[data-key="${key}"]`);
const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
};

test("paused hero editing, topbar controls, #16 tracking coexistence, and Reset with Ctrl+Z recovery", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Heroes");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p);
  await scrubTo(p, 20);
  await expect(p.getByTestId("match-play")).toHaveAttribute("data-playing", "false");

  // Clean baseline: no Reset button, Save button not dirty.
  await expect(p.getByTestId("match-reset")).toHaveCount(0);
  await expect(p.getByTestId("match-save")).not.toHaveClass(/dirty/);

  // 1. Drag Amber-0 (Doorman) while paused -> token moves, Reset appears, Save turns dirty.
  const before = await tokenAt(p, "Amber-0");
  await dragToken(p, "Amber-0", 0.55, 0.45);
  await expect.poll(async () => {
    const after = await tokenAt(p, "Amber-0");
    return Math.hypot(after.x - before.x, after.y - before.y);
  }).toBeGreaterThan(80);
  await expect(p.getByTestId("match-reset")).toBeVisible();
  await expect(p.getByTestId("match-save")).toHaveClass(/dirty/);
  await expect(p.getByTestId("match-save")).toContainText("Save as scene");

  // 2. Stationary click on Amber-2 opens HeroCard; double-click / F triggers #16 tracking cleanly.
  const a2 = p.locator('[data-testid=map] .tok[data-slot="Amber-2"]');
  const a2c = await centre(a2);
  await p.mouse.click(a2c.x, a2c.y);
  await expect(p.getByTestId("hero-card")).toBeVisible();
  await p.keyboard.press("Escape");

  // Track Amber-2 with F hotkey while hovering -> track-chip appears; dragging Amber-0 still works.
  await p.mouse.move(a2c.x, a2c.y);
  await p.keyboard.press("f");
  await expect(p.getByTestId("track-chip")).toBeVisible();
  await p.getByTestId("track-chip").click();
  await expect(p.getByTestId("track-chip")).toHaveCount(0);

  // 3. K hotkey kills Amber-0 -> .tok.dead + editable respawn timer (rendered in labels portal).
  const a0c = await centre(p.locator('[data-testid=map] .tok[data-slot="Amber-0"]'));
  await p.mouse.move(a0c.x, a0c.y);
  await p.keyboard.press("k");
  await expect(p.locator('[data-testid=map] .tok[data-slot="Amber-0"]')).toHaveClass(/dead/);
  const respawnBadge = p.locator('[data-testid=map] .respawn').first();
  await expect(respawnBadge).toBeVisible();
  await respawnBadge.click();
  const rInput = p.getByTestId("respawn-input");
  await expect(rInput).toBeVisible();
  await rInput.fill("0:45");
  await rInput.press("Enter");
  await expect(respawnBadge).toContainText("0:45");

  // 4. Right-click dead Amber-1 portrait -> Revive brings them alive on the map.
  const deadPortrait = p.locator('.tb-player[data-slot="Amber-1"]');
  await expect(deadPortrait).toHaveClass(/dead/);
  await deadPortrait.click({ button: "right" });
  await expect(p.getByTestId("hero-menu")).toBeVisible();
  await p.getByTestId("hero-menu-life").click();
  await expect(deadPortrait).not.toHaveClass(/dead/);

  // 5. Topbar edits while paused: UltRing, Vision toggle, Souls, Rename, Hero swap.
  const s0 = p.locator('.tb-player[data-slot="Sapphire-0"]');
  await s0.getByTestId("tb-vision").click();
  await expect(s0.getByTestId("tb-vision")).toHaveClass(/off/);

  // Set souls via hero-menu
  await s0.click({ button: "right" });
  await p.getByTestId("hero-menu-souls").click();
  const soulsInput = s0.locator("input");
  await expect(soulsInput).toBeVisible();
  await soulsInput.fill("14500");
  await soulsInput.press("Enter");
  await expect(s0.getByTestId("souls-banner")).toContainText("14k");

  // UltRing drag on Amber-2 -> sets cooldown (50% at 6 o'clock)
  const a2Ult = p.locator('.tb-player[data-slot="Amber-2"] .tb-ult');
  await expect(a2Ult).toHaveClass(/ready/);
  const uc = await centre(a2Ult);
  await p.mouse.move(uc.x, uc.y);
  await p.mouse.down();
  await p.mouse.move(uc.x, uc.y + 18, { steps: 4 });
  await p.mouse.up();
  await expect(a2Ult).toHaveClass(/cooldown/);

  // 6. Explicit Reset reverts all overrides cleanly, AND Ctrl+Z brings them back!
  await p.getByTestId("match-reset").click();
  await expect(p.getByTestId("match-reset")).toHaveCount(0);
  await expect(p.locator('[data-testid=map] .tok[data-slot="Amber-0"]')).not.toHaveClass(/dead/);
  await expect(deadPortrait).toHaveClass(/dead/);
  await expect(s0.getByTestId("tb-vision")).not.toHaveClass(/off/);

  await p.keyboard.press("Control+z");
  await expect(p.getByTestId("match-reset")).toBeVisible();
  await expect(p.locator('[data-testid=map] .tok[data-slot="Amber-0"]')).toHaveClass(/dead/);
  await expect(deadPortrait).not.toHaveClass(/dead/);
});

test("paused map editing (objective toggle, #55 health drag & menu, wave drag, Doorman doorway) bakes into Save as scene", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Save Scene");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p);
  await scrubTo(p, 20);

  // 1. Move Amber-0
  await dragToken(p, "Amber-0", 0.62, 0.38);
  const movedPos = await tokenAt(p, "Amber-0");

  // 2. 1-click toggle Sapphire lane4 Guardian -> Destroyed
  const guardKey = "guardian:sapphire:lane4:1";
  const g = marker(p, guardKey);
  const gc = await centre(g);
  await p.mouse.click(gc.x, gc.y);
  await expect(g).toHaveAttribute("data-status", "Destroyed");

  // 3. #55 vertical drag on Sapphire lane6 Walker (starts at 80% from replay) -> drag down 20 px => 55%
  const walkerKey = "walker:sapphire:lane6:1";
  const w = marker(p, walkerKey);
  await expect(w).toHaveAttribute("data-health", "80");
  const wc = await centre(w);
  await p.mouse.move(wc.x, wc.y);
  await p.mouse.down();
  await p.mouse.move(wc.x, wc.y + 20, { steps: 5 });
  await expect(w).toHaveAttribute("data-health", "55");
  await p.mouse.up();
  await expect(w).toHaveAttribute("data-health", "55");

  // Also test right-click obj-menu preset on Amber lane1 Walker -> 50%
  const amberWalkerKey = "walker:amber:lane1:1";
  const awc = await centre(marker(p, amberWalkerKey));
  await p.mouse.click(awc.x, awc.y, { button: "right" });
  await expect(p.getByTestId("obj-menu")).toBeVisible();
  await p.getByTestId("obj-menu-hp-50").click();
  await expect(marker(p, amberWalkerKey)).toHaveAttribute("data-health", "50");

  // 4. Drag lane1 (yellow) wave handle
  const waveHit = p.getByTestId("wave-gap-lane1");
  await expect(waveHit).toBeVisible();
  const wBefore = await centre(waveHit);
  await p.mouse.move(wBefore.x, wBefore.y);
  await p.mouse.down();
  await p.mouse.move(wBefore.x, wBefore.y - 60, { steps: 6 });
  await p.mouse.up();
  const wAfter = await centre(waveHit);
  expect(Math.hypot(wAfter.x - wBefore.x, wAfter.y - wBefore.y)).toBeGreaterThan(20);

  // 5. Place linked Doorman doorway pair via Amber-0 right-click menu (click 1 = Door 1, click 2 = Door 2 -> commits pair!)
  await expect(p.locator(".pl-door")).toHaveCount(1);
  await p.locator('.tb-player[data-slot="Amber-0"]').click({ button: "right" });
  await p.getByTestId("hero-menu-doorway").click();
  const doorSpot1 = await mapPoint(p, 0.42, 0.55);
  const doorSpot2 = await mapPoint(p, 0.55, 0.52);
  await p.mouse.click(doorSpot1.x, doorSpot1.y);
  await p.mouse.click(doorSpot2.x, doorSpot2.y);
  await expect(p.locator(".pl-door")).toHaveCount(2);
  await expect(p.locator(".pl-door-link")).toHaveCount(1);

  // 6. Save as scene -> immediately switches to the new saved scene!
  await p.getByTestId("match-save").click();
  await expect(p.getByTestId("toast")).toContainText("Saved");
  await expect(p.getByTestId("player")).toHaveAttribute("data-state", "scene");

  // Verify saved scene has matching clock, moved hero, Destroyed guardian, #55 health on both walkers, and 2 doorways!
  await expect(p.locator(".tb-clock-label")).toHaveText("0:20");
  await expect.poll(async () => {
    const savedPos = await tokenAt(p, "Amber-0");
    return Math.hypot(savedPos.x - movedPos.x, savedPos.y - movedPos.y);
  }).toBeLessThan(20);
  await expect(marker(p, guardKey)).toHaveAttribute("data-status", "Destroyed");
  await expect(marker(p, walkerKey)).toHaveAttribute("data-health", "55");
  await expect(marker(p, amberWalkerKey)).toHaveAttribute("data-health", "50");
  await expect(p.locator(".pl-door")).toHaveCount(2);

  // Return to Player -> liveScene overrides were silently cleared after save.
  await p.getByTestId("mode-player").click();
  await expect(p.getByTestId("match-reset")).toHaveCount(0);
  await expect(marker(p, guardKey)).not.toHaveAttribute("data-status", "Destroyed");
  await expect(marker(p, walkerKey)).toHaveAttribute("data-health", "80");
  await expect(p.locator(".pl-door")).toHaveCount(1);
});

test("Space+drag pans without unpausing; Play & scrub discard overrides while keeping live ink and clean Ctrl+Z/Ctrl+Y", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Discard Undo");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p);
  await scrubTo(p, 20);

  // 1. Draw a live ink stroke (D1: must survive Play & scrub).
  await p.getByTestId("tool-draw").click();
  await gesture(p, [[0.3, 0.3], [0.4, 0.35], [0.45, 0.4]]);
  await expect(p.locator(".ink")).toHaveCount(1);
  await p.getByTestId("tool-select").click();

  // 2. Make two pause edits, then undo the second so both undo & redo stacks hold pause edits.
  const baseA0 = await tokenAt(p, "Amber-0");
  await dragToken(p, "Amber-0", 0.58, 0.42);
  await dragToken(p, "Amber-2", 0.65, 0.48);
  await p.keyboard.press("Control+z"); // undo Amber-2 -> now Amber-2 drag sits on redo stack!
  await expect(p.getByTestId("match-reset")).toBeVisible();

  // 3. Zoom in slightly, then hold Space + drag map -> pans camera WITHOUT unpausing or clearing Amber-0!
  const mid = await mapPoint(p, 0.5, 0.5);
  await p.mouse.move(mid.x, mid.y);
  await p.mouse.wheel(0, -240);
  const viewBefore = await viewOf(p);
  await p.keyboard.down("Space");
  await p.mouse.down();
  await p.mouse.move(mid.x + 70, mid.y + 50, { steps: 5 });
  await p.mouse.up();
  await p.keyboard.up("Space");
  const viewAfter = await viewOf(p);
  expect(Math.hypot(viewAfter[0] - viewBefore[0], viewAfter[1] - viewBefore[1])).toBeGreaterThan(10);
  await expect(p.getByTestId("match-play")).toHaveAttribute("data-playing", "false");
  await expect(p.getByTestId("match-reset")).toBeVisible();

  // 4. Tap Space (Play) -> unpauses, clears temporary entity overrides, keeps live ink!
  await p.keyboard.press("Space");
  await expect(p.getByTestId("match-play")).toHaveAttribute("data-playing", "true");
  await expect(p.getByTestId("match-reset")).toHaveCount(0);
  await expect(p.locator(".ink")).toHaveCount(1);

  // Pause again and check Ctrl+Y does NOT resurrect Amber-2, and Ctrl+Z undoes the live ink stroke!
  await p.keyboard.press("Space");
  await expect(p.getByTestId("match-play")).toHaveAttribute("data-playing", "false");
  await p.keyboard.press("Control+y");
  await expect(p.getByTestId("match-reset")).toHaveCount(0);
  await p.keyboard.press("Control+z");
  await expect(p.locator(".ink")).toHaveCount(0);

  // 5. Re-draw live ink, make a pause edit at t=20, then scrub to t=30 -> override cleared, live ink kept!
  await scrubTo(p, 20);
  await p.getByTestId("tool-draw").click();
  await gesture(p, [[0.35, 0.35], [0.45, 0.45]]);
  await expect(p.locator(".ink")).toHaveCount(1);
  await p.getByTestId("tool-select").click();
  await dragToken(p, "Amber-0", 0.6, 0.4);
  await expect(p.getByTestId("match-reset")).toBeVisible();
  await scrubTo(p, 30);
  await expect(p.getByTestId("match-reset")).toHaveCount(0);
  await expect(p.locator(".ink")).toHaveCount(1);
  const posAfterScrub = await tokenAt(p, "Amber-0");
  expect(Math.hypot(posAfterScrub.x - baseA0.x, posAfterScrub.y - baseA0.y)).toBeLessThan(40);
});

test("multi-user peer sync while paused, independent-timestamp isolation, and view-only lock", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Multiuser");
  const a = await joinNew(browser, url, "Presenter");
  await openReplay(a);
  await scrubTo(a, 20);

  const b = await joinNew(browser, url, "Follower");
  await expect(b.getByTestId("follow-Presenter")).toBeVisible();
  await b.getByTestId("follow-Presenter").click();
  await expect(b.getByTestId("match-clock")).toContainText("0:20");

  // Presenter drags Amber-0 and scrubs Walker health to 55% -> Follower sees both live!
  const walkerKey = "walker:sapphire:lane6:1";
  await dragToken(a, "Amber-0", 0.58, 0.42);
  const movedA = await tokenAt(a, "Amber-0");
  await expect.poll(async () => {
    const posB = await tokenAt(b, "Amber-0");
    return Math.hypot(posB.x - movedA.x, posB.y - movedA.y);
  }).toBeLessThan(15);

  const wc = await centre(marker(a, walkerKey));
  await a.mouse.move(wc.x, wc.y);
  await a.mouse.down();
  await a.mouse.move(wc.x, wc.y + 20, { steps: 5 });
  await a.mouse.up();
  await expect(marker(b, walkerKey)).toHaveAttribute("data-health", "55");

  // Presenter presses Play -> Follower sees both clear!
  await a.getByTestId("match-play").click();
  await expect(marker(b, walkerKey)).toHaveAttribute("data-health", "80");
  await a.getByTestId("match-play").click(); // pause Presenter again

  // Independent-timestamp isolation: Follower stops following and pauses at t=35;
  // Presenter scrubs to t=20 and edits Amber-0 -> Follower at t=35 doesn't see it,
  // and Follower pressing Play at t=35 does NOT wipe Presenter's t=20 edits!
  await b.getByTestId("stop-following").click();
  await scrubTo(b, 35);
  await scrubTo(a, 20);
  await dragToken(a, "Amber-0", 0.62, 0.36);
  await expect(a.getByTestId("match-reset")).toBeVisible();
  await expect(b.getByTestId("match-reset")).toHaveCount(0);

  await b.getByTestId("match-play").click(); // B plays at t=35
  await a.waitForTimeout(400);
  await expect(a.getByTestId("match-reset")).toBeVisible(); // A's edits at t=20 survive!
  await b.getByTestId("match-play").click();

  // View-only user cannot edit while paused.
  const vUrl = await viewLink(server.url, url);
  const v = await joinNew(browser, vUrl, "Viewer");
  await expect(v.getByTestId("match-tier")).toHaveText("Full replay");
  await scrubTo(v, 35);
  const vBefore = await tokenAt(v, "Amber-2");
  await dragToken(v, "Amber-2", 0.6, 0.6);
  const vAfter = await tokenAt(v, "Amber-2");
  expect(Math.hypot(vAfter.x - vBefore.x, vAfter.y - vBefore.y)).toBeLessThan(5);
  await expect(v.getByTestId("match-reset")).toHaveCount(0);
});

test("phone portrait and landscape paused editing keeps transport height budgets and 44px rail targets", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Phone");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();

  await openReplay(p);
  await scrubTo(p, 20);

  // Enter phone Edit mode from More sheet.
  await p.getByTestId("phone-more").tap();
  await p.getByTestId("phone-edit").tap();
  await expect(p.locator(".p-rail")).toBeVisible();

  // Drag Amber-0 while paused in phone Edit mode.
  const before = await tokenAt(p, "Amber-0");
  await dragToken(p, "Amber-0", 0.58, 0.45);
  await expect.poll(async () => {
    const after = await tokenAt(p, "Amber-0");
    return Math.hypot(after.x - before.x, after.y - before.y);
  }).toBeGreaterThan(50);

  // Save & Reset appear in .p-rail with >= 44px touch targets; .pl-bar stays <= 104px in portrait!
  const saveBtn = p.getByTestId("match-save");
  const resetBtn = p.getByTestId("match-reset");
  await expect(saveBtn).toBeVisible();
  await expect(resetBtn).toBeVisible();
  const saveBox = (await saveBtn.boundingBox())!;
  const resetBox = (await resetBtn.boundingBox())!;
  expect(saveBox.height).toBeGreaterThanOrEqual(44);
  expect(resetBox.height).toBeGreaterThanOrEqual(44);

  const portraitBar = (await p.locator(".phone .pl-bar").boundingBox())!;
  expect(portraitBar.height).toBeLessThanOrEqual(104);

  // Landscape 667x375: .phone .pl-bar keeps its 1-row height (44px target + 8px padding + 1px border <= 53px) even with .p-rail + Save + Reset!
  await p.setViewportSize({ width: 667, height: 375 });
  await expect(saveBtn).toBeVisible();
  const landscapeBar = (await p.locator(".phone .pl-bar").boundingBox())!;
  expect(landscapeBar.height).toBeLessThanOrEqual(53);

  // Reset works on phone!
  await resetBtn.tap();
  await expect(resetBtn).toHaveCount(0);
  await ctx.close();
});

test("scene-mode Play and Play with scene plan (playFrom) do not wipe another coach's paused edits", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit PlayFrom Isolation");
  const a = await joinNew(browser, url, "CoachA");
  await openReplay(a);
  await scrubTo(a, 40);

  // Save a scene at 40s and draw a plan stroke on that saved scene.
  await a.getByTestId("match-save").click();
  await expect(a.getByTestId("player")).toHaveAttribute("data-state", "scene");
  await a.getByTestId("tool-draw").click();
  await gesture(a, [[0.3, 0.3], [0.42, 0.36]]);
  await expect(a.locator(".ink")).toHaveCount(1);
  await a.getByTestId("tool-select").click();

  // Coach A returns to Player, pauses at 20s, and drags Amber-0.
  await a.getByTestId("mode-player").click();
  await scrubTo(a, 20);
  await dragToken(a, "Amber-0", 0.62, 0.38);
  const movedA = await tokenAt(a, "Amber-0");
  await expect(a.getByTestId("match-reset")).toBeVisible();

  // Coach B joins, opens the saved 40s scene, and triggers scene-mode Play (Resume replay).
  const b = await joinNew(browser, url, "CoachB");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await b.locator(".scene-row", { hasText: "0:40" }).click();
  await expect(b.getByTestId("player")).toHaveAttribute("data-state", "scene");
  await b.getByTestId("match-play").click();
  await expect(b.getByTestId("match-play")).toHaveAttribute("data-playing", "true");
  await a.waitForTimeout(300);

  // Coach A's 20s paused edit MUST survive Coach B's scene-mode Play!
  await expect(a.getByTestId("match-reset")).toBeVisible();
  const afterScenePlay = await tokenAt(a, "Amber-0");
  expect(Math.hypot(afterScenePlay.x - movedA.x, afterScenePlay.y - movedA.y)).toBeLessThan(15);

  // Coach B goes back to the 40s scene and clicks "Play from here" (Play with scene plan).
  await b.locator(".scene-row", { hasText: "0:40" }).click();
  await expect(b.getByTestId("play-from-here")).toBeVisible();
  await b.getByTestId("play-from-here").click();
  await expect(b.getByTestId("match-play")).toHaveAttribute("data-playing", "true");
  // The scene's drawing was copied to live ink!
  await expect(b.locator(".ink")).toHaveCount(1);
  await a.waitForTimeout(300);

  // Coach A's 20s paused edit STILL survives Coach B's playFrom!
  await expect(a.getByTestId("match-reset")).toBeVisible();
  const afterPlayFrom = await tokenAt(a, "Amber-0");
  expect(Math.hypot(afterPlayFrom.x - movedA.x, afterPlayFrom.y - movedA.y)).toBeLessThan(15);
});

test("remote wave drag preview remains visible in a second pause session after Play tombstoned the deterministic wave", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Remote Wave Tombstone");
  const a = await joinNew(browser, url, "Presenter");
  await openReplay(a);
  await scrubTo(a, 20);

  const b = await joinNew(browser, url, "Follower");
  await expect(b.getByTestId("follow-Presenter")).toBeVisible();
  await b.getByTestId("follow-Presenter").click();
  await expect(b.getByTestId("match-clock")).toContainText("0:20");

  // Cycle 1: drag wave -> commits deterministic Wave -> press Play -> tombstones deterministic Wave -> pause again at 20s.
  const waveA = a.getByTestId("wave-gap-lane1");
  const w1 = await centre(waveA);
  await a.mouse.move(w1.x, w1.y);
  await a.mouse.down();
  await a.mouse.move(w1.x, w1.y - 50, { steps: 5 });
  await a.mouse.up();
  await expect(a.getByTestId("match-reset")).toBeVisible();
  await a.getByTestId("match-play").click();
  await expect(a.getByTestId("match-reset")).toHaveCount(0);
  await a.getByTestId("match-play").click();
  await scrubTo(a, 20);
  await expect(b.getByTestId("match-clock")).toContainText("0:20");

  // Cycle 2: hold pointer down and drag wave WITHOUT releasing -> Follower MUST see live remote wave preview!
  const w2A = await centre(waveA);
  const w2BBefore = await centre(b.getByTestId("wave-gap-lane1"));
  await a.mouse.move(w2A.x, w2A.y);
  await a.mouse.down();
  await a.mouse.move(w2A.x, w2A.y - 70, { steps: 6 });

  await expect(b.locator(".waves")).toContainText("moving the wave");
  await expect.poll(async () => {
    const w2BAfter = await centre(b.getByTestId("wave-gap-lane1"));
    return Math.hypot(w2BAfter.x - w2BBefore.x, w2BAfter.y - w2BBefore.y);
  }).toBeGreaterThan(20);

  await a.mouse.up();
});

test("view-only user cannot edit TopBar controls or see Save/Reset/phone dirty dot", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit ViewOnly Controls");
  const a = await joinNew(browser, url, "Coach");
  await openReplay(a);
  await scrubTo(a, 20);
  await dragToken(a, "Amber-0", 0.58, 0.42);
  await expect(a.getByTestId("match-reset")).toBeVisible();

  // Desktop view-only user paused at 20s (same timestamp as dirty liveScene).
  const vUrl = await viewLink(server.url, url);
  const v = await joinNew(browser, vUrl, "Viewer");
  await expect(v.getByTestId("match-tier")).toHaveText("Full replay");
  await scrubTo(v, 20);

  await expect(v.getByTestId("match-reset")).toHaveCount(0);
  // Right-click portrait does not open hero-menu.
  const s0 = v.locator('.tb-player[data-slot="Sapphire-0"]');
  await s0.click({ button: "right" });
  await expect(v.getByTestId("hero-menu")).toHaveCount(0);
  // Double-click souls does not open souls editor.
  await s0.getByTestId("souls-banner").dblclick();
  await expect(v.getByTestId("souls-input")).toHaveCount(0);
  // Dragging UltRing does not change cooldown.
  const a2Ult = v.locator('.tb-player[data-slot="Amber-2"] .tb-ult');
  await expect(a2Ult).toHaveClass(/ready/);
  const uc = await centre(a2Ult);
  await v.mouse.move(uc.x, uc.y);
  await v.mouse.down();
  await v.mouse.move(uc.x, uc.y + 18, { steps: 4 });
  await v.mouse.up();
  await expect(a2Ult).toHaveClass(/ready/);
  // No editable vision toggle button for view-only user.
  await expect(s0.locator("button[data-testid=tb-vision]")).toHaveCount(0);

  // Phone view-only user paused at 20s: NO dirty dot on More button and NO Save/Reset in More sheet!
  const pCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pv = await pCtx.newPage();
  await pv.goto(vUrl);
  await pv.locator("#join-name").fill("PhoneViewer");
  await pv.keyboard.press("Enter");
  await expect(pv.getByTestId("join-card")).toBeHidden();
  await expect(pv.getByTestId("match-tier")).toHaveText("Full replay");
  await scrubTo(pv, 20);

  await expect(pv.locator('[data-testid="phone-more"] .save-dirty-dot')).toHaveCount(0);
  await pv.getByTestId("phone-more").tap();
  await expect(pv.getByTestId("phone-match-save")).toHaveCount(0);
  await expect(pv.getByTestId("phone-match-reset")).toHaveCount(0);
  await pCtx.close();
});

test("split ink + doorway Erase in paused Player preserves live-ink undo after Play", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Split Erase");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p);
  await scrubTo(p, 20);

  // Locate the replay Doorman doorway on screen.
  const door = p.locator(".pl-door").first();
  await expect(door).toBeVisible();
  const dc = await centre(door);

  // Draw a live ink stroke right beside the doorway!
  await p.getByTestId("tool-draw").click();
  await p.mouse.move(dc.x - 75, dc.y - 35);
  await p.mouse.down();
  await p.mouse.move(dc.x - 35, dc.y - 25, { steps: 5 });
  await p.mouse.up();
  await expect(p.locator(".ink")).toHaveCount(1);

  // Switch to Erase tool and sweep ONE continuous gesture across BOTH the live ink stroke AND the doorway!
  await p.getByTestId("tool-erase").click();
  await p.mouse.move(dc.x - 65, dc.y - 32);
  await p.mouse.down();
  await p.mouse.move(dc.x - 40, dc.y - 26, { steps: 4 });
  await p.mouse.move(dc.x, dc.y, { steps: 6 });
  await p.mouse.up();
  await expect(p.locator(".ink")).toHaveCount(0);
  await expect(p.locator(".pl-door")).toHaveCount(0);

  // Press Play -> clears doorway override and prunes live-entity undo, then pause again.
  await p.keyboard.press("Space");
  await expect(p.getByTestId("match-play")).toHaveAttribute("data-playing", "true");
  await expect(p.locator(".pl-door")).toHaveCount(1);
  await p.keyboard.press("Space");
  await expect(p.getByTestId("match-play")).toHaveAttribute("data-playing", "false");

  // Ctrl+Z MUST restore the erased live ink stroke (proving Erase split ink vs doorway transactions)!
  await p.keyboard.press("Control+z");
  await expect(p.locator(".ink")).toHaveCount(1);
});

test("desktop transport bar has zero overlap and zero overflow across viewports with paused Reset and dirty Save as scene (Pass 008 Finding #1)", async ({ browser }) => {
  const url = await newBoardUrl(server, "Pause Edit Transport Fit");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();

  await openReplay(p);
  await scrubTo(p, 20);

  const viewports = [
    [1024, 600],
    [1280, 600],
    [1280, 800],
    [1366, 650],
    [1366, 768],
    [1400, 900],
    [1440, 900],
    [1520, 900],
    [1920, 1080],
  ] as const;

  const clocks = [
    ["15:55", " / 25:14"],
    ["1:05:12", " / 1:10:00"],
  ] as const;

  const auditTransport = async (w: number, h: number, dirty: boolean, clockLabel: string) => {
    const res = await p.evaluate(({ w, h, dirty }) => {
      const bar = document.querySelector<HTMLElement>('[data-testid="player"]')!;
      const stage = document.querySelector<HTMLElement>(".stage")!;
      const br = bar.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      const selectors = [
        [".pl-source > summary", "pl-source"],
        ['[data-testid="match-time"]', "match-time"],
        ['[data-testid="speed-down"]', "speed-down"],
        ['[data-testid="match-back"]', "match-back"],
        ['[data-testid="match-play"]', "match-play"],
        ['[data-testid="match-forward"]', "match-forward"],
        ['[data-testid="speed-up"]', "speed-up"],
        ['[data-testid="match-clock"]', "match-clock"],
        ...(dirty ? ([['[data-testid="match-reset"]', "match-reset"]] as const) : []),
        ['[data-testid="match-save"]', "match-save"],
      ] as const;

      const items = selectors.map(([sel, id]) => {
        const el = bar.querySelector<HTMLElement>(sel)!;
        const r = el.getBoundingClientRect();
        return {
          id,
          tag: el.tagName,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
          sw: el.scrollWidth,
          cw: el.clientWidth,
        };
      });

      const issues: string[] = [];
      if (bar.scrollWidth > bar.clientWidth + 1) issues.push(`bar overflow (${bar.scrollWidth} > ${bar.clientWidth})`);
      if (document.documentElement.scrollWidth > w) issues.push(`doc overflowX (${document.documentElement.scrollWidth} > ${w})`);
      if (document.documentElement.scrollHeight > h) issues.push(`doc overflowY (${document.documentElement.scrollHeight} > ${h})`);

      for (const it of items) {
        if (it.left < Math.max(br.left, sr.left) - 0.5 || it.right > Math.min(br.right, sr.right, w) + 0.5) {
          issues.push(`${it.id} horizontal out-of-bounds (${Math.round(it.left)}..${Math.round(it.right)})`);
        }
        if (it.top < Math.max(br.top, sr.top) - 0.5 || it.bottom > Math.min(br.bottom, sr.bottom, h) + 0.5) {
          issues.push(`${it.id} vertical out-of-bounds (${Math.round(it.top)}..${Math.round(it.bottom)})`);
        }
        if (it.tag !== "INPUT" && it.sw > it.cw + 1) {
          issues.push(`${it.id} clipped (${it.sw} > ${it.cw})`);
        }
      }

      for (const el of [...bar.querySelectorAll<HTMLElement>("button:not(.pl-mark, .pl-tick), select, input:not([type=file]), .pl-source > summary, .match-clock, .match-tier, .pl-scene-label")].filter((e) => e.checkVisibility())) {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !(el === hit || el.contains(hit))) {
          issues.push(`${el.dataset.testid ?? el.className} covered by ${hit?.className || hit?.tagName}`);
        }
      }

      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const a = items[i]!;
          const b = items[j]!;
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 0.5 && oy > 0.5) {
            issues.push(`${a.id} overlaps ${b.id} by ${Math.round(ox)}×${Math.round(oy)}px`);
          }
        }
      }

      const src = items.find((x) => x.id === "pl-source")!;
      const speedDown = items.find((x) => x.id === "speed-down")!;
      const play = items.find((x) => x.id === "match-play")!;
      const speedUp = items.find((x) => x.id === "speed-up")!;
      const clock = items.find((x) => x.id === "match-clock")!;
      const save = items.find((x) => x.id === "match-save")!;
      const reset = items.find((x) => x.id === "match-reset");
      const playCenterOffset = Math.abs((play.left + play.width / 2) - (br.left + br.width / 2));
      if (playCenterOffset > 1) issues.push(`match-play off center by ${playCenterOffset.toFixed(2)}px`);

      const singleRow = Math.abs((speedUp.top + speedUp.height / 2) - (clock.top + clock.height / 2)) <= 4;
      const gap = Math.round(clock.left - speedUp.right);
      const srcTailGap = Math.round(clock.left - src.right);
      return {
        issues,
        singleRow,
        gap,
        srcTailGap,
        barW: Math.round(br.width),
        barH: Math.round(br.height),
        srcW: Math.round(src.width),
        keysW: Math.round(speedUp.right - speedDown.left),
        clockW: Math.round(clock.width),
        resetW: reset ? Math.round(reset.width) : 0,
        saveW: Math.round(save.width),
        tailW: Math.round(save.right - clock.left),
      };
    }, { w, h, dirty });

    expect(res.issues, `${w}×${h} dirty=${dirty} clock=${clockLabel}`).toEqual([]);
    if (w >= 1440) {
      expect(res.singleRow, `${w}×${h} stays single-row`).toBe(true);
      expect(res.gap, `${w}×${h} clearance between speed-up and match-clock`).toBeGreaterThanOrEqual(8);
    }
    return res;
  };

  for (const dirty of [false, true] as const) {
    if (dirty) {
      await p.setViewportSize({ width: 1440, height: 900 });
      await dragToken(p, "Amber-0", 0.58, 0.42);
      await expect(p.getByTestId("match-reset")).toBeVisible();
      await expect(p.getByTestId("match-save")).toHaveClass(/dirty/);
      await expect(p.getByTestId("match-save")).toContainText("Save as scene");
    }
    for (const [w, h] of viewports) {
      await p.setViewportSize({ width: w, height: h });
      for (const [now, of] of clocks) {
        await p.getByTestId("match-clock").evaluate((el, [nowText, ofText]) => {
          el.querySelector(".clock-now")!.textContent = nowText;
          el.querySelector(".clock-of")!.textContent = ofText;
        }, [now, of] as const);
        await auditTransport(w, h, dirty, `${now}${of}`);
      }
    }
  }

  await ctx.close();
});
