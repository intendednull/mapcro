// The DOM of the map and the top bar, pinned before map-state phase 2 changes how they are
// drawn (docs/specs/map-state.md §9): scenes made before a snapshot existed must look as they
// did, and so must Player.
// - Two old scenes from a board file: one in the oldest record shapes, and one as Save as scene
//   wrote it before it stored anything more (a source, a clock, souls, ults, the dead and the
//   unseen, objectives down, a lane split).
// - Player on a synthetic replay, paused at a frame.
// The pins are text files beside this spec, an element a line. A change that means to move one
// rewrites it with `--update-snapshots`, and says so. No names, ids or game art are in them.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000149";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-pins-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

type Rec = [string, Record<string, Record<string, unknown>>];
const hex = (n: number) => n.toString(16).padStart(32, "0");

/** The server's oldest-shapes fixture, with heroes on the roster and a second scene as the old
 * Save as scene wrote one. */
function boardFile() {
  const f = JSON.parse(readFileSync(join(ROOT, "crates/server/tests/fixtures/board-file-v1-oldest-records.mapcro.json")).toString()) as { records: Rec[] };
  const slots = f.records.filter((r) => r[1].RosterSlot);
  slots.forEach((r, i) => (r[1].RosterSlot!.hero = 1 + (i % 6)));
  const scene = hex(0xaaa);
  f.records.push([scene, { Scene: { name: "Match moment", order: "s", clock: 754, source: { match_id: Number(ID), t: 754, tier: "replay" } } }]);
  slots.forEach((r, i) => {
    const state = { scene, slot: r[0], pos: { x: -4000 + i * 700, y: i < 6 ? -2500 : 2500 }, alive: i !== 2 && i !== 9, placed: i !== 5, souls: 3000 + 450 * i, ult_cooldown: i % 4 === 0 ? 0 : 20 * (i % 5), visible: i !== 7 };
    f.records.push([hex(0xb00 + i), { PlayerState: state }]);
  });
  f.records.push([hex(0xc00), { ObjectiveState: { scene, key: "guardian:amber:lane1:1", status: "Destroyed" } }]);
  f.records.push([hex(0xc01), { ObjectiveState: { scene, key: "guardian:sapphire:lane4:1", status: "Destroyed" } }]);
  f.records.push([hex(0xc02), { Wave: { scene, lane: "lane1", t: 620 } }]);
  f.records.push([hex(0xc03), { Wave: { scene, lane: "lane4", t: 380 } }]);
  return f;
}

async function seed(file: unknown): Promise<string> {
  const r = await fetch(`${server.url}/api/boards/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(file) });
  expect(r.status).toBe(201);
  const { board, owner_token } = (await r.json()) as { board: string; owner_token: string };
  return `${server.url}/b/${board}#${owner_token}`;
}

/**
 * An element as text, a line each, attributes in name order. Left out: what differs from run to
 * run and isn't what the pin is for (a person's own colour, the order of the hero tokens).
 * Record ids minted in the page become `#n` in the order met; an inline image becomes its length.
 */
async function outline(p: Page, testid: string): Promise<string> {
  // Nothing hovered, and every transition done.
  await p.mouse.move(2, 2);
  await p.waitForTimeout(700);
  return p.getByTestId(testid).first().evaluate((root) => {
    const ids = new Map<string, string>();
    const tidy = (v: string) =>
      v
        .replace(/data:[a-z/+-]+[;,][^"')\s]*/g, (m) => `data:(${m.length})`)
        // This person's own colour, drawn at random when they join.
        .replace(/--me: #[0-9a-f]{6};\s*/g, "")
        .replace(/\b[0-9a-f]{32}\b/g, (m) => ids.get(m) ?? (ids.set(m, `#${ids.size + 1}`), ids.get(m)!))
        .replace(/-?\d+\.\d{2,}/g, (m) => String(Math.round(Number(m) * 10) / 10));
    const lines: string[] = [];
    const walk = (el: Element, depth: number) => {
      const attrs = [...el.attributes]
        .filter((a) => !["data-view", "data-tip-id"].includes(a.name))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((a) => ` ${a.name}="${tidy(a.value)}"`)
        .join("");
      const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).filter(Boolean).join(" ");
      lines.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs}>${text ? ` ${tidy(text)}` : ""}`);
      // What is drawn per hero record comes in record-id order, and a board's ids are minted at
      // random when it is imported: in a fixed order here, so the pin holds each and not their order.
      const kids = [...el.children];
      // The element that names its hero record: `c`, or the one child of a bare wrapper.
      const hero = (c: Element) => (c.hasAttribute("data-player") ? c : c.attributes.length === 0 && c.children.length === 1 && c.children[0]!.hasAttribute("data-player") ? c.children[0]! : undefined);
      // A token by its slot; what hangs off one elsewhere (a respawn badge) by where it is.
      const place = (c: Element) => hero(c)!.getAttribute("data-slot") ?? hero(c)!.getAttribute("transform") ?? "";
      const tokens = kids.filter(hero).sort((a, b) => (place(a) < place(b) ? -1 : 1));
      for (const c of kids) walk(hero(c) ? tokens.shift()! : c, depth + 1);
    };
    walk(root, 0);
    return lines.join("\n") + "\n";
  });
}

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

async function openMatch(p: Page) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

test("scenes from before a snapshot existed draw as they did: the bar and the map", async ({ browser }) => {
  const p = await joinNew(browser, await seed(boardFile()), "Coach");
  const cards = p.getByTestId("scene-card");
  await expect(cards).toHaveCount(2);
  await cards.nth(0).click();
  await expect(p.getByTestId("tb-clock")).toHaveText("0:00");
  expect(await outline(p, "topbar")).toMatchSnapshot("oldest-scene-bar.txt");
  expect(await outline(p, "map")).toMatchSnapshot("oldest-scene-map.txt");
  await cards.nth(1).click();
  await expect(p.getByTestId("tb-clock")).toHaveText("12:34");
  expect(await outline(p, "topbar")).toMatchSnapshot("saved-scene-bar.txt");
  expect(await outline(p, "map")).toMatchSnapshot("saved-scene-map.txt");
});

test("Player draws a frame as it did: the bar and the map", async ({ browser }) => {
  const p = await joinNew(browser, await newBoardUrl(server, "Pins"), "Coach");
  await openMatch(p);
  await p.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "25";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(p.getByTestId("match-clock")).toContainText("0:25 /");
  expect(await outline(p, "topbar")).toMatchSnapshot("player-bar.txt");
  expect(await outline(p, "map")).toMatchSnapshot("player-map.txt");
  // One build open, then all: the column's DOM.
  await p.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').click();
  await expect(p.getByTestId("hero-build")).toHaveCount(1);
  expect(await outline(p, "topbar")).toMatchSnapshot("player-bar-build.txt");
  await p.keyboard.press("Escape");
  await p.locator(".tb-all-builds").click();
  await expect(p.getByTestId("hero-build")).toHaveCount(12);
  expect(await outline(p, "topbar")).toMatchSnapshot("player-bar-all-builds.txt");
});
