// Doorman doorway indicators — Stage 3 (Release 2: Scene Writer + manual Scene placement, store v19, .mapcro v7).
//
// Covers:
// 1. Save scene (unpaired & linked timestamps + enemy sight), Retake on pre-R2 scene, New scene / Duplicate inheritance.
// 2. `.mapcro` v7 export (`version: 7, rows: 42`) + TD-162 matchless import (`matches: []`) rendering doors with no match open.
// 3. Manual placement via empty-map `map-menu` (blank board King/Archmother ordering + single-Doorman `Place doorway`),
//    Doorman portrait `hero-menu` (Step 1 -> Step 2 + `Clear doorways`), and Doorman map token `hero-menu` (direct Step 2).
// 4. Unpaired commit (`Enter` & re-click Door 1), `Escape` & right-click cancel, team replacement preserving other team's doors.
// 5. Direct manipulation: live `Select` drag + `Ctrl+Z`/`Ctrl+Shift+Z` undo/redo, `Arrow` (`A`) snap-from door,
//    `door-menu` (`Link second door`, `Unlink door`, `Mark not seen`<->`Mark in vision` lockstep + faded badge, `Remove doorway`),
//    `Erase` (`D`) tool + hover-`D` + `Clear` (`Shift+C`) leaving doors untouched.
// 6. Multi-user WebSocket sync (Editor A -> Editor B & Viewer).
// 7. Phone `390x844 --touch` ergonomics (long-press `map-menu` & `door-menu`, 1-finger drag, 44x44 `.pl-hit`, zero chrome overflow).

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type CDPSession, type Locator, type Page, expect, test } from "./fixtures";
import { joinNew, mapPoint, revealControls } from "./helpers";
import { hasCdp, phoneContext } from "./phone-layout";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "142815246";
const N = 40;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

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
        x: range(() => 2000),
        y: range(() => 2000),
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
      // Unpaired 4s..10s (unseen 4s..6s, seen 6s..10s), linked 10s..30s (seen 10s..16s, unseen 16s..20s).
      { id: 0, team: "sapphire", x: -2400, y: 1400, start_ds: 40, link_ds: 100, end_ds: 300, partner: 1, seen: [[60, 160], [200, 280]] },
      { id: 1, team: "sapphire", x: 2400, y: -1400, start_ds: 100, link_ds: 100, end_ds: 300, partner: 0, seen: [[100, 160], [200, 280]] },
    ],
  };
}

const answered = new Set<string>();
let uploadSeq = 1;
async function openReplay(p: Page, queue: string) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  const payload = Buffer.alloc(4096);
  payload[0] = uploadSeq++;
  await p.getByTestId("match-file").setInputFiles({
    name: `${ID}.dem`,
    mimeType: "application/octet-stream",
    buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), payload]),
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

const centre = async (l: Locator) => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

type Pt = { x: number; y: number };
interface Fingers {
  press(id: number, at: Pt): Promise<void>;
  move(id: number, at: Pt): Promise<void>;
  lift(id: number): Promise<void>;
}

class CdpFingers implements Fingers {
  private down = new Map<number, Pt>();
  constructor(private cdp: CDPSession) {}
  private points() {
    return [...this.down].map(([id, p]) => ({ id, x: p.x, y: p.y }));
  }
  async press(id: number, at: Pt) {
    this.down.set(id, at);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: this.points() });
  }
  async move(id: number, at: Pt) {
    this.down.set(id, at);
    await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
  }
  async lift(id: number) {
    this.down.delete(id);
    if (this.down.size) await this.cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.points() });
    else await this.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
}

class PageFingers implements Fingers {
  constructor(private page: Page) {}
  private send(type: string, id: number, at: Pt) {
    return this.page.evaluate(
      ({ type, id, at }) => {
        const t = document.elementFromPoint(at.x, at.y) ?? document.body;
        const ev = { pointerId: 100 + id, pointerType: "touch", isPrimary: id === 1, button: type === "pointermove" ? -1 : 0, buttons: type === "pointerup" ? 0 : 1 };
        t.dispatchEvent(new PointerEvent(type, { ...ev, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true, composed: true }));
      },
      { type, id, at },
    );
  }
  private at = new Map<number, Pt>();
  press(id: number, at: Pt) {
    this.at.set(id, at);
    return this.send("pointerdown", id, at);
  }
  move(id: number, at: Pt) {
    this.at.set(id, at);
    return this.send("pointermove", id, at);
  }
  lift(id: number) {
    const at = this.at.get(id)!;
    this.at.delete(id);
    return this.send("pointerup", id, at);
  }
}

