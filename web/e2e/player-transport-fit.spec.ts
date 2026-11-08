// Every transport control fits in the bar and nothing covers it (QA 2026-11-08: at 1280×768 the
// clock read "11:" and Save scene sat under the right panel; at 1440×900 the row ran 8 px over
// with "Pause" or at 2× and up). At three desktop sizes, paused, playing at 8×, and viewing a
// scene; a replay-tier match (every toggle) of 44 minutes (the widest clock).

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { Server, newBoardUrl } from "./server";

const ID = "129000011";
const N = 2640;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-fit-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const ev = (t: number) => ({ t, kind: "death", team: "amber", slot: t % 6, hero_id: 1 + (t % 6), by: null, key: null, x: 0, y: 0, amount: null, ability: null });
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => ({ team, slot, hero_id: 1 + slot, name: null, x: range(() => slot * 300), y: range(() => (team === "amber" ? -8000 : 8000)), health: range(() => 100), deaths: [], souls: [[0, 500]], ult: range(() => 0) })),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [],
    events: [60, 300, 900, 1500, 2400].map(ev),
    troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
  };
}

/** Each control in the bar that isn't inside its box, or whose centre something else covers. */
const misfits = (p: Page) =>
  p.getByTestId("player").evaluate((bar) => {
    const b = bar.getBoundingClientRect();
    const out: string[] = [];
    const controls = [...bar.querySelectorAll<HTMLElement>("button:not(.pl-mark), select, input:not([type=file]), .match-clock, .match-tier, .pl-scene-label")].filter((el) => el.offsetParent !== null && el.getClientRects().length);
    for (const el of controls) {
      const r = el.getBoundingClientRect();
      const name = el.dataset.testid ?? el.className;
      if (r.left < b.left - 0.5 || r.right > b.right + 0.5 || r.top < b.top - 0.5 || r.bottom > b.bottom + 0.5) out.push(`${name} outside the bar`);
      if (r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5) out.push(`${name} off screen`);
      // Clipped text: a control narrower than its content.
      if (el.scrollWidth > el.clientWidth + 1 && el.tagName !== "SELECT" && el.tagName !== "INPUT") out.push(`${name} clipped (${el.scrollWidth} > ${el.clientWidth})`);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || !(el === hit || el.contains(hit))) out.push(`${name} covered by ${hit?.className || hit?.tagName}`);
    }
    // The scrubber's scene marks overlap nothing but the scrubber (QA: they sat on the tier chip).
    for (const m of bar.querySelectorAll<HTMLElement>(".pl-mark")) {
      const r = m.getBoundingClientRect();
      for (const el of controls) {
        if (el.dataset.testid === "match-time") continue;
        const o = el.getBoundingClientRect();
        if (r.left < o.right && o.left < r.right && r.top < o.bottom && o.top < r.bottom) out.push(`a scene mark overlaps ${el.dataset.testid ?? el.className}`);
      }
    }
    return { out, n: controls.length };
  });

for (const [w, h] of [[1280, 768], [1440, 900], [1920, 1080]] as const) {
  test(`at ${w}×${h} every transport control fits, paused, at 8× playing, and on a scene`, async ({ browser }) => {
    const a = await (await browser.newContext({ viewport: { width: w, height: h } })).newPage();
    await a.goto(await newBoardUrl(server, "Transport"));
    await a.locator("#join-name").fill("Coach");
    await a.keyboard.press("Enter");
    await expect(a.getByTestId("join-card")).toBeHidden();
    await a.getByTestId("mode-player").click();
    await a.getByTestId("match-id").fill(ID);
    await a.getByTestId("match-load").click();
    await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
    let job = "";
    await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
    writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
    await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
    await expect(a.getByTestId("troopers-toggle")).toBeVisible();
    await expect(a.getByTestId("match-clock")).toHaveText("10:00 / 44:00");

    const check = async (state: string) => {
      const { out, n } = await misfits(a);
      expect(n, state).toBeGreaterThan(state === "scene" ? 2 : 12);
      expect(out, `${w}×${h} ${state}`).toEqual([]);
      await a.screenshot({ path: `shots/transport-${state}-${w}x${h}.png` });
    };
    await check("paused");
    await a.getByTestId("match-speed").selectOption("8");
    await a.getByTestId("match-play").click();
    await expect(a.getByTestId("match-play")).toHaveText("Pause");
    await check("playing-8x");
    await a.getByTestId("match-play").click();
    // Scenes saved early in the match put their marks under the head row's tier chip.
    for (const t of [60, 300, 540]) {
      await a.getByTestId("match-time").evaluate((el, t) => {
        (el as HTMLInputElement).value = String(t);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, t);
      await a.getByTestId("match-save").click();
    }
    await expect(a.getByTestId("scene-mark")).toHaveCount(3);
    await check("marks");
    await a.getByTestId("scene-mark").first().click();
    await expect(a.getByTestId("player")).toHaveAttribute("data-state", "scene");
    await check("scene");
  });
}
