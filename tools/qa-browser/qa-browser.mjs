#!/usr/bin/env node
// Interactive browser driver CLI for mapcro exploratory QA.
// Run inside `nix develop`: `tools/qa-browser/qa-browser.mjs <command> [args...]`

import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(HERE, "daemon.mjs");

function usage() {
  console.log(`Usage: qa-browser.mjs <command> [options] [args...]

Session lifecycle:
  start [--id <name>] [--url <http://...>] [--server-bin <path>] [--web-dir <path>]
        [--packs-dir <path>] [--replay-dir <path>] [--match-api-base <url>]
        [--mock-replay-129738985] [--headless | --headed]
  stop [--id <name>]
  status [--id <name>]
  feed-replay <matchId> [--source <path>] [--id <name>]

Tabs & navigation (each tab is an isolated BrowserContext):
  open <tab> <url-or-path> [--viewport WxH] [--touch] [--id <name>]
  close <tab> [--id <name>]
  resize <tab> <width> <height> [--id <name>]
  tabs [--id <name>]
  new-board [title] [--id <name>]

Inspection & interaction:
  snapshot <tab> [--max N] [--json] [--id <name>]
  click | rclick | dblclick <tab> <selector> [--any] [--id <name>]
  hover <tab> <selector> [--any] [--force] [--id <name>]
  move <tab> <x> <y> [--id <name>]
  fill <tab> <selector> <value> [--any] [--id <name>]
  upload <tab> <selector> <file> [--id <name>]
  type <tab> <text> [--id <name>]
  press <tab> <key> [--id <name>]
  drag <tab> <x1> <y1> <x2> <y2> [--steps N] [--id <name>]
  wheel <tab> <dx> <dy> [--at x,y] [--id <name>]
  wait <tab> <selector-or-ms> [--id <name>]
  shot <tab> <out.png> [--full] [--id <name>]   (refuses paths inside repo/worktrees)
  download <tab> <selector> <out-file> [--any] [--id <name>]  (refuses paths inside repo/worktrees)
  logs <tab> [--clear] [--id <name>]
  eval <tab> <js-expr> [--id <name>]

Selector shorthand: "testid:foo" expands to '[data-testid="foo"]'.
Common flags: --id <name> (default: "default"), --timeout <ms> (default: 10000).`);
}

