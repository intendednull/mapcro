import { describe, expect, it } from "vitest";
import { hoverHandle, hoverMarker, hoverToken, localHover, registerHover } from "../src/map/HoverLabel";

const spot = (text: string) => () => ({ x: 0, y: 0, gap: 0, text });

describe("the local hover", () => {
  it("is the first hovered thing that's on the map: a gone token never hides the marker under the pointer", () => {
    const offTok = registerHover("token", "Amber-0", () => undefined);
    const offMk = registerHover("marker", "camp:x", spot("Camp"));
    const offWave = registerHover("marker", "wave:lane1", spot("Wave"));
    hoverToken({ kind: "token", id: "Amber-0" });
    hoverHandle({ kind: "marker", id: "wave:lane1" });
    expect(localHover()?.id).toBe("wave:lane1");
    hoverMarker({ kind: "marker", id: "camp:x" });
    expect(localHover()?.id).toBe("camp:x");
    hoverMarker(undefined);
    offWave();
    expect(localHover()).toBeUndefined();
    offTok();
    offMk();
    hoverToken(undefined);
    hoverHandle(undefined);
  });
});
