// The feedback form against a fake GitHub (a local HTTP server; no real GitHub call is made):
// open it from the board and the landing, validation, a sent issue's link, a 429, the button
// hidden when the server has it off, the dialog's keyboard contract, and the match a board has
// open in Player going into the issue's footer (or not, when the sender unticks it).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew, openMore, revealControls, useSummary } from "./helpers";
import { checkPhoneLayout, phoneContext } from "./phone-layout";
import { ROOT, Server, newBoardUrl } from "./server";

const ISSUE = "https://github.com/intendednull/mapcro/issues/7";
const SHOTS = "test-results/feedback";

/** Requests the fake saw: path, auth header and parsed body. */
const seen: { path: string; auth: string | undefined; body: { title: string; body: string; labels?: string[] } }[] = [];
const fake = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    seen.push({ path: req.url ?? "", auth: req.headers.authorization, body: JSON.parse(raw || "{}") });
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ number: 7, html_url: ISSUE }));
  });
});

let on: Server; // the form on, generous limits
let limited: Server; // on, with no budget: every send is a 429
let off: Server; // no token file
let player: Server; // on, with the match API's fixture for a match to open
/** The match API, serving one match's metadata (the API summary). */
const MATCH = "130816395";
const matchApi = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url?.startsWith(`/v1/matches/${MATCH}/metadata`)) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${MATCH}-trimmed.json`)));
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
test.beforeAll(async () => {
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  await new Promise<void>((ok) => matchApi.listen(0, "127.0.0.1", ok));
  const api = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), "mapcro-feedback-"));
  writeFileSync(join(dir, "token"), "fake-e2e-token\n");
  const env = { FEEDBACK_GITHUB_TOKEN_FILE: join(dir, "token"), FEEDBACK_GITHUB_API: api };
  on = new Server(undefined, { ...env, FEEDBACK_PER_CLIENT_PER_HOUR: "100" });
  limited = new Server(undefined, { ...env, FEEDBACK_PER_CLIENT_PER_HOUR: "0" });
  off = new Server();
  const matches = `http://127.0.0.1:${(matchApi.address() as AddressInfo).port}`;
  player = new Server(undefined, { ...env, FEEDBACK_PER_CLIENT_PER_HOUR: "100", MATCH_API_BASE: matches, REPLAY_DIR: mkdtempSync(join(tmpdir(), "mapcro-feedback-replays-")) });
  await Promise.all([on.start(), limited.start(), off.start(), player.start()]);
});
test.afterAll(() => {
  on.stop();
  limited.stop();
  off.stop();
  player.stop();
  fake.close();
  matchApi.close();
});

/** The footer's last line, and the whole footer with no match line (regex source). */
const SENT = String.raw`— Sent from the mapcro feedback form \(build [0-9a-f]{16}\)$`;
const FOOTER = String.raw`\n\n---\n` + SENT;

async function landing(page: Page, server: Server) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/feedback"));
  await page.goto(server.url);
  await answered;
}