function validateId(id) {
  if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid session id "${id}" (allowed: letters, digits, ., _, -)`);
  }
  return id;
}

function sessionPaths(id) {
  return {
    sockPath: `/tmp/qa-browser-${id}.sock`,
    workDir: `/tmp/qa-browser-${id}`,
  };
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  const boolFlags = new Set([
    "headless",
    "headed",
    "mock-replay-129738985",
    "full",
    "clear",
    "json",
    "touch",
    "any",
    "force",
    "help",
  ]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      flags.help = true;
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        const k = a.slice(2, eq);
        const v = a.slice(eq + 1);
        flags[k] = v === "true" ? true : v === "false" ? false : v;
      } else {
        const k = a.slice(2);
        if (boolFlags.has(k)) {
          flags[k] = true;
        } else {
          if (i + 1 >= argv.length) throw new Error(`Flag --${k} requires a value`);
          flags[k] = argv[++i];
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function rpc(sockPath, cmd, args = {}, timeoutMs = 30_000) {
  return new Promise((ok, fail) => {
    const conn = createConnection(sockPath);
    let buf = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      conn.destroy();
      fail(new Error(`RPC timeout after ${timeoutMs}ms for command "${cmd}"`));
    }, timeoutMs);

    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      if (err) fail(err);
      else ok(val);
    };

    conn.setEncoding("utf8");
    conn.once("error", (e) => finish(e));
    conn.on("connect", () => {
      conn.write(JSON.stringify({ cmd, args }) + "\n");
    });
    conn.on("data", (chunk) => {
      buf += chunk;
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        try {
          const resp = JSON.parse(line);
          if (resp.ok) finish(null, resp.data);
          else finish(new Error(resp.error || "Unknown daemon error"));
        } catch (e) {
          finish(e);
        }
      }
    });
  });
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitPidExit(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(pid);
}

function formatSnapshot(s) {
  const lines = [];
  lines.push(`TAB ${s.tab} | ${s.viewport.width}x${s.viewport.height} | ${s.url}`);
  if (s.title) lines.push(`TITLE: ${s.title}`);
  const ec = s.errorCounts;
  lines.push(
    `LOGS: ${ec.consoleErrors} console-err, ${ec.pageErrors} page-err, ${ec.networkErrors} net-err, ${ec.consoleWarnings} warn`,
  );
  if (s.headings.length) {
    lines.push("HEADINGS:");
    for (const h of s.headings) {
      const id = h.testid ? ` [data-testid="${h.testid}"]` : "";
      lines.push(`  ${h.tag}${id}: ${h.text}`);
    }
  }
  if (s.overlays.length) {
    lines.push("OVERLAYS:");
    for (const o of s.overlays) {
      const id = o.testid ? ` [data-testid="${o.testid}"]` : "";
      lines.push(
        `  ${o.role}${id} (${o.box.x},${o.box.y} ${o.box.w}x${o.box.h}): ${o.text}`,
      );
    }
  }
  lines.push(
    `INTERACTIVE (${s.interactive.length}/${s.totalVisibleCandidates} visible):`,
  );
  for (const el of s.interactive) {
    const bits = [el.sel];
    if (el.role && el.role !== el.tag) bits.push(`role=${el.role}`);
    if (el.label) bits.push(`"${el.label}"`);
    if (el.title) bits.push(`title="${el.title}"`);
    if (el.state) {
      const st = Object.entries(el.state)
        .map(([k, v]) => (v === true ? k : `${k}=${JSON.stringify(v)}`))
        .join(",");
      bits.push(`[${st}]`);
    }
    bits.push(`@(${el.box.x},${el.box.y} ${el.box.w}x${el.box.h})`);
    lines.push("  " + bits.join(" "));
  }
  return lines.join("\n");
}

async function cmdStart(id, flags) {
  const { sockPath, workDir } = sessionPaths(id);
  if (existsSync(sockPath)) {
    try {
      const st = await rpc(sockPath, "ping", {}, 2000);
      throw new Error(
        `Session "${id}" is already running (pid ${st.pid}, url ${st.baseUrl}). Run \`stop --id ${id}\` first.`,
      );
    } catch (e) {
      if (e.message.includes("already running")) throw e;
      // Stale socket from a crashed daemon; clean it up.
      try {
        unlinkSync(sockPath);
      } catch {
        // ignore
      }
    }
  }

  const headless = flags.headed ? false : flags.headless !== false;
  const opts = {
    id,
    sockPath,
    workDir,
    url: flags.url || null,
    serverBin: flags["server-bin"] || null,
    webDir: flags["web-dir"] || null,
    packsDir: flags["packs-dir"] || null,
    replayDir: flags["replay-dir"] || null,
    matchApiBase: flags["match-api-base"] || null,
    mockReplay129738985: Boolean(flags["mock-replay-129738985"]),
    headless,
  };

  rmSync(join(workDir, "boot-error.txt"), { force: true });

  const child = spawn(process.execPath, [DAEMON, JSON.stringify(opts)], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const errFile = join(workDir, "boot-error.txt");
    if (existsSync(errFile)) {
      const msg = readFileSync(errFile, "utf8").trim();
      rmSync(workDir, { recursive: true, force: true });
      throw new Error(`Daemon failed to start:\n${msg}`);
    }
    if (existsSync(sockPath)) {
      try {
        const st = await rpc(sockPath, "status", {}, 3000);
        console.log(JSON.stringify(st, null, 2));
        return;
      } catch {
        // socket created, not ready yet
      }
    }
    if (!pidAlive(child.pid)) {
      const msg = existsSync(errFile)
        ? readFileSync(errFile, "utf8").trim()
        : "daemon exited without writing an error";
      throw new Error(`Daemon exited during startup: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // ignore
  }
  throw new Error(`Timed out waiting for qa-browser daemon "${id}" to start`);
}

async function cmdStop(id) {
  const { sockPath, workDir } = sessionPaths(id);
  let meta = null;
  const metaPath = join(workDir, "meta.json");
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      // ignore
    }
  }

  if (existsSync(sockPath)) {
    try {
      await rpc(sockPath, "stop", {}, 5000);
    } catch {
      // ignore; fall back to PID cleanup below
    }
  }

  if (meta?.pid && !(await waitPidExit(meta.pid, 5000))) {
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      // ignore
    }
    if (!(await waitPidExit(meta.pid, 2000))) {
      try {
        process.kill(meta.pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
  }
  if (meta?.serverPid && pidAlive(meta.serverPid)) {
    try {
      process.kill(meta.serverPid, "SIGKILL");
    } catch {
      // ignore
    }
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
  console.log(JSON.stringify({ stopped: true, id }));
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || positionals.length === 0) {
    usage();
    process.exit(flags.help ? 0 : 2);
  }

  const cmd = positionals[0];
  const rest = positionals.slice(1);
  const id = validateId(String(flags.id || "default"));
  const timeout = flags.timeout ? Number(flags.timeout) : 10_000;
  const { sockPath } = sessionPaths(id);

  if (cmd === "start") {
    await cmdStart(id, flags);
    return;
  }
  if (cmd === "stop") {
    await cmdStop(id);
    return;
  }

  if (!existsSync(sockPath)) {
    throw new Error(
      `No running qa-browser session "${id}" (missing ${sockPath}). Run \`qa-browser.mjs start --id ${id}\` first.`,
    );
  }

  let args = { timeout };
  switch (cmd) {
    case "status":
    case "tabs":
      break;
    case "new-board":
      args.title = rest[0] || "QA Board";
      break;
    case "feed-replay":
      if (!rest[0]) throw new Error("feed-replay requires <matchId>");
      args.matchId = rest[0];
      if (flags.source) args.source = flags.source;
      break;
    case "open":
      if (rest.length < 2) throw new Error("open requires <tab> <url-or-path>");
      args.tab = rest[0];
      args.url = rest[1];
      if (flags.viewport) args.viewport = flags.viewport;
      if (flags.touch) args.touch = true;
      break;
    case "close":
      if (!rest[0]) throw new Error("close requires <tab>");
      args.tab = rest[0];
      break;
    case "resize":
      if (rest.length < 3) throw new Error("resize requires <tab> <width> <height>");
      args.tab = rest[0];
      args.width = Number(rest[1]);
      args.height = Number(rest[2]);
      break;
    case "snapshot":
      if (!rest[0]) throw new Error("snapshot requires <tab>");
      args.tab = rest[0];
      if (flags.max) args.max = Number(flags.max);
      break;
    case "click":
    case "rclick":
    case "dblclick":
    case "hover":
      if (rest.length < 2) throw new Error(`${cmd} requires <tab> <selector>`);
      args.tab = rest[0];
      args.selector = rest[1];
      if (flags.any) args.any = true;
      if (flags.force) args.force = true;
      break;
    case "move":
      if (rest.length < 3) throw new Error("move requires <tab> <x> <y>");
      args.tab = rest[0];
      args.x = Number(rest[1]);
      args.y = Number(rest[2]);
      break;
    case "fill":
      if (rest.length < 3) throw new Error("fill requires <tab> <selector> <value>");
      args.tab = rest[0];
      args.selector = rest[1];
      args.value = rest.slice(2).join(" ");
      if (flags.any) args.any = true;
      break;
    case "upload":
      if (rest.length < 3) throw new Error("upload requires <tab> <selector> <file>");
      args.tab = rest[0];
      args.selector = rest[1];
      args.files = rest.slice(2);
      break;
    case "type":
      if (rest.length < 2) throw new Error("type requires <tab> <text>");
      args.tab = rest[0];
      args.text = rest.slice(1).join(" ");
      break;
    case "press":
      if (rest.length < 2) throw new Error("press requires <tab> <key>");
      args.tab = rest[0];
      args.key = rest[1];
      break;
    case "drag":
      if (rest.length < 5) throw new Error("drag requires <tab> <x1> <y1> <x2> <y2>");
      args.tab = rest[0];
      args.x1 = Number(rest[1]);
      args.y1 = Number(rest[2]);
      args.x2 = Number(rest[3]);
      args.y2 = Number(rest[4]);
      if (flags.steps) args.steps = Number(flags.steps);
      break;
    case "wheel":
      if (rest.length < 3) throw new Error("wheel requires <tab> <dx> <dy>");
      args.tab = rest[0];
      args.dx = Number(rest[1]);
      args.dy = Number(rest[2]);
      if (flags.at) args.at = flags.at;
      break;
    case "wait":
      if (rest.length < 2) throw new Error("wait requires <tab> <selector-or-ms>");
      args.tab = rest[0];
      args.target = rest[1];
      break;
    case "shot":
      if (rest.length < 2) throw new Error("shot requires <tab> <out.png>");
      args.tab = rest[0];
      args.out = rest[1];
      if (flags.full) args.full = true;
      break;
    case "download":
      if (rest.length < 3) throw new Error("download requires <tab> <selector> <out-file>");
      args.tab = rest[0];
      args.selector = rest[1];
      args.out = rest[2];
      if (flags.any) args.any = true;
      break;
    case "logs":
      if (!rest[0]) throw new Error("logs requires <tab>");
      args.tab = rest[0];
      if (flags.clear) args.clear = true;
      break;
    case "eval":
      if (rest.length < 2) throw new Error("eval requires <tab> <js-expr>");
      args.tab = rest[0];
      args.expr = rest.slice(1).join(" ");
      break;
    default:
      throw new Error(`Unknown command "${cmd}". Run with --help.`);
  }

  const data = await rpc(sockPath, cmd, args, Math.max(timeout + 10_000, 30_000));
  if (cmd === "snapshot" && !flags.json) {
    console.log(formatSnapshot(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

main().catch((err) => {
  console.error(`qa-browser error: ${err?.message || err}`);
  process.exit(1);
});
