// A smoke test of the real app (desktop/README.md, Smoke test): a debug build, driven over
// WebDriver by tauri-driver (WebKitWebDriver on Linux, msedgedriver on Windows), pointed at a page
// this script serves with the site's own CSP (`MAPCRO_URL`, which only a debug build takes).
// It checks that the page loads, that the IPC bridge is there and answers our commands, that the
// page can't reach any plugin, and (with --fake-steam) that the app finds a fake Steam install's
// replays folder and lists its replays, as the replay picker asks for them (`replays_list`).
// It never calls `replays_choose_folder`: that opens the native folder dialog.
// mapcro:// links (desktop/README.md, Deep links): a second launch with a board link hands it to
// the running app (the single-instance plugin), whose window opens the board on the site, and a
// link that isn't a board's changes nothing; then the app started by a link opens on its board.
// On Linux the hand-off needs a D-Bus session (`just desktop-smoke` runs a private one); without
// one those checks are skipped. The links are synthetic (no real board or token).
//
//   node desktop/smoke/smoke.mjs <app binary> [--fake-steam]
//
// Env: TAURI_DRIVER (default `tauri-driver` on PATH), NATIVE_DRIVER (passed as --native-driver;
// default: the driver's own lookup). --fake-steam writes the layout under a temp dir, never real
// demos: each `<digits>.dem` is the 8-byte magic plus zeros, so no player data. On Linux the
// Steam root is found through XDG_DATA_HOME (steamlocate's `$XDG_DATA_HOME/Steam`); on Windows
// it needs the registry value, which only the CI job writes (`.github/workflows/desktop.yml`).
// No dependencies: the WebDriver calls are plain fetch.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [app, ...flags] = process.argv.slice(2);
if (!app) {
  console.error("usage: node desktop/smoke/smoke.mjs <app binary> [--fake-steam]");
  process.exit(2);
}
const fakeSteam = flags.includes("--fake-steam");
/** Synthetic match ids for the fake replays folder (newest first, as `replays_list` gives them). */
const IDS = ["990000003", "990000002", "990000001"];
const DRIVER_PORT = 4444;
/** A synthetic board link, the shapes of the site's (spec §11), and the same board's other token. */
const BOARD = "SmokeBoardAbcdefghij01";
const TOKEN = "smoke-token-0123456789abcdefghijklmnopqrstu";
const TOKEN2 = "smoke-token-ZYXWVUTSRQPONMLKJIHGFEDCBA98765";
const handOff = process.platform !== "linux" || !!process.env.DBUS_SESSION_BUS_ADDRESS;

// The CSP the live site sends, read from the server's source so the two can't drift apart.
const main = readFileSync(join(ROOT, "crates/server/src/main.rs"), "utf8");
const csp = /"content-security-policy",\s*"((?:[^"\\]|\\.)*)"/s.exec(main)?.[1].replace(/\\\r?\n\s*/g, "");
if (!csp?.includes("connect-src")) throw new Error("couldn't read the CSP from crates/server/src/main.rs");

/** Synthetic off-site links (a reserved TLD: nothing resolves), a plain one and two that ask for
 * a new window, and same-site ones that ask for a new window. */
