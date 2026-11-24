// Doorman doorway indicators — Stage 2 (Release 1: Player + dormant Scene reader, store v18 floor 16).
//
// Covers:
// 1. Player rendering without a pack (DOOR_FB SVG fallback) vs with a synthetic pack (`icons/doorman_doorway_psd`).
// 2. Unpaired Door 1 vs Linked Pair (`door1`/`door2`) + curved dashed Bézier `.pl-door-link` +
//    pair-wide hover highlight (`data-hot`) + strict §4b `"Doorway"` hover label + SVG Z-order below tokens.
// 3. Enemy Vision `visionFade` hide/show on continuous playback (`data-fading="out"`, 350 ms, never a ghost)
//    and immediate snap on Vision switch / seek.
// 4. Scene rendering from stored `SceneState.more` (`rows: 42, has_doors: true, doors: [...]`) cold-loaded
//    through the Release 1 Rust server (verifying the v19 -> v18 rollback reader!) including D3 faded +
//    `.vis.off` eye-slash badge under enemy Vision, plus confirming Release 1 refuses `has_doors` on import.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "142815246";
const N = 40;
const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";

// A 1x1 non-game-art PNG for the synthetic pack test.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/**
 * Synthetic 6v6 replay with Doorman doorways:
 * - Door 0 (sapphire, (-2200, 1200)): spawns at 4.0s (unpaired), links to Door 1 at 10.0s, closes at 30.0s.
 *   Enemy FOW seen: [60, 160] (6.0s..16.0s) and [200, 280] (20.0s..28.0s).
 * - Door 1 (sapphire, (2400, -1400)): spawns linked to Door 0 at 10.0s, closes at 30.0s.
 *   Enemy FOW seen: [100, 160] (10.0s..16.0s) and [200, 280] (20.0s..28.0s).
 * - Door 2 (amber, (-500, -3200)): unpaired 32.0s..38.0s, never seen by enemy.
 */
function replayTimeline() {
  return {
    match_id: Number(ID),
    start_time: 0,
    duration_s: N,
    source: "replay",
    tier: "replay",
    build: 6865,
    reanchored: 0,
    format: TIMELINE_FORMAT,
    players: [
      {
        team: "amber",
        slot: 0,
        hero_id: 1,
        name: null,
        x: range(() => -6000),
        y: range(() => -6000),
        health: range(() => 100),
        deaths: [],
        respawn: [],
        souls: [[0, 1000]],
        ult: range(() => 0),
        seen: [[0, 400]],
      },
      {
        team: "sapphire",
        slot: 0,
        hero_id: 69,
        name: null,
        x: range(() => 6000),
        y: range(() => 6000),
        health: range(() => 100),
        deaths: [],
        respawn: [],
        souls: [[0, 1000]],
        ult: range(() => 0),
        seen: [[0, 400]],
      },
    ],
    objectives: [],
    mid_boss: [],
    rifts: [],
    powerups: [],
    zips: [],
    camps: [],
    events: [],
    doors: [
      { id: 0, team: "sapphire", x: -2200, y: 1200, start_ds: 40, link_ds: 100, end_ds: 300, partner: 1, seen: [[60, 160], [200, 280]] },
      { id: 1, team: "sapphire", x: 2400, y: -1400, start_ds: 100, link_ds: 100, end_ds: 300, partner: 0, seen: [[100, 160], [200, 280]] },
      { id: 2, team: "amber", x: -500, y: -3200, start_ds: 320, end_ds: 380, seen: [] },
    ],
  };
}

function syntheticDoorPack(): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-door-pack-"));
  const dir = join(root, "synthetic");
  const blobs: Record<string, unknown> = {};
  for (const key of ["map/minimap_midtown_mid", "icons/doorman_doorway_psd"]) {
    const file = `${key}.png`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), PNG);
    blobs[key] = { sha256: createHash("sha256").update(PNG).digest("hex"), w: 1, h: 1, mime: "image/png", file };
  }
  writeFileSync(
    join(dir, "pack.json"),
    JSON.stringify({
      schema: 3,
      game: { client_version: 6865, source_revision: 1, date: "Nov 24 2026" },
      blobs,
      heroes: [],
      entities: [],
    }),
  );
  return root;
}

