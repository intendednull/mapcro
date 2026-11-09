// Health on the replay tier (operator, 2026-11-08): the HUD's slanted bar beside each top-bar portrait, an
// arc on each hero token, each objective's icon filled from the bottom up to its health (the
// patron's shield in stage 1, its core in stage 2), all following the timeline; a Health
// toggle; none on the API summary. A synthetic timeline the
// test hands the server as the worker would.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl, TIMELINE_FORMAT } from "./server";

const ID = "129000001";
const N = 120;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-health-"));
let upstream: ReturnType<typeof createServer>;

/**
 * A pack with only the top bar's hero art (1×1 PNGs): each hero's vertical portrait and critical
 * card, hero cards for heroes 1–3 only (4–6 fall back to the vertical, as a pack from before the
 * cards does), and the badge mask, so the images draw.
 */
function heroPack(): string {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const root = mkdtempSync(join(tmpdir(), "mapcro-e2e-health-pack-"));
  const dir = join(root, "heroes-only");
  mkdirSync(join(dir, "topbar/heroes"), { recursive: true });
  const blobs: Record<string, unknown> = {};
  const blob = (key: string) => {
    writeFileSync(join(dir, `${key}.png`), png);
    blobs[key] = { sha256: createHash("sha256").update(png).digest("hex"), w: 1, h: 1, mime: "image/png", file: `${key}.png` };
  };
  blob("topbar/hero_image_mask_psd");
  const heroes = [1, 2, 3, 4, 5, 6].map((id) => {
    const card = id <= 3;
    for (const key of [`topbar/heroes/${id}`, `topbar/heroes/${id}_critical`, ...(card ? [`topbar/heroes/${id}_card`] : [])]) blob(key);
    return { hero_id: id, class_name: `hero_${id}`, name: `Hero ${id}`, disabled: false, minimap_blob: null, topbar_blob: `topbar/heroes/${id}`, card_blob: card ? `topbar/heroes/${id}_card` : null, critical_blob: `topbar/heroes/${id}_critical` };
  });
  writeFileSync(join(dir, "pack.json"), JSON.stringify({ schema: 3, game: { client_version: 1, source_revision: 1, date: "Nov 08 2026" }, blobs, heroes }));
  return root;
}
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(heroPack(), { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** Amber's first hero (a hero card) loses health from 100 to 20 over the match and dies at 100 s;
 *  its fourth (no card) loses it the same way and lives. */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6813, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const tracked = team === "amber" && (slot === 0 || slot === 3);
        const alive = (s: number) => !(team === "amber" && slot === 0) || s < 100;
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (alive(s) ? slot * 600 - 1500 : null)),
          y: range((s) => (alive(s) ? (team === "amber" ? -3000 : 3000) : null)),
          health: range((s) => (!alive(s) ? 0 : tracked ? Math.max(20, 100 - s) : 100)),
          deaths: team === "amber" && slot === 0 ? [100] : [], respawn: team === "amber" && slot === 0 ? [[100, 130]] : [], souls: [[0, 500]], ult: range(() => 0),
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], waves: [], events: [],
    objective_health: [
      { key: "walker:amber:lane1:1", at: [[0, 100], [20, 60], [40, 25]] },
      { key: "patron:sapphire:lane0:1", at: [[0, 100], [30, 50], [50, 100], [60, 40]], stage: [[0, 1], [50, 2]] },
    ],
  };
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
/** Open the match in Player and upload its "replay"; the test plays the worker and writes the
 * timeline, as the server expects. */
async function openReplay(a: Page) {
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await a.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  // The same file again is already parsed (the server says so): then there's no job to answer.
  let job = "";
  await expect
    .poll(async () => {
      job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "";
      return job !== "" || (await a.getByTestId("match-tier").textContent()) === "Full replay";
    })
    .toBe(true);
  if (job) writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline()));
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
}

const bar = (p: Page) => p.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-health]');
const mk = (p: Page, key: string) => p.locator(`.mk[data-key="${key}"]`);
/**
 * How much of an objective's icon is filled, in percent of its shape: the part of its fill
 * layer's shape (`data-span`, the shape's top and bottom in its box) the clip leaves showing.
 */
