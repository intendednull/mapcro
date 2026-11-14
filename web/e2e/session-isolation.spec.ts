// The isolation matrix (sessions.md §9.1), phase 2: no state crosses tabs. One row per piece of
// state, each on a fresh session of two boards, A and B, opened by a device that holds neither
// board's link (so each tab is opened through its grant). Each row:
//   1. sets the state on A (with a peer on A where it's presence);
//   2. switches to B and checks B shows its own value or the default, and nothing of A's;
//   3. switches back and checks A: its document state is there, and its local view is as it was
//      left where §4.2 remembers it (the scene, the viewport and side, the sidebar tab, Player's
//      match and playback, Vision and the map layers), and the default otherwise;
//   4. reloads (on `?tab=`) and checks the same, from sessionStorage.
// Vision and the map layers are per tab once a tab was left (operator decision 7); a tab never
// opened takes this browser's. The parked rows (§5) are at the end.
// Rows not here, and why, are in docs/specs/sessions.md §10 phase 2.

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { dragToken, gesture, joinNew, mapPoint, revealControls, tokenAt, viewOf } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-session-iso-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;
test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "200" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const boardOf = (url: string) => /\/b\/([^#]+)#/.exec(url)![1]!;
const tabs = (p: Page) => p.getByTestId("game-tab");
const mounted = (p: Page) => p.locator('[data-testid="board"]').getAttribute("data-board");
const saved = (p: Page) => expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");

interface Ctx {
  me: Page;
  a: string;
  b: string;
  /** Open tab 0 (A) or 1 (B), waiting for its board. */
  go(i: 0 | 1): Promise<void>;
}

/** A session of A and B, opened on a fresh device through the session's link; on A. */
async function twoTabs(browser: Browser): Promise<Ctx> {
  const a = await newBoardUrl(server, "Board A");
  const b = await newBoardUrl(server, "Board B");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(a)!;
  const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Iso", board, board_token: token }) });
  const s = (await r.json()) as { session: string; owner_token: string };
  const me = await joinNew(browser, `${server.url}/s/${s.session}#${s.owner_token}`, "Coach");
  await me.getByTestId("add-game").click();
  await me.getByTestId("add-paste").fill(b);
  await me.getByTestId("add-paste-go").click();
  await expect(tabs(me)).toHaveCount(2);
  const go = async (i: 0 | 1) => {
    await tabs(me).nth(i).click();
    await expect.poll(() => mounted(me)).toBe(boardOf(i ? b : a));
    await saved(me);
  };
  await go(1);
  await go(0);
  // Opened through the grant, not a board link of this device's.
  expect(await me.evaluate(() => JSON.parse(localStorage.getItem("mapcro.boards") ?? "[]").map((k: { kind?: string }) => k.kind ?? "board"))).toEqual(["session"]);
  return { me, a, b, go };
}

async function reloadOn(p: Page, board: string) {
  await p.reload();
  await expect.poll(() => mounted(p)).toBe(board);
  await saved(p);
}

const PALETTE = ["Parchment", "Rose", "Lilac", "Lime", "Ice", "Brass", "Cinnabar"];
const strokes = (p: Page) => p.locator(".mapbox [data-stroke]");
const sceneCards = (p: Page) => p.getByTestId("scene-card");
const ord = (p: Page) => p.locator(".scene-title .ord");
const pressed = (p: Page, testid: string) => p.getByTestId(testid).getAttribute("aria-pressed");

test("scenes and the current scene", async ({ browser }) => {
  const { me, a, go } = await twoTabs(browser);
  await me.getByTestId("scene-add").click();
  await expect(sceneCards(me)).toHaveCount(2);
  await expect(ord(me)).toHaveText("Scene 2 of 2");
  await go(1);
  await expect(sceneCards(me)).toHaveCount(1);
  await expect(ord(me)).toHaveText("Scene 1 of 1");
  await go(0);
  await expect(sceneCards(me)).toHaveCount(2);
  await expect(ord(me)).toHaveText("Scene 2 of 2"); // as it was left (§4.2)
  await reloadOn(me, boardOf(a));
  await expect(sceneCards(me)).toHaveCount(2);
  await expect(ord(me)).toHaveText("Scene 2 of 2");
});

test("strokes, and the scene note", async ({ browser }) => {
  const { me, a, go } = await twoTabs(browser);
  await me.keyboard.press("e");
  await gesture(me, [[0.3, 0.3], [0.4, 0.35], [0.5, 0.3]]);
  await expect(strokes(me)).toHaveCount(1);
  await revealControls(me, "scene-note-edit");
  await me.getByTestId("scene-note-edit").fill("Rotate mid");
  await me.locator("#events-tab").click(); // blur commits
  await saved(me);
  await go(1);
  await expect(strokes(me)).toHaveCount(0);
  await revealControls(me, "scene-note-edit");
  await expect(me.getByTestId("scene-note-edit")).toHaveValue("");
  await go(0);
  await expect(strokes(me)).toHaveCount(1);
  await revealControls(me, "scene-note-edit");
  await expect(me.getByTestId("scene-note-edit")).toHaveValue("Rotate mid");
  await reloadOn(me, boardOf(a));
  await expect(strokes(me)).toHaveCount(1);
});

test("heroes' places and objectives", async ({ browser }) => {
  const { me, go } = await twoTabs(browser);
  const homeA = await tokenAt(me, "Amber-0");
  await dragToken(me, "Amber-0", 0.3, 0.3);
  await expect.poll(() => tokenAt(me, "Amber-0")).not.toEqual(homeA);
  const movedA = await tokenAt(me, "Amber-0");
  const key = "powerup:neutral:lane1:1";
  const bb = (await me.locator(`.mapbox .mk[data-key="${key}"]`).boundingBox())!;
  await me.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await expect(me.locator(`.mapbox .mk[data-key="${key}"]`)).toHaveAttribute("data-status", "Destroyed");
  await saved(me);
  await go(1);
  expect(await tokenAt(me, "Amber-0")).toEqual(homeA);
  await expect(me.locator(`.mapbox .mk[data-key="${key}"]`)).not.toHaveAttribute("data-status", "Destroyed");
  await go(0);
  expect(await tokenAt(me, "Amber-0")).toEqual(movedA);
  await expect(me.locator(`.mapbox .mk[data-key="${key}"]`)).toHaveAttribute("data-status", "Destroyed");
});

test("the tool, the ink colour and comments open (per board), selection", async ({ browser }) => {
  const { me, go } = await twoTabs(browser);
  await me.keyboard.press("e");
  expect(await pressed(me, "tool-draw")).toBe("true");
  // A colour other than the person's own (each board starts on that).
  const mine = await me.evaluate(() => (JSON.parse(localStorage.getItem("mapcro.me")!) as { color: number }).color);
  const ink = `Colour: ${PALETTE[(mine + 2) % PALETTE.length]}`;
  await me.getByTestId("palette").click();
  await me.getByRole("radio", { name: ink }).click();
  await me.keyboard.press("Escape");
  await me.getByTestId("comments-toggle").click();
  expect(await pressed(me, "comments-toggle")).toBe("true");
  await go(1);
  expect(await pressed(me, "tool-select")).toBe("true");
  expect(await pressed(me, "comments-toggle")).toBe("false");
  await me.getByTestId("palette").click();
  await expect(me.getByRole("radio", { name: ink })).toHaveAttribute("aria-checked", "false");
  await me.keyboard.press("Escape");
  await go(0);
  // The tool resets to Move on a new mount; colour and comments are A's own, kept per board.
  expect(await pressed(me, "tool-select")).toBe("true");
  expect(await pressed(me, "comments-toggle")).toBe("true");
  await me.getByTestId("palette").click();
  await expect(me.getByRole("radio", { name: ink })).toHaveAttribute("aria-checked", "true");
});

test("peers on A: cursors, lasers and the people list never show on B", async ({ browser }) => {
  const { me, a, go } = await twoTabs(browser);
  const peer = await joinNew(browser, a, "Peer"); // on A by A's own link
  await expect(me.locator(".people")).toContainText("Peer");
  const p = await mapPoint(peer, 0.5, 0.5);
  await peer.mouse.move(p.x, p.y);
  await peer.mouse.move(p.x + 20, p.y + 10, { steps: 3 });
  await expect(me.locator('.cur[data-cursor="Peer"]')).toBeVisible();
  // The peer sees Coach on A.
  await expect(peer.locator(".people")).toContainText("Coach");
  await go(1);
  // B: nobody of A's, drawn or listed; the peer sees Coach leave A.
  await peer.keyboard.press("l");
  await gesture(peer, [[0.4, 0.4], [0.5, 0.5]], 3);
  await peer.mouse.move(p.x + 40, p.y + 30, { steps: 3 });
  await expect(peer.locator(".people")).not.toContainText("Coach");
  await expect(me.locator(".cur")).toHaveCount(0);
  await expect(me.locator(".laser")).toHaveCount(0);
  await expect(me.locator(".people")).not.toContainText("Peer");
  await go(0);
  await expect(me.locator(".people")).toContainText("Peer");
});

test("undo on B never undoes A's edit; an edit made offline on A lands on A, never B", async ({ browser }) => {
  const { me, a, b, go } = await twoTabs(browser);
  const peerA = await joinNew(browser, a, "PeerA");
  const peerB = await joinNew(browser, b, "PeerB");
  const home = await tokenAt(me, "Amber-0");
  await dragToken(me, "Amber-0", 0.3, 0.3);
  await saved(me);
  await expect.poll(() => tokenAt(peerA, "Amber-0")).not.toEqual(home);
  const moved = await tokenAt(peerA, "Amber-0");
  await go(1);
  // The one history (§7.2) on B: A's move is out of reach; the newest step here is the strip's
  // (B's own add), so Undo takes that, and you're moved to A. A's move stands.
  await me.keyboard.press("Control+z");
  await expect(tabs(me)).toHaveCount(1);
  await expect.poll(() => mounted(me)).toBe(boardOf(a));
  await saved(me);
  await expect.poll(() => tokenAt(peerA, "Amber-0")).toEqual(moved);
  await expect.poll(() => tokenAt(me, "Amber-0")).toEqual(moved);
  await me.keyboard.press("Control+Shift+z");
  await expect(tabs(me)).toHaveCount(2);
  await go(1);
  expect(await tokenAt(me, "Amber-0")).toEqual(home);

  // Offline: the server goes away; a move on A waits on this device.
  await go(0);
  await server.kill();
  await expect(me.getByTestId("save-status")).toHaveAttribute("data-state", "offline");
  await dragToken(me, "Amber-0", 0.6, 0.6);
  const offline = await tokenAt(me, "Amber-0");
  await tabs(me).nth(1).click();
  await expect.poll(() => mounted(me)).toBe(boardOf(b));
  await server.start();
  await saved(me);
  await expect(peerB.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  expect(await tokenAt(me, "Amber-0")).toEqual(home);
  expect(await tokenAt(peerB, "Amber-0")).toEqual(home);
  // Back on A: the pending move goes to A.
  await go(0);
  await expect.poll(() => tokenAt(peerA, "Amber-0"), { timeout: 20_000 }).toEqual(offline);
  expect(await tokenAt(peerB, "Amber-0")).toEqual(home);
});

test("a drag released during a switch lands on A, and the switch waits for it", async ({ browser }) => {
  const { me, a, b, go } = await twoTabs(browser);
  const peerA = await joinNew(browser, a, "PeerA");
  const home = await tokenAt(me, "Amber-0");
  const box = (await me.locator('.tok[data-slot="Amber-0"]').boundingBox())!;
  await me.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await me.mouse.down();
  const to = await mapPoint(me, 0.35, 0.35);
  await me.mouse.move(to.x, to.y, { steps: 6 });
  await me.keyboard.press("Control+PageDown");
  await me.waitForTimeout(200);
  expect(await mounted(me)).toBe(boardOf(a)); // still A while the drag is held
  await me.mouse.up();
  await expect.poll(() => mounted(me)).toBe(boardOf(b));
  await saved(me);
  expect(await tokenAt(me, "Amber-0")).toEqual(home);
  await expect.poll(() => tokenAt(peerA, "Amber-0")).not.toEqual(home);
  void go;
});

// ---- Player rows: each board its own match ----

const N = 120;
const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
function timeline(id: string, shift: number, duration = N) {
  return {
    match_id: Number(id), start_time: 0, duration_s: duration, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({
        team, slot, hero_id: 1 + slot, name: `${team === "amber" ? "A" : "S"}${slot}`,
        x: range(() => slot * 1500 - 4000 + shift), y: range(() => (team === "amber" ? -3000 : 3000) + shift),
        health: range(() => 100), deaths: [], respawn: [], souls: [[0, 500]], ult: range(() => 0), seen: [],
        items: [], abilities: [], casts: [], charges: [], effects: [], cc: [], height: [], recaps: [],
      })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
    waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
    troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
  };
}

/** Load a match as an editor does, through the tab's grant; the worker's answer written by hand. */
async function load(p: Page, id: string, shift: number) {
  const bar = p.getByTestId("player");
  if (!(await bar.count()) || (await bar.getAttribute("data-state")) !== "match") await p.getByTestId("mode-player").first().click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(id, shift)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(p.getByTestId("match-clock")).toBeVisible();
}

test("Player: the match, t and playing, Sandbox; map layers are a tab's own once it was left", async ({ browser }) => {
  const { me, a, go } = await twoTabs(browser);
  await load(me, "51001", 0);
  await me.getByTestId("match-play").click();
  await expect(me.getByTestId("match-play")).toHaveText("Pause");
  await revealControls(me, "heals-toggle");
  await me.getByTestId("heals-toggle").click();
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "true");
  await go(1);
  // B has no match: Sandbox, nothing of A's match drawn or playing.
  await expect(me.getByTestId("match-tier")).toHaveCount(0);
  await expect(me.getByTestId("match-clock")).toHaveCount(0);
  await expect(me.locator(".pl-bar")).toHaveCount(0);
  await load(me, "51002", 3000);
  await expect(me.getByTestId("match-play")).toHaveText("Play");
  // B's own match at its own default place (a match opens at 10:00, or its end), paused; A's was
  // playing from the start.
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  // B was left once already (before A turned Heals on): its map layers are its own.
  await revealControls(me, "heals-toggle");
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "false");
  await me.getByTestId("match-speed").selectOption("2");
  await go(0);
  // A opens as it was left (§4.2): its own match, still playing from where it was, at its own
  // speed, with its own layers (B's Heals are off).
  await expect(me.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(me.getByTestId("player")).toHaveAttribute("data-state", "match");
  await expect(me.getByTestId("match-play")).toHaveText("Pause");
  await expect(me.getByTestId("match-clock")).not.toHaveText("2:00 / 2:00");
  await expect(me.getByTestId("match-speed")).toHaveValue("1");
  await revealControls(me, "heals-toggle");
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "true");
  // Paused somewhere, and left for a scene: back on A, it's on the scene, the match held where it was.
  await me.getByTestId("match-play").click();
  const at = await me.getByTestId("match-clock").innerText();
  expect(at).not.toBe("2:00 / 2:00");
  await revealControls(me, "mode-sandbox");
  await me.getByTestId("mode-sandbox").first().click();
  await expect(me.getByTestId("player")).not.toHaveAttribute("data-state", "match");
  await go(1);
  // B as it was left: paused at its own place, at 2x, Heals off.
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  await expect(me.getByTestId("match-speed")).toHaveValue("2");
  await revealControls(me, "heals-toggle");
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "false");
  await go(0);
  await expect(me.getByTestId("player")).not.toHaveAttribute("data-state", "match");
  await revealControls(me, "mode-player");
  await me.getByTestId("mode-player").first().click();
  await expect(me.getByTestId("match-clock")).toHaveText(at);
  await expect(me.getByTestId("match-play")).toHaveText("Play");
  // The same after a reload, from sessionStorage.
  await reloadOn(me, boardOf(a));
  await expect(me.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(me.getByTestId("match-clock")).toHaveText(at);
  await expect(me.getByTestId("match-play")).toHaveText("Play");
  await revealControls(me, "heals-toggle");
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "true");
  // A tab never opened takes this browser's last choice (Heals on, from A), not B's own.
  const c = await newBoardUrl(server, "Board C");
  await me.getByTestId("add-game").click();
  await me.getByTestId("add-paste").fill(c);
  await me.getByTestId("add-paste-go").click();
  await expect(tabs(me)).toHaveCount(3);
  await expect.poll(() => mounted(me)).toBe(boardOf(c));
  await saved(me);
  await load(me, "51003", 0);
  await revealControls(me, "heals-toggle");
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "true");
});

