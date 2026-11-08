// Player names (operator, 2026-11-08): the metadata tier looks the players' public Steam names up
// once (deadlock-api's profiles, by the match's account ids, which the server never keeps) and
// shows them by the heroes: in the top bar, the roster and the events. With MAPCRO_SHOT_PACKS set
// (`MAPCRO_SHOT_PACKS=~/.local/share/mapcro/packs`), the screenshots use the real art.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { joinNew } from "./helpers";
import { ROOT, Server, newBoardUrl } from "./server";

const ID = "130816395";
const NAMES = ["Coach", "Marrow", "Juno", "Pike", "Wren", "Ash", "Vale", "Rook", "Sable", "Tarn", "Kite", "Moss"];
let upstream: ReturnType<typeof createServer>;
let server: Server;

test.beforeAll(async () => {
  // The trimmed fixture has no account ids: give each player a made-up one, as the API would.
  const m = JSON.parse(readFileSync(join(ROOT, `crates/server/tests/fixtures/match-${ID}-trimmed.json`)).toString());
  for (const p of m.match_info.players) p.account_id = 900000 + p.player_slot;
  const fixture = JSON.stringify(m);
  const profiles = JSON.stringify(
    m.match_info.players.map((p: { player_slot: number }) => ({ account_id: 900000 + p.player_slot, personaname: NAMES[p.player_slot - 1], profileurl: "", avatar: "", avatarmedium: "", avatarfull: "", last_updated: "2026-01-01T00:00:00Z", friends: [], matches_played_last_30d: 1 })),
  );
  upstream = createServer((req, res) => {
    if (req.url?.startsWith(`/v1/matches/${ID}/metadata`)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fixture);
    } else if (req.url?.startsWith("/v1/players/steam?account_ids=")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(profiles);
    } else {
      res.writeHead(404);
      res.end("{}");
    }
  });
  await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
  const port = (upstream.address() as { port: number }).port;
  server = new Server(process.env.MAPCRO_SHOT_PACKS, { MATCH_API_BASE: `http://127.0.0.1:${port}` });
  await server.start();
});
test.afterAll(() => {
  server.stop();
  upstream.close();
});

test("names show by their heroes: top bar, roster, events", async ({ browser }) => {
  const a = await joinNew(browser, await newBoardUrl(server, "Names"), "Coach");
  await a.getByTestId("mode-player").click();
  await a.getByTestId("match-id").fill(ID);
  await a.getByTestId("match-load").click();
  await expect(a.getByTestId("match-tier")).toHaveText("API summary");
  // Slot order: the server sorts each team by player slot (1–6 Amber, 7–12 Sapphire).
  await expect(a.locator('.tb-player[data-slot="Amber-0"] [data-testid=tb-name]')).toHaveText("Coach");
  await expect(a.locator('.tb-player[data-slot="Sapphire-5"] [data-testid=tb-name]')).toHaveText("Moss");
  await a.getByTestId("events-search").fill("juno");
  await expect(a.getByTestId("event").first()).toContainText("Juno");
  await a.getByTestId("events-search").fill("");
  await a.screenshot({ path: "shots/player-names.png" });
});