const makeFingers = async (browser: Browser, page: Page): Promise<Fingers> =>
  hasCdp(browser) ? new CdpFingers(await page.context().newCDPSession(page)) : new PageFingers(page);

const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-doors-r2-"));
let server: Server;

test.beforeAll(async () => {
  server = new Server(undefined, { REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "50" });
  await server.start();
});

test.afterAll(() => {
  server.stop();
});

test.beforeEach(({ browserName }) => test.slow(browserName === "firefox"));
test.describe.configure({ retries: process.env.MAPCRO_E2E_FIREFOX ? 2 : 0 });

test("Save scene preserves unpaired & linked doors + sight, v7 export & TD-162 matchless import render doors, and Retake backfills pre-R2 scenes", async ({ browser }) => {
  const url = await newBoardUrl(server, "Doors Save R2");
  const p = await joinNew(browser, url, "Coach");
  await openReplay(p, queue);

  const doors = p.locator("[data-testid=map] [data-testid=doorman-door]");
  const links = p.locator("[data-testid=map] [data-testid=door-link]");

  // 1. Save scene at t = 5s (unpaired Door 1, unseen by enemy).
  await scrubTo(p, 5);
  await expect(doors).toHaveCount(1);
  await p.getByTestId("match-save").click();
  await expect(p.getByTestId("mode-player")).not.toHaveAttribute("aria-pressed", "true");
  await expect(doors).toHaveCount(1);
  await expect(links).toHaveCount(0);
  await expect(doors.first()).toHaveAttribute("data-role", "unpaired");
  // Enemy Vision (Amber): Scene D3 fades the unseen Sapphire door!
  await p.getByTestId("vision-select").selectOption("amber");
  await expect(doors.first()).toHaveAttribute("data-faded", "");
  await expect(doors.first().getByTestId("door-unseen-mark")).toHaveCount(1);
  await p.getByTestId("vision-select").selectOption("all");

  // 2. Back to replay, save scene at t = 18s (linked pair, unseen by enemy).
  await p.getByTestId("mode-player").click();
  await scrubTo(p, 18);
  await p.getByTestId("match-save").click();
  await expect(doors).toHaveCount(2);
  await expect(links).toHaveCount(1);
  await expect(p.getByTestId("retake")).toHaveCount(0);

  // 3. New scene (`+`) and Duplicate (`scene-clone`) both inherit doors from the current scene.
  await p.getByTestId("scene-add").click();
  await expect(doors).toHaveCount(2);
  await expect(links).toHaveCount(1);
  await p.locator("[data-testid=scene-card].on [data-testid=scene-clone]").click();
  await expect(p.locator("[data-testid=scene-card]")).toHaveCount(5);
  await expect(doors).toHaveCount(2);
  await expect(links).toHaveCount(1);

  // 4. Export `.mapcro` v7 (`version: 7, rows: 42`) and import with `matches: []` (TD-162 matchless import).
  const boardMatch = url.match(/\/b\/([^#]+)#(.+)$/)!;
  const expRes = await fetch(`${server.url}/api/boards/${boardMatch[1]}/export`, {
    headers: { authorization: `Bearer ${boardMatch[2]}` },
  });
  expect(expRes.status).toBe(200);
  const exported = (await expRes.json()) as { version: number; rows: number; matches: number[]; records: Array<[string, Record<string, unknown>]> };
  expect(exported.version).toBe(7);
  expect(exported.rows).toBe(42);

  // Matchless import (`matches: []`) opens with NO match and still renders the saved doors!
  const impRes = await fetch(`${server.url}/api/boards/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...exported, matches: [] }),
  });
  expect(impRes.status).toBe(201);
  const imported = (await impRes.json()) as { board: string; owner_token: string };
  const p2 = await joinNew(browser, `${server.url}/b/${imported.board}#${imported.owner_token}`, "Scout");
  // Navigate to scene 3 (the linked-pair scene) on the imported matchless board.
  await p2.locator("[data-testid=scene-card]").nth(2).click();
  await expect(p2.locator("[data-testid=map] [data-testid=doorman-door]")).toHaveCount(2);
  await expect(p2.locator("[data-testid=map] [data-testid=door-link]")).toHaveCount(1);

  // 5. Retake on a pre-R2 scene (rows: 40, no `has_doors`): import an R1-shaped scene linked to match 142815246 at t = 18s.
  const preR2Records = exported.records.map(([id, rec]) => {
    if ("SceneState" in rec) {
      const st = rec.SceneState as { scene: string; more?: Record<string, unknown> };
      const { has_doors: _hd, doors: _d, ...rest } = st.more ?? {};
      return [id, { SceneState: { scene: st.scene, more: { ...rest, rows: 40 } } }];
    }
    return [id, rec];
  });
  const preR2Imp = await fetch(`${server.url}/api/boards/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...exported, version: 6, rows: 40, matches: [], records: preR2Records }),
  });
  expect(preR2Imp.status).toBe(201);
  const preR2 = (await preR2Imp.json()) as { board: string; owner_token: string };
  const p3 = await joinNew(browser, `${server.url}/b/${preR2.board}#${preR2.owner_token}`, "Analyst");
  await openReplay(p3, queue);
  // Switch to scene 3 (saved at t = 18s, stripped of doors).
  await p3.locator("[data-testid=scene-card]").nth(2).click();
  await expect(p3.locator("[data-testid=map] [data-testid=doorman-door]")).toHaveCount(0);
  await expect(p3.getByTestId("retake")).toBeVisible();
  await p3.getByTestId("retake").click();
  await expect(p3.locator("[data-testid=map] [data-testid=doorman-door]")).toHaveCount(2);
  await expect(p3.locator("[data-testid=map] [data-testid=door-link]")).toHaveCount(1);
  await expect(p3.getByTestId("retake")).toHaveCount(0);
});

test("Manual placement via map-menu & Doorman hero-menu, 2-step link/unpaired/cancel, team replacement, drag, undo/redo, door-menu, Arrow snap, Erase, Clear, and multi-user sync", async ({ browser }) => {
  const url = await newBoardUrl(server, "Doors Manual");
  const a = await joinNew(browser, url, "Coach A");
  const b = await joinNew(browser, url, "Coach B");

  // Also mint a read-only viewer link.
  const m = url.match(/\/b\/([^#]+)#(.+)$/)!;
  const viewRes = await fetch(`${server.url}/api/boards/${m[1]}/links`, {
    method: "POST",
    headers: { authorization: `Bearer ${m[2]}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "view", label: "Viewer" }),
  });
  const { token: viewTok } = (await viewRes.json()) as { token: string };
  const v = await joinNew(browser, `${server.url}/b/${m[1]}#${viewTok}`, "Viewer");

  const doorsA = a.locator("[data-testid=map] [data-testid=doorman-door]");
  const linksA = a.locator("[data-testid=map] [data-testid=door-link]");
  const doorsB = b.locator("[data-testid=map] [data-testid=doorman-door]");
  const doorsV = v.locator("[data-testid=map] [data-testid=doorman-door]");

  // 1. Blank board (no Doorman picked): empty-map right-click opens `map-menu` with King first (Amber viewpoint).
  const p1 = await mapPoint(a, 0.35, 0.45);
  const p2 = await mapPoint(a, 0.65, 0.45);
  await a.mouse.click(p1.x, p1.y, { button: "right" });
  const mapMenu = a.getByTestId("map-menu");
  await expect(mapMenu).toBeVisible();
  const mapItems = mapMenu.getByRole("menuitem");
  await expect(mapItems.nth(0)).toHaveText("Place King doorway");
  await expect(mapItems.nth(1)).toHaveText("Place Archmother doorway");

  // Start Step 2 for King doorway, move mouse to see live link preview + ghost Door 2, then cancel with Escape (0 ops!).
  await mapMenu.getByTestId("map-menu-doorway-amber").click();
  await expect(a.locator("[data-testid=door-preview-1]")).toHaveCount(1);
  await a.mouse.move(p2.x, p2.y);
  await expect(a.locator("[data-testid=door-preview-link]")).toHaveCount(1);
  await expect(a.locator("[data-testid=door-preview-2]")).toHaveCount(1);
  await a.keyboard.press("Escape");
  await expect(a.locator("[data-testid=door-preview-1]")).toHaveCount(0);
  await expect(doorsA).toHaveCount(0);

  // Right-click during active placement cancels cleanly with 0 ops (and opens no context menu).
  await a.mouse.click(p1.x, p1.y, { button: "right" });
  await a.getByTestId("map-menu-doorway-amber").click();
  await expect(a.locator("[data-testid=door-preview-1]")).toHaveCount(1);
  await a.mouse.click(p2.x, p2.y, { button: "right" });
  await expect(a.locator("[data-testid=door-preview-1]")).toHaveCount(0);
  await expect(a.getByTestId("map-menu")).toHaveCount(0);
  await expect(doorsA).toHaveCount(0);

  // 2. Place King linked pair via `map-menu` -> commits in 1 tx (`Create SceneState`), synced live to Coach B and Viewer;
  //    undo of first blank-board placement removes both doors cleanly and redo restores them!
  await a.mouse.click(p1.x, p1.y, { button: "right" });
  await a.getByTestId("map-menu-doorway-amber").click();
  await a.mouse.click(p2.x, p2.y);
  await expect(doorsA).toHaveCount(2);
  await expect(linksA).toHaveCount(1);
  await expect(doorsB).toHaveCount(2);
  await expect(doorsV).toHaveCount(2);
  await a.keyboard.press("Control+z");
  await expect(doorsA).toHaveCount(0);
  await expect(doorsB).toHaveCount(0);
  await a.keyboard.press("Control+Shift+z");
  await expect(doorsA).toHaveCount(2);
  await expect(doorsB).toHaveCount(2);

  // 3. Place Archmother unpaired door via `map-menu` + Enter -> preserves King pair (total 3 doors).
  const p3 = await mapPoint(a, 0.45, 0.62);
  await a.mouse.click(p3.x, p3.y, { button: "right" });
  await a.getByTestId("map-menu-doorway-sapphire").click();
  await a.keyboard.press("Enter");
  await expect(doorsA).toHaveCount(3);
  await expect(doorsB).toHaveCount(3);
  const sUnpaired = a.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]');
  await expect(sUnpaired).toHaveAttribute("data-role", "unpaired");

  // 4. `door-menu` on unpaired Sapphire door -> `Link second door` -> click p4 -> linked!
  const p4 = await mapPoint(a, 0.62, 0.62);
  const sPos = await centre(sUnpaired);
  await a.mouse.click(sPos.x, sPos.y, { button: "right" });
  await expect(a.getByTestId("door-menu")).toBeVisible();
  await expect(a.getByTestId("door-menu-link")).toHaveText("Link second door");
  await a.getByTestId("door-menu-link").click();
  await a.mouse.click(p4.x, p4.y);
  await expect(doorsA).toHaveCount(4);
  await expect(linksA).toHaveCount(2);

  // 5. `door-menu` -> `Mark not seen` toggles BOTH linked Sapphire doors in lockstep (D5 faded + `.vis.off` on blank board!).
  const sDoor0 = a.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]').first();
  const sDoor1 = a.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]').nth(1);
  const s0Pos = await centre(sDoor0);
  await a.mouse.click(s0Pos.x, s0Pos.y, { button: "right" });
  await expect(a.getByTestId("door-menu-vision")).toHaveText("Mark not seen");
  await a.getByTestId("door-menu-vision").click();
  await expect(sDoor0).toHaveAttribute("data-faded", "");
  await expect(sDoor1).toHaveAttribute("data-faded", "");
  await expect(sDoor0.getByTestId("door-unseen-mark")).toHaveCount(1);
  // Flip back to in vision.
  await a.mouse.click(s0Pos.x, s0Pos.y, { button: "right" });
  await expect(a.getByTestId("door-menu-vision")).toHaveText("Mark in vision");
  await a.getByTestId("door-menu-vision").click();
  await expect(sDoor0).not.toHaveAttribute("data-faded", "");
  await expect(sDoor1).not.toHaveAttribute("data-faded", "");

  // 6. `door-menu` -> `Unlink door` removes clicked Sapphire door and converts partner to unpaired.
  await a.mouse.click(s0Pos.x, s0Pos.y, { button: "right" });
  await expect(a.getByTestId("door-menu-unlink")).toHaveText("Unlink door");
  await a.getByTestId("door-menu-unlink").click();
  await expect(doorsA).toHaveCount(3);
  await expect(linksA).toHaveCount(1);
  await expect(a.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveAttribute("data-role", "unpaired");

  // 7. `Select` drag moves a door smoothly and commits on release; Ctrl+Z / Ctrl+Shift+Z undo/redo cleanly!
  const aDoor0 = a.locator('[data-testid=map] [data-testid=doorman-door][data-team="amber"]').first();
  const beforeX = Number(await aDoor0.getAttribute("data-x"));
  const beforeY = Number(await aDoor0.getAttribute("data-y"));
  const d0Pt = await centre(aDoor0);
  const dragTo = await mapPoint(a, 0.35, 0.32);
  await a.mouse.move(d0Pt.x, d0Pt.y);
  await a.mouse.down();
  await a.mouse.move(dragTo.x, dragTo.y, { steps: 6 });
  await a.mouse.up();
  await expect.poll(async () => Number(await aDoor0.getAttribute("data-y"))).not.toBe(beforeY);
  const afterY = Number(await aDoor0.getAttribute("data-y"));
  // Synced to Coach B!
  await expect.poll(async () => Number(await doorsB.first().getAttribute("data-y"))).toBe(afterY);
  // Undo puts it right back, redo moves it again!
  await a.keyboard.press("Control+z");
  await expect.poll(async () => Number(await aDoor0.getAttribute("data-y"))).toBe(beforeY);
  expect(Number(await aDoor0.getAttribute("data-x"))).toBe(beforeX);
  await a.keyboard.press("Control+Shift+z");
  await expect.poll(async () => Number(await aDoor0.getAttribute("data-y"))).toBe(afterY);

  // 8. `Arrow` (`A`) started on a door snaps from its world pos and adopts its team; `Clear` (`Shift+C`) clears arrow but NEVER touches doors!
  await a.keyboard.press("a");
  const movedPt = await centre(aDoor0);
  const arwEnd = await mapPoint(a, 0.5, 0.35);
  await a.mouse.move(movedPt.x, movedPt.y);
  await a.mouse.down();
  await a.mouse.move(arwEnd.x, arwEnd.y, { steps: 4 });
  await a.mouse.up();
  await expect(a.locator(".mapbox [data-arrow] .arw.amber")).toHaveCount(1);
  await a.keyboard.press("Shift+C");
  await expect(a.locator(".mapbox [data-arrow]")).toHaveCount(0);
  await expect(doorsA).toHaveCount(3); // Clear NEVER touches map-state doors!

  // 9. Hover + `D` deletes the Sapphire unpaired door immediately in 1 tx.
  await a.keyboard.press("q");
  const sRem = a.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]').first();
  const sRemPt = await centre(sRem);
  await a.mouse.move(sRemPt.x, sRemPt.y);
  await a.keyboard.press("d");
  await expect(doorsA).toHaveCount(2);
  await expect(doorsB).toHaveCount(2);

  // 10. `Erase` (`D`) single scrub across BOTH a drawing (stroke) AND one end of Amber's linked pair deletes both in 1 tx!
  await a.keyboard.press("e"); // Draw tool
  const strokeStart = await mapPoint(a, 0.28, 0.32);
  const strokeEnd = await mapPoint(a, 0.32, 0.32);
  await a.mouse.move(strokeStart.x, strokeStart.y);
  await a.mouse.down();
  await a.mouse.move(strokeEnd.x, strokeEnd.y, { steps: 4 });
  await a.mouse.up();
  await expect(a.locator(".mapbox [data-stroke]")).toHaveCount(1);
  await a.mouse.move(5, 5);
  await a.keyboard.press("d"); // Erase tool
  const strokeMid = { x: (strokeStart.x + strokeEnd.x) / 2, y: strokeStart.y };
  const aEndPt = await centre(doorsA.first());
  await a.mouse.move(strokeMid.x, strokeMid.y);
  await a.mouse.down();
  await a.mouse.move(aEndPt.x, aEndPt.y, { steps: 8 });
  await a.mouse.up();
  await expect(a.locator(".mapbox [data-stroke]")).toHaveCount(0);
  await expect(doorsA).toHaveCount(0);
  await expect(doorsB).toHaveCount(0);
  await expect(doorsV).toHaveCount(0);
  // One single Ctrl+Z brings BOTH the stroke AND the whole linked pair back in 1 step!
  await a.keyboard.press("Control+z");
  await expect(a.locator(".mapbox [data-stroke]")).toHaveCount(1);
  await expect(doorsA).toHaveCount(2);
  await a.keyboard.press("Shift+C"); // clean up stroke; doors stay
  await expect(a.locator(".mapbox [data-stroke]")).toHaveCount(0);
  await expect(doorsA).toHaveCount(2);
  await a.keyboard.press("q");

  // 10b. Concurrent peer edit safety (M1): Coach B removes Amber's doorway while Coach A has `door-menu` open on it
  //      (with Sapphire's door also present) -> Coach A's stale `door-menu` closes automatically instead of hitting Sapphire!
  await a.mouse.click(p3.x, p3.y, { button: "right" });
  await a.getByTestId("map-menu-doorway-sapphire").click();
  await a.keyboard.press("Enter");
  await expect(doorsA).toHaveCount(3);
  await expect(doorsB).toHaveCount(3);
  const ambMenuPt = await centre(a.locator('[data-testid=map] [data-testid=doorman-door][data-team="amber"]').first());
  await a.mouse.click(ambMenuPt.x, ambMenuPt.y, { button: "right" });
  await expect(a.getByTestId("door-menu")).toBeVisible();
  // Coach B removes Amber's doorway while Coach A's menu is open!
  const ambPtB = await centre(b.locator('[data-testid=map] [data-testid=doorman-door][data-team="amber"]').first());
  await b.mouse.click(ambPtB.x, ambPtB.y, { button: "right" });
  await b.getByTestId("door-menu-remove").click();
  // Coach A's menu closes automatically, and Sapphire's door (now shifted to index 0) stays completely untouched!
  await expect(a.getByTestId("door-menu")).toHaveCount(0);
  await expect(a.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveCount(1);
  // Restore Amber's pair and remove Sapphire's door so step 11 starts with Amber's pair as expected.
  await b.keyboard.press("Control+z");
  await expect(doorsA).toHaveCount(3);
  const sapPtB = await centre(b.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]').first());
  await b.mouse.click(sapPtB.x, sapPtB.y, { button: "right" });
  await b.getByTestId("door-menu-remove").click();
  await expect(doorsA).toHaveCount(2);

  // 11. Board with The Doorman (`hero_id = 69`) on Sapphire slot 0 -> verify single `Place doorway` in `map-menu`
  //     AND Doorman portrait + map token `hero-menu` (`Place doorway` & `Clear doorways`)!
  const expDoorman = await (
    await fetch(`${server.url}/api/boards/${m[1]}/export`, { headers: { authorization: `Bearer ${m[2]}` } })
  ).json();
  for (const [, rec] of expDoorman.records as Array<[string, Record<string, unknown>]>) {
    if ("RosterSlot" in rec) {
      const slot = rec.RosterSlot as { team: string; slot: number; hero: number | null };
      if (slot.team === "Sapphire" && slot.slot === 0) slot.hero = 69;
    }
  }
  const impDoorman = await fetch(`${server.url}/api/boards/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(expDoorman),
  });
  expect(impDoorman.status).toBe(201);
  const dBoard = (await impDoorman.json()) as { board: string; owner_token: string };
  const dPage = await joinNew(browser, `${server.url}/b/${dBoard.board}#${dBoard.owner_token}`, "Doorman Coach");
  const dLinks = dPage.locator("[data-testid=map] [data-testid=door-link]");
  const dp3 = await mapPoint(dPage, 0.45, 0.62);
  const dp4 = await mapPoint(dPage, 0.62, 0.62);

  // With exactly one Doorman on Sapphire, empty-map `map-menu` shows a single `Place doorway` item!
  const emptyPt = await mapPoint(dPage, 0.35, 0.45);
  await dPage.mouse.click(emptyPt.x, emptyPt.y, { button: "right" });
  await expect(dPage.getByTestId("map-menu").getByRole("menuitem")).toHaveCount(1);
  await expect(dPage.getByTestId("map-menu-doorway")).toHaveText("Place doorway");
  await dPage.keyboard.press("Escape");

  // Portrait `hero-menu` on Doorman has `Place doorway` -> Step 1 armed -> click dp3 -> Step 2 -> click dp3 again (<12u) -> unpaired Sapphire door!
  await dPage.locator('[data-testid=topbar] .tb-player[data-slot="Sapphire-0"]').click({ button: "right" });
  await expect(dPage.getByTestId("hero-menu-doorway")).toHaveText("Place doorway");
  await dPage.getByTestId("hero-menu-doorway").click();
  await expect(dPage.locator("svg.mm-overlay.map")).toHaveAttribute("data-placing-door", "on");
  await dPage.mouse.click(dp3.x, dp3.y);
  await expect(dPage.locator("[data-testid=door-preview-1]")).toHaveCount(1);
  await dPage.mouse.click(dp3.x, dp3.y); // re-click Door 1 -> commit unpaired
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveCount(1);

  // Portrait `hero-menu` now also offers `Clear doorways` -> removes Sapphire door while keeping Amber's pair!
  await dPage.locator('[data-testid=topbar] .tb-player[data-slot="Sapphire-0"]').click({ button: "right" });
  await expect(dPage.getByTestId("hero-menu-clear-doors")).toHaveText("Clear doorways");
  await dPage.getByTestId("hero-menu-clear-doors").click();
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveCount(0);
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="amber"]')).toHaveCount(2);

  // Map token `hero-menu` on Doorman -> `Place doorway` jumps straight into Step 2 visibly OUTSIDE Doorman's token:
  // re-clicking Door 1 directly commits unpaired (never stolen by Doorman's token!), then linking via dp4 commits linked pair!
  const doormanTok = dPage.locator('.mapbox .tok[data-slot="Sapphire-0"]');
  const tokPt = await centre(doormanTok);
  await dPage.mouse.click(tokPt.x, tokPt.y, { button: "right" });
  await expect(dPage.getByTestId("hero-menu-doorway")).toBeVisible();
  await dPage.getByTestId("hero-menu-doorway").click();
  const prev1 = dPage.locator("[data-testid=door-preview-1]");
  await expect(prev1).toHaveCount(1);
  const prev1Pt = await centre(prev1);
  // M2: Door 1 sits visibly outside Doorman's token (not buried inside the hero token!).
  expect(Math.hypot(prev1Pt.x - tokPt.x, prev1Pt.y - tokPt.y)).toBeGreaterThan(22);
  await dPage.mouse.click(prev1Pt.x, prev1Pt.y); // re-click Door 1 -> unpaired
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveCount(1);
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveAttribute("data-role", "unpaired");
  // Place linked pair from Doorman's map token -> click dp4 commits linked pair!
  await dPage.mouse.click(tokPt.x, tokPt.y, { button: "right" });
  await dPage.getByTestId("hero-menu-doorway").click();
  await expect(prev1).toHaveCount(1);
  await dPage.mouse.click(dp4.x, dp4.y);
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveCount(2);
  await expect(dLinks).toHaveCount(2);

  // `door-menu` -> `Remove doorway` removes Amber's linked pair cleanly.
  const remPt = await centre(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="amber"]').first());
  await dPage.mouse.click(remPt.x, remPt.y, { button: "right" });
  await dPage.getByTestId("door-menu-remove").click();
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="amber"]')).toHaveCount(0);
  await expect(dPage.locator('[data-testid=map] [data-testid=doorman-door][data-team="sapphire"]')).toHaveCount(2);
});

test("Phone 390x844 --touch: long-press map-menu & door-menu, 1-finger drag, 44px .pl-hit, and zero chrome overflow", async ({ browser }) => {
  const url = await newBoardUrl(server, "Doors Phone");
  const ctx = await phoneContext(browser, { width: 390, height: 844 });
  const p = await ctx.newPage();
  await p.goto(url);
  await p.locator("#join-name").fill("Thumb");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
  await expect(p.getByTestId("board")).toHaveAttribute("data-layout", "phone");

  // Record chrome heights before entering Edit / placing doors: zero overflow or height growth.
  const measureChrome = () =>
    p.evaluate(() => {
      const box = (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { h: Math.round(r.height), overflow: el.scrollWidth > el.clientWidth + 1 };
      };
      return { top: box(".p-top"), tools: box(".p-tools"), bar: box(".pl-bar") };
    });
  const before = await measureChrome();
  expect(before.top?.overflow).toBe(false);

  await p.getByTestId("phone-edit").tap();
  await p.getByTestId("tool-select").tap();
  await p.getByTestId("map").evaluate((e) => e.scrollIntoView({ block: "nearest" }));

  const f = await makeFingers(browser, p);
  const p1 = await mapPoint(p, 0.35, 0.45);
  const p2 = await mapPoint(p, 0.65, 0.45);

  // 1. Long-press empty map -> `map-menu` -> tap `Place King doorway` -> tap p2 -> linked pair!
  await f.press(1, p1);
  await sleep(750);
  await expect(p.getByTestId("map-menu")).toBeVisible();
  await f.lift(1);
  await p.getByTestId("map-menu-doorway-amber").tap();
  await expect(p.locator("[data-testid=door-preview-1]")).toHaveCount(1);
  await f.press(1, p2);
  await sleep(50);
  await f.lift(1);
  const doors = p.locator("[data-testid=map] [data-testid=doorman-door]");
  await expect(doors).toHaveCount(2);
  await expect(p.locator("[data-testid=map] [data-testid=door-link]")).toHaveCount(1);

  // 2. Verify `.pl-hit` touch target is >= 40 CSS px diameter (`44x44` nominal).
  const hitDia = await doors
    .first()
    .locator(".pl-hit")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Math.min(r.width, r.height);
    });
  expect(hitDia).toBeGreaterThanOrEqual(40);

  // 3. 1-finger drag moves Door 0 smoothly!
  const beforeY = Number(await doors.first().getAttribute("data-y"));
  const d0Pt = await centre(doors.first());
  const dest = await mapPoint(p, 0.35, 0.30);
  await f.press(1, d0Pt);
  for (let i = 1; i <= 8; i++) {
    await f.move(1, { x: d0Pt.x + ((dest.x - d0Pt.x) * i) / 8, y: d0Pt.y + ((dest.y - d0Pt.y) * i) / 8 });
    await sleep(25);
  }
  await f.lift(1);
  await expect.poll(async () => Number(await doors.first().getAttribute("data-y"))).not.toBe(beforeY);

  // 4. Long-press on door -> `door-menu` -> `Remove doorway`!
  const afterPt = await centre(doors.first());
  await f.press(1, afterPt);
  await sleep(750);
  await expect(p.getByTestId("door-menu")).toBeVisible();
  await f.lift(1);
  await p.getByTestId("door-menu-remove").tap();
  await expect(doors).toHaveCount(0);

  // 5. Touch Step-2 Door 1 re-tap tolerance: tapping +7 CSS px off Door 1 commits unpaired Door 1 (not a tiny overlapping pair!).
  await f.press(1, p1);
  await sleep(750);
  await expect(p.getByTestId("map-menu")).toBeVisible();
  await f.lift(1);
  await p.getByTestId("map-menu-doorway-amber").tap();
  await expect(p.locator("[data-testid=door-preview-1]")).toHaveCount(1);
  await f.press(1, { x: p1.x + 7, y: p1.y });
  await sleep(50);
  await f.lift(1);
  await expect(doors).toHaveCount(1);
  await expect(doors.first()).toHaveAttribute("data-role", "unpaired");

  // 6. Verify zero `.p-top` / `.p-tools` overflow and unchanged `.p-top` height!
  const after = await measureChrome();
  expect(after.top).toEqual(before.top);
  expect(after.tools?.overflow).toBe(false);
  await ctx.close();

  // 7. Phone landscape `615x344 --touch`: verify zero chrome overflow & doors render cleanly!
  const ctxLand = await phoneContext(browser, { width: 615, height: 344 });
  const pLand = await ctxLand.newPage();
  await pLand.goto(url);
  await pLand.locator("#join-name").fill("ThumbL");
  await pLand.keyboard.press("Enter");
  await expect(pLand.getByTestId("join-card")).toBeHidden();
  await expect(pLand.locator("[data-testid=map] [data-testid=doorman-door]")).toHaveCount(1);
  const landChrome = await pLand.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      return { overflow: el.scrollWidth > el.clientWidth + 1 };
    };
    return { top: box(".p-top"), tools: box(".p-tools"), bar: box(".pl-bar") };
  });
  expect(landChrome.top?.overflow).toBe(false);
  expect(landChrome.tools?.overflow ?? false).toBe(false);
  expect(landChrome.bar?.overflow ?? false).toBe(false);
  await ctxLand.close();
});