const OFF_BLANK = "https://smoke.example.invalid/blank";
const OFF_OPEN = "https://smoke.example.invalid/open";
const OFF_NAV = "https://smoke.example.invalid/nav";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>mapcro smoke</title></head>
<body><p id="ready">ready</p>
<p><a id="off-blank" href="${OFF_BLANK}" target="_blank" rel="noopener">off-site, new window</a></p>
<p><button id="off-open" type="button">window.open</button></p>
<p><a id="off-nav" href="${OFF_NAV}">off-site</a></p>
<p><a id="in-blank" href="/smoke-in-blank" target="_blank">same site, new window</a></p>
<p><button id="in-open" type="button">same site, window.open</button></p>
<script src="/smoke.js"></script></body></html>`;
/** As a file, not inline: the site's CSP has no 'unsafe-inline' for scripts. */
const SCRIPT = `document.getElementById("off-open").addEventListener("click", () => window.open(${JSON.stringify(OFF_OPEN)}, "_blank"));
document.getElementById("in-open").addEventListener("click", () => window.open("/smoke-in", "_blank"));`;

/** Writes Steam's layout for one library holding Deadlock, with three synthetic replays. */
function writeFakeSteam(steam) {
  const replays = join(steam, "steamapps/common/Deadlock/game/citadel/replays");
  mkdirSync(replays, { recursive: true });
  const path = steam.replaceAll("\\", "\\\\");
  writeFileSync(
    join(steam, "steamapps/libraryfolders.vdf"),
    `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${path}"\n\t\t"apps"\n\t\t{\n\t\t\t"1422450"\t\t"1"\n\t\t}\n\t}\n}\n`,
  );
  writeFileSync(join(steam, "steamapps/appmanifest_1422450.acf"), `"AppState"\n{\n\t"appid"\t\t"1422450"\n\t"installdir"\t\t"Deadlock"\n}\n`);
  // Oldest first, so the newest has the latest time.
  [...IDS].reverse().forEach((id, i) => {
    const dem = Buffer.alloc(4096);
    dem.write("PBDEMS2\0", 0, "latin1");
    const f = join(replays, `${id}.dem`);
    writeFileSync(f, dem);
    const t = new Date(Date.now() - (IDS.length - i) * 60_000);
    utimesSync(f, t, t);
  });
  return replays;
}

async function wd(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${DRIVER_PORT}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j.value ?? j)}`);
  return j.value;
}

async function until(what, f, ms = 30_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out: ${what}${last ? ` (${last.message})` : ""}`);
}

const failures = [];
function check(name, ok, detail) {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail === undefined ? "" : `: ${detail}`}`);
  if (!ok) failures.push(name);
}

/** A second launch of the app with one argument, as the system starts it for a link. It hands the
 * link to the running app and exits. */
function launch(arg) {
  return new Promise((done) => {
    const p = spawn(resolve(app), [arg], { env, stdio: "ignore" });
    const t = setTimeout(() => (p.kill(), done()), 15_000);
    p.on("exit", () => (clearTimeout(t), done()));
    p.on("error", () => (clearTimeout(t), done()));
  });
}

const server = createServer((req, res) => {
  const js = req.url === "/smoke.js";
  res.writeHead(200, { "content-type": js ? "text/javascript" : "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" });
  res.end(js ? SCRIPT : PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}/`;

const env = { ...process.env, MAPCRO_URL: site };
// Links off the site: on Linux the opener runs `xdg-open <url>` (the `open` crate, first on its
// list); a stand-in first on PATH records each URL instead of starting a browser. Elsewhere the
// opener is the system's (Windows: ShellExecute), so those checks are Linux only.
const opened = process.platform === "linux" ? join(mkdtempSync(join(tmpdir(), "mapcro-smoke-open-")), "opened.txt") : undefined;
if (opened) {
  const bin = dirname(opened);
  writeFileSync(join(bin, "xdg-open"), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o755 });
  env.PATH = `${bin}:${env.PATH ?? ""}`;
}
const openedUrls = () => (opened && existsSync(opened) ? readFileSync(opened, "utf8").split("\n").filter(Boolean) : []);
if (fakeSteam) {
  if (process.platform === "linux") {
    const xdg = mkdtempSync(join(tmpdir(), "mapcro-smoke-"));
    writeFakeSteam(join(xdg, "Steam"));
    env.XDG_DATA_HOME = xdg;
  } else if (!process.env.MAPCRO_SMOKE_STEAM) {
    throw new Error("--fake-steam on Windows: set MAPCRO_SMOKE_STEAM to the root the registry names (CI does)");
  } else {
    writeFakeSteam(process.env.MAPCRO_SMOKE_STEAM);
  }
}