const answered = new Set<string>();
async function openReplay(p: Page, queue: string) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
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

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, sec) => {
    (el as HTMLInputElement).value = String(sec);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

const catchFade = (p: Page, sel: string) =>
  p.evaluate(
    (sel) =>
      new Promise<{ from: number; to: number; easing: string; duration: number; out: boolean }>((done, fail) => {
        const until = performance.now() + 5000;
        const look = () => {
          const el = document.querySelector(sel);
          const a = el?.getAnimations().find((x) => (x.effect as KeyframeEffect).getKeyframes().some((k) => "opacity" in k));
          if (el && a) {
            a.pause();
            const k = (a.effect as KeyframeEffect).getKeyframes();
            const tm = (a.effect as KeyframeEffect).getTiming();
            return done({
              from: Number(k[0]!.opacity),
              to: Number(k.at(-1)!.opacity),
              easing: String(tm.easing),
              duration: Number(tm.duration),
              out: el.getAttribute("data-fading") === "out",
            });
          }
          if (performance.now() > until) return fail(new Error(`no fade on ${sel}`));
          requestAnimationFrame(look);
        };
        look();
      }),
    sel,
  );

const resumeFades = (p: Page) => p.evaluate(() => document.getAnimations().forEach((a) => a.playState === "paused" && a.play()));

const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-doors-"));
let server: Server;

test.beforeAll(async () => {
  server = new Server(undefined, { REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "50" });
  await server.start();
});

test.afterAll(() => {
  server.stop();
});

test("Player renders fallback SVG, unpaired vs linked pair + link arc + pair hover highlight + Z-order", async ({ browser }) => {
  const url = await newBoardUrl(server, "Doors Player");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p, queue);

  const doors = p.locator("[data-testid=map] [data-testid=doorman-door]");
  const links = p.locator("[data-testid=map] [data-testid=door-link]");

  // Before first spawn: no doors.
  await scrubTo(p, 2);
  await expect(doors).toHaveCount(0);
  await expect(links).toHaveCount(0);

  // t = 5s: unpaired Door 1 (sapphire), dashed rim, fallback SVG, no link arc.
  await scrubTo(p, 5);
  await expect(doors).toHaveCount(1);
  await expect(links).toHaveCount(0);
  const d0 = doors.first();
  await expect(d0).toHaveAttribute("data-team", "sapphire");
  await expect(d0).toHaveAttribute("data-role", "unpaired");
  await expect(d0).toHaveAttribute("data-art", "fallback");
  await expect(d0).toHaveAttribute("aria-label", "Archmother Doorway");
  await expect(d0.locator("image.pl-door-art")).toHaveAttribute("href", /^data:image\/svg\+xml,/);
  await expect(d0.locator("circle.pl-door-rim")).toHaveAttribute("stroke-dasharray", /\d/);

  // t = 12s: linked pair (door1 + door2) + curved dashed Bézier link arc.
  await scrubTo(p, 12);
  await expect(doors).toHaveCount(2);
  await expect(links).toHaveCount(1);
  const door0 = p.locator('[data-testid=map] [data-testid=doorman-door][data-door-id="0"]');
  const door1 = p.locator('[data-testid=map] [data-testid=doorman-door][data-door-id="1"]');
  const link = links.first();
  await expect(door0).toHaveAttribute("data-role", "door1");
  await expect(door1).toHaveAttribute("data-role", "door2");
  await expect(door0).toHaveAttribute("data-partner", "1");
  await expect(door1).toHaveAttribute("data-partner", "0");
  await expect(link.locator("path.pl-door-link-thread")).toHaveAttribute("d", /^M[\d.-]+ [\d.-]+ Q[\d.-]+ [\d.-]+ [\d.-]+ [\d.-]+$/);

  // SVG Z-order: `.pl-doors` sits BEFORE `.tokens` so hero tokens draw on top of doorways.
  const zOrderOk = await p.evaluate(() => {
    const svg = document.querySelector("[data-testid=map] svg.mm-overlay.map");
    if (!svg) return false;
    const d = svg.querySelector(".pl-doors");
    const t = svg.querySelector(".tokens");
    return !!(d && t && (d.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING));
  });
  expect(zOrderOk).toBe(true);

  // Hovering door0 shows exact §4b `"Doorway"` label and highlights BOTH doors + link arc.
  const box = (await door0.boundingBox())!;
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(p.getByTestId("hover-label")).toHaveText("Doorway");
  await expect(door0).toHaveAttribute("data-hot", "");
  await expect(door1).toHaveAttribute("data-hot", "");
  await expect(link).toHaveAttribute("data-hot", "");

  // Moving pointer away clears hover label and pair highlight.
  await p.mouse.move(10, 10);
  await expect(p.getByTestId("hover-label")).toHaveCount(0);
  await expect(door0).not.toHaveAttribute("data-hot", "");
  await expect(door1).not.toHaveAttribute("data-hot", "");
  await expect(link).not.toHaveAttribute("data-hot", "");

  // After close (t = 31s): pair is gone.
  await scrubTo(p, 31);
  await expect(doors).toHaveCount(0);
  await expect(links).toHaveCount(0);
});

