#!/usr/bin/env node
// Background daemon for tools/qa-browser.
// Owns a Playwright Chromium browser (one isolated BrowserContext per tab),
// an optional local mapcro-server process, an optional reference-replay queue responder,
// and a Unix domain socket RPC server at /tmp/qa-browser-<id>.sock.

import { spawn, execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");

const ALLOWED_SHOT_ROOTS = [
  "/tmp",
  "/home/intendednull/concierge/artifacts",
];

// ---- Playwright resolution (zero new dependencies; reuses web/node_modules) ----

function findGitCommonRoot() {
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!common) return null;
    const abs = resolve(REPO_ROOT, common);
    // For main checkout, common is `<root>/.git`; for a worktree, `<main>/.git`.
    return dirname(abs);
  } catch {
    return null;
  }
}

function loadPlaywright() {
  const mainRoot = findGitCommonRoot();
  const candidates = [
    join(REPO_ROOT, "web/node_modules/playwright/index.js"),
    ...(mainRoot && mainRoot !== REPO_ROOT
      ? [join(mainRoot, "web/node_modules/playwright/index.js")]
      : []),
    "/storage/projects/mapcro/web/node_modules/playwright/index.js",
    "/tmp/lead-gate/web/node_modules/playwright/index.js",
  ];
  const req = createRequire(import.meta.url);
  for (const p of candidates) {
    if (existsSync(p)) {
      return req(p);
    }
  }
  // Fallback to standard Node resolution (e.g. NODE_PATH).
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return req(name);
    } catch {
      // try next
    }
  }
  throw new Error(
    `Could not locate Playwright. Checked:\n${candidates.map((c) => `  - ${c}`).join("\n")}\nRun inside nix develop with web/node_modules installed.`,
  );
}

// ---- Local mapcro-server launcher (matches web/test/support/server.ts) ----

function unusedPort() {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => ok(port));
    });
  });
}

function portAfter(line, prefix) {
  const t = line.trimEnd();
  if (!t.startsWith(prefix)) return undefined;
  const m = /:(\d+)$/.exec(t);
  return m ? Number(m[1]) : undefined;
}

function spawnServerOnce(bin, port, env, logFile) {
  const child = spawn(bin, [], {
    env: { ...env, PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  return new Promise((ok, fail) => {
    let settled = false;
    let seen = "";
    let partial = "";
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      fail(new Error(`mapcro-server did not listen within 30s: ${seen.trimEnd()}`));
    }, 30_000);
    const settle = () => {
      settled = true;
      clearTimeout(timer);
    };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (logFile) {
        try {
          writeFileSync(logFile, chunk, { flag: "a" });
        } catch {
          // ignore log errors
        }
      }
      if (settled) return;
      seen += chunk;
      const lines = (partial + chunk).split("\n");
      partial = lines.pop();
      for (const line of lines) {
        const p = portAfter(line, "mapcro-server: listening on ");
        if (p !== undefined) {
          settle();
          ok({ child, port: p });
          return;
        }
      }
    });
    child.once("error", (e) => {
      if (settled) return;
      settle();
      fail(e);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settle();
      const err = new Error(
        `mapcro-server exited before listening (${signal ? `signal ${signal}` : `exit ${code}`}): ${seen.trimEnd()}`,
      );
      err.bindFailed = seen.includes("cannot bind");
      fail(err);
    });
  });
}

