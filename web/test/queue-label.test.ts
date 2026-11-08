// The tier chip's queue labels (spec §6a, the queue): labels only, no prose.
import { describe, expect, it } from "vitest";
import { busy, etaLabel, queueLabel } from "../src/player/api";

describe("queue labels", () => {
  it("say how many are ahead, and the wait when the server has an estimate", () => {
    expect(queueLabel({ state: "queued", ahead: 3 })).toBe("Queued · 3 ahead");
    expect(queueLabel({ state: "queued", ahead: 3, eta_s: 50 })).toBe("Queued · 3 ahead · ~1 min");
    expect(queueLabel({ state: "queued", ahead: 0, eta_s: 140 })).toBe("Queued · ~2 min");
    expect(queueLabel({ state: "queued" })).toBe("Queued");
    expect(queueLabel({ state: "waiting", ahead: 2 })).toBe("Waiting for a slot · 2 ahead");
    expect(queueLabel({ state: "waiting", ahead: 0 })).toBe("Waiting for a slot");
    expect(queueLabel({ state: "parsing" })).toBeUndefined();
    expect(queueLabel(undefined)).toBeUndefined();
  });

  it("round the wait to whole minutes, never under one", () => {
    expect(etaLabel(5)).toBe("~1 min");
    expect(etaLabel(89)).toBe("~1 min");
    expect(etaLabel(91)).toBe("~2 min");
  });

  it("count a reservation waiting in line as busy", () => {
    expect(busy({ state: "waiting" })).toBe(true);
    expect(busy({ state: "done" })).toBe(false);
  });
});