const driverArgs = ["--port", String(DRIVER_PORT)];
if (process.env.NATIVE_DRIVER) driverArgs.push("--native-driver", process.env.NATIVE_DRIVER);
const driver = spawn(process.env.TAURI_DRIVER ?? "tauri-driver", driverArgs, { env, stdio: ["ignore", "inherit", "inherit"] });
let session;
try {
  await until("tauri-driver up", () => wd("GET", "/status").then(() => true), 20_000);
  const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: resolve(app) } } } });
  session = s.sessionId;
  const exec = (script) =>
    wd("POST", `/session/${session}/execute/async`, {
      script: `const done = arguments[arguments.length - 1]; (async () => { ${script} })().then((v) => done({ v }), (e) => done({ e: String(e) }));`,
      args: [],
    });

  // The page loads: the window is on our server, and the body rendered.
  const url = await until("the page", async () => {
    const u = await wd("GET", `/session/${session}/url`);
    return u.startsWith(site) && (await exec("return document.getElementById('ready')?.textContent")).v === "ready" ? u : null;
  });
  check("the page loads from MAPCRO_URL", true, url);

  // The bridge: Tauri's IPC is injected, and our own command answers.
  const bridge = await exec("return typeof window.__TAURI_INTERNALS__?.invoke");
  check("the IPC bridge is present", bridge.v === "function", JSON.stringify(bridge));
  const call = (cmd, args = {}) => exec(`return await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const bad = await call("replay_read", { id: "../1" });
  check("replay_read refuses an id that isn't digits", bad.e === "bad_id", JSON.stringify(bad));
  // The installed build updates itself: it tells the page of no update (only portable does).
  const upd = await call("app_update");
  check("app_update answers nothing in the installed build", "v" in upd && upd.v === null, JSON.stringify(upd));

  // No plugin, core or otherwise, is the page's to call.
  for (const [cmd, args] of [
    ["plugin:opener|open_url", { url: "https://example.com/" }],
    ["plugin:dialog|open", { options: { directory: true } }],
    ["plugin:updater|check", {}],
    ["plugin:window|close", {}],
    ["plugin:webview|print", {}],
    ["plugin:event|emit", { event: "x" }],
    ["plugin:deep-link|get_current", {}],
    ["plugin:deep-link|register", { protocol: "x" }],
  ]) {
    const r = await call(cmd, args);
    check(`${cmd} is refused`, "e" in r && /not allowed|not found|denied/i.test(r.e), JSON.stringify(r));
  }

  // The replays folder: listed through the bridge (a fake Steam install), or not found.
  if (fakeSteam) {
    const list = await until("the fake replays folder", async () => {
      const r = await call("replays_list");
      return Array.isArray(r.v) && r.v.length > 0 ? r.v : null;
    });
    const ids = list.map((r) => r.id);
    check("replays_list finds the fake Steam's replays, newest first", JSON.stringify(ids) === JSON.stringify(IDS), JSON.stringify(ids));
    check("each replay has its size", list.every((r) => r.size === 4096), JSON.stringify(list.map((r) => r.size)));
  } else {
    const r = await call("replays_list");
    check("replays_list answers", Array.isArray(r.v) || r.e === "not_found", JSON.stringify(r).slice(0, 200));
  }

  // Links from the page (desktop/README.md, Links off the site): off the site, a plain link and
  // window.open go to the system browser and leave the window where it was; a same-site
  // window.open opens in this window; no second window opens. A target=_blank link takes
  // window.open's path on Windows (WebView2's NewWindowRequested); under WebKitWebDriver its click
  // raises no new-window request at all, so here it is only checked to open nothing.
  if (opened) {
    const page = () => wd("GET", `/session/${session}/url`);
    const handles = async () => (await wd("GET", `/session/${session}/window/handles`)).length;
    const click = async (css) => {
      const el = await wd("POST", `/session/${session}/element`, { using: "css selector", value: css });
      await wd("POST", `/session/${session}/element/${Object.values(el)[0]}/click`, {});
    };
    for (const [css, want, what] of [
      ["#off-open", OFF_OPEN, "an off-site window.open"],
      ["#off-nav", OFF_NAV, "an off-site link"],
    ]) {
      await click(css);
      const got = await until(`${what} handed to the opener`, async () => (openedUrls().includes(want) ? true : null), 10_000).catch(() => false);
      check(`${what} opens in the system browser`, got, got ? undefined : JSON.stringify(openedUrls()));
      check(`${what} opens no window`, (await handles()) === 1, String(await handles()));
      check(`${what} leaves the window on the site`, (await page()) === site, await page());
    }
    for (const css of ["#off-blank", "#in-blank"]) {
      await click(css);
      await new Promise((r) => setTimeout(r, 1500));
      check(`a target=_blank link (${css}) opens no window`, (await handles()) === 1, String(await handles()));
      check(`a target=_blank link (${css}) leaves the window on the site`, (await page()) === site, await page());
    }
    await click("#in-open");
    const inApp = await until("the same-site window.open in the window", async () => ((await page()) === `${site}smoke-in` ? true : null), 10_000).catch(() => false);
    check("a same-site window.open opens in the window", inApp, inApp ? undefined : await page());
    check("a same-site window.open opens no window", (await handles()) === 1, String(await handles()));
    check("nothing on the site is handed to the opener", !openedUrls().some((u) => u.startsWith(site)), JSON.stringify(openedUrls()));
  } else {
    console.log("skip links off the site: the opener is the system's here (Linux only)");
  }

  // A mapcro:// link, handed from a second launch to this one.
  if (handOff) {
    const page = () => wd("GET", `/session/${session}/url`);
    const board = `${site}b/${BOARD}`;
    await launch(`mapcro://b/${BOARD}#${TOKEN}`);
    const opened = await until("the board link opened", async () => ((await page()) === `${board}#${TOKEN}` ? true : null), 20_000).catch(() => false);
    check("a second launch's mapcro:// link opens the board in the window", opened, opened ? undefined : await page());
    await launch(`mapcro://b/${BOARD}#${TOKEN2}`);
    const again = await until("the other token", async () => ((await page()) === `${board}#${TOKEN2}` ? true : null), 20_000).catch(() => false);
    check("the same board with another token is followed", again, again ? undefined : await page());
    for (const bad of [`mapcro://evil.example/b/${BOARD}#${TOKEN}`, `mapcro://b/${BOARD}#short`, `mapcro://b/${BOARD}?x#${TOKEN}`]) {
      await launch(bad);
    }
    await new Promise((r) => setTimeout(r, 3000));
    const still = await page();
    check("a link that isn't a board's changes nothing", still === `${board}#${TOKEN2}`, still);
  } else {
    console.log("skip mapcro:// hand-off: no D-Bus session (run under dbus-run-session)");
  }
} catch (e) {
  check("the run", false, e.message);
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
}

