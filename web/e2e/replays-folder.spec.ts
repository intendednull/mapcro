// The linked replays folder (spec §6b, Getting a replay in): on Chromium an editor links the
// game's replays folder once; Player then finds the open match's `<match id>.dem` there (looking
// again on focus) and uploads it in one click, and a later visit reuses the folder. The folder is
// the browser's own private file system (a real directory handle, so IndexedDB keeps it), handed
// out by a stubbed `showDirectoryPicker`; the native picker can't be driven. Without the API
// nothing changes. A fake deadlock-api (no replay at Valve); the test plays the worker's inbox.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type Page, expect, test } from "./fixtures";
import { revealControls } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

/** deadlock-api has its metadata, but Valve no replay. */
const KNOWN = 130816395;
const RELOADED = 130816396;
const ASKED = 130816397;
const PLAIN = 130816398;
const DEFAULT = 130816399;
/** Another match's replay, in the folder too. */
const OTHER = 130816390;
const queue = mkdtempSync(join(tmpdir(), "mapcro-e2e-folder-"));
const shots = process.env.MAPCRO_FOLDER_SHOTS ?? "/tmp/pw-replays-folder";
let upstream: ReturnType<typeof createServer>;
let server: Server;

function meta(id: number) {
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-130816395-trimmed.json`)).toString());
  m.match_info.match_id = id;
  m.match_info.start_time = Math.floor(Date.now() / 1000) - 86400;
  return JSON.stringify(m);
}

test.beforeAll(async () => {
  upstream = createServer((req, res) => {
    const m = /^\/v1\/matches\/(\d+)\/metadata$/.exec((req.url ?? "").split("?")[0]!);
    if (m) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(meta(Number(m[1])));
    }
    res.writeHead(404);
    res.end("{}");
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(undefined, {
    MATCH_API_BASE: `http://127.0.0.1:${port}`,
    REPLAY_CDN_BASE: `http://127.0.0.1:${port}/cdn`,
    REPLAY_DIR: queue,
    REPLAY_PER_CLIENT_PER_HOUR: "100",
  });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

/** The picker hands out `replays/` in the origin's private file system, counting its calls. */
const PICKER = () => {
  (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
    sessionStorage.setItem("picked", String(Number(sessionStorage.getItem("picked") ?? 0) + 1));
    return (await navigator.storage.getDirectory()).getDirectoryHandle("replays", { create: true });
  };
};
/** As after a browser restart: read access needs a click (until it's given, in this tab). */
const ASK = () => {
  const proto = FileSystemHandle.prototype as unknown as { queryPermission: () => Promise<string>; requestPermission: () => Promise<string> };
  proto.queryPermission = async () => (sessionStorage.getItem("allowed") ? "granted" : "prompt");
  proto.requestPermission = async () => {
    if (!navigator.userActivation.isActive) throw new DOMException("needs a click", "SecurityError");
    sessionStorage.setItem("allowed", "1");
    return "granted";
  };
};
/** Steam's default folder: Chrome refuses it (or the user cancels); the page sees an AbortError. */
const REFUSED = () => {
  (window as unknown as { showDirectoryPicker: () => Promise<never> }).showDirectoryPicker = () => Promise.reject(new DOMException("The user aborted a request.", "AbortError"));
};
/** Firefox and Safari: no folder access at all. */
const NO_API = () => {
  delete (Window.prototype as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
};

async function board(browser: Browser, title: string, scripts: Array<() => void>) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  for (const s of scripts) await ctx.addInitScript(s);
  const p = await ctx.newPage();
  await p.goto(await newBoardUrl(server, title));
  await p.locator("#join-name").fill("Coach");
  await p.keyboard.press("Enter");
  await expect(p.getByTestId("join-card")).toBeHidden();
  return p;
}

/** Put a replay in the folder (a demo's header and some bytes). */
async function put(p: Page, id: number) {
  await p.evaluate(async (id) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("replays", { create: true });
    const w = await (await dir.getFileHandle(`${id}.dem`, { create: true })).createWritable();
    const bytes = new Uint8Array(64 * 1024).fill(7);
    bytes.set(new TextEncoder().encode("PBDEMS2\0"));
    await w.write(bytes);
    await w.close();
  }, id);
}

async function load(p: Page, id: number) {
  await p.getByTestId("mode-player").click();
  await revealControls(p, "match-id");
  await p.getByTestId("match-id").fill(String(id));
  await p.getByTestId("match-load").click();
  await expect(p.getByTestId("replay-prompt-why")).toHaveText("Valve doesn't have the replay yet.", { timeout: 15_000 });
}

/** The job the server queued for `id` (the worker's inbox), once it's there. */
async function queued(id: number) {
  await expect.poll(() => readdirSync(join(queue, "inbox")).some((f) => f.startsWith(`${id}-`) && f.endsWith(".dem")), { timeout: 15_000 }).toBe(true);
}

