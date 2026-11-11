// Board links and the app (spec §6b, The Windows app; desktop/README.md, Deep links): in the app,
// "Open link" on the landing and Ctrl+L anywhere take a pasted share link (the site's, or the
// mapcro:// form) and open the board in the window; anything else says "Not a board link". A
// board page reloads when only its token changes (a link the app opened in place). In a browser
// none of it shows, and "Open in app" stays off until the app's first release
// (`WINDOWS_APP_RELEASED`; its gating is unit-tested in test/applink.test.ts). The app is stubbed
// (`__TAURI_INTERNALS__.invoke`, as Tauri injects it); the boards are the real server's.

import { type Browser, expect, test } from "./fixtures";
import { Server, newBoardUrl } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

/** A context in the app's window (the bridge stubbed: no command is needed here). */
async function inApp(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: async () => Promise.reject("unknown_command") };
  });
  return ctx;
}

const parts = (url: string) => {
  const u = new URL(url);
  return { board: u.pathname.slice(3), token: u.hash.slice(1) };
};

test("in the app, the landing's Open link opens a pasted share link, in either form; anything else is refused", async ({ browser }) => {
  const ctx = await inApp(browser);
  const p = await ctx.newPage();
  const a = await newBoardUrl(server, "Linked A");
  const b = await newBoardUrl(server, "Linked B");
  await p.goto(server.url);
  const input = p.getByTestId("open-link-input");
  await expect(input).toBeVisible();

  for (const bad of ["hello", "130816395", `${a}x`, a.replace(server.url, "https://evil.example"), a.replace("#", "?t=")]) {
    await input.fill(bad);
    await p.getByTestId("open-link-go").click();
    await expect(p.getByTestId("open-link-error")).toHaveText("Not a board link");
    expect(p.url()).toBe(`${server.url}/`);
  }
  // Typing again clears the tag.
  await input.fill("x");
  await expect(p.getByTestId("open-link-error")).toBeHidden();

  // The live site's share link opens the board here, on this origin.
  const { board, token } = parts(a);
  await input.fill(`  https://mapcro.dmgdeadlock.com/b/${board}#${token}  `);
  await input.press("Enter");
  await expect(p.getByTestId("board-title")).toHaveText("Linked A");
  expect(p.url()).toBe(a);

  // The mapcro:// form, through Ctrl+L on the board.
  await p.keyboard.press("Control+l");
  const dialog = p.getByTestId("open-link-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("open-link-input")).toBeFocused();
  await dialog.getByTestId("open-link-input").fill("mapcro://b/nope");
  await dialog.getByTestId("open-link-input").press("Enter");
  await expect(dialog.getByTestId("open-link-error")).toHaveText("Not a board link");
  const nb = parts(b);
  await dialog.getByTestId("open-link-input").fill(`mapcro://b/${nb.board}#${nb.token}`);
  await dialog.getByTestId("open-link-input").press("Enter");
  await expect(p.getByTestId("board-title")).toHaveText("Linked B");
  expect(p.url()).toBe(b);

  // Escape closes it, and nothing changes.
  await p.keyboard.press("Control+l");
  await expect(dialog).toBeVisible();
  await p.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(p.url()).toBe(b);
  await ctx.close();
});

test("the same board with another token loads again with it", async ({ browser }) => {
  const ctx = await inApp(browser);
  const p = await ctx.newPage();
  const owner = await newBoardUrl(server, "Two links");
  const { board, token } = parts(owner);
  const r = await fetch(`${server.url}/api/boards/${board}/links`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ role: "view", label: "view" }),
  });
  const view = ((await r.json()) as { token: string }).token;
  await p.goto(owner);
  await expect(p.getByTestId("share")).toBeVisible();
  await p.keyboard.press("Control+l");
  await p.getByTestId("open-link-dialog").getByTestId("open-link-input").fill(`${server.url}/b/${board}#${view}`);
  await p.getByTestId("open-link-dialog").getByTestId("open-link-input").press("Enter");
  // Reloaded as the view link: no Share.
  await expect(p.getByTestId("board-title")).toHaveText("Two links");
  await expect(p.getByTestId("share")).toBeHidden();
  expect(p.url()).toBe(`${server.url}/b/${board}#${view}`);
  await ctx.close();
});

test("in a browser: no Open link, Ctrl+L is the browser's, and Open in app is off until the release", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: WINDOWS_UA });
  const p = await ctx.newPage();
  await p.goto(server.url);
  await expect(p.getByTestId("open-match")).toBeVisible();
  await expect(p.getByTestId("open-link")).toHaveCount(0);
  await p.goto(await newBoardUrl(server, "Browser"));
  await expect(p.getByTestId("board-title")).toHaveText("Browser");
  await p.keyboard.press("Control+l");
  await expect(p.getByTestId("open-link-dialog")).toHaveCount(0);
  await expect(p.getByTestId("open-in-app")).toHaveCount(0);
  await ctx.close();

  // Never inside the app, either.
  const app = await inApp(browser);
  const q = await app.newPage();
  await q.goto(await newBoardUrl(server, "App"));
  await expect(q.getByTestId("board-title")).toHaveText("App");
  await expect(q.getByTestId("open-in-app")).toHaveCount(0);
  await app.close();
});
