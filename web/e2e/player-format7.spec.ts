// Timeline format 7 (builds, abilities, casts, CC, effects, recaps, height, zipline rides) was
// stored, not shown (operator, 2026-11-09): a format-7 timeline loads in Player and draws exactly
// what the same timeline without those fields draws, on two boards, at the same moments. Shown
// on purpose since: the death's recap in the events list (d13abf4). CC and elevation stay behind
// their default-off layers.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, revealControls } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000079";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-format7-"));
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

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const NO_HERO = 255;

/** A minute of match; Amber 1 dies at 20 (back at 30). `extras`: format 7's fields too. */
function timeline(extras: boolean) {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const a1 = team === "amber" && slot === 1;
        const dead = (s: number) => a1 && s >= 20 && s < 30;
        const at = { x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 };
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : at.x + s * 20)),
          y: range((s) => (dead(s) ? null : at.y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: a1 ? [20] : [],
          respawn: a1 ? [[20, 30]] : [],
          souls: [[0, 500]], ult: range(() => 0),
          ...(extras && {
            items: [[50, 715_762_406, 0], [120, 1_009_965_641, 0], [300, 715_762_406, 2], [300, 3_000_000_001, 0], [500, 1_009_965_641, 1]],
            abilities: [[0, 2_521_902_222, 1], [40, 2_521_902_222, 2]],
            casts: [[100, 2_521_902_222, 220], [250, 1_000_000_007, 0]],
            charges: [[100, 2_521_902_222, 1], [220, 2_521_902_222, 2]],
            cc: [[190, 200, 20, 7, 3_400_000_011]],
            effects: [[0, 600, 4_000_000_013, NO_HERO, 0, 3], [150, 190, 1_398_909_042, 7, 3_400_000_011, 1]],
            recaps: a1 ? [{ t: 200, damage: [[7, 3_400_000_011, 640], [NO_HERO, 0, 120]], cc: [[190, 200, 20, 7, 3_400_000_011]] }] : [],
            height: [[10, 1], [14, 0], [40, 2]],
            zipline: [[2, 9], [45, 50]],
          }),
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    events: [{ t: 20, kind: "death", team: "amber", slot: 1, hero_id: 2, x: -2500, y: -3000 }],
  };
}

/** The jobs already answered: the other board's demo can still be in the inbox. */
const answered = new Set<string>();

/** The death's recap row (640 + 120 damage), in the events list at every moment. */
const RECAP = "Death recap · 760 damage";

async function open(p: Page, extras: boolean) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
  answered.add(job);
  writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(extras)));
  await expect(p.getByTestId("match-tier")).toHaveText("Full replay");
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
  await expect(p.getByTestId("match-clock")).toContainText(`0:${String(t).padStart(2, "0")} /`);
}

/** What Player draws at t: the map's markup and the page's text. */
async function drawn(p: Page, t: number) {
  await scrubTo(p, t);
  await p.mouse.move(2, 2);
  // Each board has its own record ids, which also order the tokens: those aside, the markup.
  const map = await p.getByTestId("map").evaluate((el) => {
    const c = el.cloneNode(true) as Element;
    const toks = [...c.querySelectorAll(".tok")].map((t) => {
      t.remove();
      t.removeAttribute("data-player");
      return t.outerHTML.replace(/ data-player="[^"]*"/g, "");
    });
    return [c.innerHTML.replace(/ data-player="[^"]*"/g, ""), ...toks.sort()].join("\n");
  });
  // All the page says, top bar and side panel included, as lines: rosters are in record order.
  const text = (await p.locator("body").innerText()).split("\n").sort().join("\n");
  return { map, side: text };
}

test("a format-7 timeline draws exactly what one without its new fields does", async ({ browser }) => {
  const seven = await joinNew(browser, await newBoardUrl(server, "Format"), "Coach");
  await open(seven, true);
  const six = await joinNew(browser, await newBoardUrl(server, "Format"), "Coach");
  await open(six, false);
  // "Full replay" above means the server's checks took the format-7 fields (it refuses an
  // out-of-shape timeline and the job fails).
  for (const t of [5, 12, 19, 21, 42, 55]) {
    const [a, b] = [await drawn(seven, t), await drawn(six, t)];
    // The page says what the plain one says, and the recap besides.
    const lines = a.side.split("\n");
    expect(lines, `the recap at ${t} s`).toContain(RECAP);
    lines.splice(lines.indexOf(RECAP), 1);
    expect(lines.join("\n"), `the page's text at ${t} s`).toBe(b.side);
    const at = [...a.map].findIndex((c, i) => c !== b.map[i]);
    expect(at < 0 && a.map.length === b.map.length, `the map at ${t} s: ${a.map.slice(at - 120, at + 120)} | ${b.map.slice(at - 120, at + 120)}`).toBe(true);
  }
});