test("link the folder, a new replay is found on focus, and one click uploads it", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium-only: linking a folder is the File System Access API, and the stubbed picker hands out an OPFS handle (no navigator.storage.getDirectory in this WebKit)");
  const a = await board(browser, "Folder", [PICKER]);
  await put(a, OTHER);
  await load(a, KNOWN);
  const prompt = a.getByTestId("replay-prompt");
  await expect(prompt.getByTestId("replay-help-open")).toBeVisible();
  await prompt.getByTestId("replay-help-open").click();
  await expect(prompt.getByTestId("replay-help-link")).toContainText("steamapps › common › Deadlock › game › citadel › replays");
  await prompt.getByTestId("replay-help-open").click();
  // Linked: another match's replay is there, not this one's.
  await prompt.getByTestId("folder-link").click();
  await expect(prompt.getByTestId("folder-none")).toHaveText("Not in your replays folder yet");
  await expect(prompt.getByTestId("replay-prompt-upload")).toHaveClass(/primary/);
  // The game downloads it; back in the browser, it's found (once it has settled, 5 s).
  await put(a, KNOWN);
  await a.evaluate(() => dispatchEvent(new Event("focus")));
  const up = prompt.getByTestId("folder-upload");
  await expect(up).toHaveText(`Upload ${KNOWN} from your replays folder`, { timeout: 15_000 });
  await expect(prompt.getByTestId("replay-prompt-upload")).not.toHaveClass(/primary/);
  await a.screenshot({ path: `${shots}/prompt-found.png` });
  await up.click();
  await queued(KNOWN);
  await expect(prompt).toHaveCount(0);
  await expect(a.getByTestId("match-tier")).toHaveText("Queued");
  expect(await a.evaluate(() => sessionStorage.getItem("picked"))).toBe("1");
});

test("a later visit reuses the folder; with no match open, its recent replays open one", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium-only: linking a folder is the File System Access API, and the stubbed picker hands out an OPFS handle (no navigator.storage.getDirectory in this WebKit)");
  const a = await board(browser, "Reload", [PICKER]);
  await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  // No match yet: link from the match source.
  await a.getByTestId("folder-link").click();
  await put(a, RELOADED);
  await a.reload();
  await expect(a.getByTestId("player").or(a.getByTestId("mode-player")).first()).toBeVisible();
  if (await a.getByTestId("mode-player").isVisible()) await a.getByTestId("mode-player").click();
  await revealControls(a, "match-id");
  const recent = a.locator(`[data-testid=folder-recent][data-match="${RELOADED}"]`);
  await expect(recent).toBeVisible({ timeout: 15_000 });
  expect(await a.evaluate(() => sessionStorage.getItem("picked")), "not picked again").toBe("1");
  await recent.click();
  await expect(a.getByTestId("replay-prompt-why")).toHaveText("Valve doesn't have the replay yet.", { timeout: 15_000 });
  // Use API summary: the match source offers it beside Upload replay file.
  await a.getByTestId("replay-prompt-summary").click();
  await revealControls(a, "match-upload");
  await expect(a.getByTestId("folder-upload")).toHaveText(`Upload ${RELOADED} from your replays folder`);
  await a.screenshot({ path: `${shots}/source-found.png` });
  await a.getByTestId("folder-upload").click();
  await queued(RELOADED);
});

test("after a browser restart, a click gives read access back", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "Chromium-only: linking a folder is the File System Access API, and the stubbed picker hands out an OPFS handle (no navigator.storage.getDirectory in this WebKit)");
  const a = await board(browser, "Ask", [PICKER, ASK]);
  await put(a, ASKED);
  await load(a, ASKED);
  const prompt = a.getByTestId("replay-prompt");
  await prompt.getByTestId("folder-link").click();
  // The picker's choice is granted for this tab (as in Chrome); a new visit asks again.
  await expect(prompt.getByTestId("folder-upload")).toBeVisible({ timeout: 15_000 });
  await a.evaluate(() => sessionStorage.removeItem("allowed"));
  await a.reload();
  const again = a.getByTestId("replay-prompt");
  await expect(again).toBeVisible({ timeout: 15_000 });
  await expect(again.getByTestId("folder-allow")).toHaveText("Reconnect replays folder");
  await again.getByTestId("folder-allow").click();
  await expect(again.getByTestId("folder-upload")).toHaveText(`Upload ${ASKED} from your replays folder`);
  expect(await a.evaluate(() => sessionStorage.getItem("picked"))).toBe("1");
});

test("without the API (Firefox, Safari) nothing changes: pick or drop the file", async ({ browser }) => {
  const a = await board(browser, "Plain", [NO_API]);
  await load(a, PLAIN);
  const prompt = a.getByTestId("replay-prompt");
  await expect(prompt.getByTestId("replay-prompt-upload")).toHaveClass(/primary/);
  await expect(a.locator("[data-testid^=folder-]")).toHaveCount(0);
  await prompt.getByTestId("replay-help-open").click();
  await expect(prompt.getByTestId("replay-help-steps")).toContainText("game → citadel → replays");
  await expect(prompt.getByTestId("replay-help-link")).toHaveCount(0);
  await a.getByTestId("replay-prompt-summary").click();
  await revealControls(a, "match-upload");
  await expect(a.getByTestId("match-upload")).toHaveClass(/primary/);
  await expect(a.locator("[data-testid^=folder-]")).toHaveCount(0);
});

test("the picker refuses Steam's default folder (or is cancelled): a short line, and the upload stays first", async ({ browser }) => {
  const a = await board(browser, "Refused", [REFUSED]);
  await load(a, DEFAULT);
  const prompt = a.getByTestId("replay-prompt");
  await prompt.getByTestId("folder-link").click();
  await expect(prompt.getByTestId("folder-note")).toHaveText("Browsers can't link Steam's default folder. Upload the file instead.");
  await expect(prompt.getByTestId("replay-prompt-upload")).toHaveClass(/primary/);
  await expect(prompt.getByTestId("folder-link")).toHaveClass(/ghost/);
  await a.screenshot({ path: `${shots}/prompt-refused.png` });
  // The plain file picker still opens it.
  const chooser = a.waitForEvent("filechooser");
  await prompt.getByTestId("replay-prompt-upload").click();
  await (await chooser).setFiles({ name: `${DEFAULT}.dem`, mimeType: "application/octet-stream", buffer: Buffer.concat([Buffer.from("PBDEMS2\0", "binary"), Buffer.alloc(64 * 1024, 7)]) });
  await queued(DEFAULT);
});