// ---- what a tab remembers (§4.2), and parked boards (§5) ----

test("a tab comes back as it was left: scene, viewport and side, the sidebar tab; a scene gone meanwhile opens cold", async ({ browser }) => {
  const { me, a, go } = await twoTabs(browser);
  const fit = await viewOf(me);
  await me.getByTestId("scene-add").click();
  await expect(ord(me)).toHaveText("Scene 2 of 2");
  const m = await mapPoint(me, 0.4, 0.4);
  await me.mouse.move(m.x, m.y);
  await me.mouse.wheel(0, -300);
  await expect.poll(() => viewOf(me)).not.toEqual(fit);
  const zoomed = await viewOf(me);
  await me.getByTestId("viewpoint-flip").click();
  await expect(me.locator(".mapbox .mm-host")).toHaveClass(/vp-sapphire/);
  const flipped = await viewOf(me);
  await me.locator("#notes-tab").click();
  await expect(me.locator("#notes-tab")).toHaveAttribute("aria-selected", "true");
  await saved(me);
  await go(1);
  // B is its own: first scene, fitted, Amber side, Events.
  await expect(ord(me)).toHaveText("Scene 1 of 1");
  expect(await viewOf(me)).toEqual(fit);
  await expect(me.locator(".mapbox .mm-host")).not.toHaveClass(/vp-sapphire/);
  await expect(me.locator("#events-tab")).toHaveAttribute("aria-selected", "true");
  const asLeft = async () => {
    await expect(ord(me)).toHaveText("Scene 2 of 2");
    await expect(me.locator(".mapbox .mm-host")).toHaveClass(/vp-sapphire/);
    expect(await viewOf(me)).toEqual(flipped);
    await expect(me.locator("#notes-tab")).toHaveAttribute("aria-selected", "true");
  };
  await go(0);
  await asLeft();
  await reloadOn(me, boardOf(a));
  await asLeft();
  // What's remembered is this browser tab's alone, under the session and the board.
  const keys = await me.evaluate(() => Object.keys(sessionStorage).filter((k) => k.startsWith("mapcro.tabview.")));
  expect(keys.length).toBe(2);
  expect(keys.every((k) => /^mapcro\.tabview\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/.test(k))).toBe(true);
  // A peer deletes that scene while this tab is on B: A opens on its first scene, fitted, as cold.
  await go(1);
  const peerA = await joinNew(browser, a, "PeerA");
  await expect(sceneCards(peerA)).toHaveCount(2);
  await sceneCards(peerA).nth(1).hover();
  await sceneCards(peerA).nth(1).getByTestId("scene-delete").click();
  await expect(sceneCards(peerA)).toHaveCount(1);
  await saved(peerA);
  await go(0);
  await expect(sceneCards(me)).toHaveCount(1);
  await expect(ord(me)).toHaveText("Scene 1 of 1");
  expect(await viewOf(me)).toEqual(fit);
  await expect(me.locator(".mapbox .mm-host")).not.toHaveClass(/vp-sapphire/);
  await expect(me.locator("#notes-tab")).toHaveAttribute("aria-selected", "true"); // the sidebar isn't the scene's
  void zoomed;
});

