// A scene's builds (feedback #49; docs/specs/map-state.md phase 2), on a synthetic replay:
// - a scene saved from Player holds the frame's builds, and shows them as Player does: a
//   portrait opens its hero's build, All builds and holding Tab open the twelve, the build
//   order lists the buys up to the frame; souls stay an edit and the right click the hero menu;
// - a scene saved from the match before it could hold builds offers Retake, which fills them
//   in from the scene's own moment, and nothing a person set since is overwritten;
// - a follower sees the builds its presenter opens on a scene, with the match and on a board
//   that has none (a scene that came in a file).

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000151";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-scene-builds-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
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

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Twelve heroes with souls, health, ults, items and abilities; Amber 1 dead from 20 to 30 and
 * seen by Sapphire before it; a guardian down at 10. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const a1 = team === "amber" && slot === 1;
        const dead = (s: number) => a1 && s >= 20 && s < 30;
        const at = { x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 };
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : at.x + s * 10)),
          y: range((s) => (dead(s) ? null : at.y)),
          health: range((s) => (dead(s) ? 0 : 100 - slot * 12)),
          deaths: a1 ? [20] : [],
          respawn: a1 ? [[20, 30]] : [],
          souls: [[0, 500 + slot * 100], [15, 2500 + slot * 300]], ult: range((s) => (s < 12 ? 100 - s * 8 : 0)),
          seen: a1 ? [[100, 198]] : [],
          level: [[0, 1], [10, 3 + slot]],
          items: [[50, 715_762_406, 0], [120, 1_009_965_641, 0]],
          abilities: [[3, 9_000 + slot, 1], [14, 9_000 + slot, 2]], casts: [], charges: [], cc: [], effects: [],
          recaps: [],
        };
      }),
    ),
    objectives: [{ key: "guardian:amber:lane1:1", kind: "guardian", team: "amber", lane: 1, destroyed_s: 10 }], mid_boss: [], rifts: [], powerups: [],
    events: [{ t: 20, kind: "death", team: "amber", slot: 1, hero_id: 2, x: -2500, y: -3000 }],
  };
}

