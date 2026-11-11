// A smoke test of the real app (desktop/README.md, Smoke test): a debug build, driven over
// WebDriver by tauri-driver (WebKitWebDriver on Linux, msedgedriver on Windows), pointed at a page
// this script serves with the site's own CSP (`MAPCRO_URL`, which only a debug build takes).
// It checks that the page loads, that the IPC bridge is there and answers our commands, that the
// page can't reach any plugin, and (with --fake-steam) that the app finds a fake Steam install's
// replays folder and lists its replays, as the replay picker asks for them (`replays_list`).
// It never calls `replays_choose_folder`: that opens the native folder dialog.
//
//   node desktop/smoke/smoke.mjs <app binary> [--fake-steam]
//
// Env: TAURI_DRIVER (default `tauri-driver` on PATH), NATIVE_DRIVER (passed as --native-driver;
// default: the driver's own lookup). --fake-steam writes the layout under a temp dir, never real
// demos: each `<digits>.dem` is the 8-byte magic plus zeros, so no player data. On Linux the
// Steam root is found through XDG_DATA_HOME (steamlocate's `$XDG_DATA_HOME/Steam`); on Windows
// it needs the registry value, which only the CI job writes (`.github/workflows/desktop.yml`).
// No dependencies: the WebDriver calls are plain fetch.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// The CSP the live site sends, read from the server's source so the two can't drift apart.
const main = readFileSync(join(ROOT, "crates/server/src/main.rs"), "utf8");
const csp = /"content-security-policy",\s*"((?:[^"\\]|\\.)*)"/s.exec(main)?.[1].replace(/\\\r?\n\s*/g, "");
if (!csp?.includes("connect-src")) throw new Error("couldn't read the CSP from crates/server/src/main.rs");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>mapcro smoke</title></head>
<body><p id="ready">ready</p></body></html>`;

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

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}/`;

const env = { ...process.env, MAPCRO_URL: site };
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

  // No plugin, core or otherwise, is the page's to call.
  for (const [cmd, args] of [
    ["plugin:opener|open_url", { url: "https://example.com/" }],
    ["plugin:dialog|open", { options: { directory: true } }],
    ["plugin:updater|check", {}],
    ["plugin:window|close", {}],
    ["plugin:webview|print", {}],
    ["plugin:event|emit", { event: "x" }],
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
} catch (e) {
  check("the run", false, e.message);
} finally {
  if (session) await wd("DELETE", `/session/${session}`).catch(() => {});
  driver.kill();
  server.close();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
