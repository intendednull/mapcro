// The feedback form against a fake GitHub (a local HTTP server; no real GitHub call is made):
// open it from the board and the landing, validation, a sent issue's link, a 429, the button
// hidden when the server has it off, and the dialog's keyboard contract.

import { mkdtempSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import { joinNew } from "./helpers";
import { Server, newBoardUrl } from "./server";

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
test.beforeAll(async () => {
  await new Promise<void>((ok) => fake.listen(0, "127.0.0.1", ok));
  const api = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  const dir = mkdtempSync(join(tmpdir(), "mapcro-feedback-"));
  writeFileSync(join(dir, "token"), "fake-e2e-token\n");
  const env = { FEEDBACK_GITHUB_TOKEN_FILE: join(dir, "token"), FEEDBACK_GITHUB_API: api };
  on = new Server(undefined, { ...env, FEEDBACK_PER_CLIENT_PER_HOUR: "100" });
  limited = new Server(undefined, { ...env, FEEDBACK_PER_CLIENT_PER_HOUR: "0" });
  off = new Server();
  await Promise.all([on.start(), limited.start(), off.start()]);
});
test.afterAll(() => {
  on.stop();
  limited.stop();
  off.stop();
  fake.close();
});

async function landing(page: Page, server: Server) {
  const answered = page.waitForResponse((r) => r.url().endsWith("/api/feedback"));
  await page.goto(server.url);
  await answered;
}

test("from the board: validation, send, the issue's link; Escape and Tab stay in the dialog", async ({ browser }) => {
  const page = await joinNew(browser, await newBoardUrl(on, "Feedback board"), "Coach");
  const open = page.getByTestId("feedback-open");
  await expect(open).toBeVisible();
  // In the top bar, next to Clone and Share.
  await expect(page.locator("header.top").getByTestId("feedback-open")).toHaveCount(1);
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
  await expect(open).toBeFocused();

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
  await expect(open).toBeFocused();
});

test("from the landing; a rate limit says when to try again, and retry keeps the text", async ({ page }) => {
  await landing(page, on);
  await expect(page.locator("footer.legal")).toHaveText("MIT · Not affiliated with Valve · Feedback");
  await page.screenshot({ path: `${SHOTS}/landing.png` });
  await page.getByTestId("feedback-open").click();
  await expect(page.getByTestId("feedback-dialog")).toBeVisible();
  await expect(page.getByTestId("feedback-title")).toBeFocused();
  await page.keyboard.press("Escape");
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
  await expect(page.locator("footer.legal")).toHaveText("MIT · Not affiliated with Valve");

  const answered = (p: Page) => p.waitForResponse((r) => r.url().endsWith("/api/feedback"));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const board = await ctx.newPage();
  const asked = answered(board);
  await board.goto(await newBoardUrl(off, "No feedback"));
  await asked;
  await expect(board.getByTestId("clone")).toBeVisible();
  await expect(board.getByTestId("feedback-open")).toHaveCount(0);
});