const answered = new Set<string>();
async function openMatch(p: Page) {
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

const portrait = (p: Page, slot: string) => p.locator(`.tb-player[data-slot="${slot}"]`);
const builds = (p: Page) => p.locator("[data-testid=hero-build]:not([hidden])");
/** What a hero's open build shows: its level, items and abilities. */
const shown = async (p: Page, slot: string) => ({
  level: await portrait(p, slot).getByTestId("tb-level").textContent(),
  items: await portrait(p, slot).locator(".tb-build-item").evaluateAll((els) => els.map((e) => e.getAttribute("data-item-id"))),
  abilities: await portrait(p, slot).locator(".tb-build-ability").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-ability-id")}:${e.getAttribute("data-level")}`)),
});

/** Player at 25 s, saved as a scene: the page is left on the new scene. */
async function savedScene(p: Page) {
  await openMatch(p);
  await scrubTo(p, 25);
  await p.locator('.tb-player[data-slot="Amber-3"] [data-testid=focus-hero]').click();
  const inPlayer = await shown(p, "Amber-3");
  await p.keyboard.press("Escape");
  await p.getByTestId("match-save").click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  return inPlayer;
}

test("a scene saved from Player shows each hero's build as Player did (#49)", async ({ browser }) => {
  const p = await joinNew(browser, await newBoardUrl(server, "Scene builds"), "Coach");
  const inPlayer = await savedScene(p);
  expect(inPlayer.items).toEqual(["715762406", "1009965641"]);
  await expect(builds(p)).toHaveCount(0);
  // A portrait opens its hero's build: what Player showed at the frame.
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(1);
  expect(await shown(p, "Amber-3")).toEqual(inPlayer);
  // The build order up to the frame, as a list; no Effects (they aren't in a frame).
  await expect(p.getByTestId("active-effects")).toHaveCount(0);
  const order = p.getByTestId("build-order");
  await order.locator("summary").click();
  expect(await order.getByTestId("build-order-row").evaluateAll((els) => els.map((el) => `${el.getAttribute("data-t")} ${el.getAttribute("data-kind")} ${el.getAttribute("data-item-id")}`))).toEqual(["5 bought 715762406", "12 bought 1009965641"]);
  // Another portrait moves it; Escape closes it.
  await portrait(p, "Sapphire-1").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(1);
  await expect(portrait(p, "Sapphire-1").locator("[data-testid=hero-build]:not([hidden])")).toHaveCount(1);
  await p.keyboard.press("Escape");
  await expect(builds(p)).toHaveCount(0);
  // All builds, and holding Tab, as in Player.
  await p.getByTestId("all-builds").click();
  await expect(builds(p)).toHaveCount(12);
  await p.getByTestId("all-builds").click();
  await expect(builds(p)).toHaveCount(0);
  await p.getByTestId("map").hover();
  await p.keyboard.down("Tab");
  await expect(builds(p)).toHaveCount(12);
  await p.keyboard.up("Tab");
  await expect(builds(p)).toHaveCount(0);
  // Souls stay an edit, and the right click the hero's menu (feedback #53).
  await portrait(p, "Amber-0").getByTestId("souls-banner").click();
  await expect(portrait(p, "Amber-0").locator("input")).toBeFocused();
  await p.keyboard.press("Escape");
  await expect(builds(p)).toHaveCount(0);
  await portrait(p, "Amber-0").click({ button: "right", position: { x: 20, y: 30 } });
  await expect(p.getByTestId("hero-menu")).toBeVisible();
  await p.keyboard.press("Escape");
  // Nothing to retake: the scene holds everything this build writes.
  await expect(p.getByTestId("retake")).toHaveCount(0);
  // It is the scene's own: it survives a reload. (A board with a match opens in Player: back
  // to the scene, where the replay stands elsewhere.)
  await p.reload();
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await p.getByTestId("scene-card").nth(1).click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await expect(p.getByTestId("all-builds")).toBeVisible();
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  expect(await shown(p, "Amber-3")).toEqual(inPlayer);
});

type Rec = [string, Record<string, Record<string, unknown>>];
const hex = (n: number) => n.toString(16).padStart(32, "0");

/** A board whose second scene is one Save as scene made from the match at 25 s before a scene
 * could hold builds: no state, nothing more on its heroes. */
function oldBoard() {
  const f = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/board-file-v1-oldest-records.mapcro.json")).toString()) as { records: Rec[] };
  const slots = f.records.filter((r) => r[1].RosterSlot);
  slots.forEach((r, i) => (r[1].RosterSlot!.hero = 1 + (i % 6)));
  const scene = hex(0xaaa);
  f.records.push([scene, { Scene: { name: "Match moment", order: "s", clock: 25, source: { match_id: Number(ID), t: 25, tier: "replay" } } }]);
  slots.forEach((r, i) => f.records.push([hex(0xb00 + i), { PlayerState: { scene, slot: r[0], pos: { x: -4000 + i * 700, y: i < 6 ? -2500 : 2500 }, alive: true, placed: true, souls: 3000, ult_cooldown: 0, visible: true } }]));
  return f;
}

async function seed(file: unknown): Promise<string> {
  const r = await fetch(`${server.url}/api/boards/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file) });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}

test("Retake gives a scene saved before builds its own moment's builds, once its match is open", async ({ browser }) => {
  const p = await joinNew(browser, await seed(oldBoard()), "Coach");
  const cards = p.getByTestId("scene-card");
  await cards.nth(1).click();
  // No match open: nothing to retake from, and no builds.
  await expect(p.getByTestId("retake")).toHaveCount(0);
  await expect(p.getByTestId("all-builds")).toHaveCount(0);
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  await expect(builds(p)).toHaveCount(0);
  // Its match opened, and back on the scene: Retake.
  await openMatch(p);
  await scrubTo(p, 50);
  await cards.nth(1).click();
  await expect(p.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await p.getByTestId("retake").click();
  await expect(p.getByTestId("retake")).toHaveCount(0);
  await expect(p.getByTestId("all-builds")).toBeVisible();
  await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  // The scene's moment (25 s), not where the replay stands (50 s): level 6, both items.
  await portrait(p, "Amber-3").getByTestId("focus-hero").click();
  expect(await shown(p, "Amber-3")).toEqual({ level: "6", items: ["715762406", "1009965641"], abilities: expect.arrayContaining(["9003:2"]) });
  // One undo step takes it back; the scene offers Retake again.
  await p.keyboard.press("Escape");
  await p.getByTestId("map").hover();
  await p.keyboard.press("Control+z");
  await expect(p.getByTestId("retake")).toBeVisible();
  await expect(p.getByTestId("all-builds")).toHaveCount(0);
  // The first scene isn't from a match: never offered.
  await cards.nth(0).click();
  await expect(p.getByTestId("retake")).toHaveCount(0);
});

test("a follower sees the builds its presenter opens on a scene", async ({ browser }) => {
  const url = await newBoardUrl(server, "Scene follow");
  const a = await joinNew(browser, url, "Coach");
  await savedScene(a);
  const b = await joinNew(browser, url, "Viewer");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await expect(b.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  // One build, another, the popover in it, all, none.
  await portrait(a, "Amber-2").getByTestId("focus-hero").click();
  await expect(portrait(b, "Amber-2").locator("[data-testid=hero-build]:not([hidden])")).toHaveCount(1);
  await a.getByTestId("build-order").locator("summary").click();
  await expect(b.getByTestId("build-order")).toHaveAttribute("open", "");
  await portrait(a, "Sapphire-4").getByTestId("focus-hero").click();
  await expect(portrait(b, "Sapphire-4").locator("[data-testid=hero-build]:not([hidden])")).toHaveCount(1);
  await expect(builds(b)).toHaveCount(1);
  await a.getByTestId("all-builds").click();
  await expect(builds(b)).toHaveCount(12);
  await a.getByTestId("all-builds").click();
  await expect(builds(b)).toHaveCount(0);
  // The follower's own build is its own until the presenter's next change, and following goes on.
  await portrait(b, "Amber-0").getByTestId("focus-hero").click();
  await expect(builds(b)).toHaveCount(1);
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await portrait(a, "Amber-5").getByTestId("focus-hero").click();
  await expect(portrait(b, "Amber-5").locator("[data-testid=hero-build]:not([hidden])")).toHaveCount(1);
  await expect(builds(b)).toHaveCount(1);
});

test("with no match on the board, a scene from a file shows its builds and a follower sees them opened", async ({ browser }) => {
  // A scene saved with its builds, exported, and imported as a board that has no match.
  const from = await newBoardUrl(server, "Scene export");
  const maker = await joinNew(browser, from, "Coach");
  const inPlayer = await savedScene(maker);
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(from)!;
  const file = (await (await fetch(`${server.url}/api/boards/${board}/export`, { headers: { authorization: `Bearer ${token}` } })).json()) as { version: number; rows: number; matches: number[] };
  expect(file.version).toBe(2);
  expect(file.matches).toEqual([Number(ID)]);
  file.matches = [];
  await maker.close();
  const url = await seed(file);
  const a = await joinNew(browser, url, "Coach");
  await expect(a.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await a.getByTestId("scene-card").nth(1).click();
  // The snapshot is the scene's own: its builds show with no replay anywhere, and there is
  // nothing to retake from.
  await expect(a.getByTestId("all-builds")).toBeVisible();
  await expect(a.getByTestId("retake")).toHaveCount(0);
  await portrait(a, "Amber-3").getByTestId("focus-hero").click();
  expect(await shown(a, "Amber-3")).toEqual(inPlayer);
  await a.keyboard.press("Escape");
  await expect(builds(a)).toHaveCount(0);
  // A follower: one build, its popover, all, none, and one closed again.
  const b = await joinNew(browser, url, "Viewer");
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
  await expect(b.getByTestId("all-builds")).toBeVisible();
  await portrait(a, "Amber-2").getByTestId("focus-hero").click();
  await expect(portrait(b, "Amber-2").locator("[data-testid=hero-build]:not([hidden])")).toHaveCount(1);
  await a.getByTestId("build-order").locator("summary").click();
  await expect(b.getByTestId("build-order")).toHaveAttribute("open", "");
  await a.getByTestId("all-builds").click();
  await expect(builds(b)).toHaveCount(12);
  await a.getByTestId("all-builds").click();
  await expect(builds(b)).toHaveCount(0);
  await portrait(a, "Sapphire-4").getByTestId("focus-hero").click();
  await expect(portrait(b, "Sapphire-4").locator("[data-testid=hero-build]:not([hidden])")).toHaveCount(1);
  await a.keyboard.press("Escape");
  await expect(builds(a)).toHaveCount(0);
  await expect(builds(b)).toHaveCount(0);
  await expect(b.getByTestId("stop-following")).toHaveCount(1);
});

test("a scene whose builds are over one transaction is duplicated whole (review F1)", async ({ browser }) => {
  const from = await newBoardUrl(server, "Big scene");
  const maker = await joinNew(browser, from, "Coach");
  await savedScene(maker);
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(from)!;
  const file = (await (await fetch(`${server.url}/api/boards/${board}/export`, { headers: { authorization: `Bearer ${token}` } })).json()) as { records: Rec[]; matches: number[] };
  file.matches = [];
  await maker.close();
  // Each hero's build order filled to the row's 600 integers with rows far past the frame, as
  // long as real ids are: twelve heroes are then over a transaction's 64 KiB, as after Retake
  // on a late-game scene.
  let heroes = 0;
  for (const [, r] of file.records) {
    const more = (r.PlayerState as { more?: { build_order?: number[] } } | undefined)?.more;
    if (!more) continue;
    heroes++;
    const order = (more.build_order ??= []);
    for (let i = 0; order.length < 600; i++) order.push(4_000_000_000 + i, 4_100_000_000 + i, 4_200_000_000 + i);
  }
  expect(heroes).toBe(12);
  // Over one transaction, whatever wraps the heroes.
  expect(JSON.stringify(file.records.filter(([, r]) => (r.PlayerState as { more?: object } | undefined)?.more)).length).toBeGreaterThan(70_000);
  const url = await seed(file);
  const a = await joinNew(browser, url, "Coach");
  const b = await joinNew(browser, url, "Viewer");
  const cards = a.getByTestId("scene-card");
  await expect(cards).toHaveCount(2);
  await cards.nth(1).click();
  await portrait(a, "Amber-3").getByTestId("focus-hero").click();
  const before = await shown(a, "Amber-3");
  await a.keyboard.press("Escape");
  await cards.nth(1).hover();
  await cards.nth(1).getByTestId("scene-clone").click();
  // The copy exists for everyone, is the scene shown, and holds the twelve builds.
  await expect(cards).toHaveCount(3);
  await expect(b.getByTestId("scene-card")).toHaveCount(3);
  await expect(cards.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await portrait(a, "Amber-3").getByTestId("focus-hero").click();
  expect(await shown(a, "Amber-3")).toEqual(before);
  await a.keyboard.press("Escape");
  await a.getByTestId("all-builds").click();
  await expect(builds(a)).toHaveCount(12);
  // And after a reload, from the server's copy.
  await b.reload();
  await b.getByTestId("scene-card").nth(2).click();
  await b.getByTestId("all-builds").click();
  await expect(builds(b)).toHaveCount(12);
});