test("from the board: validation, send, the issue's link; Escape and Tab stay in the dialog", async ({ browser }) => {
  const page = await joinNew(browser, await newBoardUrl(on, "Feedback board"), "Coach");
  // A button in the header, next to Share, not a row of More (feedback #52); focus comes back to it.
  const opener = page.getByTestId("feedback-open");
  const open = { click: () => opener.click() };
  await expect(page.locator('header.top > [data-testid="feedback-open"]')).toHaveText("Feedback");
  await openMore(page);
  await expect(page.getByTestId("more-menu").getByTestId("feedback-open")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.locator("header.top").screenshot({ path: `${SHOTS}/topbar.png` });
  await open.click();
  const dlg = page.getByTestId("feedback-dialog");
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("feedback-notice")).toHaveText(
    "This creates a public issue on GitHub (intendednull/mapcro). Don't include personal info or board links.",
  );
  await expect(dlg.getByTestId("feedback-title")).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/empty.png` });

  // Escape closes it, and focus goes back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dlg).toHaveCount(0);
  await expect(opener).toBeFocused();

  // Tab and Shift+Tab wrap inside; the board behind is inert.
  await open.click();
  await expect(dlg.getByTestId("feedback-title")).toBeFocused();
  const inside = () => page.evaluate(() => !!document.activeElement?.closest('[data-testid="feedback-dialog"]'));
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    expect(await inside()).toBe(true);
  }
  // From the first control (the header's close button), Shift+Tab wraps to the last (Send).
  await dlg.getByRole("button", { name: "Close" }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await inside()).toBe(true);
  await expect(dlg.getByTestId("feedback-send")).toBeFocused();
  expect(await page.evaluate(() => (document.querySelector('[data-testid="board"]')!.closest("body > *") as HTMLElement).inert)).toBe(true);

  // Empty fields are refused here, with the field named.
  await dlg.getByTestId("feedback-send").click();
  await expect(dlg.getByTestId("feedback-error")).toHaveText("Add a title.");
  await expect(dlg.getByTestId("feedback-title")).toBeFocused();
  await dlg.getByTestId("feedback-title").fill("Tokens jump when @someone drags");
  await dlg.getByTestId("feedback-send").click();
  await expect(dlg.getByTestId("feedback-error")).toHaveText("Add a description.");
  // Keys pressed in the dialog are its own: the board's Space (pan) doesn't swallow a button's.
  await dlg.getByTestId("feedback-cancel").focus();
  await page.keyboard.press("Space");
  await expect(dlg).toHaveCount(0);
  await open.click();
  await expect(dlg.getByTestId("feedback-title")).toHaveValue(""); // a fresh form each time
  await dlg.getByTestId("feedback-title").fill("Tokens jump when @someone drags");
  // The count shows near the limit, and the field stops at it.
  await expect(dlg.getByTestId("feedback-count")).toHaveCount(0);
  await dlg.getByTestId("feedback-description").fill("x".repeat(4100));
  await expect(dlg.getByTestId("feedback-count")).toHaveText("4,100 / 5,000");
  await dlg.getByTestId("feedback-description").fill("y".repeat(5200));
  await expect(dlg.getByTestId("feedback-count")).toHaveText("5,000 / 5,000");
  await dlg.getByTestId("feedback-description").fill("Drag a token fast and it jumps back.\nSeen twice.");
  await page.screenshot({ path: `${SHOTS}/filled.png` });

  await dlg.getByTestId("feedback-send").click();
  await expect(dlg.getByTestId("feedback-done")).toContainText("Thanks — sent");
  const link = dlg.getByTestId("feedback-link");
  await expect(link).toHaveAttribute("href", ISSUE);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", /noopener/);
  await expect(dlg.getByTestId("feedback-close")).toBeFocused();
  await page.screenshot({ path: `${SHOTS}/success.png` });

  // What reached the fake: the text (mention neutralised), the footer, the label; no board link.
  const r = seen.at(-1)!;
  expect(r.path).toBe("/repos/intendednull/mapcro/issues");
  expect(r.auth).toBe("Bearer fake-e2e-token");
  expect(r.body.title).toBe("Tokens jump when @‍someone drags");
  expect(r.body.body).toMatch(/^Drag a token fast and it jumps back\.\nSeen twice\.\n\n---\n— Sent from the mapcro feedback form \(build [0-9a-f]{16}\)$/);
  expect(r.body.labels).toEqual(["feedback"]);
  expect(JSON.stringify(r)).not.toContain("/b/");

  await dlg.getByTestId("feedback-close").click();
  await expect(dlg).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("from the landing; a rate limit says when to try again, and retry keeps the text", async ({ page }) => {
  await landing(page, on);
  // The project's "Desktop Chrome" is a Windows browser, so the app's download shows (app-download.spec.ts).
  await expect(page.locator("footer.legal")).toHaveText("MIT · Not affiliated with Valve · GitHub · Get the Windows app · Feedback");
  await page.screenshot({ path: `${SHOTS}/landing.png` });
  await page.getByTestId("feedback-open").click();
  await expect(page.getByTestId("feedback-dialog")).toBeVisible();
  await expect(page.getByTestId("feedback-title")).toBeFocused();
  // No match from the landing: no line, and nothing sent about one.
  await expect(page.getByTestId("feedback-match")).toHaveCount(0);
  await page.getByTestId("feedback-title").fill("From the landing");
  await page.getByTestId("feedback-description").fill("No match here.");
  const req = page.waitForRequest((r) => r.url().endsWith("/api/feedback") && r.method() === "POST");
  await page.getByTestId("feedback-send").click();
  await expect(page.getByTestId("feedback-done")).toBeVisible();
  expect(JSON.parse((await req).postData()!)).toEqual({ title: "From the landing", description: "No match here." });
  expect(seen.at(-1)!.body.body).toMatch(new RegExp(`^No match here\\.${FOOTER}`));
  await page.getByTestId("feedback-close").click();
  await expect(page.getByTestId("feedback-dialog")).toHaveCount(0);

  await landing(page, limited);
  await page.getByTestId("feedback-open").click();
  const dlg = page.getByTestId("feedback-dialog");
  await dlg.getByTestId("feedback-title").fill("Rate limited");
  await dlg.getByTestId("feedback-description").fill("Should not be sent.");
  const before = seen.length;
  await dlg.getByTestId("feedback-send").click();
  await expect(dlg.getByTestId("feedback-error")).toHaveText("That's the limit for feedback for now. Try again in about 60 minutes.");
  await expect(dlg.getByTestId("feedback-send")).toHaveText("Try again");
  await expect(dlg.getByTestId("feedback-description")).toHaveValue("Should not be sent.");
  await page.screenshot({ path: `${SHOTS}/error.png` });
  expect(seen.length).toBe(before);
});

test("hidden when the server has it off", async ({ browser, page }) => {
  await landing(page, off);
  await expect(page.getByTestId("new-board")).toBeVisible();
  await expect(page.getByTestId("feedback-open")).toHaveCount(0);
  await expect(page.locator("footer.legal")).toHaveText("MIT · Not affiliated with Valve · GitHub · Get the Windows app");

  const answered = (p: Page) => p.waitForResponse((r) => r.url().endsWith("/api/feedback"));
  let asked: Promise<unknown> = Promise.resolve();
  const board = await joinNew(browser, await newBoardUrl(off, "No feedback"), "Coach", (p) => (asked = answered(p)));
  await asked;
  await expect(board.getByTestId("more")).toBeVisible();
  await openMore(board);
  await expect(board.getByTestId("download")).toBeVisible();
  await expect(board.getByTestId("feedback-open")).toHaveCount(0);
});

async function scrubTo(p: Page, t: number) {
  await p.getByTestId("match-time").evaluate((el, t) => {
    (el as HTMLInputElement).value = String(t);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, t);
}

test("on a board with a match open, the issue names the match and the time; unticked, it doesn't", async ({ browser }) => {
  const page = await joinNew(browser, await newBoardUrl(player, "Match feedback"), "Coach");
  await page.getByTestId("mode-player").click();
  await revealControls(page, "match-id");
  await page.getByTestId("match-id").fill(MATCH);
  await page.getByTestId("match-load").click();
  await expect(page.getByTestId("match-tier")).toHaveText("API summary");
  await useSummary(page);
  await scrubTo(page, 542);
  await expect(page.getByTestId("match-clock")).toHaveText("9:02 / 21:40");

  // In Player too, in the header (feedback #52).
  const open = { click: () => page.locator('header.top > [data-testid="feedback-open"]').click() };
  await open.click();
  const dlg = page.getByTestId("feedback-dialog");
  await expect(dlg.getByTestId("feedback-match")).toHaveText(`Includes: match ${MATCH} at 9:02 (API summary)Helps find the moment. Untick to leave it out of the issue.`);
  await expect(dlg.getByTestId("feedback-match-check")).toBeChecked();
  await dlg.getByTestId("feedback-title").fill("Mid guardian");
  await dlg.getByTestId("feedback-description").fill("mid guardia is bugged and shows its up at 9 mins");
  await page.screenshot({ path: "shots/feedback-match.png" });
  let req = page.waitForRequest((r) => r.url().endsWith("/api/feedback") && r.method() === "POST");
  await dlg.getByTestId("feedback-send").click();
  await expect(dlg.getByTestId("feedback-done")).toBeVisible();
  // Structured fields on the wire; the server writes the line.
  expect(JSON.parse((await req).postData()!).match).toEqual({ id: MATCH, t_s: 542, tier: "summary" });
  let r = seen.at(-1)!;
  expect(r.body.body).toMatch(new RegExp(`^mid guardia is bugged and shows its up at 9 mins\\n\\n---\\nMatch ${MATCH} at 9:02 \\(API summary\\)\\n${SENT}`));
  expect(JSON.stringify(r)).not.toContain("/b/");
  await dlg.getByTestId("feedback-close").click();

  // Unticked: the line stays on screen as what's left out, and nothing about the match is sent.
  await open.click();
  await expect(dlg.getByTestId("feedback-match-check")).toBeChecked(); // a fresh form each time
  await dlg.getByTestId("feedback-match").click();
  await expect(dlg.getByTestId("feedback-match-check")).not.toBeChecked();
  await dlg.getByTestId("feedback-title").fill("Without the match");
  await dlg.getByTestId("feedback-description").fill("Leave it out.");
  req = page.waitForRequest((r) => r.url().endsWith("/api/feedback") && r.method() === "POST");
  await dlg.getByTestId("feedback-send").click();
  await expect(dlg.getByTestId("feedback-done")).toBeVisible();
  expect(JSON.parse((await req).postData()!)).toEqual({ title: "Without the match", description: "Leave it out." });
  r = seen.at(-1)!;
  expect(r.body.body).toMatch(new RegExp(`^Leave it out\\.${FOOTER}`));
  expect(r.body.body).not.toContain(MATCH);
  await dlg.getByTestId("feedback-close").click();

  // Back in the sandbox on the blank Scene 1, no match is attached.
  await revealControls(page, "mode-sandbox");
  await page.getByTestId("mode-sandbox").click();
  await open.click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("feedback-match")).toHaveCount(0);
  await dlg.getByTestId("feedback-cancel").click();
  await expect(dlg).toHaveCount(0);

  // Save a scene from the match (at 9:02): viewing that saved scene in Scenes pre-fills its match details (Argon #8).
  await page.getByTestId("mode-player").click();
  await expect(page.getByTestId("match-clock")).toHaveText("9:02 / 21:40");
  await page.getByTestId("match-save").click();
  await expect(page.getByTestId("topbar")).not.toHaveAttribute("data-mode", "player");
  await open.click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("feedback-match")).toHaveText(`Includes: match ${MATCH} at 9:02 (API summary)Helps find the moment. Untick to leave it out of the issue.`);
  await expect(dlg.getByTestId("feedback-match-check")).toBeChecked();
  await dlg.getByTestId("feedback-title").fill("Saved scene match info");
  await dlg.getByTestId("feedback-description").fill("From a scene saved from a match.");
  req = page.waitForRequest((r) => r.url().endsWith("/api/feedback") && r.method() === "POST");
  await dlg.getByTestId("feedback-send").click();
  await expect(dlg.getByTestId("feedback-done")).toBeVisible();
  expect(JSON.parse((await req).postData()!).match).toEqual({ id: MATCH, t_s: 542, tier: "summary" });
  await dlg.getByTestId("feedback-close").click();

  // Switching to the blank Scene 1 omits match details again.
  await page.getByTestId("scene-card").first().click();
  await open.click();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("feedback-match")).toHaveCount(0);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 800 }] as const) {
  test(`phone ${viewport.width}×${viewport.height} session Scene .p-top header fits with Feedback enabled`, async ({ browser }) => {
    const links = [await newBoardUrl(on, "Match 129738985"), await newBoardUrl(on, "Blank board")];
    const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(links[0]!)!;
    const r = await fetch(`${on.url}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Match 129738985", board, board_token: token }),
    });
    const s = (await r.json()) as { session: string; owner_token: string };
    const url = `${on.url}/s/${s.session}#${s.owner_token}`;
    const desk = await joinNew(browser, url, "Coach");
    await desk.getByTestId("add-game").click();
    await desk.getByTestId("add-paste").fill(links[1]!);
    await desk.getByTestId("add-paste-go").click();
    await expect(desk.getByTestId("game-tab")).toHaveCount(2);

    const ctx = await phoneContext(browser, viewport, { hasTouch: true });
    const phone = await ctx.newPage();
    await phone.goto(url);
    await phone.locator("#join-name").fill("Student");
    await phone.keyboard.press("Enter");
    await expect(phone.getByTestId("join-card")).toBeHidden();
    await expect(phone.getByTestId("board")).toHaveAttribute("data-layout", "phone");

    const top = phone.locator(".p-top");
    await expect(top).toBeVisible();
    expect(await top.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);

    const gamesBtn = phone.getByTestId("games-open");
    await expect(gamesBtn).toBeVisible();
    const gamesBox = (await gamesBtn.boundingBox())!;
    expect(gamesBox.x).toBeGreaterThanOrEqual(0);
    expect(gamesBox.x + gamesBox.width).toBeLessThanOrEqual(viewport.width);
    expect(gamesBox.width).toBeGreaterThanOrEqual(44);
    expect(gamesBox.height).toBeGreaterThanOrEqual(44);

    const roleChip = phone.getByTestId("role-chip");
    await expect(roleChip).toBeVisible();
    expect(await roleChip.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    const roleBox = (await roleChip.boundingBox())!;
    expect(roleBox.width).toBeGreaterThanOrEqual(50);

    const fb = phone.getByTestId("feedback-open");
    await expect(fb).toBeVisible();
    const fbBox = (await fb.boundingBox())!;
    expect(fbBox.x).toBeGreaterThanOrEqual(0);
    expect(fbBox.x + fbBox.width).toBeLessThanOrEqual(viewport.width);
    expect(fbBox.width).toBeGreaterThanOrEqual(44);
    expect(fbBox.height).toBeGreaterThanOrEqual(44);

    await checkPhoneLayout(phone);

    await fb.tap();
    const dlg = phone.getByTestId("feedback-dialog");
    await expect(dlg).toBeVisible();
    await dlg.getByTestId("feedback-cancel").tap();
    await expect(dlg).toHaveCount(0);

    await ctx.close();
    await desk.context().close();
  });
}

