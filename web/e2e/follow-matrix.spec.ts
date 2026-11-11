// What following does with each piece of view state (spec §8 "Follow mode"), one row per key,
// pinned in real browsers: a presenter, a follower and, for a late joiner, a third. Each row says
// how a person sets the key and how the screen shows it; its `policy` says what the follower sees
//   - when it follows a presenter who already set it, and as the presenter changes it (`mirror`);
//   - after its own change while following (`own`: following stops, or it is its own until the
//     presenter's next change, or it wins while held), and what the rest of its screen keeps
//     (`witness`: Vision and one layer, the follower's own or the presenter's);
//   - after Stop following, and after the presenter leaves (its own back, or the presenter's kept);
//   - for someone who joins the board later and follows;
//   - after the server restarts mid-follow (everyone reconnects).
// A new key is one row. docs/plans/2026-11-11-view-state-sync.md has the registry this checks.

import { createServer } from "node:http";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { joinNew, revealControls, viewOf } from "./helpers";
import { Server, TIMELINE_FORMAT, newBoardUrl } from "./server";

const ID = "129000101";
const ID2 = "129000102";
const N = 60;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-follow-matrix-"));
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.describe.configure({ mode: "parallel" });
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

const range = <T,>(f: (s: number) => T) => Array.from({ length: N + 1 }, (_, s) => f(s));

/** player-follow-view.spec.ts's match: Amber 1 dies at 20, Sapphire 2 at 40 (both with recaps,
 * in the events list), Sapphire 0 stunned 10–30 s; plus an objective, for a second filter. */
function timeline(id: string) {
  return {
    match_id: Number(id), start_time: 0, duration_s: N, source: "replay", tier: "replay", build: 6839, reanchored: 0, format: TIMELINE_FORMAT,
    players: (["amber", "sapphire"] as const).flatMap((team) =>
      [0, 1, 2, 3, 4, 5].map((slot) => {
        const a1 = team === "amber" && slot === 1;
        const s2 = team === "sapphire" && slot === 2;
        const s0 = team === "sapphire" && slot === 0;
        const dead = (s: number) => (a1 && s >= 20 && s < 30) || (s2 && s >= 40 && s < 50);
        const at = { x: slot * 1500 - 4000, y: team === "amber" ? -3000 : 3000 };
        return {
          team, slot, hero_id: 1 + slot, name: `${team === "amber" ? "A" : "S"}${slot}`,
          x: range((s) => (dead(s) ? null : at.x)),
          y: range((s) => (dead(s) ? null : at.y)),
          health: range((s) => (dead(s) ? 0 : 100)),
          deaths: a1 ? [20] : s2 ? [40] : [],
          respawn: a1 ? [[20, 30]] : s2 ? [[40, 50]] : [],
          souls: [[0, 500]], ult: range(() => 0),
          seen: a1 ? [[100, 198]] : [],
          items: [[50, 715_762_406, 0]],
          abilities: [], casts: [], charges: [], effects: [],
          cc: s0 ? [[100, 300, 20, 255, 0]] : [],
          height: s0 ? [[0, 1]] : [],
          recaps: a1 ? [{ t: 200, damage: [[7, 0, 640], [255, 0, 120]], cc: [] }] : s2 ? [{ t: 400, damage: [[1, 0, 900]], cc: [] }] : [],
        };
      }),
    ),
    objectives: [], mid_boss: [], rifts: [], powerups: [],
    events: [
      { t: 20, kind: "death", team: "amber", slot: 1, hero_id: 2, x: -2500, y: -3000 },
      { t: 30, kind: "objective", team: "amber", key: "walker:amber:lane1:1" },
      { t: 40, kind: "death", team: "sapphire", slot: 2, hero_id: 3, x: -1000, y: 3000 },
    ],
    waves: [{ lane: "lane4", t: range(() => 500), stale: [] }],
    troopers: { every_s: 1, amber: range(() => ""), sapphire: range(() => "") },
  };
}