async function startLocalServer(opts) {
  const mainRoot = findGitCommonRoot();
  const binCandidates = [
    opts.serverBin,
    join(REPO_ROOT, "target/debug/mapcro-server"),
    ...(mainRoot && mainRoot !== REPO_ROOT
      ? [join(mainRoot, "target/debug/mapcro-server")]
      : []),
    "/tmp/lead-gate/target/debug/mapcro-server",
  ].filter(Boolean);
  const bin = binCandidates.find((p) => existsSync(p));
  if (!bin) {
    throw new Error(
      `No mapcro-server binary found. Tried:\n${binCandidates.map((c) => `  - ${c}`).join("\n")}\nBuild with \`cargo build -p mapcro-server\` or pass --server-bin.`,
    );
  }

  const webCandidates = [
    opts.webDir,
    join(REPO_ROOT, "web/dist"),
    "/tmp/lead-gate/web/dist",
    ...(mainRoot && mainRoot !== REPO_ROOT ? [join(mainRoot, "web/dist")] : []),
  ].filter(Boolean);
  const webDir = webCandidates.find((p) => existsSync(join(p, "index.html")));
  if (!webDir) {
    throw new Error(
      `No built web/dist found (missing index.html). Tried:\n${webCandidates.map((c) => `  - ${c}`).join("\n")}\nBuild with \`just wasm && (cd web && npx vite build)\` or pass --web-dir.`,
    );
  }

  const defaultPacks = join(homedir(), ".local/share/mapcro/packs");
  const packsDir =
    opts.packsDir || (existsSync(defaultPacks) ? defaultPacks : undefined);

  const dataDir = join(opts.workDir, "data");
  const replayDir = opts.replayDir || join(opts.workDir, "replays");
  mkdirSync(join(dataDir, "replays"), { recursive: true });
  mkdirSync(join(replayDir, "inbox"), { recursive: true });
  mkdirSync(join(replayDir, "outbox"), { recursive: true });
  mkdirSync(join(replayDir, "work"), { recursive: true });

  const env = {
    ...process.env,
    DATA_DIR: dataDir,
    WEB_DIR: webDir,
    REPLAY_DIR: replayDir,
    RUST_LOG: "warn",
    CREATE_PER_HOUR: "1000",
    REPLAY_PER_CLIENT_PER_HOUR: "200",
  };
  if (packsDir) env.PACKS_DIR = packsDir;
  if (opts.matchApiBase) {
    env.MATCH_API_BASE = opts.matchApiBase;
  } else if (opts.mockReplay129738985) {
    // Fail fast on uncached upstream lookups while serving cached/mocked 129738985.
    env.MATCH_API_BASE = "http://127.0.0.1:9";
  }

  const logFile = join(opts.workDir, "server.log");
  let started = null;
  for (let i = 0; i < 20; i++) {
    const port = await unusedPort();
    try {
      started = await spawnServerOnce(
        bin,
        port,
        { ...env, PUBLIC_ORIGIN: `http://127.0.0.1:${port}` },
        logFile,
      );
      break;
    } catch (e) {
      if (!e.bindFailed || i === 19) throw e;
    }
  }
  return {
    child: started.child,
    port: started.port,
    url: `http://127.0.0.1:${started.port}`,
    bin,
    webDir,
    packsDir: packsDir || null,
    dataDir,
    replayDir,
  };
}

// ---- Screenshot path guardrail (HARD: never write inside repo/worktrees) ----