const fill = (p: Page, key: string, layer = "hp-fill") =>
  mk(p, key).locator(`i.${layer}`).first().evaluate((el) => {
    const [top, bottom] = (el.getAttribute("data-span") ?? "0 1").split(" ").map(Number) as [number, number];
    const m = /^inset\((.*)\)$/.exec(getComputedStyle(el).clipPath);
    if (!m) return 100;
    const v = m[1]!.split(" ").map((x) => parseFloat(x) / 100);
    const [cutTop, cutBottom] = [v[0]!, v[2] ?? v[0]!];
    // Clipped from the top (filling up), or from the bottom for a layer drawn rotated.
    const lit = cutTop > 0 ? bottom - Math.max(top, cutTop) : Math.min(bottom, 1 - cutBottom) - top;
    return Math.round((Math.max(0, lit) / (bottom - top)) * 100);
  });
/** The bar's fill: its height over the bar's, bottom-aligned (the HUD's #HealthBar_Fill). Layout
 *  boxes, before the bar's slant. */
const barFill = (p: Page) =>
  bar(p).evaluate((el) => {
    const f = el.querySelector(".tb-health-fill") as HTMLElement;
    const b = el as HTMLElement;
    return Math.abs(f.offsetTop + f.offsetHeight - b.clientHeight) < 1.5 ? f.offsetHeight / b.clientHeight : -1;
  });

