// Board links and the app (spec §6b, The Windows app; desktop/README.md, Deep links): in the app,
// "Open link" on the landing and Ctrl+L anywhere take a pasted share link (the site's, or the
// mapcro:// form) and open the board in the window; anything else says "Not a board link". The
// same board with another token mounts afresh with it, in place: the page doesn't reload
// (sessions.md §4.1; a link the app opened in place). In a browser none of it shows; a board page
// offers "Open in app" (its mapcro:// link) on a Windows or desktop Linux browser, beside "Get the
// app" (that system's download, a file), and nowhere else (`desktopAppLinks`; the matrix is
// unit-tested in test/desktop-release.test.ts). The app is stubbed
// (`__TAURI_INTERNALS__.invoke`, as Tauri injects it); the boards are the real server's.

import { type Browser, expect, test } from "./fixtures";
import { noSecondary } from "./helpers";
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
  // Mounted again as the view link: no Share.
  await expect(p.getByTestId("board-title")).toHaveText("Two links");
  await expect(p.getByTestId("share")).toBeHidden();
  expect(p.url()).toBe(`${server.url}/b/${board}#${view}`);
  await ctx.close();
});

const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

test("in a browser: no Open link, Ctrl+L is the browser's, and Open in app on Windows and Linux only", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: WINDOWS_UA });
  const p = await ctx.newPage();
  await p.goto(server.url);
  await expect(p.getByTestId("open-match")).toBeVisible();
  await expect(p.getByTestId("open-link")).toHaveCount(0);
  const url = await newBoardUrl(server, "Browser");
  await p.goto(url);
  await expect(p.getByTestId("board-title")).toHaveText("Browser");
  await p.keyboard.press("Control+l");
  await expect(p.getByTestId("open-link-dialog")).toHaveCount(0);
  const { board, token } = parts(url);
  await expect(p.getByTestId("open-in-app")).toHaveAttribute("href", `mapcro://b/${board}#${token}`);
  await expect(p.getByTestId("open-in-app-get")).toHaveAttribute("href", "https://github.com/intendednull/mapcro/releases/latest/download/mapcro_x64-setup.exe");
  await expect(p.getByTestId("open-in-app-get")).toHaveAttribute("download", "");
  await expect(p.getByTestId("open-in-app-get")).not.toHaveAttribute("target", /.+/);
  await noSecondary(p);
  await ctx.close();

  // A desktop Linux browser: the same link, and the AppImage.
  const linux = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: LINUX_UA });
  const l = await linux.newPage();
  await l.goto(url);
  await expect(l.getByTestId("board-title")).toHaveText("Browser");
  await expect(l.getByTestId("open-in-app")).toHaveAttribute("href", `mapcro://b/${board}#${token}`);
  await expect(l.getByTestId("open-in-app-get")).toHaveAttribute("href", "https://github.com/intendednull/mapcro/releases/latest/download/mapcro_amd64.AppImage");
  await noSecondary(l);
  await linux.close();

  // Not on other systems.
  const mac = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: MAC_UA });
  const m = await mac.newPage();
  await m.goto(url);
  await expect(m.getByTestId("board-title")).toHaveText("Browser");
  await expect(m.getByTestId("open-in-app")).toHaveCount(0);
  await expect(m.getByTestId("open-in-app-get")).toHaveCount(0);
  await mac.close();

  // Never inside the app, either.
  const app = await inApp(browser);
  const q = await app.newPage();
  await q.goto(await newBoardUrl(server, "App"));
  await expect(q.getByTestId("board-title")).toHaveText("App");
  await expect(q.getByTestId("open-in-app")).toHaveCount(0);
  await app.close();
});