function hasGitAncestor(dir) {
  let cur = resolve(dir);
  for (;;) {
    // Stop at allowed screenshot roots so a stray /tmp/.git never blocks /tmp/<subdir>/...,
    // while git checkouts inside /tmp (like /tmp/lead-gate) are still caught and refused.
    if (ALLOWED_SHOT_ROOTS.includes(cur)) return false;
    if (existsSync(join(cur, ".git"))) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function validateShotPath(outPath) {
  if (!outPath || typeof outPath !== "string") {
    throw new Error("shot requires an output path (e.g. /tmp/qa/shot.png)");
  }
  const abs = resolve(outPath);
  // Resolve symlinks on the deepest existing ancestor so a symlink in /tmp pointing into the repo is caught.
  let existing = abs;
  const tail = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(existing.slice(parent.length).replace(/^\/+/, ""));
    existing = parent;
  }
  let realAbs = abs;
  try {
    realAbs = join(realpathSync(existing), ...tail);
  } catch {
    realAbs = abs;
  }

  // Hard block on mapcro repo, worktrees, or any git repository.
  const forbiddenPrefixes = [
    "/storage/projects/mapcro",
    REPO_ROOT,
  ];
  for (const p of [abs, realAbs]) {
    for (const bad of forbiddenPrefixes) {
      if (p === bad || p.startsWith(bad + sep)) {
        throw new Error(
          `REFUSED: screenshot path "${outPath}" resolves inside the repository (${p}). Game art screenshots must never enter the repo; write under /tmp/ or /home/intendednull/concierge/artifacts/.`,
        );
      }
    }
    if (hasGitAncestor(dirname(p))) {
      throw new Error(
        `REFUSED: screenshot path "${outPath}" is inside a git repository (${p}). Write under /tmp/ or /home/intendednull/concierge/artifacts/.`,
      );
    }
  }

  // Allow-list check on both lexical and symlink-resolved paths.
  const isAllowed = (p) =>
    ALLOWED_SHOT_ROOTS.some((root) => p === root || p.startsWith(root + sep));
  if (!isAllowed(abs) || !isAllowed(realAbs)) {
    throw new Error(
      `REFUSED: screenshot path "${outPath}" (resolved: ${realAbs}) is outside allowed directories (${ALLOWED_SHOT_ROOTS.join(", ")}).`,
    );
  }
  return realAbs;
}

// ---- Selector helper ----

function normalizeSelector(sel) {
  if (typeof sel !== "string" || !sel.trim()) {
    throw new Error("Selector must be a non-empty string");
  }
  if (sel.startsWith("testid:")) {
    return `[data-testid="${sel.slice("testid:".length)}"]`;
  }
  return sel;
}

function parseViewport(spec) {
  if (!spec) return { width: 1440, height: 900 };
  const m = /^(\d+)x(\d+)$/i.exec(String(spec).trim());
  if (!m) throw new Error(`Invalid viewport "${spec}" (expected WxH, e.g. 1440x900)`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

// ---- Snapshot script run inside the page ----

function buildSnapshotInPage(maxInteractive) {
  const vis = (el) => {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const clip = (s, n = 64) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };

  const headings = [...document.querySelectorAll("h1, h2, h3, h4")]
    .filter(vis)
    .slice(0, 12)
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      text: clip(el.textContent, 80),
      testid: el.getAttribute("data-testid") || undefined,
    }));

  const overlaySel =
    '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [role="menu"], .toast, .banner, .modal, .sheet, .popover, .context-menu, [data-testid*="toast"], [data-testid*="banner"], [data-testid*="dialog"], [data-testid*="modal"]';
  const overlays = [...document.querySelectorAll(overlaySel)]
    .filter(vis)
    .slice(0, 16)
    .map((el) => ({
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      testid: el.getAttribute("data-testid") || undefined,
      text: clip(el.textContent, 120),
      box: box(el),
    }));

  const interSel = [
    "button",
    "a[href]",
    "input",
    "select",
    "textarea",
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="slider"]',
    '[role="option"]',
    "[data-testid]",
  ].join(", ");

  const all = [...document.querySelectorAll(interSel)].filter(vis);
  const items = [];
  for (const el of all) {
    if (items.length >= maxInteractive) break;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || undefined;
    const testid = el.getAttribute("data-testid") || undefined;
    const isNativeInteractive =
      tag === "button" ||
      tag === "a" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      Boolean(role);
    // Keep non-interactive data-testid containers only if they carry short direct text or are key landmarks.
    if (!isNativeInteractive && !testid) continue;
    const aria = el.getAttribute("aria-label") || undefined;
    const title = el.getAttribute("title") || undefined;
    const label = clip(
      aria ||
        (tag === "input" ? el.getAttribute("placeholder") : "") ||
        el.innerText ||
        el.textContent ||
        title ||
        "",
      60,
    );
    const state = {};
    if (el.disabled || el.getAttribute("aria-disabled") === "true") state.disabled = true;
    if (el.checked === true || el.getAttribute("aria-checked") === "true") state.checked = true;
    if (el.getAttribute("aria-pressed") === "true") state.pressed = true;
    if (el.getAttribute("aria-expanded") !== null) {
      state.expanded = el.getAttribute("aria-expanded") === "true";
    }
    if (el.getAttribute("aria-selected") === "true") state.selected = true;
    if (
      (tag === "input" || tag === "textarea" || tag === "select") &&
      "value" in el &&
      el.type !== "password"
    ) {
      const v = String(el.value ?? "");
      if (v) state.value = clip(v, 40);
    }
    items.push({
      sel: testid ? `[data-testid="${testid}"]` : tag,
      tag,
      ...(role ? { role } : {}),
      ...(label ? { label } : {}),
      ...(title && title !== label ? { title: clip(title, 50) } : {}),
      ...(Object.keys(state).length ? { state } : {}),
      box: box(el),
    });
  }

  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    headings,
    overlays,
    interactive: items,
    totalVisibleCandidates: all.length,
  };
}

