// The isolation matrix (sessions.md §9.1), phase 2: no state crosses tabs. One row per piece of
// state, each on a fresh session of two boards, A and B, opened by a device that holds neither
// board's link (so each tab is opened through its grant). Each row:
//   1. sets the state on A (with a peer on A where it's presence);
//   2. switches to B and checks B shows its own value or the default, and nothing of A's;
//   3. switches back and checks A: its document state is there, and its local view is the
//      default (phase 2 remembers no TabView: §4.2 is phase 3);
//   4. reloads (on `?tab=`) and checks the same.
// Device-wide settings (Vision, map layers) are the same on B by design; the row says so.
// Rows not here, and why, are in docs/specs/sessions.md §10 phase 2.

import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { dragToken, gesture, joinNew, mapPoint, revealControls, tokenAt } from "./helpers";
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
  await expect(ord(me)).toHaveText("Scene 1 of 2"); // the current scene isn't remembered yet (phase 3)
  await reloadOn(me, boardOf(a));
  await expect(sceneCards(me)).toHaveCount(2);
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
function timeline(id: string, shift: number) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
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

test("Player: the match, t and playing, Sandbox; map layers are device-wide", async ({ browser }) => {
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
  // Map layers are device-wide, by design: the same on B.
  await revealControls(me, "heals-toggle");
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "true");
  await me.getByTestId("heals-toggle").click();
  await go(0);
  // A opens on its own match, paused at the start (no TabView yet).
  await expect(me.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(me.getByTestId("player")).toHaveAttribute("data-state", "match");
  await expect(me.getByTestId("match-play")).toHaveText("Play");
  await expect(me.getByTestId("match-clock")).toHaveText("2:00 / 2:00");
  await revealControls(me, "heals-toggle");
  await expect(me.getByTestId("heals-toggle")).toHaveAttribute("aria-pressed", "false");
  await reloadOn(me, boardOf(a));
  await expect(me.getByTestId("match-tier")).toHaveText("Full replay");
});