test("health bars, token arcs and objective fills follow the replay; Health turns them off", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Health"), "Coach");
  await openReplay(a);

  // Two times: the bar's fill and the token's arc follow the data.
  await scrubTo(a, 10);
  await expect(bar(a)).toHaveAttribute("data-health", "90");
  await expect.poll(() => barFill(a)).toBeCloseTo(0.9, 1);
  await expect(a.locator('.tok[data-slot="Amber-0"] [data-testid=tok-health]')).toHaveAttribute("data-health", "90");
  // Undamaged objectives are full.
  await expect(mk(a, "walker:amber:lane1:1")).toHaveAttribute("data-health", "100");
  await expect.poll(() => fill(a, "walker:amber:lane1:1")).toBe(100);
  await scrubTo(a, 45);
  await expect(bar(a)).toHaveAttribute("data-health", "55");
  await expect.poll(() => barFill(a)).toBeCloseTo(0.55, 1);
  // The walker's icon is a quarter full; the patron's shield (stage 1) half.
  await expect(mk(a, "walker:amber:lane1:1")).toHaveAttribute("data-health", "25");
  await expect.poll(() => fill(a, "walker:amber:lane1:1")).toBeCloseTo(25, 0);
  await expect(mk(a, "patron:sapphire:lane0:1")).not.toHaveClass(/\bstage2\b/);
  await expect.poll(() => fill(a, "patron:sapphire:lane0:1")).toBeCloseTo(50, 0);
  await expect.poll(() => fill(a, "patron:sapphire:lane0:1", "hp-core")).toBe(100);
  await a.screenshot({ path: "shots/health-synthetic.png" });
  await scrubTo(a, 65);
  // Stage 2: the shield is gone and the core fills to the health.
  await expect(mk(a, "patron:sapphire:lane0:1")).toHaveClass(/\bstage2\b/);
  await expect.poll(() => fill(a, "patron:sapphire:lane0:1", "hp-core")).toBeCloseTo(40, 0);
  // The hero badge (hero_badge.vcss): with the pack's hero card, the card in a 70.4 × 95.5 frame
  // on a team-coloured disc (team1Color #D4860B, team2Color #4D75C3) at the frame's bottom.
  // Without one (hero 4 here, as on a pack from before the cards), the vertical bust on the
  // grey disc, as before.
  const amber0 = a.locator('.tb-player[data-slot="Amber-0"]');
  const amber3 = a.locator('.tb-player[data-slot="Amber-3"]');
  const art = () => amber0.locator(".tb-img");
  const art3 = () => amber3.locator(".tb-img");
  const box = async (l: ReturnType<typeof art>): Promise<[number, number, number, number]> => {
    const b = (await l.boundingBox())!;
    const r = (v: number) => Math.round(v * 10) / 10;
    return [r(b.x), r(b.y), r(b.width), r(b.height)];
  };
  const discColor = (l: typeof amber0) => l.locator(".tb-disc").evaluate((el) => getComputedStyle(el).backgroundColor);
  await scrubTo(a, 45);
  await expect(art()).toHaveAttribute("data-art", "card");
  await expect(art()).toHaveAttribute("style", /topbar\/heroes\/1_card\.png/);
  await expect(amber0).toHaveClass(/\bcard-art\b/);
  await expect(art3()).toHaveAttribute("data-art", "topbar");
  await expect(art3()).toHaveAttribute("style", /topbar\/heroes\/4\.png/);
  await expect(amber3).not.toHaveClass(/\bcard-art\b/);
  expect(await discColor(amber0)).toBe("rgb(212, 134, 11)");
  expect(await discColor(a.locator('.tb-player[data-slot="Sapphire-0"]'))).toBe("rgb(77, 117, 195)");
  expect(await discColor(amber3)).not.toBe("rgb(212, 134, 11)");
  // The card covers the disc's initials; none show through its transparent edges.
  expect(await amber0.locator(".tb-disc").evaluate((el) => getComputedStyle(el).color)).toBe("rgba(0, 0, 0, 0)");
  const [, cardTop, cardW, cardH] = await box(art());
  const [, discTop, discW] = await box(amber0.locator(".tb-disc"));
  expect(cardH / cardW).toBeCloseTo(380 / 280, 1); // the card's own aspect
  expect(discW).toBeCloseTo(cardW, 0); // .HeroImageBackground: the frame's width,
  expect(discTop + discW).toBeCloseTo(cardTop + cardH, 0); // at its bottom
  const cardBox = await box(art());
  const bustBox = await box(art3());

  // Low health (the HUD's .healthLow, at or under 30%): the portrait becomes the hero's critical
  // card and says Critical; not above it, and not once dead. No tint, pulse or glow (operator).
  // With a hero card the critical card takes the same frame, so the swap moves nothing.
  await expect(amber0).not.toHaveClass(/\bhealth-low\b/);
  await expect(amber0.getByTestId("tb-critical")).toHaveCount(0);
  await scrubTo(a, 69);
  await expect(bar(a)).toHaveAttribute("data-health", "31");
  await expect(amber0).not.toHaveClass(/\bhealth-low\b/);
  await expect(art()).toHaveAttribute("data-art", "card");
  await scrubTo(a, 75);
  await expect(bar(a)).toHaveAttribute("data-health", "25");
  await expect(amber0).toHaveClass(/\bhealth-low\b/);
  await expect(art()).toHaveAttribute("data-art", "critical");
  await expect(art()).toHaveAttribute("style", /topbar\/heroes\/1_critical\.png/);
  expect(await box(art())).toEqual(cardBox);
  await expect(amber0.getByTestId("tb-critical")).toBeVisible();
  // Without a card the critical card still swaps in, in its own frame over the bust's disc.
  await expect(amber3).toHaveClass(/\bhealth-low\b/);
  await expect(art3()).toHaveAttribute("data-art", "critical");
  await expect(art3()).toHaveAttribute("style", /topbar\/heroes\/4_critical\.png/);
  expect(await box(art3())).not.toEqual(bustBox);
  await expect(a.locator(".tb-player.health-low")).toHaveCount(2);
  await expect(a.locator('.tb-img[data-art="critical"]')).toHaveCount(2);
  const disc = await amber0.locator(".tb-disc").evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).boxShadow]);
  expect(disc).toEqual(["none", "none"]);
  // Reduced motion: the Critical tag stops its wobble; the state stays.
  await a.emulateMedia({ reducedMotion: "reduce" });
  expect(await amber0.getByTestId("tb-critical").locator("span").evaluate((el) => getComputedStyle(el).animationName)).toBe("none");
  await expect(art()).toHaveAttribute("data-art", "critical");
  await a.emulateMedia({ reducedMotion: "no-preference" });
  // Health off: the usual portrait.
  await a.getByTestId("health-toggle").click();
  await expect(amber0).not.toHaveClass(/\bhealth-low\b/);
  await expect(art()).toHaveAttribute("data-art", "card");
  await expect(art3()).toHaveAttribute("data-art", "topbar");
  await expect(amber0.getByTestId("tb-critical")).toHaveCount(0);
  await a.getByTestId("health-toggle").click();
  await expect(art()).toHaveAttribute("data-art", "critical");

  // Dead: no bar (.Dead #HealthBar collapses); the respawn countdown stays, over the disc; the
  // card is greyed and darkened (.Dead #HeroImage: saturation 0, brightness 0.2) on an offBlack
  // disc; the others keep theirs.
  await scrubTo(a, 110);
  await expect(a.locator('.tb-player[data-slot="Amber-0"]')).toHaveAttribute("data-alive", "false");
  await expect(bar(a)).toHaveCount(0);
  await expect(amber0).not.toHaveClass(/\bhealth-low\b/);
  await expect(art()).toHaveAttribute("data-art", "card");
  expect(await art().evaluate((el) => getComputedStyle(el).filter)).toBe("grayscale(1) brightness(0.2)");
  expect(await discColor(amber0)).toBe("rgba(16, 19, 13, 0.933)");
  await expect(amber0.getByTestId("tb-respawn")).toHaveAttribute("data-respawn", "20");
  expect(await box(amber0.getByTestId("tb-respawn"))).toEqual(await box(amber0.locator(".tb-disc")));
  await expect(a.locator('.tb-player[data-slot="Amber-1"] [data-testid=tb-health]')).toHaveAttribute("data-health", "100");

  await scrubTo(a, 45);
  await a.getByTestId("health-toggle").click();
  await expect(bar(a)).toHaveCount(0);
  await expect(a.locator("[data-testid=tok-health]")).toHaveCount(0);
  await expect(a.locator(".mk[data-health]")).toHaveCount(0);
  await expect.poll(() => fill(a, "walker:amber:lane1:1")).toBe(100);
});