// ---- Daemon main ----

async function main() {
  const opts = JSON.parse(process.argv[2]);
  const { id, sockPath, workDir, headless } = opts;
  mkdirSync(workDir, { recursive: true });

  const pw = loadPlaywright();
  let serverInfo = null;
  let baseUrl = opts.url || null;

  if (!baseUrl) {
    serverInfo = await startLocalServer(opts);
    baseUrl = serverInfo.url;
  }

  // Reference-replay responder (seeds DATA_DIR/replays and watches REPLAY_DIR/inbox).
  const replaySources = new Map(); // matchId -> sourceJsonPath
  const answeredJobs = new Set();
  let replayTimer = null;

  function registerReplayFeed(matchId, sourcePath) {
    const idStr = String(matchId).trim();
    if (!/^\d+$/.test(idStr)) {
      throw new Error(`Invalid matchId "${matchId}" (expected digits)`);
    }
    const src =
      sourcePath ||
      join(homedir(), `.local/share/mapcro/data/replays/${idStr}-cdn.json`);
    if (!existsSync(src)) {
      throw new Error(`Replay timeline source not found: ${src}`);
    }
    replaySources.set(idStr, src);

    let seededCache = false;
    if (serverInfo?.dataDir) {
      const cacheDir = join(serverInfo.dataDir, "replays");
      mkdirSync(cacheDir, { recursive: true });
      copyFileSync(src, join(cacheDir, `${idStr}-cdn.json`));
      seededCache = true;
    }

    const answeredNow = scanReplayInbox();
    if (!replayTimer && serverInfo?.replayDir) {
      replayTimer = setInterval(() => {
        try {
          scanReplayInbox();
        } catch {
          // ignore transient fs errors
        }
      }, 300);
      replayTimer.unref();
    }
    return { matchId: idStr, source: src, seededCache, answeredNow };
  }

  function scanReplayInbox() {
    if (!serverInfo?.replayDir || replaySources.size === 0) return 0;
    const inbox = join(serverInfo.replayDir, "inbox");
    const outbox = join(serverInfo.replayDir, "outbox");
    if (!existsSync(inbox)) return 0;
    let count = 0;
    for (const file of readdirSync(inbox)) {
      if (!file.endsWith(".dem") || answeredJobs.has(file)) continue;
      for (const [matchId, src] of replaySources.entries()) {
        if (file.startsWith(`${matchId}-`)) {
          const outName = file.replace(/\.dem$/, ".json");
          const tmpOut = join(outbox, `.${outName}.tmp`);
          copyFileSync(src, tmpOut);
          // Atomic rename into outbox so the server never reads a half-written file.
          renameSync(tmpOut, join(outbox, outName));
          answeredJobs.add(file);
          count++;
        }
      }
    }
    return count;
  }

  let mockReplayInfo = null;
  if (opts.mockReplay129738985) {
    mockReplayInfo = registerReplayFeed("129738985");
  }

  const browser = await pw.chromium.launch({
    headless: headless !== false,
  });

  // tabName -> { context, page, logs }
  const tabs = new Map();

  function requireTab(name) {
    const t = tabs.get(name);
    if (!t) {
      const openNames = [...tabs.keys()];
      throw new Error(
        `Unknown tab "${name}". Open tabs: ${openNames.length ? openNames.join(", ") : "(none)"}`,
      );
    }
    return t;
  }

  function resolveUrl(urlOrPath) {
    if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
    if (!baseUrl) {
      throw new Error(`Relative URL "${urlOrPath}" requires a session base URL`);
    }
    return new URL(urlOrPath, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/").href;
  }

  async function handleCommand(req) {
    const { cmd, args = {} } = req;
    const timeout = Number(args.timeout) || 10_000;

    switch (cmd) {
      case "ping":
      case "status":
        return {
          id,
          pid: process.pid,
          serverPid: serverInfo?.child?.pid ?? null,
          baseUrl,
          serverBin: serverInfo?.bin ?? null,
          webDir: serverInfo?.webDir ?? null,
          packsDir: serverInfo?.packsDir ?? null,
          mockReplay: mockReplayInfo,
          tabs: [...tabs.keys()],
        };

      case "feed-replay":
        return registerReplayFeed(args.matchId, args.source);

      case "open": {
        const name = args.tab;
        if (!name) throw new Error("open requires <tab>");
        const targetUrl = resolveUrl(args.url || "/");
        const vp = args.viewport ? parseViewport(args.viewport) : null;
        let entry = tabs.get(name);
        if (!entry) {
          const viewport = vp || { width: 1440, height: 900 };
          const ctxOpts = { viewport };
          if (args.touch) {
            ctxOpts.hasTouch = true;
            if (viewport.width <= 500) ctxOpts.isMobile = true;
          }
          const context = await browser.newContext(ctxOpts);
          const page = await context.newPage();
          page.setDefaultTimeout(timeout);
          const logs = {
            consoleErrors: [],
            consoleWarnings: [],
            pageErrors: [],
            networkErrors: [],
          };
          page.on("console", (msg) => {
            const type = msg.type();
            if (type === "error") {
              logs.consoleErrors.push({ ts: Date.now(), text: msg.text() });
            } else if (type === "warning") {
              logs.consoleWarnings.push({ ts: Date.now(), text: msg.text() });
            }
          });
          page.on("pageerror", (err) => {
            logs.pageErrors.push({ ts: Date.now(), text: String(err?.stack || err) });
          });
          page.on("requestfailed", (request) => {
            logs.networkErrors.push({
              ts: Date.now(),
              kind: "requestfailed",
              method: request.method(),
              url: request.url(),
              error: request.failure()?.errorText || "failed",
            });
          });
          page.on("response", (response) => {
            if (response.status() >= 400) {
              logs.networkErrors.push({
                ts: Date.now(),
                kind: "http",
                status: response.status(),
                method: response.request().method(),
                url: response.url(),
              });
            }
          });
          entry = { context, page, logs };
          tabs.set(name, entry);
        } else if (vp) {
          await entry.page.setViewportSize(vp);
        }
        await entry.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout });
        await entry.page.waitForTimeout(150);
        return {
          tab: name,
          url: entry.page.url(),
          title: await entry.page.title(),
          viewport: entry.page.viewportSize(),
        };
      }

      case "close": {
        const entry = requireTab(args.tab);
        await entry.context.close();
        tabs.delete(args.tab);
        return { closed: args.tab };
      }

      case "resize": {
        const entry = requireTab(args.tab);
        const width = Number(args.width);
        const height = Number(args.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          throw new Error(`Invalid dimensions: ${args.width}x${args.height}`);
        }
        await entry.page.setViewportSize({ width, height });
        return { tab: args.tab, viewport: { width, height } };
      }

      case "snapshot": {
        const entry = requireTab(args.tab);
        const max = Number(args.max) || 120;
        const snap = await entry.page.evaluate(buildSnapshotInPage, max);
        return {
          tab: args.tab,
          ...snap,
          errorCounts: {
            consoleErrors: entry.logs.consoleErrors.length,
            consoleWarnings: entry.logs.consoleWarnings.length,
            pageErrors: entry.logs.pageErrors.length,
            networkErrors: entry.logs.networkErrors.length,
          },
        };
      }

      case "click": {
        const entry = requireTab(args.tab);
        const sel = normalizeSelector(args.selector);
        await entry.page.locator(sel).first().click({ timeout });
        return { ok: true, tab: args.tab, action: "click", selector: sel };
      }

      case "rclick": {
        const entry = requireTab(args.tab);
        const sel = normalizeSelector(args.selector);
        await entry.page.locator(sel).first().click({ button: "right", timeout });
        return { ok: true, tab: args.tab, action: "rclick", selector: sel };
      }

      case "dblclick": {
        const entry = requireTab(args.tab);
        const sel = normalizeSelector(args.selector);
        await entry.page.locator(sel).first().dblclick({ timeout });
        return { ok: true, tab: args.tab, action: "dblclick", selector: sel };
      }

      case "hover": {
        const entry = requireTab(args.tab);
        const sel = normalizeSelector(args.selector);
        await entry.page.locator(sel).first().hover({ timeout });
        return { ok: true, tab: args.tab, action: "hover", selector: sel };
      }

      case "fill": {
        const entry = requireTab(args.tab);
        const sel = normalizeSelector(args.selector);
        await entry.page.locator(sel).first().fill(String(args.value ?? ""), { timeout });
        return { ok: true, tab: args.tab, action: "fill", selector: sel };
      }

      case "type": {
        const entry = requireTab(args.tab);
        await entry.page.keyboard.type(String(args.text ?? ""));
        return { ok: true, tab: args.tab, action: "type" };
      }

      case "press": {
        const entry = requireTab(args.tab);
        await entry.page.keyboard.press(String(args.key));
        return { ok: true, tab: args.tab, action: "press", key: args.key };
      }

      case "drag": {
        const entry = requireTab(args.tab);
        const x1 = Number(args.x1);
        const y1 = Number(args.y1);
        const x2 = Number(args.x2);
        const y2 = Number(args.y2);
        const steps = Number(args.steps) || 10;
        if (![x1, y1, x2, y2].every(Number.isFinite)) {
          throw new Error("drag requires numeric x1 y1 x2 y2");
        }
        await entry.page.mouse.move(x1, y1);
        await entry.page.mouse.down();
        await entry.page.mouse.move(x2, y2, { steps });
        await entry.page.mouse.up();
        return { ok: true, tab: args.tab, action: "drag", from: [x1, y1], to: [x2, y2], steps };
      }

      case "wheel": {
        const entry = requireTab(args.tab);
        const dx = Number(args.dx);
        const dy = Number(args.dy);
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
          throw new Error("wheel requires numeric dx dy");
        }
        if (args.at) {
          const [ax, ay] = String(args.at).split(",").map(Number);
          if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
            throw new Error(`Invalid --at "${args.at}" (expected x,y)`);
          }
          await entry.page.mouse.move(ax, ay);
        }
        await entry.page.mouse.wheel(dx, dy);
        return { ok: true, tab: args.tab, action: "wheel", dx, dy };
      }

      case "wait": {
        const entry = requireTab(args.tab);
        const target = String(args.target ?? "");
        if (/^\d+$/.test(target)) {
          await entry.page.waitForTimeout(Number(target));
          return { ok: true, waitedMs: Number(target) };
        }
        const sel = normalizeSelector(target);
        await entry.page.locator(sel).first().waitFor({ state: "visible", timeout });
        return { ok: true, visible: sel };
      }

      case "shot": {
        const entry = requireTab(args.tab);
        const outPath = validateShotPath(args.out);
        mkdirSync(dirname(outPath), { recursive: true });
        await entry.page.screenshot({ path: outPath, fullPage: Boolean(args.full) });
        return { ok: true, tab: args.tab, path: outPath, full: Boolean(args.full) };
      }

      case "logs": {
        const entry = requireTab(args.tab);
        const out = {
          tab: args.tab,
          consoleErrors: [...entry.logs.consoleErrors],
          consoleWarnings: [...entry.logs.consoleWarnings],
          pageErrors: [...entry.logs.pageErrors],
          networkErrors: [...entry.logs.networkErrors],
        };
        if (args.clear) {
          entry.logs.consoleErrors.length = 0;
          entry.logs.consoleWarnings.length = 0;
          entry.logs.pageErrors.length = 0;
          entry.logs.networkErrors.length = 0;
        }
        return out;
      }

      case "eval": {
        const entry = requireTab(args.tab);
        const expr = String(args.expr ?? "");
        const result = await entry.page.evaluate((code) => {
          // eslint-disable-next-line no-eval
          const val = (0, eval)(code);
          return typeof val === "function" ? val() : val;
        }, expr);
        return { tab: args.tab, result };
      }

      case "tabs": {
        const list = [];
        for (const [name, entry] of tabs.entries()) {
          list.push({
            tab: name,
            url: entry.page.url(),
            title: await entry.page.title(),
            viewport: entry.page.viewportSize(),
            errors:
              entry.logs.consoleErrors.length +
              entry.logs.pageErrors.length +
              entry.logs.networkErrors.length,
          });
        }
        return { tabs: list };
      }

      case "new-board": {
        if (!baseUrl) throw new Error("new-board requires a session base URL");
        const title = args.title || "QA Board";
        const r = await fetch(`${baseUrl}/api/boards`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!r.ok) {
          throw new Error(`POST /api/boards failed (${r.status}): ${await r.text()}`);
        }
        const { board, owner_token } = await r.json();
        let viewUrl = null;
        const vr = await fetch(`${baseUrl}/api/boards/${board}/links`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${owner_token}`,
          },
          body: JSON.stringify({ role: "view", label: "QA view" }),
        });
        if (vr.ok) {
          const { token } = await vr.json();
          viewUrl = `${baseUrl}/b/${board}#${token}`;
        }
        return {
          board,
          url: `${baseUrl}/b/${board}#${owner_token}`,
          viewUrl,
        };
      }

      case "stop":
        // Reply first, then shut down cleanly.
        setImmediate(() => shutdown(0));
        return { stopping: true, id };

      default:
        throw new Error(`Unknown command "${cmd}"`);
    }
  }

  let shuttingDown = false;
  let unixServer = null;

  async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    if (replayTimer) clearInterval(replayTimer);
    try {
      if (unixServer) unixServer.close();
    } catch {
      // ignore
    }
    try {
      for (const entry of tabs.values()) {
        await entry.context.close().catch(() => {});
      }
      tabs.clear();
      await browser.close().catch(() => {});
    } catch {
      // ignore
    }
    if (serverInfo?.child && serverInfo.child.exitCode === null) {
      const child = serverInfo.child;
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      const deadline = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2000);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 2500))]);
      clearTimeout(deadline);
    }
    try {
      if (existsSync(sockPath)) unlinkSync(sockPath);
    } catch {
      // ignore
    }
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    process.exit(code);
  }

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  try {
    if (existsSync(sockPath)) unlinkSync(sockPath);
  } catch {
    // ignore
  }

  unixServer = createNetServer((conn) => {
    conn.setEncoding("utf8");
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        (async () => {
          try {
            const req = JSON.parse(line);
            const data = await handleCommand(req);
            conn.write(JSON.stringify({ ok: true, data }) + "\n");
          } catch (err) {
            conn.write(
              JSON.stringify({
                ok: false,
                error: err?.message || String(err),
              }) + "\n",
            );
          }
        })();
      }
    });
  });

  await new Promise((ok, fail) => {
    unixServer.once("error", fail);
    unixServer.listen(sockPath, ok);
  });

  const meta = {
    id,
    pid: process.pid,
    serverPid: serverInfo?.child?.pid ?? null,
    baseUrl,
    serverBin: serverInfo?.bin ?? null,
    webDir: serverInfo?.webDir ?? null,
    packsDir: serverInfo?.packsDir ?? null,
    sockPath,
    workDir,
    mockReplay: mockReplayInfo,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(workDir, "meta.json"), JSON.stringify(meta, null, 2));
}

main().catch((err) => {
  try {
    const opts = JSON.parse(process.argv[2] || "{}");
    if (opts.workDir) {
      mkdirSync(opts.workDir, { recursive: true });
      writeFileSync(
        join(opts.workDir, "boot-error.txt"),
        String(err?.stack || err) + "\n",
      );
    }
  } catch {
    // ignore
  }
  console.error(err?.stack || err);
  process.exit(1);
});
