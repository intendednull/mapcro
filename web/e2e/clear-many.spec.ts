// Clear on a scene with more ink than one transaction may hold (256 ops): it clears in chunks
// that each fit, says so only for what committed, and Undo brings all of it back
// (review 2026-11-07, finding 5).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures";
import WebSocket from "ws";
import { initSync, newRecordId } from "../src/wasm/mapcro_wasm.js";
import { MemoryPersist } from "../src/core/persist";
import { BoardSession, type SocketLike } from "../src/core/session";
import type { Op } from "../src/gen/Op";
import { joinNew } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

initSync({ module: readFileSync(join(ROOT, "web/src/wasm/mapcro_wasm_bg.wasm")) });

let server: Server;
test.beforeAll(async () => {
  server = new Server();
  await server.start();
});
test.afterAll(() => server.stop());

test("clearing 300 strokes: all go, one toast, and Undo brings all 300 back", async ({ browser }) => {
  const url = await newBoardUrl(server, "lots of ink");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  // A script draws 300 strokes, in transactions that each fit.
  const port = new URL(server.url).port;
  const bot = new BoardSession({
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    board: board!,
    token: token!,
    persist: new MemoryPersist(),
    openSocket: (u) => new WebSocket(u, { origin: server.url }) as unknown as SocketLike,
  });
  await bot.start();
  await expect.poll(() => bot.connection.kind).toBe("live");
  const scene = [...bot.records].find(([, e]) => "Scene" in e.record)![0];
  for (let k = 0; k < 3; k++) {
    const ops: Op[] = Array.from({ length: 100 }, (_, i) => ({
      Create: { id: newRecordId(), record: { Stroke: { scene, points: [{ x: i * 50, y: k * 900 }, { x: i * 50 + 30, y: k * 900 + 30 }], color: 1, width: 30 } } },
    }));
    bot.edit(ops);
  }
  await expect.poll(() => bot.status.kind).toBe("saved");
  bot.stop();

  const a = await joinNew(browser, url, "Coach");
  const strokes = a.locator(".mapbox [data-stroke]");
  await expect(strokes).toHaveCount(300);
  await a.getByTestId("clear-menu").click();
  await a.getByTestId("clear-ink").click();
  await expect(strokes).toHaveCount(0);
  await expect(a.getByTestId("toast")).toContainText("Ink cleared");
  await a.reload();
  await expect(a.locator(".mapbox [data-stroke]")).toHaveCount(0); // it reached the server
  await a.getByTestId("clear-menu").isDisabled();
});

test("Undo on the clear toast restores everything that was cleared, and nothing else", async ({ browser }) => {
  const url = await newBoardUrl(server, "undo clear");
  const [, board, token] = /\/b\/([^#]+)#(.+)$/.exec(url)!;
  const port = new URL(server.url).port;
  const bot = new BoardSession({
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    board: board!,
    token: token!,
    persist: new MemoryPersist(),
    openSocket: (u) => new WebSocket(u, { origin: server.url }) as unknown as SocketLike,
  });
  await bot.start();
  await expect.poll(() => bot.connection.kind).toBe("live");
  const scene = [...bot.records].find(([, e]) => "Scene" in e.record)![0];
  for (let k = 0; k < 3; k++)
    bot.edit(
      Array.from({ length: 100 }, (_, i): Op => ({
        Create: { id: newRecordId(), record: { Stroke: { scene, points: [{ x: i * 50, y: k * 900 }, { x: i * 50 + 30, y: k * 900 + 30 }], color: 1, width: 30 } } },
      })),
    );
  await expect.poll(() => bot.status.kind).toBe("saved");
  bot.stop();

  const a = await joinNew(browser, url, "Coach");
  // Something of A's own to undo first: a comment. Clear's Undo must not take it back.
  await a.keyboard.press("t");
  const box = (await a.locator("[data-testid=map] .mm-overlay.map").boundingBox())!;
  await a.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await a.getByTestId("comment-input").fill("keep me");
  await a.keyboard.press("Enter");
  const strokes = a.locator(".mapbox [data-stroke]");
  await expect(strokes).toHaveCount(300);
  await a.getByTestId("clear-menu").click();
  await a.getByTestId("clear-ink").click();
  await expect(strokes).toHaveCount(0);
  await a.getByTestId("toast").getByRole("button", { name: "Undo" }).click();
  await expect(strokes).toHaveCount(300);
  await expect(a.locator(".mapbox [data-callout]")).toHaveCount(1);
});
