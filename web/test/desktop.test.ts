// The Windows app's bridge (desktop/README.md): found only when the app's IPC is there; the
// app's replays folder as a ReplaySource; its parse uploaded as a timeline, falling back to the
// `.dem` when the server has no timeline route; and the download link, gated.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Api } from "../src/player/api";
import { DesktopError, type Invoke, WINDOWS_APP_URL, bridge, desktopSource, isLocal, windowsAppLink } from "../src/player/desktop";
import { folderSource } from "../src/player/folder";
import { noticeFor } from "../src/player/notice";

describe("bridge", () => {
  it("is the app's invoke, called on its own object", async () => {
    const internals = {
      tag: "app",
      invoke(this: { tag: string }, cmd: string, args?: Record<string, unknown>) {
        return Promise.resolve([this.tag, cmd, args]);
      },
    };
    const b = bridge({ __TAURI_INTERNALS__: internals });
    expect(b).toBeTypeOf("function");
    expect(await b!("replays_list", { a: 1 })).toEqual(["app", "replays_list", { a: 1 }]);
  });
  it("is nothing in a browser", () => {
    expect(bridge({})).toBeUndefined();
    expect(bridge({ __TAURI_INTERNALS__: {} })).toBeUndefined();
    expect(bridge({ __TAURI_INTERNALS__: { invoke: "no" } })).toBeUndefined();
    expect(bridge(undefined)).toBeUndefined();
    expect(bridge()).toBeUndefined();
  });
});

/** A stand-in for the app: answers per command, and records the calls. */
function app(answers: Record<string, (args?: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown> | undefined][] = [];
  const invoke: Invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    const a = answers[cmd];
    if (!a) throw "unknown_command";
    return a(args);
  };
  return { invoke, calls };
}

describe("desktopSource", () => {
  it("lists the app's replays newest first, dropping anything that isn't one", async () => {
    const { invoke } = app({
      replays_list: () => [
        { id: "100", lastModified: 1, size: 5 },
        { id: "300", lastModified: 3, size: 7, path: "C:\\never\\used" },
        { id: "../x", lastModified: 9, size: 1 },
        { id: "0123", lastModified: 9, size: 1 },
        { id: "200", lastModified: "soon", size: 1 },
        null,
      ],
    });
    const list = await desktopSource(invoke).list();
    expect(list).toEqual([
      { id: "300", lastModified: 3, size: 7 },
      { id: "100", lastModified: 1, size: 5 },
    ]);
  });
  it("throws the app's reason code", async () => {
    const { invoke } = app({ replays_list: () => Promise.reject("not_found"), replay_timeline: () => Promise.reject("brawl") });
    const s = desktopSource(invoke);
    await expect(s.list()).rejects.toMatchObject({ name: "DesktopError", code: "not_found" });
    await expect(s.timeline("5")).rejects.toMatchObject({ code: "brawl" });
    // Anything that isn't a plain code is just "failed" (nothing from the app is shown raw).
    const odd = desktopSource(app({ replays_list: () => Promise.reject(new Error("C:\\Users\\someone")) }).invoke);
    await expect(odd.list()).rejects.toMatchObject({ code: "failed" });
    const notList = desktopSource(app({ replays_list: () => ({}) }).invoke);
    await expect(notList.list()).rejects.toBeInstanceOf(DesktopError);
  });
  it("reads a replay and its timeline by match id only, as bytes", async () => {
    const { invoke, calls } = app({
      replay_read: () => new TextEncoder().encode("PBDEMS2\0").buffer,
      replay_timeline: () => new Uint8Array([0x1f, 0x8b, 8]),
    });
    const s = desktopSource(invoke);
    const f = await s.read("130816395");
    expect(f.name).toBe("130816395.dem");
    expect(new TextDecoder().decode(await f.arrayBuffer())).toBe("PBDEMS2\0");
    const t = await s.timeline("130816395");
    expect([...new Uint8Array(await t.arrayBuffer())]).toEqual([0x1f, 0x8b, 8]);
    expect(calls).toEqual([
      ["replay_read", { id: "130816395" }],
      ["replay_timeline", { id: "130816395" }],
    ]);
  });
  it("takes a number array too (an IPC that answers JSON)", async () => {
    const s = desktopSource(app({ replay_timeline: () => [1, 2, 3] }).invoke);
    expect([...new Uint8Array(await (await s.timeline("1")).arrayBuffer())]).toEqual([1, 2, 3]);
    const bad = desktopSource(app({ replay_timeline: () => "text" }).invoke);
    await expect(bad.timeline("1")).rejects.toMatchObject({ code: "failed" });
  });
  it("is a local source; the linked folder isn't", () => {
    expect(isLocal(desktopSource(app({}).invoke))).toBe(true);
    const dir = { kind: "directory" as const, name: "replays", values: async function* () {}, getFileHandle: () => Promise.reject(new Error()) };
    expect(isLocal(folderSource(dir))).toBe(false);
    expect(isLocal(undefined)).toBe(false);
  });
});