test("Player renders pack icon when asset pack carries icons/doorman_doorway_psd", async ({ browser }) => {
  const packQueue = mkdtempSync(join(tmpdir(), "mapcro-e2e-doors-pack-"));
  const packServer = new Server(syntheticDoorPack(), { REPLAY_DIR: packQueue, REPLAY_PER_CLIENT_PER_HOUR: "50" });
  await packServer.start();
  try {
    const url = await newBoardUrl(packServer, "Doors Pack");
    const p = await joinNew(browser, url, "Coach");
    await openReplay(p, packQueue);
    await scrubTo(p, 12);
    const door0 = p.locator('[data-testid=map] [data-testid=doorman-door][data-door-id="0"]');
    await expect(door0).toHaveAttribute("data-art", "pack");
    await expect(door0.locator("image.pl-door-art")).toHaveAttribute("href", /\/packs\/[0-9a-f]+\/icons\/doorman_doorway_psd\.png$/);
  } finally {
    packServer.stop();
  }
});

test("Player enemy Vision fades doors out and back in smoothly (350 ms, never a ghost)", async ({ browser }) => {
  const url = await newBoardUrl(server, "Doors Vision");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p, queue);

  const door0Sel = '[data-testid=map] [data-testid=doorman-door][data-door-id="0"]';
  const linkSel = '[data-testid=map] [data-testid=door-link]';
  const doors = p.locator("[data-testid=map] [data-testid=doorman-door]");

  // Switch Vision to Amber (enemy of Sapphire Doorman).
  await p.getByTestId("vision-select").selectOption("amber");

  // At t = 15s (seen [100..160]): both doors visible. Start continuous playback across t = 16.0s -> fade out!
  await scrubTo(p, 15);
  await expect(doors).toHaveCount(2);
  await p.getByTestId("match-play").click();
  const [doorOut, linkOut] = await Promise.all([catchFade(p, door0Sel), catchFade(p, linkSel)]);
  expect(doorOut).toEqual({ from: 1, to: 0, easing: EXPO, duration: 350, out: true });
  expect(linkOut).toEqual({ from: 1, to: 0, easing: EXPO, duration: 350, out: true });
  await resumeFades(p);
  await expect(doors).toHaveCount(0);
  await p.getByTestId("match-play").click(); // pause

  // At t = 19s (unseen): start continuous playback across t = 20.0s -> fade back in!
  await scrubTo(p, 19);
  await expect(doors).toHaveCount(0);
  await p.getByTestId("match-play").click();
  const doorIn = await catchFade(p, door0Sel);
  expect(doorIn).toEqual({ from: 0, to: 1, easing: EXPO, duration: 350, out: false });
  await resumeFades(p);
  await expect(doors).toHaveCount(2);
  await p.getByTestId("match-play").click(); // pause

  // Switching to Sapphire (own team) at t = 18s (unseen by enemy) snaps doors visible immediately.
  await scrubTo(p, 18);
  await expect(doors).toHaveCount(0);
  await p.getByTestId("vision-select").selectOption("sapphire");
  await expect(doors).toHaveCount(2);
});

