// Vision in Player (spec §6b): on a synthetic replay timeline handed to the server as the worker
// would, "Vision: Hidden King" / "Archmother" draws the map as that team saw it. Its own heroes
// always show; an enemy out of its sight isn't drawn, or, with "Show last seen location", is a
// ghost at the spot it was last seen, labelled with how long ago; one it hasn't seen (yet, or
// since it died) isn't drawn either way. "All" is the map as before. Both choices are this
// browser's (a reload keeps them); a follower sees its presenter's while following.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { ROOT, Server, TIMELINE_FORMAT, newBoardUrl, translate } from "./server";

const ID = "129000044";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-vision-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  upstream = createServer((_req, res) => {
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  // Every test opens the match by upload: more than the server's 6 an hour for one client.
  server = new Server(undefined, { MATCH_API_BASE: `http://127.0.0.1:${port}`, REPLAY_DIR: queue, REPLAY_PER_CLIENT_PER_HOUR: "20" });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));
const DROP = { x: -2000, y: 1500 };
const stand = (team: string, slot: number) => ({ x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 });

/**
 * - Sapphire 0 walks east 100 units a second; the King's team sees it 10–20 s, and 45–50 s.
 * - Amber 1 is seen by the Archmother's team 0–30 s, dies at 35 and is back at 40, unseen since.
 * - Amber 0 is seen by the Archmother's team all match; every other hero by nobody.
 * - The urn: Sapphire 0 carries it 10–30 s, Sapphire 1 (never seen) 30–40 s; it's dropped at
 *   40 and lies there.
 */