// The app started by a link opens on its board.
session = undefined;
const link = `mapcro://b/${BOARD}#${TOKEN}`;
const want = `${site}b/${BOARD}#${TOKEN}`;
if (process.platform === "win32") {
  // msedgedriver turns each `args` entry into a lowercased `--` switch, so it can't start the app
  // with a link. Start it as the system does instead, with WebView2's DevTools on a port (the debug
  // build passes WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS on under TAURI_WEBVIEW_AUTOMATION), and read
  // the page's URL from the DevTools target list.
  spawnSync("taskkill", ["/F", "/T", "/IM", basename(app)], { stdio: "ignore" });
  const cdp = 9223;
  const p = spawn(resolve(app), [link], {
    env: {
      ...env,
      TAURI_WEBVIEW_AUTOMATION: "true",
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdp}`,
      WEBVIEW2_USER_DATA_FOLDER: mkdtempSync(join(tmpdir(), "mapcro-smoke-wv2-")),
    },
    stdio: "ignore",
  });
  try {
    const url = await until("the first page", async () => {
      const targets = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
      return targets.find((t) => t.type === "page" && t.url.startsWith(site))?.url ?? null;
    });
    check("started by a mapcro:// link, the app opens on its board", url === want, url);
  } catch (e) {
    check("the start by a link", false, e.message);
  } finally {
    p.kill();
    spawnSync("taskkill", ["/F", "/T", "/IM", basename(app)], { stdio: "ignore" });
    driver.kill();
    server.close();
  }
  console.log(failures.length ? `${failures.length} failed` : "all passed");
  process.exit(failures.length ? 1 : 0);
}
try {
  const s = await wd("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: resolve(app), args: [link] } } } });
  session = s.sessionId;
  const url = await until("the first page", async () => {
    const u = await wd("GET", `/session/${session}/url`);
    return u.startsWith(site) ? u : null;
  });
  check("started by a mapcro:// link, the app opens on its board", url === want, url);
} catch (e) {
  check("the start by a link", false, e.message);
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  driver.kill();
  server.close();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
