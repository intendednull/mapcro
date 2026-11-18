import { describe, expect, it } from "vitest";
import { asksName, rejection, statusView } from "../src/board/status";

const live = { kind: "live", role: "owner" } as const;
describe("save status", () => {
  it("never says Saved while a change waits", () => {
    expect(statusView({ kind: "syncing", pending: 2 }, live, false, undefined).kind).toBe("syncing");
    expect(statusView({ kind: "syncing", pending: 2 }, live, false, undefined).text).toBe("");
    expect(statusView({ kind: "syncing", pending: 2 }, live, true, undefined).text).toBe("Syncing 2");
    expect(statusView({ kind: "saved" }, live, false, undefined).text).toBe("Saved");
  });
  it("offline says how many changes are kept here", () => {
    expect(statusView({ kind: "offline", pending: 5 }, { kind: "waiting", retryInMs: 400 }, false, undefined).text).toBe("Offline: 5 kept");
    expect(statusView({ kind: "offline", pending: 1 }, { kind: "waiting", retryInMs: 400 }, false, undefined).text).toBe("Offline: 1 kept");
    expect(statusView({ kind: "saved" }, { kind: "waiting", retryInMs: 400 }, false, undefined).text).toBe("Offline");
  });
  it("a rejection is named, and a dead link says so", () => {
    expect(rejection('rejected: "TextTooLong"')).toBe("TextTooLong");
    expect(rejection("protocol error, reconnecting: x")).toBeUndefined();
    expect(statusView({ kind: "saved" }, live, false, "TextTooLong").text).toBe("Text too long");
    expect(statusView({ kind: "saved" }, { kind: "closed", reason: "unauthorized" }, false, undefined)).toEqual({ kind: "closed", text: "Invalid link" });
    expect(statusView({ kind: "saved" }, { kind: "closed", reason: "revoked" }, false, undefined)).toEqual({ kind: "closed", text: "Link revoked" });
  });
  it("a full board says so", () => {
    expect(rejection('rejected: "BoardFull"')).toBe("BoardFull");
    const v = statusView({ kind: "saved" }, live, false, "BoardFull");
    expect(v.kind).toBe("rejected");
    expect(v.text).toBe("Board full");
    expect(statusView({ kind: "saved" }, live, false, "ServerFull").text).toBe("Server full");
  });
});

describe("the join card (sessions.md §8)", () => {
  const refused = { kind: "closed", reason: "unauthorized" } as const;
  const revoked = { kind: "closed", reason: "revoked" } as const;
  const outdated = { kind: "closed", reason: "outdated" } as const;
  it("a board alone asks while it connects, and not once it's refused", () => {
    expect(asksName(false, { kind: "connecting", attempt: 0 }, false)).toBe(true);
    expect(asksName(false, live, false)).toBe(true);
    expect(asksName(false, refused, false)).toBe(false);
    expect(asksName(false, revoked, false)).toBe(false);
  });
  it("a session's tab asks even when its board refuses: the name is the session's", () => {
    expect(asksName(false, refused, true)).toBe(true);
    expect(asksName(false, revoked, true)).toBe(true);
    expect(asksName(false, live, true)).toBe(true);
  });
  it("an outdated build offers the update alone, and someone who gave a name isn't asked", () => {
    expect(asksName(false, outdated, true)).toBe(false);
    expect(asksName(false, outdated, false)).toBe(false);
    for (const c of [live, refused, outdated]) for (const session of [true, false]) expect(asksName(true, c, session)).toBe(false);
  });
});