/** IndexedDB connections open in the page: the session's, the mounted board's, and each parked board's. */
const countIdb = (p: Page) =>
  p.addInitScript(() => {
    const w = window as unknown as { __idb: number };
    w.__idb = 0;
    const open = IDBFactory.prototype.open;
    IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory["open"]>) {
      const req = open.apply(this, args);
      req.addEventListener("success", () => {
        w.__idb += 1;
        const db = req.result;
        const close = db.close.bind(db);
        let closed = false;
        db.close = () => {
          if (!closed) w.__idb -= 1;
          closed = true;
          close();
        };
      });
      return req;
    };
  });
/** "People here": how many are online on the board. */
const online = (p: Page) => p.locator(".people-section h2 small");
const idb = (p: Page) => p.evaluate(() => (window as unknown as { __idb: number }).__idb);

test("a parked A: off A's people list at once; an edit made offline on A flushes to A from B, unseen; back on A, undo still takes it", async ({ browser }) => {
  const a0 = await newBoardUrl(server, "Board A");
  const b0 = await newBoardUrl(server, "Board B");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(a0)!;
  const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Parked", board, board_token: token }) });
  const s = (await r.json()) as { session: string; owner_token: string };
  const me = await joinNew(browser, `${server.url}/s/${s.session}#${s.owner_token}`, "Coach", (p) => void countIdb(p));
  await me.getByTestId("add-game").click();
  await me.getByTestId("add-paste").fill(b0);
  await me.getByTestId("add-paste-go").click();
  await expect(tabs(me)).toHaveCount(2);
  await expect.poll(() => mounted(me)).toBe(boardOf(b0));
  await saved(me);
  // On B, with A parked: the session's storage, B's, and A's kept open.
  await expect.poll(() => idb(me)).toBe(3);
  const peerA = await joinNew(browser, a0, "PeerA");
  const peerB = await joinNew(browser, b0, "PeerB");
  await expect(online(peerA)).toContainText("1 online"); // PeerA alone: Coach is on B
  await tabs(me).nth(0).click();
  await expect.poll(() => mounted(me)).toBe(boardOf(a0));
  await saved(me);
  await expect(online(peerA)).toContainText("2 online");
  const home = await tokenAt(me, "Amber-0");

  // Offline on A: a move waits on this device. Then to B, and the server comes back.
  await server.kill();
  await expect(me.getByTestId("save-status")).toHaveAttribute("data-state", "offline");
  await dragToken(me, "Amber-0", 0.6, 0.6);
  const offline = await tokenAt(me, "Amber-0");
  await tabs(me).nth(1).click();
  await expect.poll(() => mounted(me)).toBe(boardOf(b0));
  await server.start();
  await saved(me);
  // The parked A flushes its move to A, while this tab stays on B and never shows on A's list.
  await expect.poll(() => tokenAt(peerA, "Amber-0"), { timeout: 20_000 }).toEqual(offline);
  expect(await mounted(me)).toBe(boardOf(b0));
  expect(await tokenAt(me, "Amber-0")).toEqual(home);
  await expect(peerB.getByTestId("save-status")).toHaveAttribute("data-state", "saved", { timeout: 20_000 });
  expect(await tokenAt(peerB, "Amber-0")).toEqual(home);
  await expect(online(peerA)).toContainText("1 online");
  await peerA.waitForTimeout(500);
  await expect(online(peerA)).toContainText("1 online");
  // PeerA moves another hero meanwhile.
  const other = await tokenAt(peerA, "Amber-1");
  await dragToken(peerA, "Amber-1", 0.2, 0.7);
  await saved(peerA);
  // Back on A: both moves are there, and Undo takes back this tab's own (its stack was kept).
  await tabs(me).nth(0).click();
  await expect.poll(() => mounted(me)).toBe(boardOf(a0));
  await saved(me);
  expect(await tokenAt(me, "Amber-0")).toEqual(offline);
  await expect.poll(() => tokenAt(me, "Amber-1")).not.toEqual(other);
  await expect(online(peerA)).toContainText("2 online");
  await me.keyboard.press("Control+z");
  await expect.poll(() => tokenAt(peerA, "Amber-0")).toEqual(home);
  expect(await tokenAt(peerA, "Amber-1")).not.toEqual(other);
});

