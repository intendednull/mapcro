import { describe, expect, it } from "vitest";
import { hoverHandle, hoverMarker, hoverToken, hoverUnit, localHover, registerHover } from "../src/map/HoverLabel";

const spot = (text: string) => () => ({ x: 0, y: 0, gap: 0, text });

describe("the local hover", () => {
  it("is the first hovered thing that's on the map: token > unit > marker > handle, and a gone token never hides what is under it", () => {
    const offTok = registerHover("token", "Amber-0", () => undefined);
    const offLiveTok = registerHover("token", "Amber-1", spot("Hero"));
    const offUnit = registerHover("marker", "rift-trooper:1", spot("Rift trooper"));
    const offMk = registerHover("marker", "camp:x", spot("Camp"));
    const offWave = registerHover("marker", "wave:lane1", spot("Wave"));
    hoverToken({ kind: "token", id: "Amber-0" });
    hoverHandle({ kind: "marker", id: "wave:lane1" });
    expect(localHover()?.id).toBe("wave:lane1");
    hoverMarker({ kind: "marker", id: "camp:x" });
    expect(localHover()?.id).toBe("camp:x");
    // A hovered moving unit (rift trooper) beats static markers like the rift spawner underneath it.
    hoverUnit({ kind: "marker", id: "rift-trooper:1" });
    expect(localHover()?.id).toBe("rift-trooper:1");
    // A live hero token still beats a unit.
    hoverToken({ kind: "token", id: "Amber-1" });
    expect(localHover()?.id).toBe("Amber-1");
    hoverToken(undefined);
    expect(localHover()?.id).toBe("rift-trooper:1");
    hoverUnit(undefined);
    expect(localHover()?.id).toBe("camp:x");
    hoverMarker(undefined);
    offWave();
    expect(localHover()).toBeUndefined();
    offTok();
    offLiveTok();
    offUnit();
    offMk();
    hoverHandle(undefined);
  });
});