test("Release 1 Scene reader renders stored v19 SceneState.more.doors (seen & D3 faded) while refusing Ahead rows on import", async ({ browser }) => {
  const rbServer = new Server(undefined, { REPLAY_DIR: queue });
  await rbServer.start();
  try {
    // 1. Confirm Release 1 admission gate refuses `has_doors` / `doors` on /api/boards/import.
    const createRes = await fetch(`${rbServer.url}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Doors Rollback" }),
    });
    expect(createRes.status).toBe(201);
    const { board, owner_token } = (await createRes.json()) as { board: string; owner_token: string };
    const expRes = await fetch(`${rbServer.url}/api/boards/${board}/export`, {
      headers: { authorization: `Bearer ${owner_token}` },
    });
    expect(expRes.status).toBe(200);
    const exported = (await expRes.json()) as {
      records: Array<[string, Record<string, unknown>]>;
    };
    const sceneEntry = exported.records.find(([, rec]) => "Scene" in rec)!;
    const sceneId = sceneEntry[0];
    const stateId = "0000000000000000000000000000d001";
    // Packed doors: Sapphire linked pair (id 0 & 1, unseenInt = 1 -> unseen by enemy) + Amber unpaired (id 2, seen).
    const doorInts = [
      1, -2400, 1400, 1, 1, 1,
      1, 2400, -1400, 2, 0, 1,
      0, 0, -2800, 0, -1, 0,
    ];
    const stateRec = {
      SceneState: {
        scene: sceneId,
        more: {
          rows: 42,
          has_sight: true,
          has_doors: true,
          doors: doorInts,
        },
      },
    };
    const badImport = await fetch(`${rbServer.url}/api/boards/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...exported,
        records: [...exported.records, [stateId, stateRec]],
      }),
    });
    expect(badImport.status).toBe(422);

    // 2. Simulate v19 -> v18 rollback: store the v19 SceneState directly in SQLite `boards.base_doc`
    //    and restart the Release 1 server so it cold-loads the board cleanly.
    await rbServer.kill();
    const docEntries = [
      ...exported.records.map(([id, record]) => [id, { record, deleted: false }]),
      [stateId, { record: stateRec, deleted: false }],
    ];
    execFileSync("python3", [
      "-c",
      "import sqlite3, sys; c = sqlite3.connect(sys.argv[1]); c.execute('UPDATE boards SET base_doc = ?, base_codec = \"json\" WHERE id = ?', (sys.argv[2], sys.argv[3])); c.commit(); c.close()",
      join(rbServer.dataDir, "mapcro.sqlite"),
      JSON.stringify(docEntries),
      board,
    ]);
    await rbServer.start();

    const p = await joinNew(browser, `${rbServer.url}/b/${board}#${owner_token}`, "Coach");
    const doors = p.locator("[data-testid=map] [data-testid=doorman-door]");
    const links = p.locator("[data-testid=map] [data-testid=door-link]");
    const sDoor0 = p.locator('[data-testid=map] [data-testid=doorman-door][data-door-id="0"]');
    const sDoor1 = p.locator('[data-testid=map] [data-testid=doorman-door][data-door-id="1"]');
    const aDoor2 = p.locator('[data-testid=map] [data-testid=doorman-door][data-door-id="2"]');

    // Vision: All (default) -> all 3 doors drawn seen (not faded), 1 link arc for Sapphire pair.
    await expect(doors).toHaveCount(3);
    await expect(links).toHaveCount(1);
    await expect(sDoor0).not.toHaveAttribute("data-faded", "");
    await expect(aDoor2).toHaveAttribute("data-role", "unpaired");

    // Hover in Scene shows `"Doorway"` and highlights linked pair.
    const box = (await sDoor0.boundingBox())!;
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(p.getByTestId("hover-label")).toHaveText("Doorway");
    await expect(sDoor0).toHaveAttribute("data-hot", "");
    await expect(sDoor1).toHaveAttribute("data-hot", "");
    await expect(links.first()).toHaveAttribute("data-hot", "");

    // Vision: Amber (enemy of Sapphire) -> Scene D3 rule draws unseen Sapphire doors faded with `.vis.off` eye-slash badge,
    // while Amber's own door stays seen!
    await p.getByTestId("vision-select").selectOption("amber");
    await expect(doors).toHaveCount(3);
    await expect(sDoor0).toHaveAttribute("data-faded", "");
    await expect(sDoor1).toHaveAttribute("data-faded", "");
    await expect(sDoor0.getByTestId("door-unseen-mark")).toHaveCount(1);
    await expect(links.first()).toHaveAttribute("data-faded", "");
    await expect(aDoor2).not.toHaveAttribute("data-faded", "");
  } finally {
    await rbServer.kill();
  }
});