test("a parked A dropped from the pool (three boards left since) reopens cold, correct; nothing piles up", async ({ browser }) => {
  const urls: string[] = [];
  for (const t of ["A", "B", "C", "D", "E"]) urls.push(await newBoardUrl(server, `Board ${t}`));
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(urls[0]!)!;
  const r = await fetch(`${server.url}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Many", board, board_token: token }) });
  const s = (await r.json()) as { session: string; owner_token: string };
  const me = await joinNew(browser, `${server.url}/s/${s.session}#${s.owner_token}`, "Coach", (p) => void countIdb(p));
  // A move on A, to find again (and to undo) after A was dropped.
  const home = await tokenAt(me, "Amber-0");
  await dragToken(me, "Amber-0", 0.3, 0.3);
  await saved(me);
  const moved = await tokenAt(me, "Amber-0");
  await expect.poll(() => idb(me)).toBe(2);
  for (const [i, url] of urls.slice(1).entries()) {
    await me.getByTestId("add-game").click();
    await me.getByTestId("add-paste").fill(url);
    await me.getByTestId("add-paste-go").click();
    await expect(tabs(me)).toHaveCount(2 + i);
    await expect.poll(() => mounted(me)).toBe(boardOf(url));
    await saved(me);
    // The session's, the open board's, and at most three parked (§4.3): A goes when D is left.
    await expect.poll(() => idb(me)).toBe(Math.min(3 + i, 5));
  }
  // A peer changes A while it's neither open nor parked here.
  const peerA = await joinNew(browser, urls[0]!, "PeerA");
  const other = await tokenAt(peerA, "Amber-1");
  await dragToken(peerA, "Amber-1", 0.2, 0.7);
  await saved(peerA);
  await tabs(me).nth(0).click();
  await expect.poll(() => mounted(me)).toBe(boardOf(urls[0]!));
  await saved(me);
  expect(await tokenAt(me, "Amber-0")).toEqual(moved);
  await expect.poll(() => tokenAt(me, "Amber-1")).not.toEqual(other);
  await expect.poll(() => idb(me)).toBe(5);
  // Round and round: the count holds.
  for (const i of [1, 2, 3, 4, 0, 2]) {
    await tabs(me).nth(i).click();
    await expect.poll(() => mounted(me)).toBe(boardOf(urls[i]!));
    await saved(me);
  }
  await expect.poll(() => idb(me)).toBe(5);
  // Leaving the session ends them all.
  await me.goto(`${server.url}/`);
  await expect.poll(() => idb(me)).toBe(0);
  void home;
});

// ---- the page's timeline cache (§4.3): the server decides on every open ----

/**
 * A and B, each with the same fetched replay attached (one file for every board), on A after a
 * reload: the page's cache starts empty. `gets` is every answer to a timeline request since, as
 * `<board> <status>`.
 */
async function sameFetchedMatch(browser: Browser, id: string) {
  const ctx = await twoTabs(browser);
  mkdirSync(join(server.dataDir, "replays"), { recursive: true });
  const file = join(server.dataDir, "replays", `${id}-cdn.json`);
  writeFileSync(file, JSON.stringify(timeline(id, 0)));
  for (const url of [ctx.a, ctx.b]) {
    const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
    const r = await fetch(`${server.url}/api/boards/${board}/matches/${id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` } });
    expect(r.ok).toBe(true);
  }
  const gets: string[] = [];
  ctx.me.on("response", (r) => {
    const m = new RegExp(`/api/boards/([^/]+)/matches/${id}$`).exec(new URL(r.url()).pathname);
    if (m && r.request().method() === "GET") gets.push(`${m[1] === boardOf(ctx.a) ? "A" : m[1] === boardOf(ctx.b) ? "B" : "?"} ${r.status()}`);
  });
  await reloadOn(ctx.me, boardOf(ctx.a));
  await expect(ctx.me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  return { ...ctx, gets, file };
}

