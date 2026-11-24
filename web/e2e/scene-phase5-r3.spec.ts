// Map-state phase 5, Release R3 (Writer B, store v17 floor 16, docs/specs/map-state-phase5-plan.md §5 & §8):
// 1. Saving a full replay scene captures Group B baseline (camps/heals/crates, powerups, rift capture
//    rings, urn ground/carried, objective health & Patron stage, Rejuvenator badge/timer, Mid-Boss
//    respawn on scene bar, closed lane shops, marker hover timers) AND shrinks ObjectiveState record
//    count substantially vs R2 (emitting only destroyed structural objectives).
// 2. Clicking a baseline-cleared camp in the saved R3 scene marks it up in ONE click (overriding
//    baseline & clearing hover timer); clicking a baseline-active rift turns it off (removing
//    rift-rings); clicking the other rift swaps them in one transaction.
// 3. Retaking an R2/v14 scene backfills Group B baseline while preserving manual ObjectiveState
//    overrides; metadata scenes do NOT offer Retake for Group B.
// 4. Exporting the R3 board produces version: 6, rows: 40; importing it with matches: [] (no match
//    open) renders Group B markers, hover timers, scene bar timers, and Health/Heals/Crates controls.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000163";
const META_ID = "129000164";
const N = 40;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-phase5-r3-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

const CAMP_CLEARED = "camp:neutral:lane0:3";
const HEAL_CLEARED = "heal:neutral:lane1:1";
const CRATE_CLEARED = "tough_crate:neutral:lane1:1";
const BOSS = "mid_boss:neutral:lane0:1";
const PWR0 = "powerup:neutral:lane1:1";
const PWR1 = "powerup:neutral:lane6:1";
const RIFT0 = "rift:neutral:lane1:1";
const RIFT1 = "rift:neutral:lane6:1";
const URN0 = "urn:neutral:lane1:1";
const URN1 = "urn:neutral:lane6:1";
const WALKER = "walker:amber:lane1:1";
const GUARDIAN = "guardian:sapphire:lane4:1";
const PATRON = "patron:amber:lane0:1";
const CLOSED_SHOP = "shop:sapphire:lane4:1";
const OPEN_SHOP = "shop:amber:lane1:1";

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Synthetic 6v6 replay with every Group B feature active across t=15 and t=25:
 * - t=15:
 *   - 18 non-up camps (CAMP_CLEARED cleared [10, 135] + 17 unspawned first_s: 120),
 *     HEAL_CLEARED cleared [10, 75], CRATE_CLEARED cleared [10, 85], BOSS cleared [12, 415]
 *   - PWR0 up ("casting"), PWR1 down (next "gun" at 35)
 *   - RIFT0 active (start_s=10, live_s=10, end_s=20, give_up_s=20, capture amber=50 sapphire=25)
 *   - Urn on ground at (1500, -1500), delivery URN1
 *   - GUARDIAN destroyed at t=5 -> CLOSED_SHOP closed, OPEN_SHOP open
 *   - WALKER at 42% HP, PATRON at 60% HP Stage 2
 *   - Rejuv held by Sapphire (taken 12, ends 22, 3 revives left)
 * - t=25:
 *   - Rejuv expired -> scene bar shows Mid-Boss respawn (6:30)
 *   - Urn carried by Sapphire-1, delivery URN1
 *   - PWR0 down (next "gun" at 35)
 */
