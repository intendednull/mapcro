// The linked replays folder (spec §6b, Getting a replay in): which names are the game's replays,
// newest first, a file still downloading held back, and read access asked for only on a click.
// A stub directory handle stands in for the browser's.
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import {
  type DirHandleLike,
  type FileHandleLike,
  folderSource,
  type Replay,
  SETTLE_MS,
  access,
  forgetFolder,
  found,
  listReplays,
  loadFolder,
  lookFailed,
  newestFirst,
  recent,
  replayId,
  saveFolder,
  settleIn,
  settled,
  supported,
} from "../src/player/folder";

describe("replayId", () => {
  it("is the match id of the game's `<match id>.dem`", () => {
    expect(replayId("130816395.dem")).toBe("130816395");
    expect(replayId("130816395.DEM")).toBe("130816395");
    expect(replayId("0130816395.dem")).toBe("130816395");
  });
  it("is nothing for any other name", () => {
    for (const n of ["130816395 (1).dem", "130816395.dem.part", "130816395.dem.bz2", "replay.dem", ".dem", "0.dem", "130816395", "a130816395.dem", "130816395.txt", "cfg"]) {
      expect(replayId(n), n).toBeUndefined();
    }
  });
});

const r = (id: string, lastModified: number): Replay => ({ id, lastModified, size: 1 });

describe("newestFirst", () => {
  it("sorts by when the file was written, newest first", () => {
    expect(newestFirst([r("1", 10), r("2", 30), r("3", 20)]).map((x) => x.id)).toEqual(["2", "3", "1"]);
  });
  it("puts the larger match id first on a tie, numerically", () => {
    expect(newestFirst([r("99", 5), r("130816395", 5), r("130816400", 5)]).map((x) => x.id)).toEqual(["130816400", "130816395", "99"]);
  });
  it("leaves its input alone", () => {
    const list = [r("1", 1), r("2", 2)];
    newestFirst(list);
    expect(list.map((x) => x.id)).toEqual(["1", "2"]);
  });
});

describe("settling", () => {
  const now = 1_000_000;
  it("holds back a file written in the last SETTLE_MS", () => {
    expect(settled(r("1", now - SETTLE_MS), now)).toBe(true);
    expect(settled(r("1", now - SETTLE_MS + 1), now)).toBe(false);
  });
  it("finds the open match's file only once it has settled", () => {
    const list = [r("7", now - 1000), r("8", now - 60_000)];
    expect(found(list, "8", now)?.id).toBe("8");
    expect(found(list, "7", now)).toBeUndefined();
    expect(found(list, "7", now + SETTLE_MS)?.id).toBe("7");
    expect(found(list, "9", now)).toBeUndefined();
    expect(found(list, undefined, now)).toBeUndefined();
  });
  it("says when to look again for a file still settling", () => {
    expect(settleIn([r("8", now - 60_000)], now)).toBeUndefined();
    expect(settleIn([r("7", now - 1000), r("6", now - 4000)], now)).toBe(SETTLE_MS - 4000 + 50);
  });
  it("offers other recent replays, newest first, without the open match's", () => {
    const list = newestFirst([r("1", now - 90_000), r("2", now - 80_000), r("3", now - 70_000), r("4", now - 60_000), r("5", now - 10)]);
    expect(recent(list, "4", now).map((x) => x.id)).toEqual(["3", "2", "1"]);
    expect(recent(list, undefined, now, 2).map((x) => x.id)).toEqual(["4", "3"]);
  });
});

/** A stub folder: its entries, and its permission as the browser would answer. */
function folder(names: Array<[string, number] | string>, perm: { now: PermissionState; onAsk?: PermissionState } = { now: "granted" }) {
  const opened: string[] = [];
  const asked: string[] = [];
  const entries = names.map((n): FileHandleLike | { kind: "directory"; name: string } =>
    typeof n === "string"
      ? { kind: "directory", name: n }
      : {
          kind: "file",
          name: n[0],
          getFile: async () => {
            opened.push(n[0]);
            return new File([new Uint8Array(3)], n[0], { lastModified: n[1] });
          },
        },
  );
  const dir: DirHandleLike = {
    kind: "directory",
    name: "replays",
    async *values() {
      yield* entries;
    },
    getFileHandle: async (name) => {
      const e = entries.find((x) => x.name === name);
      if (e?.kind !== "file") throw new DOMException(name, "NotFoundError");
      return e;
    },
    queryPermission: async () => {
      asked.push("query");
      return perm.now;
    },
    requestPermission: async () => {
      asked.push("request");
      perm.now = perm.onAsk ?? perm.now;
      return perm.now;
    },
  };
  return { dir, opened, asked };
}