const answered = new Set<string>();
/** Load a match as an editor does, the worker's answer written by hand (as player-follow-view). */
async function load(p: Page, id: string) {
  const bar = p.getByTestId("player");
  if (!(await bar.count()) || (await bar.getAttribute("data-state")) !== "match") await p.getByTestId("mode-player").first().click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(id);
  await p.getByTestId("match-load").click();
  const file = p.getByTestId("match-file");
  const tier = p.getByTestId("match-tier");
  const straight = await expect
    .poll(async () => ((await p.locator(".pl-source summary").textContent()) ?? "").includes(id) && (await tier.textContent().catch(() => "")) === "Full replay", { timeout: 3000 })
    .toBe(true)
    .then(() => true, () => false);
  if (!straight) {
    await file.setInputFiles({ name: `${id}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(4096)]) });
    let job = "";
    await expect.poll(() => (job = readdirSync(join(queue, "inbox")).find((f) => f.startsWith(`${id}-`) && f.endsWith(".dem") && !answered.has(f)) ?? "")).not.toBe("");
    answered.add(job);
    writeFileSync(join(queue, "outbox", job.replace(/\.dem$/, ".json")), JSON.stringify(timeline(id)));
  }
  await expect(p.locator(".pl-source summary")).toContainText(id);
  await expect(tier).toHaveText("Full replay");
  await expect(p.getByTestId("match-clock")).toBeVisible();
}

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}
const clock = async (p: Page) => ((await p.getByTestId("match-clock").textContent()) ?? "").split(" / ")[0]!.trim();
const pressed = async (p: Page, id: string) => (await p.getByTestId(id).getAttribute("aria-pressed")) === "true";
const onOff = (b: boolean) => (b ? "on" : "off");

type V = string;
interface Row {
  key: string;
  /** Sets the key to `v` as a person does (nothing when it already shows `v`). */
  set: (p: Page, v: V) => Promise<void>;
  /** What the screen shows. */
  read: (p: Page) => Promise<V>;
  /** The follower's own value before it follows, and the presenter's. They differ. */
  own: V;
  theirs: V;
  /** What a follower reads when it shows the presenter's `v` (default `v`). */
  seen?: (v: V) => V;
  /** Before the row's test: in Sandbox; or both at a moment; or a state both need. */
  prep?: (a: Page, b: Page) => Promise<void>;
  /** The witnesses this row can't change without changing itself (its own key, or a needed state). */
  noWitness?: Array<"vision" | "cc">;
  /** The follower's own change while following, when it isn't `own` (default: `own`). */
  mine?: V;
  /** Scenarios that don't apply (said why at the row). */
  skip?: Array<"own">;
  policy: Policy;
}
type Side = "own" | "theirs";
interface Policy {
  /** The follower shows the presenter's value, on following and live. */
  mirror: boolean;
  /** A follower's own change: stops following, is its own until the presenter's next change
   * (following goes on), or wins only while held. */
  own: "stops" | "local" | "held";
  /** After an own change that stops: what Vision and Crowd control show. */
  witness?: Partial<Record<"vision" | "cc", Side>>;
  /** After Stop following, and after the presenter leaves. */
  stop: Side;
  leave: Side;
  /** After a server restart mid-follow: still following the presenter (found again by its
   * seat, spec §8), or the follow ends (as when the presenter leaves). */
  reconnect: "follows" | "drops";
}

// ---- the keys ----

const layer = (k: string, d: boolean): Row => ({
  key: `layer.${k}`,
  read: async (p) => {
    await revealControls(p, `${k}-toggle`);
    return onOff(await pressed(p, `${k}-toggle`));
  },
  set: async (p, v) => {
    await revealControls(p, `${k}-toggle`);
    if (onOff(await pressed(p, `${k}-toggle`)) !== v) await p.getByTestId(`${k}-toggle`).click();
  },
  own: onOff(!d),
  theirs: onOff(d),
  noWitness: k === "cc" ? ["cc"] : [],
  policy: { mirror: true, own: "stops", witness: { vision: "theirs", cc: "theirs" }, stop: "own", leave: "own", reconnect: "follows" },
});

const VISION: Row = {
  key: "vision.team",
  read: (p) => p.getByTestId("vision-select").inputValue(),
  set: async (p, v) => {
    if ((await p.getByTestId("vision-select").inputValue()) !== v) await p.getByTestId("vision-select").selectOption(v);
  },
  own: "sapphire",
  theirs: "all",
  noWitness: ["vision"],
  policy: { mirror: true, own: "stops", witness: { cc: "theirs" }, stop: "own", leave: "own", reconnect: "follows" },
};
const CC = layer("cc", false);
const WITNESS = { vision: VISION, cc: CC } as const;

/** Stopping the follow by a change to the board, not the store (Board.tsx `stopFollowing(why)`). */
const boardStop: Policy = { mirror: true, own: "stops", witness: { vision: "theirs", cc: "theirs" }, stop: "theirs", leave: "theirs", reconnect: "follows" };
/** The panels (spec §8): a follower's own is its own until the presenter's next change. */
const panel: Policy = { mirror: true, own: "local", stop: "theirs", leave: "theirs", reconnect: "follows" };
/** The top bar's builds: Stop following is a press outside the top bar, which closes them
 * (PlayerTopBar.tsx `outside`), so after it they read as closed; the presenter leaving keeps them. */
const buildsPanel: Policy = { ...panel, stop: "own" };
/** Each browser's own (not shared, or not yet). */
const personal: Policy = { mirror: false, own: "local", stop: "own", leave: "own", reconnect: "follows" };

const skull = (p: Page) => p.locator('[data-testid=death-skull][data-slot="sapphire-2"]');
const recapRow = (p: Page) => p.locator('[data-testid=event][data-kind=death][data-t="20"] [data-testid=death-recap]');
const inspected = (p: Page, slot = "Amber-0") => p.locator(`.tb-player[data-slot="${slot}"] [data-testid=hero-build]`);
const at41 = async (a: Page, b: Page) => {
  await scrubTo(a, 41);
  await scrubTo(b, 41);
  await expect(b.getByTestId("match-clock")).toContainText("0:41 /");
};
const openInspect = async (p: Page) => {
  if ((await inspected(p).count()) === 0) await p.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').click();
  await expect(inspected(p)).toHaveCount(1);
};
const scenes = (p: Page) => p.getByTestId("scene-card");
const inSandbox = async (a: Page, b: Page) => {
  for (const p of [a, b]) await MODE.set(p, "scene");
  await a.getByTestId("scene-add").click();
  await expect(scenes(b)).toHaveCount(2);
};
const popover = async (p: Page) => {
  const b = inspected(p);
  if ((await b.count()) === 0) return "none";
  if (await b.getByTestId("active-effects").evaluate((el) => (el as HTMLDetailsElement).open)) return "effects";
  if (await b.getByTestId("build-order").evaluate((el) => (el as HTMLDetailsElement).open)) return "order";
  return "none";
};
const hoverOf = async (p: Page) => {
  const l = p.getByTestId("hover-label");
  if ((await l.count()) === 0) return "none";
  const by = await l.getAttribute("data-by");
  return `${await l.getAttribute("data-key")}${by ? `@${by}` : ""}`;
};

const MODE: Row = {
    key: "mode",
    read: async (p) => (await p.getByTestId("player").getAttribute("data-state")) ?? "",
    set: async (p, v) => {
      if ((await p.getByTestId("player").getAttribute("data-state")) === v) return;
      if (v === "scene") await revealControls(p, "mode-sandbox");
      await (v === "scene" ? p.getByTestId("mode-sandbox") : p.getByTestId("mode-player").first()).click();
    },
    own: "scene",
    theirs: "match",
    noWitness: ["vision", "cc"],
    policy: { ...boardStop, witness: {} },
  };

const ROWS: Row[] = [
  {
    key: "time",
    read: clock,
    set: async (p, v) => scrubTo(p, Number(v.split(":")[1])),
    own: "0:05",
    theirs: "0:15",
    policy: boardStop,
  },
  {
    key: "playing",
    read: async (p) => ((await p.getByTestId("match-play").getAttribute("aria-label")) === "Pause" ? "playing" : "paused"),
    set: async (p, v) => {
      const now = (await p.getByTestId("match-play").getAttribute("aria-label")) === "Pause" ? "playing" : "paused";
      if (now !== v) await p.getByTestId("match-play").click();
    },
    own: "playing",
    theirs: "paused",
    policy: boardStop,
  },
  {
    key: "speed",
    read: (p) => p.getByTestId("match-speed").inputValue(),
    set: async (p, v) => {
      if ((await p.getByTestId("match-speed").inputValue()) !== v) await p.getByTestId("match-speed").selectOption(v);
    },
    own: "4",
    theirs: "1",
    policy: boardStop,
  },
  MODE,
  {
    key: "match",
    read: async (p) => (await p.getByTestId("match-tier").textContent()) === "Full replay" ? ((await p.locator(".pl-source summary").textContent()) ?? "").replace(/\D/g, "") : "",
    set: async (p, v) => {
      if (!((await p.locator(".pl-source summary").textContent()) ?? "").includes(v)) await load(p, v);
    },
    own: ID2,
    theirs: ID,
    prep: async (a) => {
      await load(a, ID2);
      await load(a, ID);
    },
    policy: boardStop,
  },
  {
    key: "jump",
    read: async (p) => ((await p.locator("[data-testid=event-highlight]").count()) ? ((await p.locator("[data-testid=event][data-current=true]").getAttribute("data-t")) ?? "") : "none"),
    set: async (p, v) => {
      await p.locator(`[data-testid=event][data-t="${v}"] [data-testid=event-jump]`).click();
    },
    own: "30",
    theirs: "40",
    policy: boardStop,
  },
  VISION,
  {
    key: "vision.last_seen",
    read: async (p) => ((await p.getByTestId("last-seen-toggle").count()) ? onOff(await pressed(p, "last-seen-toggle")) : "hidden"),
    set: async (p, v) => {
      if (onOff(await pressed(p, "last-seen-toggle")) !== v) await p.getByTestId("last-seen-toggle").click();
    },
    own: "on",
    theirs: "off",
    prep: async (a, b) => {
      await VISION.set(a, "amber");
      await VISION.set(b, "amber");
    },
    noWitness: ["vision"],
    policy: { mirror: true, own: "stops", witness: { cc: "theirs" }, stop: "own", leave: "own", reconnect: "follows" },
  },
  {
    key: "scene",
    read: async (p) => String(await scenes(p).evaluateAll((els) => els.findIndex((e) => e.getAttribute("aria-current") === "true"))),
    set: async (p, v) => {
      await scenes(p).nth(Number(v)).click();
    },
    own: "0",
    theirs: "1",
    prep: inSandbox,
    noWitness: ["vision", "cc"],
    policy: { ...boardStop, witness: {} },
  },
  {
    key: "viewport",
    read: async (p) => ((await viewOf(p))[2] > 990 ? "fit" : "zoomed"),
    set: async (p, v) => {
      if (((await viewOf(p))[2] > 990 ? "fit" : "zoomed") === v) return;
      const box = (await p.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await p.mouse.wheel(0, v === "zoomed" ? -300 : 2000);
      await expect.poll(async () => ((await viewOf(p))[2] > 990 ? "fit" : "zoomed")).toBe(v);
    },
    own: "zoomed",
    theirs: "fit",
    policy: boardStop,
  },
  {
    key: "side",
    read: async (p) => ((await p.locator(".mapbox .mm-host").getAttribute("class"))?.includes("vp-sapphire") ? "sapphire" : "amber"),
    set: async (p, v) => {
      if (((await p.locator(".mapbox .mm-host").getAttribute("class"))?.includes("vp-sapphire") ? "sapphire" : "amber") !== v) await p.getByTestId("viewpoint-flip").click();
    },
    own: "sapphire",
    theirs: "amber",
    policy: boardStop,
  },
  {
    key: "hover",
    read: hoverOf,
    set: async (p, v) => {
      if (v === "none") return p.mouse.move(2, 2);
      const box = (await p.locator(`.mapbox .tok[data-slot="${v.split(":")[0]}"]`).boundingBox())!;
      await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    },
    own: "none",
    theirs: "Amber-0",
    mine: "Amber-3",
    seen: (v) => (v === "none" ? v : `${v}@Coach`),
    // Your own hover wins while you hover; the presenter's shows again when you stop.
    policy: { mirror: true, own: "held", stop: "own", leave: "own", reconnect: "follows" },
  },
  layer("troopers", true),
  layer("health", true),
  layer("pings", true),
  CC,
  layer("movement", false),
  layer("heals", false),
  layer("crates", false),
  {
    key: "skull_recap",
    read: async (p) => ((await p.getByTestId("skull-recap").count()) ? ((await p.getByTestId("skull-recap").getAttribute("data-slot")) ?? "") : "none"),
    set: async (p, v) => {
      const open = (await p.getByTestId("skull-recap").count()) > 0;
      if (v === "none" && open) await p.getByTestId("skull-recap-close").click();
      if (v !== "none" && !open) await skull(p).click();
    },
    own: "sapphire-2",
    theirs: "none",
    prep: at41,
    policy: panel,
  },
  {
    key: "event_recap",
    read: async (p) => ((await recapRow(p).getAttribute("open")) !== null ? "open" : "closed"),
    set: async (p, v) => {
      if (((await recapRow(p).getAttribute("open")) !== null ? "open" : "closed") !== v) await recapRow(p).locator("summary").click();
    },
    // A follower's own open recaps stay open: the presenter's open and close only theirs.
    own: "closed",
    theirs: "open",
    policy: panel,
  },
  {
    key: "inspect",
    read: async (p) => ((await p.getByTestId("hero-build").count()) === 1 ? ((await p.locator(".tb-player:has([data-testid=hero-build])").getAttribute("data-slot")) ?? "") : "none"),
    set: async (p, v) => {
      if (v !== "none") return openInspect(p);
      if ((await inspected(p).count()) > 0) await p.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').click();
    },
    own: "none",
    theirs: "Amber-0",
    policy: buildsPanel,
  },
  {
    key: "builds.all",
    read: async (p) => ((await p.getByTestId("hero-build").count()) === 12 ? "on" : "off"),
    set: async (p, v) => {
      if (((await p.getByTestId("hero-build").count()) === 12 ? "on" : "off") !== v) await p.locator(".tb-all-builds").click();
    },
    own: "off",
    theirs: "on",
    policy: buildsPanel,
  },
  {
    key: "builds.tab",
    read: async (p) => ((await p.getByTestId("hero-build").count()) === 12 ? "on" : "off"),
    set: async (p, v) => {
      await p.locator("[data-testid=map]").hover();
      await (v === "on" ? p.keyboard.down("Tab") : p.keyboard.up("Tab"));
    },
    own: "off",
    theirs: "on",
    noWitness: ["vision", "cc"],
    // Holding Tab shows every build on your own screen whatever the presenter does.
    skip: ["own"],
    policy: buildsPanel,
  },
  {
    key: "names",
    read: async (p) => ((await p.getByTestId("tb-name").count()) > 0 ? "on" : "off"),
    set: async (p, v) => {
      await revealControls(p, "names-toggle");
      if (onOff(await pressed(p, "names-toggle")) !== v) await p.getByTestId("names-toggle").click();
    },
    own: "off",
    theirs: "on",
    policy: personal,
  },
  {
    key: "builds.popover",
    read: popover,
    set: async (p, v) => {
      await openInspect(p);
      const now = await popover(p);
      if (now === v) return;
      const which = v === "none" ? now : v;
      await inspected(p).getByTestId(which === "effects" ? "active-effects" : "build-order").locator(":scope > summary").click();
    },
    own: "none",
    theirs: "effects",
    prep: async (a, b) => {
      await openInspect(a);
      await openInspect(b);
    },
    noWitness: ["vision", "cc"],
    policy: buildsPanel,
  },
  {
    key: "events.filters",
    read: async (p) => (await pressed(p, "chip-death")) ? "death" : "",
    set: async (p, v) => {
      if (((await pressed(p, "chip-death")) ? "death" : "") !== v) await p.getByTestId("chip-death").click();
    },
    own: "death",
    theirs: "",
    policy: panel,
  },
  {
    key: "events.search",
    read: (p) => p.getByTestId("events-search").inputValue(),
    set: (p, v) => p.getByTestId("events-search").fill(v),
    own: "walker",
    theirs: "",
    policy: panel,
  },
  {
    key: "sidebar.tab",
    read: async (p) => ((await p.locator("#notes-tab").getAttribute("aria-selected")) === "true" ? "notes" : "events"),
    set: async (p, v) => p.locator(v === "notes" ? "#notes-tab" : "#events-tab").click(),
    own: "notes",
    theirs: "events",
    policy: personal,
  },
  {
    key: "layers.popover",
    read: async (p) => ((await p.locator(".map-layers").evaluate((el) => (el as HTMLDetailsElement).open)) ? "open" : "closed"),
    set: async (p, v) => {
      if (((await p.locator(".map-layers").evaluate((el) => (el as HTMLDetailsElement).open)) ? "open" : "closed") !== v) await p.getByTestId("map-layers-toggle").click();
    },
    own: "closed",
    theirs: "open",
    noWitness: ["cc"],
    policy: personal,
  },
];
// Not a row: the floor. Presence carries `floor`, but no client control changes it (always
// "surface"), so there is nothing a person can set to follow.

// ---- the scenarios ----

const following = (p: Page) => p.getByTestId("stop-following");
async function follow(b: Page) {
  await b.getByTestId("follow-Coach").click();
  await expect(following(b)).toHaveCount(1);
}
/** Set a key as a person does, and see the screen show it. */
async function put(r: Row, p: Page, v: V) {
  await r.set(p, v);
  await expect.poll(() => r.read(p), { message: `${r.key}: set ${v}` }).toBe(v);
}
const flip = (r: Row, v: V) => (v === r.own ? r.theirs : r.own);
const shows = (r: Row, p: Page, v: V) => expect.poll(() => r.read(p), { message: r.key }).toBe(v);

async function board(browser: Browser, r: Row) {
  const url = await newBoardUrl(server, `Follow ${r.key}`);
  const a = await joinNew(browser, url, "Coach");
  await load(a, ID);
  await scrubTo(a, 15);
  const b = await joinNew(browser, url, "Second");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await r.prep?.(a, b);
  return { url, a, b };
}
/** The witnesses: the follower's own Vision and Crowd control differ from the presenter's. */
async function witnessesOwn(r: Row, b: Page) {
  for (const [k, w] of Object.entries(WITNESS)) if (!r.noWitness?.includes(k as "cc")) await put(w, b, w.own);
}

for (const r of ROWS) {
  const P = r.policy;
  const seen = (v: V) => (r.seen ? r.seen(v) : v);
  test.describe(r.key, () => {
    test(`mirrors ${P.mirror}; Stop following: ${P.stop}; late joiner`, async ({ browser }) => {
      const { url, a, b } = await board(browser, r);
      await put(r, b, r.own);
      await put(r, a, r.theirs);
      await follow(b);
      const want = (v: V) => (P.mirror ? seen(v) : r.own);
      await shows(r, b, want(r.theirs));
      // Live: the presenter changes it and back.
      await put(r, a, r.own);
      await shows(r, b, want(r.own));
      await put(r, a, r.theirs);
      await shows(r, b, want(r.theirs));
      await expect(following(b)).toHaveCount(1);
      // A late joiner who follows gets what the presenter shows now.
      const c = await joinNew(browser, url, "Third");
      await expect(c.getByTestId("match-tier")).toHaveText("Full replay");
      const first = await r.read(c);
      await follow(c);
      await shows(r, c, P.mirror ? seen(r.theirs) : first);
      await c.context().close();
      // Stop following.
      await following(b).click();
      await expect(following(b)).toHaveCount(0);
      await shows(r, b, P.stop === "own" || !P.mirror ? r.own : r.theirs);
    });

    if (!r.skip?.includes("own")) test(`a follower's own change: ${P.own}${P.witness ? `, Vision ${P.witness.vision ?? "-"}, CC ${P.witness.cc ?? "-"}` : ""}`, async ({ browser }) => {
      const { a, b } = await board(browser, r);
      const witnesses = P.own === "stops";
      if (witnesses) await witnessesOwn(r, b);
      await put(r, b, r.own);
      await put(r, a, r.theirs);
      await follow(b);
      if (witnesses) for (const [k, w] of Object.entries(WITNESS)) if (!r.noWitness?.includes(k as "cc")) await shows(w, b, w.theirs);
      await shows(r, b, P.mirror ? seen(r.theirs) : r.own);
      const mine = r.mine ?? (P.mirror ? r.own : flip(r, r.own));
      await put(r, b, mine);
      await shows(r, b, mine);
      if (P.own === "stops") {
        await expect(following(b)).toHaveCount(0);
        for (const [k, side] of Object.entries(P.witness ?? {})) {
          if (r.noWitness?.includes(k as "cc")) continue;
          const w = WITNESS[k as "vision" | "cc"];
          await shows(w, b, side === "own" ? w.own : w.theirs);
        }
        return;
      }
      await expect(following(b)).toHaveCount(1);
      if (P.own === "held") {
        // Letting go of your own shows the presenter's again.
        await r.set(b, "none");
        await shows(r, b, seen(r.theirs));
        return;
      }
      if (!P.mirror) {
        await put(r, a, flip(r, r.theirs));
        await b.waitForTimeout(300);
        await shows(r, b, mine);
        return;
      }
      // The presenter's next change wins.
      await put(r, a, r.own);
      await put(r, a, r.theirs);
      await shows(r, b, seen(r.theirs));
      await expect(following(b)).toHaveCount(1);
    });

    test(`the presenter leaves: ${P.leave}; a restart mid-follow: ${P.reconnect}`, async ({ browser }) => {
      const { a, b } = await board(browser, r);
      await put(r, b, r.own);
      await put(r, a, r.theirs);
      await follow(b);
      await shows(r, b, P.mirror ? seen(r.theirs) : r.own);
      // The server restarts: everyone reconnects.
      await server.kill();
      await server.start();
      await a.waitForTimeout(1000);
      for (const p of [a, b]) await expect(p.getByTestId("save-status")).toHaveAttribute("data-connection", "live", { timeout: 20_000 });
      // Neither made an edit: no save status says Conflict (backlog: the follower that joined
      // just before the restart showed a refused `IdTaken`, its own copy of the live layer).
      for (const p of [a, b]) await expect(p.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
      if (P.reconnect === "follows") {
        // Found again by seat on its new connection: still following, and live.
        await expect(following(b)).toHaveCount(1);
        await shows(r, b, P.mirror ? seen(r.theirs) : r.own);
        await put(r, a, r.own);
        await shows(r, b, P.mirror ? seen(r.own) : r.own);
        await put(r, a, r.theirs);
        await shows(r, b, P.mirror ? seen(r.theirs) : r.own);
        await expect(following(b)).toHaveCount(1);
      } else {
        await expect(following(b)).toHaveCount(0);
        await shows(r, b, P.leave === "own" || !P.mirror ? r.own : r.theirs);
      }
      if ((await following(b).count()) === 0) await follow(b);
      await shows(r, b, P.mirror ? seen(r.theirs) : r.own);
      await a.context().close();
      await expect(following(b)).toHaveCount(0, { timeout: 40_000 });
      await shows(r, b, P.leave === "own" || !P.mirror ? r.own : r.theirs);
    });
  });
}

