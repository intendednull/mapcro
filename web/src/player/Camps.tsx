// What a hovered map marker says (spec §6b), through the map's one hover label
// (map/HoverLabel.tsx). Anywhere, a marker names itself ("Guardian (Amber, west lane)"). In
// Player, everything that spawns says when: camps and the mid boss, the rifts, the bridge
// powerups and the urn's points, as "Respawns in m:ss (at m:ss)" while down and "Up" (or
// "active") while up. No countdown shows otherwise. Hovering one, or tapping it on the phone,
// shows it; the map never stops a pointer for it.

import { createMemo, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { HUD_MAP_PX, type Marker } from "../map/model";
import { type Pt, mapToView } from "../map/transform";
import { svgPoint } from "../board/Tokens";
import { type CampAt, type PowerupAt, type RiftAt, clockLabel } from "../match/timeline";
import type { MatchPreview } from "../match/preview";
import { buffInfo, buffLabel } from "../match/buffs";
import { hoverMarker, localHover, registerHover } from "../map/HoverLabel";
import { urnTip } from "./Urn";

/** "in 0:25 (at 1:35)": the seconds left to `at`, rounded up, and when. */
export const inAt = (at: number, t: number) => `in ${clockLabel(Math.max(0, Math.ceil(at - t)))} (at ${clockLabel(at)})`;

/** The tooltip for a camp at playback time t; `who` names it (the mid boss), else the camp's
 * own words. */
export function campTip(c: CampAt, t: number, who?: string): string {
  const say = (s: string) => (who ? `${who} ${s[0]!.toLowerCase()}${s.slice(1)}` : s);
  if (c.state === "unspawned") return say(`Spawns ${inAt(c.at, t)}`);
  if (c.state === "cleared") return say(`Respawns ${inAt(c.at, t)}`);
  return say("Up");
}

/** A rift site at t. The rift spawns when its cash-in opens (`live_s`, exploration round 7). */
export function riftTip(r: RiftAt, key: string, t: number): string {
  if (r.state === "active") return "Rift active";
  if (r.state === "elsewhere") return "Rift active at the other site";
  if (!r.next) return "No more rifts in this replay";
  return r.next.key === key ? `Rift spawns here ${inAt(r.next.t, t)}` : `Next rift spawns at the other site ${inAt(r.next.t, t)}`;
}

/** A bridge powerup site at t: the buff that's up, else the next one and when. */
export function powerupTip(p: PowerupAt, t: number): string {
  if (p.state === "up") return `${buffLabel(p.buff)} up`;
  if (!p.next) return "No more buffs in this replay";
  const name = buffInfo(p.next.buff)?.name ?? p.next.buff;
  return `${name} buff ${p.first ? "spawns" : "respawns"} ${inAt(p.next.t, t)}`;
}

/** What marker `m` says at t: its timer in Player where the match has one, else its name. */
export function markerTip(m: Pick<Marker, "key" | "kind" | "title">, pv: MatchPreview | undefined, t: number): string {
  if (pv) {
    const c = pv.camps.get(m.key);
    if (m.kind === "camp" && c) return campTip(c, t);
    if (m.kind === "midboss") {
      if (c) return campTip(c, t, "Mid boss");
      // The API summary has the kills, not the respawns.
      return pv.down.has(m.key) ? "Mid boss down: its respawn isn't in the API summary" : "Mid boss up";
    }
    const r = pv.rifts?.get(m.key);
    if (m.kind === "koth" && r) return riftTip(r, m.key, t);
    const b = pv.powerups?.get(m.key);
    if (m.kind === "powerup" && b) return powerupTip(b, t);
    if (m.kind === "urn" && pv.urn) return urnTip(pv.urn, m.key, t);
  }
  return m.title;
}

export function MarkerTips(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; preview: () => MatchPreview | undefined; t: () => number; k: number }) {
  let g!: SVGGElement;
  const markers = () => p.art.model.markers;
  const near = (at: Pt) => {
    let best: { key: string; d: number } | undefined;
    for (const m of markers()) {
      const v = mapToView(m.at, p.vp);
      const d = Math.hypot(v.x - at.x, v.y - at.y);
      // About the icon's drawn size: markers draw at ~40% of their HUD box.
      const r = Math.max(8, (m.px / HUD_MAP_PX) * 1000 * 0.25 * p.k);
      if (d <= r && (!best || d < best.d)) best = { key: m.key, d };
    }
    return best?.key;
  };
  const set = (key: string | undefined) => hoverMarker(key ? { kind: "marker", id: key } : undefined);
  // Every marker can say what it is, from this browser's own state (a follower's too).
  const regs = createMemo(() =>
    markers().map((m) =>
      registerHover("marker", m.key, () => {
        const at = mapToView(m.at, p.vp);
        return { x: at.x, y: at.y, gap: Math.max(10, (m.px / HUD_MAP_PX) * 1000 * 0.22 * p.k) + 6 * p.k, text: markerTip(m, p.preview(), p.t()) };
      }),
    ),
  );
  createMemo(() => {
    const off = regs();
    onCleanup(() => off.forEach((f) => f()));
  });
  onMount(() => {
    // Listened to on the overlay itself, never intercepting: drawing, the laser and the tools
    // work over a marker as anywhere else.
    const svg = g.ownerSVGElement;
    if (!svg) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || e.pointerType === "pen") set(near(svgPoint(svg, e)));
    };
    const leave = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || e.pointerType === "pen") set(undefined);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const k = near(svgPoint(svg, e));
      const h = localHover();
      set(k && !(h?.kind === "marker" && h.id === k) ? k : undefined);
    };
    svg.addEventListener("pointermove", move, { passive: true });
    svg.addEventListener("pointerleave", leave, { passive: true });
    svg.addEventListener("pointerdown", down, { passive: true });
    onCleanup(() => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerleave", leave);
      svg.removeEventListener("pointerdown", down);
      set(undefined);
    });
  });
  return <g ref={g} class="marker-tips" />;
}
