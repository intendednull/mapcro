import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBoard, fileName, isBoardFile, isJsonFile, refusalTag } from "../src/core/boardfile";
import type { Invoke } from "../src/player/desktop";

describe("board files", () => {
  it("are named after the board, safely", () => {
    expect(fileName("Scrim prep")).toBe("Scrim prep.mapcro.json");
    expect(fileName("a/b\\c:d*e?f\"g<h>i|j")).toBe("a_b_c_d_e_f_g_h_i_j.mapcro.json");
    expect(fileName("../../etc/passwd")).toBe("_.._etc_passwd.mapcro.json");
    expect(fileName("  ...  ")).toBe("board.mapcro.json");
    expect(fileName("x".repeat(200))).toBe(`${"x".repeat(80)}.mapcro.json`);
    // Windows' device names, alone or before a dot, in any case.
    for (const t of ["CON", "nul", "Com1", "LPT9", "aux.notes", "com\u00b9"]) expect(fileName(t)).toBe(`_${t}.mapcro.json`);
    expect(fileName("Console")).toBe("Console.mapcro.json");
    // Bidi overrides would show "json.exe" as something else; C1 controls are controls.
    expect(fileName("evil\u202enosj.exe")).toBe("evilnosj.exe.mapcro.json");
    expect(fileName("a\u2066b\u2069c\u200fd")).toBe("abcd.mapcro.json");
    expect(fileName("a\u0085b\u009fc")).toBe("a_b_c.mapcro.json");
    // Cut by character, never inside one.
    const name = fileName("\u{1F600}".repeat(100));
    expect(Array.from(name.replace(/\.mapcro\.json$/, ""))).toEqual(Array(80).fill("\u{1F600}"));
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    // A cut that ends on a space or a dot is trimmed again.
    expect(fileName(`${"x".repeat(79)} y`)).toBe(`${"x".repeat(79)}.mapcro.json`);
  });

  it("are told from replays", () => {
    expect(isBoardFile("Scrim prep.mapcro.json")).toBe(true);
    expect(isBoardFile("Scrim prep.mapcro (1).json")).toBe(true);
    expect(isBoardFile("BOARD.MAPCRO.JSON")).toBe(true);
    // Another JSON file is JSON, but not sent as a board when dropped.
    expect(isBoardFile("notes.json")).toBe(false);
    expect(isJsonFile("notes.json")).toBe(true);
    expect(isBoardFile("130816395.dem")).toBe(false);
    expect(isJsonFile("130816395.dem")).toBe(false);
  });

  it("refusals are tags", () => {
    expect(refusalTag(422, "newer")).toBe("Newer file");
    expect(refusalTag(413)).toBe("Too large");
    expect(refusalTag(413, "too_large")).toBe("Too large");
    expect(refusalTag(400, "not_a_board")).toBe("Not a board");
    expect(refusalTag(422, "invalid")).toBe("Bad file");
    expect(refusalTag(400, "too_deep")).toBe("Bad file");
    expect(refusalTag(429, "rate_limited")).toBe("Try later");
    expect(refusalTag(503, "busy")).toBe("Try later");
    expect(refusalTag(408, "timeout")).toBe("Try later");
    expect(refusalTag(507)).toBe("Server full");
    expect(refusalTag(500)).toBe("Failed");
  });
});

describe("Download", () => {
  const exported = JSON.stringify({ version: 1, title: "Scrim prep", matches: [] });
  const serving = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(exported, { status: 200, headers: { "content-type": "application/json" } })));

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("in the app saves through the Save as dialog, with the safe name and the board's text", async () => {
    serving();
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const invoke: Invoke = async (cmd, args) => {
      calls.push([cmd, args]);
      return "saved";
    };
    expect(await downloadBoard("b1", "tok", "Scrim prep", undefined, invoke)).toBeUndefined();
    // The page names the file and passes no path; the app's dialog decides where it goes.
    expect(calls).toEqual([["board_file_save", { name: fileName("Scrim prep"), contents: exported }]]);
  });

  it("in the app, cancelled and saved are quiet; a failure or a too-large board is a tag", async () => {
    serving();
    expect(await downloadBoard("b", "t", "x", undefined, async () => "cancelled")).toBeUndefined();
    expect(await downloadBoard("b", "t", "x", undefined, async () => "saved")).toBeUndefined();
    const rejects = (why: unknown): Invoke => async () => Promise.reject(why);
    expect(await downloadBoard("b", "t", "x", undefined, rejects("failed"))).toBe("Failed");
    expect(await downloadBoard("b", "t", "x", undefined, rejects("too_large"))).toBe("Too large");
    // Nothing from the app is shown raw.
    expect(await downloadBoard("b", "t", "x", undefined, rejects("C:\\Users\\someone"))).toBe("Failed");
    expect(await downloadBoard("b", "t", "x", undefined, async () => "weird")).toBe("Failed");
  });

  it("in a browser still saves a blob the browser way, and asks the app for nothing", async () => {
    serving();
    vi.useFakeTimers();
    const create = vi.fn((_b: Blob) => "blob:board");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const a = { href: "", download: "", click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => a), body: { append: vi.fn() } });

    expect(await downloadBoard("b", "t", "Scrim prep")).toBeUndefined();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].size).toBe(exported.length);
    expect(a.href).toBe("blob:board");
    expect(a.download).toBe("Scrim prep.mapcro.json");
    expect(a.click).toHaveBeenCalledTimes(1);
    expect(a.remove).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:board");
  });
});
