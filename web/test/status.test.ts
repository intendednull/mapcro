import { describe, expect, it } from "vitest";
import { rejection, statusView } from "../src/board/status";

const live = { kind: "live", role: "owner" } as const;
describe("save status", () => {
  it("never says Saved while a change waits", () => {
    expect(statusView({ kind: "syncing", pending: 2 }, live, false, undefined).kind).toBe("syncing");
    expect(statusView({ kind: "syncing", pending: 2 }, live, false, undefined).text).toBe("");
    expect(statusView({ kind: "syncing", pending: 2 }, live, true, undefined).text).toBe("Syncing (2)");
    expect(statusView({ kind: "saved" }, live, false, undefined).text).toBe("Saved");
  });
  it("offline says how many changes are kept here", () => {
    expect(statusView({ kind: "offline", pending: 5 }, { kind: "waiting", retryInMs: 400 }, false, undefined).text).toBe("Offline: 5 changes kept on this device");
    expect(statusView({ kind: "offline", pending: 1 }, { kind: "waiting", retryInMs: 400 }, false, undefined).text).toBe("Offline: 1 change kept on this device");
    expect(statusView({ kind: "saved" }, { kind: "waiting", retryInMs: 400 }, false, undefined).text).toBe("Offline: reconnecting");
  });
  it("a rejection says why, and a dead link says so", () => {
    expect(rejection('rejected: "TextTooLong"')).toBe("TextTooLong");
    expect(rejection("protocol error, reconnecting: x")).toBeUndefined();
    expect(statusView({ kind: "saved" }, live, false, "TextTooLong").text).toBe("Rejected: the text is too long");
    expect(statusView({ kind: "saved" }, { kind: "closed", reason: "unauthorized" }, false, undefined).kind).toBe("closed");
  });
  it("a full board says so, and how to keep working", () => {
    expect(rejection('rejected: "BoardFull"')).toBe("BoardFull");
    const v = statusView({ kind: "saved" }, live, false, "BoardFull");
    expect(v.kind).toBe("rejected");
    expect(v.text).toBe("Rejected: the board is full");
    expect(v.why).toContain("Clone it");
    expect(statusView({ kind: "saved" }, live, false, "ServerFull").text).toBe("Rejected: the server is out of space");
  });
});