/** Scrub to `t` and, a frame later, list the transitions running on the bar's fill, the token's
 * arc and an objective's fill clip: the property, its easing and its duration. Read in the page,
 * from the animations themselves, so a slow frame can't make it pass or fail. */
async function scrubAndEases(p: Page, t: number, key: string) {
  return p.evaluate(
    ({ t, key }) =>
      new Promise<Record<string, string[]>>((done) => {
        const el = document.querySelector("[data-testid=match-time]") as HTMLInputElement;
        el.value = String(t);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        requestAnimationFrame(() => {
          const of = (sel: string) =>
            (document.querySelector(sel)?.getAnimations() ?? [])
              .filter((x): x is CSSTransition => x instanceof CSSTransition)
              .map((x) => `${x.transitionProperty} ${(x.effect as KeyframeEffect).getTiming().easing} ${(x.effect as KeyframeEffect).getTiming().duration}`);
          done({
            bar: of('.tb-player[data-slot="Amber-0"] .tb-health-fill'),
            arc: of('.tok[data-slot="Amber-0"] .tok-hp-fill'),
            // Without the pack's fill art (as here) the marker's --hp eases its gradient; with it,
            // the art's clip (minimap.css) eases the same way.
            objective: of(`.mk[data-key="${key}"]`),
          });
        });
      }),
    { t, key },
  );
}

test("health eases to each new value (easeOutExpo), and jumps with reduced motion", async ({ browser }) => {
  const WALKER = "walker:amber:lane1:1";
  for (const reduced of [false, true]) {
    const a = await joinNew(browser, await newBoardUrl(server, `Ease ${reduced}`), "Coach");
    await a.emulateMedia({ reducedMotion: reduced ? "reduce" : "no-preference" });
    await openReplay(a);
    await scrubTo(a, 10);
    await expect.poll(() => barFill(a)).toBeCloseTo(0.9, 1);
    await expect.poll(() => fill(a, WALKER)).toBe(100);
    // Let every ease from loading settle, so the next one runs its full course (a reversed,
    // unfinished transition is shortened).
    await expect
      .poll(() =>
        a.evaluate(
          (key) =>
            [".tb-health-fill", ".tok-hp-fill", `.mk[data-key="${key}"]`]
              .flatMap((sel) => [...document.querySelectorAll(sel)])
              .reduce((n, el) => n + el.getAnimations().length, 0),
          WALKER,
        ),
      )
      .toBe(0);
    // 10 s → 45 s: the bar 90 → 55, the arc 90 → 55, the walker 100 → 25. Each eases, out-expo
    // over 350 ms (easings.net/#easeOutExpo), or with reduced motion jumps.
    const eases = await scrubAndEases(a, 45, WALKER);
    const EXPO = "cubic-bezier(0.16, 1, 0.3, 1) 350";
    expect(eases).toEqual(
      reduced
        ? { bar: [], arc: [], objective: [] }
        : { bar: [`height ${EXPO}`], arc: [`stroke-dasharray ${EXPO}`], objective: [`--hp ${EXPO}`] },
    );
    // And each lands on the new value.
    await expect.poll(() => barFill(a)).toBeCloseTo(0.55, 1);
    await expect.poll(() => a.locator('.tok[data-slot="Amber-0"] .tok-hp-fill').evaluate((el) => parseFloat(getComputedStyle(el).strokeDasharray))).toBeCloseTo(55, 0);
    await expect.poll(() => fill(a, WALKER)).toBeCloseTo(25, 0);
  }
});