test("phone 390×844 session Player .p-top and More feedback fit with match loaded", async ({ browser }) => {
  const links = [await newBoardUrl(player, `Match ${MATCH}`), await newBoardUrl(player, "Game 2")];
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(links[0]!)!;
  const r = await fetch(`${player.url}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: `Match ${MATCH}`, board, board_token: token }),
  });
  const s = (await r.json()) as { session: string; owner_token: string };
  const url = `${player.url}/s/${s.session}#${s.owner_token}`;
  const desk = await joinNew(browser, url, "Coach");
  await desk.getByTestId("add-game").click();
  await desk.getByTestId("add-paste").fill(links[1]!);
  await desk.getByTestId("add-paste-go").click();
  await expect(desk.getByTestId("game-tab")).toHaveCount(2);
  await desk.getByTestId("game-tab").first().click();
  await desk.getByTestId("mode-player").click();
  await revealControls(desk, "match-id");
  await desk.getByTestId("match-id").fill(MATCH);
  await desk.getByTestId("match-load").click();
  await expect(desk.getByTestId("match-tier")).toHaveText("API summary");
  await useSummary(desk);

  const ctx = await phoneContext(browser, { width: 390, height: 844 }, { hasTouch: true });
  const phone = await ctx.newPage();
  await phone.goto(url);
  await phone.locator("#join-name").fill("Student");
  await phone.keyboard.press("Enter");
  await expect(phone.getByTestId("join-card")).toBeHidden();
  await expect(phone.locator(".phone.phone-player")).toBeVisible();
  await expect(phone.getByTestId("match-tier")).toHaveText("API summary");

  const top = phone.locator(".p-top");
  expect(await top.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await checkPhoneLayout(phone);

  await phone.getByTestId("phone-more").tap();
  const fb = phone.getByTestId("feedback-open");
  await expect(fb).toBeVisible();
  const fbBox = (await fb.boundingBox())!;
  expect(fbBox.x).toBeGreaterThanOrEqual(0);
  expect(fbBox.x + fbBox.width).toBeLessThanOrEqual(390);
  expect(fbBox.width).toBeGreaterThanOrEqual(44);
  expect(fbBox.height).toBeGreaterThanOrEqual(44);

  // Switch from Player to Scene 1 via Scenes drawer: matchId(), games-open, role-chip, save, and feedback-open are all active simultaneously.
  await phone.getByTestId("scene-drawer").tap();
  await expect(phone.getByTestId("scene-card")).toHaveCount(1);
  await phone.getByTestId("scene-card").first().tap();
  await expect(phone.locator(".phone:not(.phone-player)")).toBeVisible();
  expect(await top.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);

  const roleChip = phone.getByTestId("role-chip");
  await expect(roleChip).toBeVisible();
  expect(await roleChip.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect((await roleChip.boundingBox())!.width).toBeGreaterThanOrEqual(50);

  const sceneFb = phone.locator('.p-top > [data-testid="feedback-open"]');
  await expect(sceneFb).toBeVisible();
  const sceneFbBox = (await sceneFb.boundingBox())!;
  expect(sceneFbBox.x).toBeGreaterThanOrEqual(0);
  expect(sceneFbBox.x + sceneFbBox.width).toBeLessThanOrEqual(390);
  expect(sceneFbBox.width).toBeGreaterThanOrEqual(44);
  expect(sceneFbBox.height).toBeGreaterThanOrEqual(44);
  expect(await phone.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await checkPhoneLayout(phone);

  await ctx.close();
  await desk.context().close();
});