// The presenter's connection alone drops and comes back (its own reconnect, the server up):
// the follower waits for its seat and follows it on the new connection. A presenter that
// doesn't come back is gone after the wait (spec §8).
test("the presenter's own reconnect keeps the follow", async ({ browser }) => {
  const r = ROWS.find((x) => x.key === "vision.team")!;
  const url = await newBoardUrl(server, "Presenter reconnects");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sockets: Array<{ close: () => Promise<void> }> = [];
  await ctx.routeWebSocket(/\/ws$/, (ws) => {
    ws.connectToServer();
    sockets.push(ws);
  });
  const a = await ctx.newPage();
  await a.goto(url);
  await a.locator("#join-name").fill("Coach");
  await a.keyboard.press("Enter");
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await load(a, ID);
  const b = await joinNew(browser, url, "Second");
  await expect(b.getByTestId("match-tier")).toHaveText("Full replay");
  await put(r, b, r.own);
  await put(r, a, r.theirs);
  await follow(b);
  await shows(r, b, r.theirs);
  // Drop the presenter's socket: the server sees it leave, and the page reconnects.
  const before = sockets.length;
  await sockets.at(-1)!.close();
  await expect.poll(() => sockets.length).toBeGreaterThan(before);
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-connection", "live", { timeout: 20_000 });
  await expect(following(b)).toHaveCount(1);
  await put(r, a, r.own);
  await shows(r, b, r.own);
  await expect(following(b)).toHaveCount(1);
  await expect(b.getByTestId("save-status")).toHaveAttribute("data-state", "saved");
  await ctx.close();
});

