// Replay upload validation on Session AddGame (`loadGame`) and Player `host.take()` (QA Pass 003,
// FM-071): corrupt `.dem` files with no numeric match id are refused as "Not a replay" before
// complaining about a missing id, and `host.take()` is a clean no-op when no match is open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";

vi.hoisted(() => {
  // src/core/nav.ts reads location.href and calls addEventListener("popstate", ...) at import time.
  if (typeof globalThis.location === "undefined") {
    Object.defineProperty(globalThis, "location", { value: { href: "http://127.0.0.1/", origin: "http://127.0.0.1" }, configurable: true });
  }
  if (typeof globalThis.addEventListener === "undefined") {
    Object.defineProperty(globalThis, "addEventListener", { value: () => {}, configurable: true });
  }
});

import { loadGame } from "../src/session/AddGame";
import { createPlayerHost } from "../src/player/host";
import { timelines } from "../src/player/timelineCache";

const BOARD = "AAAAAAAAAAAAAAAAAAAAAA";
const ID = "129738985";

class MemStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key = (i: number) => [...this.m.keys()][i] ?? null;
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
  clear = () => this.m.clear();
}

const badFile = (name: string) => new File([new TextEncoder().encode("not a demo")], name);
const demoFile = (name: string) => {
  const bytes = new Uint8Array(64).fill(7);
  bytes.set(new TextEncoder().encode("PBDEMS2\0"));
  return new File([bytes], name);
};

let reserveCalled = 0;

beforeEach(() => {
  reserveCalled = 0;
  timelines.clear();
  vi.stubGlobal("localStorage", new MemStorage());
  vi.stubGlobal("sessionStorage", new MemStorage());
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/replays/") && url.endsWith("/reserve")) {
        reserveCalled++;
        // Hold the upload in queue so we only verify upload() started and cleared problem.
        return new Response(JSON.stringify({ state: "done" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/matches/")) {
        if (init?.method === "PUT") return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ match_id: Number(ID), duration_s: 1200, tier: "summary", players: [], events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/replays/")) {
        return new Response(JSON.stringify({ state: "none" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AddGame loadGame validation", () => {
  it("reports not_a_replay before Invalid id for a corrupt .dem with no match id in its name", async () => {
    const res = await loadGame({ id: "", file: badFile("bad.dem") });
    expect(res).toEqual({ error: "Not a replay. Pick the match's .dem file." });
  });

  it("still reports Invalid id for a valid-header .dem with no match id in its name or input", async () => {
    const res = await loadGame({ id: "", file: demoFile("replay.dem") });
    expect(res).toEqual({ error: "Invalid id" });
  });

  it("preserves non-.dem, mismatched id, and invalid typed id errors", async () => {
    expect(await loadGame({ id: "", file: badFile("notes.txt") })).toEqual({ error: "Not a .dem file. Pick the match's replay." });
    expect(await loadGame({ id: "123", file: demoFile("999.dem") })).toEqual({ error: "That file is match 999, not 123" });
    expect(await loadGame({ id: "abc" })).toEqual({ error: "Invalid id" });
  });
});

describe("Player host.take()", () => {
  it("is a clean no-op when no match is open (does not leave stale problem or status)", async () => {
    const { h, end } = createRoot((dispose) => ({ h: createPlayerHost(BOARD, "token"), end: dispose }));
    try {
      expect(h.matchId()).toBeUndefined();
      await h.take(badFile("bad.dem"));
      expect(h.problem()).toBeUndefined();
      expect(h.status()).toBe("");
      await h.take(badFile("notes.txt"));
      expect(h.problem()).toBeUndefined();
      expect(h.status()).toBe("");
      expect(reserveCalled).toBe(0);
    } finally {
      end();
    }
  });

  it("refuses a corrupt .dem on an open match and clears the problem when a valid .dem is uploaded", async () => {
    const { h, end } = createRoot((dispose) => ({ h: createPlayerHost(BOARD, "token"), end: dispose }));
    try {
      await h.open(ID, { attach: false });
      expect(h.matchId()).toBe(ID);
      await h.take(badFile(`${ID}.dem`));
      expect(h.problem()).toEqual({ code: "not_a_replay", step: "upload" });
      expect(reserveCalled).toBe(0);

      await h.take(demoFile(`${ID}.dem`));
      // Let upload() run its reserve call and settle.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(reserveCalled).toBe(1);
      expect(h.problem()).toBeUndefined();
    } finally {
      end();
    }
  });
});
