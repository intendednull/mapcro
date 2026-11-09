// A marker hidden from the map has nothing to say: hovering where it sits shows no label
// (review 2026-11-08, buffs-timers finding 4), while the markers around it still do.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Page, expect, test } from "./fixtures";
import WebSocket from "ws";
import { initSync, newRecordId } from "../src/wasm/mapcro_wasm.js";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import { joinNew } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

const HIDDEN = "walker:amber:lane1:1";
const SHOWN = "walker:sapphire:lane1:1";
const marker = (p: Page, key: string) => p.locator(`[data-testid=map] .mk[data-key="${key}"]`);
const label = (p: Page) => p.getByTestId("hover-label");

async function hover(p: Page, key: string) {
  const b = (await marker(p, key).boundingBox())!;
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
}

test("a marker with nothing timed shows no label, hidden or shown; it keeps its name for screen readers", async ({ browser }) => {
  const url = await newBoardUrl(server, "hidden marker");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const bot = new BoardSession({
    wsUrl: `ws://127.0.0.1:${new URL(server.url).port}/ws`,
    board: board!,
    token: token!,
    persist: new MemoryPersist(),
    openSocket: (u) => new WebSocket(u, { origin: server.url }) as unknown as SocketLike,
  });
  await bot.start();
  await expect.poll(() => bot.connection.kind).toBe("live");
  const scene = [...bot.records].find(([, e]) => "Scene" in e.record)![0];
  bot.edit([{ Create: { id: newRecordId(), record: { ObjectiveState: { scene, key: HIDDEN, status: "Hidden" } } } }]);
  await expect.poll(() => bot.status.kind).toBe("saved");
  bot.stop();

  const a = await joinNew(browser, url, "Coach");
  // An editor still sees where it was, faded; it says nothing.
  await expect(marker(a, HIDDEN)).toHaveAttribute("data-status", "Hidden");
  // A walker is a walker (operator 2026-11-08): no label shown or hidden.
  await hover(a, SHOWN);
  await expect(label(a)).toHaveCount(0);
  await hover(a, HIDDEN);
  await expect(label(a)).toHaveCount(0);
  // And its role: a named image, found by its name.
  await expect(a.getByRole("img", { name: (await marker(a, SHOWN).getAttribute("aria-label"))! }).first()).toBeVisible();
});