describe("Api.uploadTimeline", () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, body?: unknown) =>
    vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: body === undefined ? {} : { "content-type": "application/json" } }));

  it("posts the gzip to the board's timeline route with the board's token", async () => {
    const f = answer(200, { state: "done", source: "upload", client: true });
    vi.stubGlobal("fetch", f);
    const gz = new Blob([new Uint8Array([0x1f, 0x8b])]);
    expect(await new Api("b1", "tok").uploadTimeline("130816395", gz)).toBeUndefined();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/boards/b1/replays/130816395/timeline");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ authorization: "Bearer tok", "content-encoding": "gzip", "content-type": "application/json" });
    expect(init.body).toBe(gz);
  });
  it("is `missing` only for a 404 without an error body: a server without the route", async () => {
    vi.stubGlobal("fetch", answer(404));
    expect(await new Api("b", "t").uploadTimeline("1", new Blob())).toBe("missing");
    // The route's own 404 (the board is gone) is an error, not a reason to send the file.
    vi.stubGlobal("fetch", answer(404, { error: "no_board" }));
    expect(await new Api("b", "t").uploadTimeline("1", new Blob())).toBe("no_board");
  });
  it("gives the server's code, or offline", async () => {
    for (const [status, code] of [
      [422, "outdated_parser"],
      [422, "brawl"],
      [409, "in_progress"],
      [429, "rate_limited"],
      [403, "view_only"],
    ] as const) {
      vi.stubGlobal("fetch", answer(status, { error: code, message: "x" }));
      expect(await new Api("b", "t").uploadTimeline("1", new Blob())).toBe(code);
    }
    vi.stubGlobal("fetch", answer(500));
    expect(await new Api("b", "t").uploadTimeline("1", new Blob())).toBe("failed");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("network"))));
    expect(await new Api("b", "t").uploadTimeline("1", new Blob())).toBe("offline");
  });
});

describe("windowsAppLink", () => {
  const win = { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36" };
  const linux = { userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/142" };
  it("is the releases page on a Windows browser, once released", () => {
    expect(windowsAppLink({ released: true, nav: win, w: {} })).toBe(WINDOWS_APP_URL);
    expect(windowsAppLink({ released: true, nav: { userAgentData: { platform: "Windows" } }, w: {} })).toBe(WINDOWS_APP_URL);
  });
  it("is nothing before the first release, elsewhere, or inside the app", () => {
    expect(windowsAppLink({ nav: win, w: {} })).toBeUndefined();
    expect(windowsAppLink({ released: true, nav: linux, w: {} })).toBeUndefined();
    expect(windowsAppLink({ released: true, nav: { userAgentData: { platform: "macOS" }, userAgent: win.userAgent }, w: {} })).toBeUndefined();
    expect(windowsAppLink({ released: true, nav: win, w: { __TAURI_INTERNALS__: { invoke: () => Promise.resolve() } } })).toBeUndefined();
  });
});

describe("the timeline route's refusals", () => {
  it("each says what to do, not just Failed", () => {
    for (const c of ["outdated_parser", "newer_parser", "wrong_match", "not_a_timeline", "file_gone"]) {
      expect(noticeFor(c, "upload")?.text, c).not.toBe("Failed. Try again.");
    }
    expect(noticeFor("outdated_parser", "upload")?.text).toMatch(/Update the mapcro app/);
  });
});