// Not a follow scenario, but the popover's state moved from the DOM into the store: a build you
// open yourself opens with neither popover open, as a fresh <details> did.
test("a build opened again opens with Effects and Build order closed", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Popover reset"), "Coach");
  await load(a, ID);
  await openInspect(a);
  await inspected(a).getByTestId("active-effects").locator(":scope > summary").click();
  await expect.poll(() => popover(a)).toBe("effects");
  await a.locator('.tb-player[data-slot="Amber-0"] [data-testid=focus-hero]').click();
  await expect(inspected(a)).toHaveCount(0);
  await openInspect(a);
  await expect.poll(() => popover(a)).toBe("none");
});

// The search keeps at most its bytes, while the box's maxLength counts UTF-16 units: the box
// shows what was kept, so what you see is what a follower sees (review 2026-11-11).
test("the events search shows exactly what it keeps, and a follower sees the same", async ({ browser }) => {
  const { a, b } = await board(browser, ROWS.find((r) => r.key === "events.search")!);
  const box = (p: Page) => p.getByTestId("events-search");
  await follow(b);
  // Typed one key at a time: the 33rd two-byte letter doesn't go in.
  await box(a).pressSequentially("ж".repeat(40));
  await expect(box(a)).toHaveValue("ж".repeat(32));
  await expect(box(b)).toHaveValue("ж".repeat(32));
  // Pasted whole, ending in an emoji that doesn't fit: cut before it, never through it.
  await box(a).fill(`${"x".repeat(61)}😀`);
  await expect(box(a)).toHaveValue("x".repeat(61));
  await expect(box(b)).toHaveValue("x".repeat(61));
  await expect(a.getByTestId("save-status")).toHaveAttribute("data-connection", "live");
});