function replayTimeline() {
  const extraCamps = Array.from({ length: 17 }, (_, i) => ({
    key: `camp:neutral:lane0:${i + 10}`,
    first_s: 120,
    cleared: [] as Array<[number, number]>,
  }));
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: null,
        x: range(() => slot * 1400 - 3500),
        y: range(() => (team === "amber" ? -2800 : 2800)),
        health: range(() => 100),
        deaths: [], respawn: [],
        souls: [[0, 1000 + slot * 100]], ult: range(() => 0),
        seen: [[0, 400]],
        level: [[0, 5]],
        items: [[10, 715_762_406, 0]],
        abilities: [], casts: [], charges: [], cc: [], effects: [], recaps: [],
      })),
    ),
    objectives: [{ key: GUARDIAN, kind: "guardian", team: "sapphire", lane: 4, destroyed_s: 5 }],
    mid_boss: [],
    camps: [
      { key: CAMP_CLEARED, first_s: 0, cleared: [[10, 135]] },
      { key: BOSS, first_s: 0, cleared: [[12, 415]] },
      ...extraCamps,
    ],
    heals: [{ key: HEAL_CLEARED, first_s: 0, cleared: [[10, 75]] }],
    crates: [{ key: CRATE_CLEARED, first_s: 0, cleared: [[10, 85]] }],
    powerups: [
      {
        key: PWR0,
        available: range((s) => (s >= 10 && s < 20 ? 1 : 0)),
        stale: [],
        spawns: [{ t: 10, buff: "casting", taken_s: 20 }, { t: 35, buff: "gun" }],
      },
      {
        key: PWR1,
        available: range(() => 0),
        stale: [],
        spawns: [{ t: 35, buff: "gun" }],
      },
    ],
    rifts: [
      { key: RIFT0, start_s: 10, live_s: 13, end_s: 20, give_up_s: 20, capture: [[130, 0, 0], [150, 50, 25]] },
    ],
    objective_health: [
      { key: WALKER, at: [[0, 100], [10, 42]] },
      { key: PATRON, at: [[0, 100], [10, 60]], stage: [[0, 1], [10, 2]] },
    ],
    urn: {
      spawns: [{ t: 10, key: URN0 }],
      at: [
        { t: 10, state: "ground", x: 1500, y: -1500, delivery: URN1 },
        { t: 22, state: "carried", team: "sapphire", slot: 1, delivery: URN1 },
      ],
    },
    rejuv: [{ team: "sapphire", taken_s: 12, ends_s: 22, left: [[12, 3]] }],
    zips: [
      { lane: "lane1", at: [[0, 500, 500]] },
      { lane: "lane4", at: [[0, 400, 600]] },
      { lane: "lane6", at: [[0, 500, 500]] },
    ],
    events: [],
  };
}