test("the portable app's Update available: shown when the app reports a newer version, linking to the new portable zip", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === "app_update" ? { version: "9.9.9", kind: "link" } : Promise.reject("unknown_command")),
    };
  });
  const p = await ctx.newPage();
  await p.goto(server.url);
  await expect(p.getByTestId("app-update")).toHaveText("Update available");
  await expect(p.getByTestId("app-update")).toHaveAttribute("href", "https://github.com/intendednull/mapcro/releases/latest/download/mapcro_x64-portable.zip");
  await p.goto(await newBoardUrl(server, "Update"));
  await expect(p.getByTestId("board-title")).toHaveText("Update");
  await expect(p.getByTestId("app-update")).toBeVisible();
  await expect(p.getByTestId("app-update-banner")).toHaveCount(0);
  await ctx.close();

  // The installed app with nothing to offer (it answers null) and a browser show nothing.
  const app = await inApp(browser);
  const q = await app.newPage();
  await q.goto(server.url);
  await expect(q.getByTestId("open-link")).toBeVisible();
  await expect(q.getByTestId("app-update")).toHaveCount(0);
  await app.close();
});

/** The installed app with an update out (issue #43): records each command; Install fails the
 * first time, then hangs (the app restarting). */
async function updatingApp(browser: Browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    const w = window as unknown as { __TAURI_INTERNALS__: unknown; __calls: string[] };
    const calls = JSON.parse(sessionStorage.getItem("calls") ?? "[]") as string[];
    w.__calls = calls;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: { version?: string }) => {
        calls.push(cmd === "app_update_install" ? `${cmd} ${args?.version}` : cmd);
        sessionStorage.setItem("calls", JSON.stringify(calls));
        if (cmd === "app_update") return { version: "9.9.9", kind: "install" };
        if (cmd === "app_update_install") return calls.filter((c) => c.startsWith("app_update_install")).length === 1 ? Promise.reject("failed") : new Promise(() => {});
        return Promise.reject("unknown_command");
      },
    };
  });
  return ctx;
}

test("the installed app's Update available: a banner with Install and Later, on the landing and boards; nothing installs without a click", async ({ browser }) => {
  const ctx = await updatingApp(browser);
  const p = await ctx.newPage();
  const calls = () => p.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
  await p.goto(server.url);
  const banner = p.getByTestId("app-update-banner");
  await expect(banner).toContainText("Update available");
  await expect(p.getByTestId("app-update-install")).toHaveText("Install");
  await expect(p.getByTestId("app-update-later")).toHaveText("Later");
  // The portable app's link is not this.
  await expect(p.getByTestId("app-update")).toHaveCount(0);

  // On a board too, out of the board's way, and still nothing installed.
  await p.goto(await newBoardUrl(server, "Banner"));
  await expect(p.getByTestId("board-title")).toHaveText("Banner");
  await expect(banner).toContainText("Update available");
  await p.waitForTimeout(500);
  expect((await calls()).filter((c) => c.startsWith("app_update_install"))).toEqual([]);
  const box = (await banner.boundingBox())!;
  expect(box.height).toBeLessThan(60);
  expect(box.width).toBeLessThan(400);

  // Install (on the landing: a board's join card is a dialog, over it): the offered version; a
  // failure says so and offers Retry, which asks again.
  await p.goto(server.url);
  await p.getByTestId("app-update-install").click();
  await expect(banner).toContainText("Update failed");
  await p.getByTestId("app-update-retry").click();
  await expect(banner).toContainText("Installing…");
  expect((await calls()).filter((c) => c.startsWith("app_update_install"))).toEqual(["app_update_install 9.9.9", "app_update_install 9.9.9"]);
  await ctx.close();
});

test("the installed app's Later hides the banner for the run: another page doesn't bring it back", async ({ browser }) => {
  const ctx = await updatingApp(browser);
  const p = await ctx.newPage();
  await p.goto(server.url);
  await p.getByTestId("app-update-later").click();
  await expect(p.getByTestId("app-update-banner")).toHaveCount(0);
  await p.goto(await newBoardUrl(server, "Later"));
  await expect(p.getByTestId("board-title")).toHaveText("Later");
  await p.waitForTimeout(500);
  await expect(p.getByTestId("app-update-banner")).toHaveCount(0);
  const calls = await p.evaluate(() => (window as unknown as { __calls: string[] }).__calls);
  expect(calls.filter((c) => c.startsWith("app_update_install"))).toEqual([]);
  await ctx.close();
});
