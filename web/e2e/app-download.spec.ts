// The app's downloads (operator, 2026-11-11; desktop/README.md, Releasing): a Windows browser gets
// the installer with a quieter "Portable" beside it, a desktop Linux browser the AppImage with
// ".deb"; a quiet text row under Load a game, the footer, and "Where's my replay?". Every download
// link is a file of the latest release, downloaded in place (no new tab, never a release page).
// Never on other systems (macOS, phones) or inside the app. The footer links the source on every
// system, the app included.

import { type Browser, type Page, expect, test } from "./fixtures";
import { Server } from "./server";

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const UA = {
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  macOs: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
};
const FILE = /^https:\/\/github\.com\/intendednull\/mapcro\/releases\/latest\/download\/mapcro_(x64-setup\.exe|x64-portable\.zip|amd64\.AppImage|amd64\.deb)$/;
const REPO = "https://github.com/intendednull/mapcro";

async function at(browser: Browser, userAgent: string, o: { inApp?: boolean; width?: number } = {}) {
  const ctx = await browser.newContext({ userAgent, viewport: { width: o.width ?? 1440, height: 900 } });
  if (o.inApp)
    await ctx.addInitScript(() => {
      (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: () => Promise.reject("unknown_command") };
    });
  const page = await ctx.newPage();
  await page.goto(server.url);
  await expect(page.getByTestId("open-match")).toBeVisible();
  return { ctx, page };
}

/** Every link on the page to the repo's releases names a file, by a stable name, downloaded in place. */
async function onlyFiles(page: Page) {
  const links = await page.locator('a[href*="/releases"], a[download]').evaluateAll((as) =>
    as.map((a) => ({ href: (a as HTMLAnchorElement).href, download: a.hasAttribute("download"), target: a.getAttribute("target") })),
  );
  for (const l of links) {
    expect(l.href).toMatch(FILE);
    expect(l.download, l.href).toBe(true);
    expect(l.target, l.href).toBeNull();
  }
  return links.length;
}

for (const [os, ua, label, alt, file, altFile] of [
  ["Windows", UA.windows, "Get the Windows app", "Portable", "mapcro_x64-setup.exe", "mapcro_x64-portable.zip"],
  ["Linux", UA.linux, "Get the Linux app", ".deb", "mapcro_amd64.AppImage", "mapcro_amd64.deb"],
] as const) {
  test(`a ${os} browser gets its app: under Load a game, in the footer, and in Where's my replay?`, async ({ browser }) => {
    const { ctx, page } = await at(browser, ua);
    const row = page.getByTestId("app-home");
    await expect(row).toBeVisible();
    await expect(row.getByRole("link", { name: label })).toHaveAttribute("href", new RegExp(`/releases/latest/download/${file.replace(".", "\\.")}$`));
    await expect(row.getByRole("link", { name: alt, exact: true })).toHaveAttribute("href", new RegExp(`/releases/latest/download/${altFile.replace(".", "\\.")}$`));
    // A quiet text row: no button styling.
    await expect(row.locator(".btn")).toHaveCount(0);
    for (const where of ["landing", "help"]) {
      await expect(page.getByTestId(`app-get-${where}`)).toHaveAttribute("href", await page.getByTestId("app-get-home").getAttribute("href") as string);
      await expect(page.getByTestId(`app-alt-${where}`)).toHaveAttribute("href", await page.getByTestId("app-alt-home").getAttribute("href") as string);
      await expect(page.getByTestId(`app-get-${where}`)).toHaveText(label);
    }
    await page.getByTestId("replay-help-open").click();
    await expect(page.getByTestId("replay-help-app")).toContainText(`Or get the ${os} app`);
    expect(await onlyFiles(page)).toBe(6);
    await expect(page.getByTestId("github-landing")).toBeVisible();
    await expect(page.getByTestId("github-landing")).toHaveAttribute("href", REPO);
    await ctx.close();
  });
}

test("a download starts in place: the page stays, no tab opens", async ({ browser }) => {
  const { ctx, page } = await at(browser, UA.windows);
  await ctx.route("https://github.com/**", (r) =>
    r.fulfill({ status: 200, headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="mapcro_x64-setup.exe"' }, body: "MZ" }),
  );
  const url = page.url();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("app-get-home").click()]);
  expect(download.url()).toMatch(/\/releases\/latest\/download\/mapcro_x64-setup\.exe$/);
  expect(page.url()).toBe(url);
  expect(ctx.pages()).toHaveLength(1);
  await expect(page.getByTestId("app-home")).toBeVisible();
  await ctx.close();
});

test("the home row reads quietly on the dark page, at phone width too", async ({ browser }) => {
  for (const width of [1440, 390]) {
    const { ctx, page } = await at(browser, UA.linux, { width });
    const link = page.getByTestId("app-get-home");
    await expect(link).toBeVisible();
    const s = await link.evaluate((a) => {
      const c = getComputedStyle(a);
      return { color: c.color, size: parseFloat(c.fontSize), bg: c.backgroundColor, border: c.borderStyle, animation: c.animationName, right: a.getBoundingClientRect().right };
    });
    // The site's accent, not the browser's default blue (unreadable on the dark page).
    expect(s.color).toBe("rgb(142, 224, 196)");
    expect(s.size).toBeLessThanOrEqual(13);
    expect(s.bg).toBe("rgba(0, 0, 0, 0)");
    expect(s.border).toBe("none");
    expect(s.animation).toBe("none");
    expect(s.right).toBeLessThanOrEqual(width);
    // The footer's links: its size, the quiet text colour (not the browser's blue), alt included.
    for (const id of ["app-get-landing", "app-alt-landing", "github-landing"]) {
      const f = await page.getByTestId(id).evaluate((a) => ({ color: getComputedStyle(a).color, size: getComputedStyle(a).fontSize }));
      expect(f, id).toEqual({ color: "rgb(147, 168, 160)", size: "11.5px" });
    }
    await ctx.close();
  }
});

test("other systems and the app itself get no download; the footer's GitHub shows everywhere", async ({ browser }) => {
  for (const [ua, inApp] of [[UA.macOs, false], [UA.android, false], [UA.windows, true], [UA.linux, true]] as const) {
    const { ctx, page } = await at(browser, ua, { inApp });
    await expect(page.getByTestId("app-home"), ua).toHaveCount(0);
    await expect(page.getByTestId("app-get-landing")).toHaveCount(0);
    await expect(page.locator("a[download]")).toHaveCount(0);
    const gh = page.getByTestId("github-landing");
    await expect(gh).toBeVisible();
    await expect(gh).toHaveText("GitHub");
    await expect(gh).toHaveAttribute("href", REPO);
    // In the app it's a plain navigation (the app hands it to the system browser); a new tab elsewhere.
    if (inApp) await expect(gh).not.toHaveAttribute("target", /.+/);
    else await expect(gh).toHaveAttribute("target", "_blank");
    await ctx.close();
  }
});