/** Deadlock-api metadata response for META_ID (metadata tier: no Group B features). */
function metaApiResponse() {
  const m = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/match-130816395-trimmed.json"), "utf8"));
  m.match_info.match_id = Number(META_ID);
  // Older than Valve's replay retention so Player stays on the API summary tier without queuing a fetch.
  m.match_info.start_time = Math.floor(Date.now() / 1000) - 30 * 86400;
  return m;
}

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    if (req.url?.includes(`/v1/matches/${META_ID}/metadata`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(metaApiResponse()));
      return;
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "50" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const answered = new Set<string>();
async function openReplay(p: Page) {
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
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
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

async function saveAt(p: Page, t: number) {
  await scrubTo(p, t);
  await p.getByTestId("match-save").click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
}

const mk = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);

async function hoverMarker(p: Page, key: string) {
  const b = (await mk(p, key).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

async function clickMarker(p: Page, key: string) {
  const b = (await mk(p, key).boundingBox())!;
  await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

type Rec = [string, Record<string, Record<string, unknown>>];
const hex = (n: number) => n.toString(16).padStart(32, "0");

async function seed(file: unknown): Promise<string> {
  const r = await fetch(`${server.url}/api/boards/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(file),
  });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}

test("1. R3 saved scene captures full Group B baseline, hovers, bar timers, closed shops, and shrinks ObjectiveState count", async ({ browser }) => {
  const url = await newBoardUrl(server, "R3 Save");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p);

  // Save at t=15 (Rejuv held, ground urn, active rift with capture rings, up powerup, cleared camp/heal/crate/boss, closed shop, Patron Stage 2).
  await saveAt(p, 15);
  await revealControls(p, "health-toggle");
  if ((await p.getByTestId("heals-toggle").getAttribute("aria-pressed")) !== "true") await p.getByTestId("heals-toggle").click();
  if ((await p.getByTestId("crates-toggle").getAttribute("aria-pressed")) !== "true") await p.getByTestId("crates-toggle").click();

  // Camps, heals, crates, Mid-Boss baseline states & hover timers.
  await expect(mk(p, CAMP_CLEARED)).toHaveAttribute("data-status", "Destroyed");
  await expect(mk(p, CAMP_CLEARED)).toHaveAttribute("data-camp", "cleared");
  await expect(mk(p, HEAL_CLEARED)).toHaveAttribute("data-status", "Destroyed");
  await expect(mk(p, HEAL_CLEARED)).toHaveAttribute("data-camp", "cleared");
  await expect(mk(p, CRATE_CLEARED)).toHaveAttribute("data-status", "Destroyed");
  await expect(mk(p, CRATE_CLEARED)).toHaveAttribute("data-camp", "cleared");
  await expect(mk(p, BOSS)).toHaveAttribute("data-status", "Destroyed");
  await expect(mk(p, BOSS)).toHaveAttribute("data-camp", "cleared");

  await hoverMarker(p, CAMP_CLEARED);
  await expect(p.getByTestId("hover-label")).toHaveText("Respawns in 2:00");
  await hoverMarker(p, HEAL_CLEARED);
  await expect(p.getByTestId("hover-label")).toHaveText("Respawns in 1:00");
  await hoverMarker(p, CRATE_CLEARED);
  await expect(p.getByTestId("hover-label")).toHaveText("Respawns in 1:10");

  // Powerups (up casting buff + down next timer), active rift capture rings, ground urn, objective health, Patron Stage 2, closed lane shop.
  await expect(mk(p, PWR0)).toHaveAttribute("data-status", "Active");
  await expect(mk(p, PWR0)).toHaveAttribute("data-buff", "casting");
  await expect(mk(p, PWR1)).toHaveAttribute("data-status", "Destroyed");
  await hoverMarker(p, PWR0);
  await expect(p.getByTestId("hover-label")).toHaveText("Casting buff");
  await hoverMarker(p, PWR1);
  await expect(p.getByTestId("hover-label")).toHaveText("Buff spawns in 0:20");

  await expect(mk(p, RIFT0)).toHaveAttribute("data-status", "Active");
  await expect(mk(p, RIFT1)).toHaveAttribute("data-status", "Destroyed");
  await expect(p.getByTestId("rift-rings")).toHaveAttribute("data-key", RIFT0);
  await expect(p.getByTestId("rift-rings")).toHaveAttribute("data-amber", "50");
  await expect(p.getByTestId("rift-rings")).toHaveAttribute("data-sapphire", "25");
  await hoverMarker(p, RIFT0);
  await expect(p.getByTestId("hover-label")).toHaveText("Fades in 0:05");

  await expect(p.getByTestId("urn")).toHaveAttribute("data-state", "ground");
  await expect(mk(p, URN1)).toHaveAttribute("data-status", "Active");
  await expect(mk(p, WALKER)).toHaveAttribute("data-health", "42");
  await expect(mk(p, PATRON)).toHaveAttribute("data-status", "Stage2");
  await expect(mk(p, PATRON)).toHaveAttribute("data-health", "60");
  // Untracked standing objective in this sparse `objective_health` timeline has NO invented `100%` health!
  await expect(mk(p, "guardian:amber:lane6:1")).not.toHaveAttribute("data-health");
  // Closed lane shop (`Hidden`) is omitted from the map; open lane shop remains visible.
  await expect(mk(p, CLOSED_SHOP)).toHaveCount(0);
  await expect(mk(p, OPEN_SHOP)).toHaveAttribute("data-status", "Active");

  // Scene bar Rejuvenator badge (3 revives) and timer.
  await expect(p.locator('[data-testid=tb-rejuv][data-team="sapphire"]')).toHaveAttribute("data-left", "3");
  await expect(p.locator('[data-testid=tb-rejuv-timer][data-team="sapphire"]')).toHaveClass(/\bon\b/);
  await expect(p.getByTestId("tb-respawn-timer")).not.toHaveClass(/\bon\b/);

  // Export and verify massive ObjectiveState reduction: 23+ non-default baseline sites collapsed into SceneState,
  // leaving ONLY the 1 destroyed structural objective (`guardian:sapphire:lane4:1`) as an ObjectiveState!
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const exported = (await (await fetch(`${server.url}/api/boards/${board}/export`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    version: number;
    rows: number;
    records: Rec[];
  };
  expect(exported.version).toBe(6);
  expect(exported.rows).toBe(40);
  const objRecs = exported.records.filter(([, r]) => "ObjectiveState" in r).map(([, r]) => r.ObjectiveState!);
  expect(objRecs).toEqual([expect.objectContaining({ key: GUARDIAN, status: "Destroyed" })]);

  // Also save at t=25 (Rejuv expired, Mid-Boss respawn on scene bar, carried urn) and verify both!
  await p.getByTestId("mode-player").click();
  await saveAt(p, 25);
  await expect(p.locator('[data-testid=tb-rejuv][data-team="sapphire"]')).toHaveAttribute("data-left", "0");
  await expect(p.getByTestId("tb-respawn-timer")).toHaveClass(/\bon\b/);
  await expect(p.getByTestId("tb-respawn-label")).toHaveText("6:30");
  await expect(p.getByTestId("urn")).toHaveAttribute("data-state", "carried");

  // Also save at t=11 (pre-live rift announcement window `start_s=10 <= t < live_s=13`):
  // RIFT0 stays lit (`Active`), shows `"Rift opens in 0:02"`, has no capture rings, and emits zero `koth` ObjectiveStates!
  await p.getByTestId("mode-player").click();
  await saveAt(p, 11);
  await expect(mk(p, RIFT0)).toHaveAttribute("data-status", "Active");
  await expect(mk(p, RIFT1)).toHaveAttribute("data-status", "Destroyed");
  await expect(p.getByTestId("rift-rings")).toHaveCount(0);
  await hoverMarker(p, RIFT0);
  await expect(p.getByTestId("hover-label")).toHaveText("Rift opens in 0:02");
  await hoverMarker(p, RIFT1);
  await expect(p.getByTestId("hover-label")).toHaveText("Rift opens at the other site in 0:02");
});

test("2. One-click baseline camp revive and rift toggle/swap in saved R3 scene", async ({ browser }) => {
  const url = await newBoardUrl(server, "R3 Clicks");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p);
  await saveAt(p, 15);

  // Baseline-cleared camp starts Destroyed with respawn hover; ONE click marks it Active and clears the respawn hover!
  await expect(mk(p, CAMP_CLEARED)).toHaveAttribute("data-status", "Destroyed");
  await hoverMarker(p, CAMP_CLEARED);
  await expect(p.getByTestId("hover-label")).toHaveText("Respawns in 2:00");
  await clickMarker(p, CAMP_CLEARED);
  await expect(mk(p, CAMP_CLEARED)).toHaveAttribute("data-status", "Active");
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await hoverMarker(p, CAMP_CLEARED);
  await expect(p.getByTestId("hover-label")).toHaveCount(0);

  // Clicking the OTHER rift (RIFT1) turns baseline-active RIFT0 off (removing rift-rings) and RIFT1 on in ONE tx!
  await expect(p.getByTestId("rift-rings")).toHaveAttribute("data-key", RIFT0);
  await clickMarker(p, RIFT1);
  await expect(mk(p, RIFT1)).toHaveAttribute("data-status", "Active");
  await expect(mk(p, RIFT0)).toHaveAttribute("data-status", "Destroyed");
  await expect(p.getByTestId("rift-rings")).toHaveCount(0);

  // One Ctrl+Z undoes BOTH rift changes together, bringing baseline RIFT0 and its capture rings back!
  await p.keyboard.press("Control+z");
  await expect(mk(p, RIFT0)).toHaveAttribute("data-status", "Active");
  await expect(mk(p, RIFT1)).toHaveAttribute("data-status", "Destroyed");
  await expect(p.getByTestId("rift-rings")).toHaveAttribute("data-key", RIFT0);

  // Clicking baseline-active RIFT0 directly turns it off in ONE click!
  await clickMarker(p, RIFT0);
  await expect(mk(p, RIFT0)).toHaveAttribute("data-status", "Destroyed");
  await expect(p.getByTestId("rift-rings")).toHaveCount(0);

  // Overrides persist across reload!
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await p.reload();
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await p.getByTestId("scene-card").nth(1).click();
  await expect(mk(p, CAMP_CLEARED)).toHaveAttribute("data-status", "Active");
  await expect(mk(p, RIFT0)).toHaveAttribute("data-status", "Destroyed");
  await expect(p.getByTestId("rift-rings")).toHaveCount(0);
});

test("3. Retake on an R2 scene backfills Group B while preserving manual ObjectiveState overrides; metadata scenes do NOT offer Group B Retake", async ({ browser }) => {
  // Seed an R2-era scene (`rows: 27`, Group A flags only) with a manual ObjectiveState override reviving CAMP_CLEARED.
  const f = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/board-file-v1-oldest-records.mapcro.json")).toString()) as { version: number; rows?: number; records: Rec[] };
  f.version = 5;
  f.rows = 27;
  const slots = f.records.filter((r) => r[1].RosterSlot);
  const sceneId = hex(0xaaa1);
  f.records.push([sceneId, { Scene: { name: "R2 moment", order: "s", clock: 15, source: { match_id: Number(ID), t: 15, tier: "replay" } } }]);
  slots.forEach((r, i) => {
    f.records.push([
      hex(0xb10 + i),
      {
        PlayerState: {
          scene: sceneId,
          slot: r[0],
          pos: { x: -3500 + (i % 6) * 1400, y: i < 6 ? -2800 : 2800 },
          alive: true,
          placed: true,
          souls: 1000,
          ult_cooldown: 0,
          visible: true,
          more: { hero: 1 + (i % 6), level: 5, items: [715_762_406, -1, -1, -1], abilities: [], build_order: [], health: 100, pickups: [0, 0, 0, 0, 0], kills: 0, deaths: 0, assists: 0, max_health: 700 },
        },
      },
    ]);
  });
  // Manual coach override: revived CAMP_CLEARED ("Active") + structural GUARDIAN down.
  f.records.push([hex(0xc10), { ObjectiveState: { scene: sceneId, key: CAMP_CLEARED, status: "Active" } }]);
  f.records.push([hex(0xc11), { ObjectiveState: { scene: sceneId, key: GUARDIAN, status: "Destroyed" } }]);
  f.records.push([
    hex(0xd10),
    {
      SceneState: {
        scene: sceneId,
        more: {
          rows: 27,
          has_builds: true,
          build: 6839,
          has_heroes: true,
          has_sight: true,
          has_cc: true,
          has_movement: true,
          has_lanes: true,
          has_skulls: true,
        },
      },
    },
  ]);

  const p = await joinNew(browser, await seed(f), "Coach");
  await openReplay(p);
  await p.getByTestId("scene-card").nth(1).click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");

  // Before Retake: no Group B baseline (`rift-rings` absent, Rejuv absent, shop still open, Retake offered).
  await expect(p.getByTestId("rift-rings")).toHaveCount(0);
  await expect(p.locator('[data-testid=tb-rejuv][data-team="sapphire"]')).toHaveCount(0);
  await expect(mk(p, CLOSED_SHOP)).toHaveAttribute("data-status", "Active");
  await expect(p.getByTestId("retake")).toBeVisible();

  await p.getByTestId("retake").click();
  await expect(p.getByTestId("retake")).toHaveCount(0);
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

  // Group B backfilled cleanly: rift rings, urn, Rejuv, closed shop hidden, and Patron Stage 2 all appear!
  await expect(p.getByTestId("rift-rings")).toHaveAttribute("data-key", RIFT0);
  await expect(p.getByTestId("urn")).toHaveAttribute("data-state", "ground");
  await expect(p.locator('[data-testid=tb-rejuv][data-team="sapphire"]')).toHaveAttribute("data-left", "3");
  await expect(mk(p, CLOSED_SHOP)).toHaveCount(0);
  await expect(mk(p, PATRON)).toHaveAttribute("data-status", "Stage2");
  // Manual coach override reviving CAMP_CLEARED is PRESERVED (status wins over baseline!).
  await expect(mk(p, CAMP_CLEARED)).toHaveAttribute("data-status", "Active");
  await hoverMarker(p, CAMP_CLEARED);
  await expect(p.getByTestId("hover-label")).toHaveCount(0);

  // Metadata scene: saving from metadata tier sets `has_skulls` and `rows: 40`, and does NOT offer Retake for Group B!
  const metaUrl = await newBoardUrl(server, "R3 Meta");
  const mp = await joinNew(browser, metaUrl, "Coach");
  await mp.getByTestId("mode-player").click();
  await revealControls(mp, "match-id");
  await mp.getByTestId("match-id").fill(META_ID);
  await mp.getByTestId("match-load").click();
  await expect(mp.getByTestId("match-tier")).toHaveText("API summary");
  await mp.getByTestId("match-save").click();
  await expect(mp.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(mp.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await expect(mp.getByTestId("retake")).toHaveCount(0);
});

test("4. Exported R3 board (v6, rows: 40) imported with matches: [] renders Group B markers, hovers, bar timers, and controls", async ({ browser }) => {
  const from = await newBoardUrl(server, "R3 Export");
  const maker = await joinNew(browser, from, "Coach");
  await openReplay(maker);
  await saveAt(maker, 15);
  await maker.getByTestId("mode-player").click();
  await saveAt(maker, 25);

  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(from)!;
  const file = (await (await fetch(`${server.url}/api/boards/${board}/export`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
    version: number;
    rows: number;
    matches: number[];
    records: Rec[];
  };
  expect(file.version).toBe(6);
  expect(file.rows).toBe(40);
  expect(file.matches).toEqual([Number(ID)]);
  file.matches = [];
  await maker.close();

  const p = await joinNew(browser, await seed(file), "Coach");
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");

  // Scene 1 (saved at t=15): with ZERO matches open on the board, Group B renders completely!
  await p.getByTestId("scene-card").nth(1).click();
  await revealControls(p, "health-toggle");
  await expect(p.getByTestId("health-toggle")).toBeVisible();
  await expect(p.getByTestId("heals-toggle")).toBeVisible();
  await expect(p.getByTestId("crates-toggle")).toBeVisible();
  if ((await p.getByTestId("heals-toggle").getAttribute("aria-pressed")) !== "true") await p.getByTestId("heals-toggle").click();
  if ((await p.getByTestId("crates-toggle").getAttribute("aria-pressed")) !== "true") await p.getByTestId("crates-toggle").click();

  await expect(mk(p, CAMP_CLEARED)).toHaveAttribute("data-camp", "cleared");
  await expect(mk(p, HEAL_CLEARED)).toHaveAttribute("data-camp", "cleared");
  await expect(mk(p, CRATE_CLEARED)).toHaveAttribute("data-camp", "cleared");
  await expect(mk(p, PWR0)).toHaveAttribute("data-buff", "casting");
  await expect(p.getByTestId("rift-rings")).toHaveAttribute("data-key", RIFT0);
  await expect(p.getByTestId("urn")).toHaveAttribute("data-state", "ground");
  await expect(mk(p, WALKER)).toHaveAttribute("data-health", "42");
  await expect(mk(p, PATRON)).toHaveAttribute("data-status", "Stage2");
  await expect(mk(p, PATRON)).toHaveAttribute("data-health", "60");
  await expect(mk(p, CLOSED_SHOP)).toHaveCount(0);
  await expect(mk(p, OPEN_SHOP)).toHaveAttribute("data-status", "Active");
  await expect(p.locator('[data-testid=tb-rejuv][data-team="sapphire"]')).toHaveAttribute("data-left", "3");
  await hoverMarker(p, CAMP_CLEARED);
  await expect(p.getByTestId("hover-label")).toHaveText("Respawns in 2:00");

  // Toggling Health off hides objective health & Patron Stage 2 cleanly without a match open; turning it back on restores both.
  await p.getByTestId("health-toggle").click();
  await expect(mk(p, WALKER)).not.toHaveAttribute("data-health");
  await expect(mk(p, PATRON)).not.toHaveAttribute("data-health");
  await expect(mk(p, PATRON)).toHaveAttribute("data-status", "Active");
  await p.getByTestId("health-toggle").click();
  await expect(mk(p, WALKER)).toHaveAttribute("data-health", "42");
  await expect(mk(p, PATRON)).toHaveAttribute("data-health", "60");
  await expect(mk(p, PATRON)).toHaveAttribute("data-status", "Stage2");

  // Scene 2 (saved at t=25): Mid-Boss respawn timer and carried urn also render without a match open!
  await p.getByTestId("scene-card").nth(2).click();
  await expect(p.getByTestId("tb-respawn-timer")).toHaveClass(/\bon\b/);
  await expect(p.getByTestId("tb-respawn-label")).toHaveText("6:30");
  await expect(p.getByTestId("urn")).toHaveAttribute("data-state", "carried");
});