describe("listReplays", () => {
  it("opens only the game's replay files, and lists them newest first", async () => {
    const f = folder([["130816395.dem", 100], ["notes.txt", 999], ["130816400.dem", 300], "130816401.dem", ["130816396.dem.part", 400], ["130816397.dem", 200]]);
    const list = await listReplays(f.dir);
    expect(list.map((x) => [x.id, x.lastModified, x.size])).toEqual([
      ["130816400", 300, 3],
      ["130816397", 200, 3],
      ["130816395", 100, 3],
    ]);
    // A folder named like a replay, a partial download and anything else are never opened.
    expect(f.opened.sort()).toEqual(["130816395.dem", "130816397.dem", "130816400.dem"]);
  });
  it("reads one replay by its match id, opening nothing else", async () => {
    const f = folder([["130816395.dem", 100], ["notes.txt", 999], ["130816400.dem", 300]]);
    const file = await folderSource(f.dir).read("130816400");
    expect([file.name, file.lastModified]).toEqual(["130816400.dem", 300]);
    expect(f.opened).toEqual(["130816400.dem"]);
    await expect(folderSource(f.dir).read("130816401")).rejects.toThrow();
  });
});

describe("access", () => {
  it("uses access already granted, without asking", async () => {
    const f = folder([], { now: "granted" });
    expect(await access(f.dir, true)).toBe("granted");
    expect(f.asked).toEqual(["query"]);
  });
  it("waits for a click: it asks only when told it's one", async () => {
    const f = folder([], { now: "prompt", onAsk: "granted" });
    expect(await access(f.dir, false)).toBe("prompt");
    expect(f.asked).toEqual(["query"]);
    expect(await access(f.dir, true)).toBe("granted");
    expect(f.asked).toEqual(["query", "query", "request"]);
  });
  it("reports a refusal, and doesn't ask again once denied", async () => {
    const f = folder([], { now: "prompt", onAsk: "denied" });
    expect(await access(f.dir, true)).toBe("denied");
    f.asked.length = 0;
    expect(await access(f.dir, true)).toBe("denied");
    expect(f.asked).toEqual(["query"]);
  });
  it("takes a handle without the calls as granted, and one that throws as needing a click", async () => {
    expect(await access({ kind: "directory", name: "x", values: async function* () {}, getFileHandle: () => Promise.reject(new Error("unused")) }, false)).toBe("granted");
    const f = folder([]);
    f.dir.queryPermission = () => Promise.reject(new DOMException("no gesture", "SecurityError"));
    expect(await access(f.dir, true)).toBe("prompt");
  });
});

describe("lookFailed", () => {
  it("tells access lost from a folder that's gone", () => {
    expect(lookFailed(new DOMException("x", "NotAllowedError"))).toBe("prompt");
    expect(lookFailed(new DOMException("x", "SecurityError"))).toBe("prompt");
    expect(lookFailed(new DOMException("x", "NotFoundError"))).toBe("gone");
    expect(lookFailed(undefined)).toBe("gone");
  });
});

describe("supported", () => {
  it("needs showDirectoryPicker in a secure context", () => {
    expect(supported({ showDirectoryPicker: () => {}, isSecureContext: true })).toBe(true);
    expect(supported({ showDirectoryPicker: () => {}, isSecureContext: false })).toBe(false);
    expect(supported({ isSecureContext: true })).toBe(false);
  });
});

describe("the kept folder", () => {
  it("keeps a handle for later visits, and forgets it", async () => {
    const idb = new IDBFactory();
    expect(await loadFolder(idb)).toBeUndefined();
    // A real handle is structured-cloneable; a plain object stands in for it here.
    expect(await saveFolder({ kind: "directory", name: "replays" } as unknown as DirHandleLike, idb)).toBe(true);
    expect((await loadFolder(idb))?.name).toBe("replays");
    await forgetFolder(idb);
    expect(await loadFolder(idb)).toBeUndefined();
  });
  it("still works for this visit when the handle can't be kept", async () => {
    const idb = new IDBFactory();
    // Functions can't be cloned, as a private window can't store a handle.
    expect(await saveFolder(folder([]).dir, idb)).toBe(false);
    expect(await loadFolder(idb)).toBeUndefined();
  });
});