test("the timeline cache: a match is sent once, then confirmed by the server on every open, for each board; a file written again is sent again", async ({ browser }) => {
  const id = "52001";
  const { me, go, gets, file } = await sameFetchedMatch(browser, id);
  // Sent once, to A. Whatever A asks after is answered "the same".
  expect(gets[0]).toBe("A 200");
  await go(1);
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  await go(0);
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  await go(1);
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  // B asked too, each time it opened (the server's checks ran for it), and was sent nothing.
  await expect.poll(() => gets.filter((g) => g === "B 304").length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => gets.filter((g) => g === "A 304").length).toBeGreaterThanOrEqual(1);
  expect(gets.filter((g) => !g.endsWith(" 304"))).toEqual(["A 200"]);
  // A newer parse of the replay: the validator held names the old file, so the new one is sent.
  writeFileSync(file, JSON.stringify(timeline(id, 0, 180)));
  await go(0);
  await expect(me.getByTestId("match-clock")).toHaveText(/ \/ 3:00$/);
  expect(gets.filter((g) => !g.endsWith(" 304"))).toEqual(["A 200", "A 200"]);
  // And it's the one held now, for B as well.
  await go(1);
  await expect(me.getByTestId("match-clock")).toHaveText(/ \/ 3:00$/);
  expect(gets.filter((g) => !g.endsWith(" 304"))).toEqual(["A 200", "A 200"]);
});

test("the timeline cache: refused by the server, what the page held isn't shown; with no answer, it stays", async ({ browser }) => {
  const id = "52002";
  const { me, a, go, gets } = await sameFetchedMatch(browser, id);
  await go(1);
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  // The server refuses A the match from here on (as it would a link that no longer opens it).
  const route = `**/api/boards/${boardOf(a)}/matches/${id}`;
  const refuse = (r: import("@playwright/test").Route) => (r.request().method() === "GET" ? r.fulfill({ status: 403, contentType: "application/json", body: '{"error":"forbidden"}' }) : r.continue());
  await me.route(route, refuse);
  await go(0);
  await expect.poll(() => gets.filter((g) => g === "A 403").length).toBeGreaterThanOrEqual(1);
  await expect(me.getByTestId("match-clock")).toHaveCount(0);
  // B is asked for itself and keeps its own.
  await go(1);
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  // No answer at all (offline): what the page holds stays drawn.
  await me.unroute(route, refuse);
  await me.route(route, (r) => (r.request().method() === "GET" ? r.abort() : r.continue()));
  await go(0);
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  await me.waitForTimeout(500);
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
});