function timeline() {
  return {
    match_id: Number(ID), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const walker = team === "sapphire" && slot === 0;
        const victim = team === "amber" && slot === 1;
        const dead = (s: number) => victim && s >= 35 && s < 40;
        const at = (s: number) => (walker ? { x: -4000 + 100 * s, y: 0 } : stand(team, slot));
        return {
          team, slot, hero_id: 1 + slot, name: null,
          x: range((s) => (dead(s) ? null : at(s).x)),
          y: range((s) => (dead(s) ? null : at(s).y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: victim ? [35] : [],
          respawn: victim ? [[35, 40]] : [],
          souls: [[0, 500]], ult: range(() => 0),
          seen: walker ? [[100, 200], [450, 500]] : victim ? [[0, 300]] : team === "amber" && slot === 0 ? [[0, N * 10]] : [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [], events: [],
    urn: {
      spawns: [],
      at: [
        { t: 10, state: "carried", team: "sapphire", slot: 0 },
        { t: 30, state: "carried", team: "sapphire", slot: 1 },
        { t: 40, state: "ground", x: DROP.x, y: DROP.y, team: "sapphire" },
      ],
    },
  };
}

async function open(p: Page) {
  await p.getByTestId("mode-player").click();
  await p.getByTestId("match-id").fill(ID);
  await p.getByTestId("match-load").click();
  await p.getByTestId("match-file").setInputFiles({ name: `${ID}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
  let job = "";
  await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${ID}-`) && f.endsWith(".dem")) ?? "")).not.toBe("");
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
const tok = (p: Page, slot: string) => p.locator(`[data-testid=map] .tok[data-slot="${slot}"]`);
const at = async (p: Page, slot: string) => translate(await tok(p, slot).getAttribute("transform"));
/** Every drawn token: its slot and whether it's a ghost. */
const drawn = (p: Page) =>
  p.locator("[data-testid=map] .tok[data-slot]").evaluateAll((els) => Object.fromEntries(els.map((el) => [el.getAttribute("data-slot"), el.getAttribute("data-seen") === "false" ? "ghost" : "shown"])));
const everyone = (state: string) => Object.fromEntries(["Amber", "Sapphire"].flatMap((t) => [0, 1, 2, 3, 4, 5].map((s) => [`${t}-${s}`, state])));

test("each team's view shows its own heroes and the enemies in its sight; Show last seen location ghosts the ones it lost", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision"), "Coach");
  await open(a);
  await a.emulateMedia({ reducedMotion: "reduce" });
  const pick = a.getByTestId("vision-select");
  await expect(pick).toHaveValue("all");
  await expect(pick.locator("option")).toHaveText(["Vision: All", "Vision: Hidden King", "Vision: Archmother"]);

  // All: every living hero, none a ghost, where the match has it, as before.
  const all: Record<number, Record<string, { x: number; y: number }>> = {};
  for (const t of [5, 15, 20, 30, 42]) {
    await scrubTo(a, t);
    expect(await drawn(a)).toEqual(everyone("shown"));
    all[t] = { s0: await at(a, "Sapphire-0"), a0: await at(a, "Amber-0"), a2: await at(a, "Amber-2") };
  }
  await expect(tok(a, "Sapphire-0")).not.toHaveAttribute("aria-label", /Seen/);
  // Last seen means nothing in All: not offered.
  const lastSeen = a.getByTestId("last-seen-toggle");
  await expect(lastSeen).toHaveCount(0);

  // The King's view.
  await pick.selectOption("amber");
  await expect(lastSeen).toHaveAttribute("aria-pressed", "false");
  const kingOwn = { "Amber-0": "shown", "Amber-1": "shown", "Amber-2": "shown", "Amber-3": "shown", "Amber-4": "shown", "Amber-5": "shown" };
  await scrubTo(a, 5);
  expect(await drawn(a)).toEqual(kingOwn);
  await scrubTo(a, 15);
  expect(await drawn(a)).toEqual({ ...kingOwn, "Sapphire-0": "shown" });
  expect(await at(a, "Sapphire-0")).toEqual(all[15]!.s0);
  // Out of sight at 20: not drawn, by default.
  await scrubTo(a, 30);
  expect(await drawn(a)).toEqual(kingOwn);
  // Show last seen location: a ghost at its spot then, while it really walks on.
  await lastSeen.click();
  await expect(lastSeen).toHaveAttribute("aria-pressed", "true");
  expect(await drawn(a)).toEqual({ ...kingOwn, "Sapphire-0": "ghost" });
  expect(await at(a, "Sapphire-0")).toEqual(all[20]!.s0);
  const [p30, p20] = [all[30]!.s0!, all[20]!.s0!];
  expect(Math.hypot(p30.x - p20.x, p30.y - p20.y)).toBeGreaterThan(30);
  expect(await at(a, "Amber-2")).toEqual(all[30]!.a2);
  const ghost = tok(a, "Sapphire-0");
  await expect(ghost).toHaveClass(/\bghost\b/);
  await expect(ghost).toHaveAttribute("aria-label", /Seen 0:10 ago$/);
  // Dim and desaturated; its health isn't known out of sight.
  expect(await ghost.evaluate((el) => [getComputedStyle(el).filter, getComputedStyle(el.querySelector(".body")!).opacity])).toEqual(["saturate(0.25)", "0.6"]);
  await expect(ghost.getByTestId("tok-health")).toHaveCount(0);
  await expect(tok(a, "Amber-2").getByTestId("tok-health")).toHaveCount(1);
  const b = (await ghost.locator("circle.body").boundingBox())!;
  await a.mouse.move(b.x + b.width / 2, b.y + 2);
  await expect(a.getByTestId("hover-label")).toHaveText(/Seen 0:10 ago$/);
  await a.mouse.move(5, 5);
  await a.screenshot({ path: "/tmp/vision/synthetic-king-30.png" });

  // The Archmother's view: Amber 0 always seen; Amber 1 a ghost after 30 s, gone once it dies.
  await pick.selectOption("sapphire");
  const archOwn = { "Sapphire-0": "shown", "Sapphire-1": "shown", "Sapphire-2": "shown", "Sapphire-3": "shown", "Sapphire-4": "shown", "Sapphire-5": "shown" };
  await scrubTo(a, 20);
  expect(await drawn(a)).toEqual({ ...archOwn, "Amber-0": "shown", "Amber-1": "shown" });
  expect(await at(a, "Sapphire-0")).toEqual(all[20]!.s0);
  await scrubTo(a, 30);
  expect(await drawn(a)).toEqual({ ...archOwn, "Amber-0": "shown", "Amber-1": "ghost" });
  await expect(tok(a, "Amber-1")).toHaveAttribute("aria-label", /Seen 0:00 ago$/);
  await scrubTo(a, 42);
  expect(await drawn(a)).toEqual({ ...archOwn, "Amber-0": "shown" });
  expect(await at(a, "Amber-0")).toEqual(all[42]!.a0);
  // Off again: the lost one goes.
  await scrubTo(a, 30);
  await lastSeen.click();
  expect(await drawn(a)).toEqual({ ...archOwn, "Amber-0": "shown" });

  // All again: exactly as before.
  await pick.selectOption("all");
  for (const t of [5, 30]) {
    await scrubTo(a, t);
    expect(await drawn(a)).toEqual(everyone("shown"));
    expect(await at(a, "Sapphire-0")).toEqual(all[t]!.s0);
  }
});

test("a ghost eases in and out, and jumps under reduced motion", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision ease"), "Coach");
  await open(a);
  await a.getByTestId("vision-select").selectOption("amber");
  await a.getByTestId("last-seen-toggle").click();
  await scrubTo(a, 15);
  const s0 = tok(a, "Sapphire-0");
  const ease = () => s0.evaluate((el) => [getComputedStyle(el).transitionDuration, getComputedStyle(el.querySelector(".body")!).transitionDuration]);
  expect(await ease()).toEqual(["0.35s", "0.35s"]);
  await a.emulateMedia({ reducedMotion: "reduce" });
  expect(await ease()).toEqual(["0s", "0s"]);
});

test("a follower sees the presenter's view and last seen, live; unfollowing brings its own back, and a reload keeps them", async ({ browser }) => {
  const url = await newBoardUrl(server, "Vision follow");
  const a = await joinNew(browser, url, "Coach");
  await open(a);
  await a.emulateMedia({ reducedMotion: "reduce" });
  const b = await joinNew(browser, url, "Second");
  await b.emulateMedia({ reducedMotion: "reduce" });
  const chip = b.getByTestId("follow-chip");
  await b.getByTestId("follow-Coach").click();
  await expect(chip).toContainText("Following Coach");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  // The follower's own choice, the Archmother's view, is a change to what it sees: following stops.
  await b.getByTestId("vision-select").selectOption("sapphire");
  await expect(b.getByTestId("stop-following")).toHaveCount(0);
  await expect(b.getByTestId("last-seen-toggle")).toHaveAttribute("aria-pressed", "false");

  // Following again: the presenter's All, every hero shown.
  await b.getByTestId("follow-Coach").click();
  await expect(chip).toContainText("Following Coach");
  await expect(b.getByTestId("vision-select")).toHaveValue("all");
  await expect(b.getByTestId("last-seen-toggle")).toHaveCount(0);
  await scrubTo(a, 30);
  await expect(b.getByTestId("match-clock")).toContainText("0:30 /");
  await expect(tok(b, "Sapphire-0")).toHaveAttribute("data-seen", "true");
  await expect(tok(b, "Sapphire-1")).toHaveCount(1);

  // The presenter picks the King's view and last seen: the follower's map follows, live.
  await a.getByTestId("vision-select").selectOption("amber");
  await expect(b.getByTestId("vision-select")).toHaveValue("amber");
  await expect(tok(b, "Sapphire-0")).toHaveCount(0);
  await expect(tok(b, "Sapphire-1")).toHaveCount(0);
  await expect(tok(b, "Amber-1")).toHaveCount(1);
  await a.getByTestId("last-seen-toggle").click();
  await expect(b.getByTestId("last-seen-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(tok(b, "Sapphire-0")).toHaveAttribute("data-seen", "false");
  expect(await drawn(b)).toEqual(await drawn(a));
  await b.mouse.move(5, 5);
  await b.screenshot({ path: join(ROOT, "web/shots/follow-vision-follower.png") });
  await expect(chip).toContainText("Following Coach");

  // Unfollowing: the follower's own view comes back, untouched (the Archmother's, no ghosts).
  await b.getByTestId("stop-following").click();
  await expect(b.getByTestId("stop-following")).toHaveCount(0);
  await expect(b.getByTestId("vision-select")).toHaveValue("sapphire");
  await expect(b.getByTestId("last-seen-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(tok(b, "Amber-0")).toHaveCount(1);
  await expect(tok(b, "Amber-1")).toHaveCount(0);
  await expect(tok(b, "Sapphire-0")).toHaveAttribute("data-seen", "true");
  // The presenter's own is theirs still.
  await expect(tok(a, "Sapphire-0")).toHaveAttribute("data-seen", "false");

  // A follower's change while following keeps what it was seeing plus that change: following
  // the King's view with ghosts, turning ghosts off leaves the King's view without them.
  await b.getByTestId("follow-Coach").click();
  await expect(b.getByTestId("vision-select")).toHaveValue("amber");
  await b.getByTestId("last-seen-toggle").click();
  await expect(b.getByTestId("stop-following")).toHaveCount(0);
  await expect(b.getByTestId("vision-select")).toHaveValue("amber");
  await expect(b.getByTestId("last-seen-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(tok(b, "Sapphire-0")).toHaveCount(0);
  await b.reload();
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(b.getByTestId("vision-select")).toHaveValue("amber");

  await a.reload();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("vision-select")).toHaveValue("amber");
  await expect(a.getByTestId("last-seen-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(tok(a, "Sapphire-1")).toHaveCount(0);
  await expect(tok(a, "Amber-1")).toHaveCount(1);
  await expect(tok(a, "Sapphire-0")).toHaveAttribute("data-seen", "false");
  // Off, and the reload keeps that too: the lost one isn't drawn.
  await a.getByTestId("last-seen-toggle").click();
  await a.reload();
  await expect(a.getByTestId("match-tier")).toHaveText("Full replay");
  await expect(a.getByTestId("last-seen-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(tok(a, "Amber-1")).toHaveCount(1);
  await expect(tok(a, "Sapphire-0")).toHaveCount(0);
});

test("in a team's view, an urn carried by an enemy out of its sight isn't drawn or hovered", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision urn"), "Coach");
  await open(a);
  await a.emulateMedia({ reducedMotion: "reduce" });
  const urn = a.locator("[data-testid=map] [data-testid=urn]");
  const pick = a.getByTestId("vision-select");
  const centre = async () => {
    const b = (await urn.locator("image").boundingBox())!;
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  };

  // All: carried by Sapphire 0, by Sapphire 1, then on the ground.
  const spot: Record<number, { x: number; y: number }> = {};
  for (const t of [15, 25, 35]) {
    await scrubTo(a, t);
    await expect(urn).toHaveAttribute("data-state", "carried");
    spot[t] = await centre();
  }
  await scrubTo(a, 45);
  await expect(urn).toHaveAttribute("data-state", "ground");

  // The King's view: shown on the carrier it sees (15), gone on a ghost (25) and on a carrier it
  // never saw (35), back once dropped (45).
  await pick.selectOption("amber");
  await scrubTo(a, 15);
  await expect(urn).toHaveAttribute("data-state", "carried");
  await expect(tok(a, "Sapphire-0")).toHaveAttribute("data-seen", "true");
  await scrubTo(a, 25);
  await expect(tok(a, "Sapphire-0")).toHaveCount(0);
  await expect(urn).toHaveCount(0);
  // Nor on its ghost, with Show last seen location.
  await a.getByTestId("last-seen-toggle").click();
  await expect(tok(a, "Sapphire-0")).toHaveAttribute("data-seen", "false");
  await expect(urn).toHaveCount(0);
  // Where it really is says nothing of it.
  await a.mouse.move(spot[25]!.x, spot[25]!.y);
  await a.mouse.move(spot[25]!.x + 1, spot[25]!.y);
  await expect(a.getByTestId("hover-label").filter({ hasText: /Urn/ })).toHaveCount(0);
  await a.mouse.move(5, 5);
  await a.screenshot({ path: "/tmp/vision/urn-king-25.png" });
  await scrubTo(a, 35);
  await expect(tok(a, "Sapphire-1")).toHaveCount(0);
  await expect(urn).toHaveCount(0);
  await scrubTo(a, 45);
  await expect(urn).toHaveAttribute("data-state", "ground");
  const g = await centre();
  await a.mouse.move(g.x, g.y);
  await a.mouse.move(g.x + 1, g.y);
  await expect(a.getByTestId("hover-label")).toHaveText("Urn");
  await a.mouse.move(5, 5);

  // The Archmother's view: her own carriers, seen or not by the King, carry it in sight.
  await pick.selectOption("sapphire");
  for (const t of [25, 35]) {
    await scrubTo(a, t);
    await expect(urn).toHaveAttribute("data-state", "carried");
  }

  // All again: on every carrier.
  await pick.selectOption("all");
  await scrubTo(a, 25);
  await expect(urn).toHaveAttribute("data-state", "carried");
});

// Vision's fades (board/fade.ts): on continuous playback an enemy coming into sight fades in, and
// one leaving it fades out where it was last drawn, then goes; so does the urn it carries. A seek
// snaps, and so does reduced motion. Timed like every eased value: out-expo over 350 ms.

const EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
async function play(p: Page, from: number) {
  await scrubTo(p, from);
  await p.getByTestId("match-play").click();
}
/**
 * Wait (up to 5 s) for `sel` to run an opacity fade, pause it there, and say what it is: from
 * and to, easing, duration, and whether the element is marked fading out.
 */
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
            return done({ from: Number(k[0]!.opacity), to: Number(k.at(-1)!.opacity), easing: String(tm.easing), duration: Number(tm.duration), out: el.getAttribute("data-fading") === "out" });
          }
          if (performance.now() > until) return fail(new Error(`no fade on ${sel}`));
          requestAnimationFrame(look);
        };
        look();
      }),
    sel,
  );
/** Let every paused fade run on. */
const resume = (p: Page) => p.evaluate(() => document.getAnimations().forEach((a) => a.playState === "paused" && a.play()));
/** Watch `sel` for `ms`: whether it ever faded, or was marked fading out. */
const watchFades = (p: Page, sel: string, ms: number) =>
  p.evaluate(
    ({ sel, ms }) =>
      new Promise<boolean>((done) => {
        const until = performance.now() + ms;
        let seen = false;
        const look = () => {
          for (const el of document.querySelectorAll(sel)) if (el.getAttribute("data-fading") || el.getAnimations().some((x) => (x.effect as KeyframeEffect).getKeyframes().some((k) => "opacity" in k))) seen = true;
          if (performance.now() > until) return done(seen);
          requestAnimationFrame(look);
        };
        look();
      }),
    { sel, ms },
  );
const S0 = '[data-testid=map] .tok[data-slot="Sapphire-0"]';
const URN = "[data-testid=map] [data-testid=urn]";

test("on playback an enemy leaving sight fades out where it was last seen, unhoverable, then goes; its urn too", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision fade out"), "Coach");
  await open(a);
  await a.getByTestId("vision-select").selectOption("amber");
  await play(a, 18);
  const [tok0, urn0] = await Promise.all([catchFade(a, S0), catchFade(a, URN)]);
  expect(tok0).toEqual({ from: 1, to: 0, easing: EXPO, duration: 350, out: true });
  expect(urn0).toEqual({ from: 1, to: 0, easing: EXPO, duration: 350, out: true });
  // Held there while the fade is held: where it was last drawn, as the match walks on without it.
  const spot = await at(a, "Sapphire-0");
  await expect.poll(async () => Number((await a.getByTestId("match-clock").textContent())!.slice(2, 4))).toBeGreaterThanOrEqual(21);
  expect(await at(a, "Sapphire-0")).toEqual(spot);
  expect(spot.x).toBeLessThan((await translate(await tok(a, "Amber-5").getAttribute("transform"))).x);
  // Not there to point at: no label, and the pointer falls through.
  const b = (await tok(a, "Sapphire-0").locator("circle.body").boundingBox())!;
  await a.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await a.mouse.move(b.x + b.width / 2 + 1, b.y + b.height / 2);
  await expect(a.getByTestId("hover-label")).toHaveCount(0);
  expect(await tok(a, "Sapphire-0").evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await a.mouse.move(5, 5);
  // A few frames of it, for the eye: the map around the token at 0, ⅓, ⅔ and all of the fade.
  const box = (await a.getByTestId("map").boundingBox())!;
  const clip = { x: Math.max(box.x, b.x - 120), y: Math.max(box.y, b.y - 90), width: 280, height: 200 };
  for (const ms of [0, 60, 120, 200, 350])
    await a.evaluate((ms) => document.getAnimations().forEach((x) => x.playState === "paused" && (x.currentTime = ms)), ms).then(() => a.screenshot({ path: `/tmp/vision-fade/fade-out-${String(ms).padStart(3, "0")}ms.png`, clip }));
  // Then it goes.
  await resume(a);
  await expect(tok(a, "Sapphire-0")).toHaveCount(0);
  await expect(a.locator(URN)).toHaveCount(0);
});

test("on playback an enemy coming into sight fades in; a ghost seen again elsewhere fades out where it was", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision fade in"), "Coach");
  await open(a);
  await a.getByTestId("vision-select").selectOption("amber");
  await play(a, 8);
  expect(await catchFade(a, S0)).toEqual({ from: 0, to: 1, easing: EXPO, duration: 350, out: false });
  await resume(a);
  await a.getByTestId("match-play").click();

  // Show last seen location: the ghost at its 20 s spot; at 45 s it's seen 2,500 units on.
  await a.getByTestId("last-seen-toggle").click();
  await play(a, 43);
  const echo = `[data-testid=map] [data-echo="Sapphire-0"]`;
  const [fadeIn, fadeOut] = await Promise.all([catchFade(a, S0), catchFade(a, echo)]);
  expect(fadeIn).toEqual({ from: 0, to: 1, easing: EXPO, duration: 350, out: false });
  expect(fadeOut).toEqual({ from: 1, to: 0, easing: EXPO, duration: 350, out: true });
  await expect(tok(a, "Sapphire-0")).toHaveAttribute("data-seen", "true");
  expect((await translate(await a.locator(echo).getAttribute("transform"))).x).toBeLessThan((await at(a, "Sapphire-0")).x);
  await resume(a);
  await expect(a.locator(echo)).toHaveCount(0);
});

test("a seek, even while playing, snaps the view without a fade", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision seek"), "Coach");
  await open(a);
  await a.getByTestId("vision-select").selectOption("amber");
  await play(a, 15);
  const watched = watchFades(a, `${S0}, ${URN}`, 1500);
  // Out of sight: gone at once.
  await a.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "25";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(tok(a, "Sapphire-0")).toHaveCount(0, { timeout: 100 });
  // Back in sight: there at once.
  await a.getByTestId("match-time").evaluate((el) => {
    (el as HTMLInputElement).value = "12";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(tok(a, "Sapphire-0")).toHaveCount(1, { timeout: 100 });
  expect(await watched).toBe(false);
});

test("under reduced motion a hero leaves and enters sight at once", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Vision fade reduced"), "Coach");
  await open(a);
  await a.emulateMedia({ reducedMotion: "reduce" });
  await a.getByTestId("vision-select").selectOption("amber");
  await play(a, 19);
  expect(await watchFades(a, `${S0}, ${URN}`, 2000)).toBe(false);
  await expect(tok(a, "Sapphire-0")).toHaveCount(0);
  await a.getByTestId("match-play").click();
  await play(a, 9);
  expect(await watchFades(a, S0, 2000)).toBe(false);
  await expect(tok(a, "Sapphire-0")).toHaveCount(1);
});
