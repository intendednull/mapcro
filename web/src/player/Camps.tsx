// What a hovered map marker says (spec §6b), through the map's one hover label
// (map/HoverLabel.tsx), in Player. A label is short, and only there when it says something a
// player can't see (operator 2026-11-08): a timer ("Respawns in 1:20", "Buff respawns in 0:35",
// "Rift opens in 0:46", "Fades in 0:41", "Urn returns in 2:13"), an objective's health ("Walker 62%") or a name that is the news ("Casting buff", "Urn
// delivery point"). A camp that's up says nothing, and nor does any marker in Sandbox. Hovering
// one, or tapping it on the phone, shows it; the map never stops a pointer for it.

import { Show, createMemo, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { HUD_MAP_PX, type Marker, type OptionalFurniture, optionalShown, teamName } from "../map/model";
import { type Pt, mapToView, worldToView } from "../map/transform";
import { svgPoint } from "../board/Tokens";
import { type CampAt, type PowerupAt, type RejuvNow, type RiftAt, type UrnNow, clockLabel } from "../match/timeline";
import type { MatchPreview } from "../match/preview";
import { buffInfo } from "../match/buffs";
import { hoverMarker, localHover, registerHover } from "../map/HoverLabel";
import { urnTip } from "./Urn";

/** "in 0:25": the seconds left to `at`, rounded up. Labels stay short (operator 2026-11-08), so
 * no "(at m:ss)". */
export const inAt = (at: number, t: number) => `in ${clockLabel(Math.max(0, Math.ceil(at - t)))}`;


/** A camp (or the mid boss) at playback time t: its timer while down; up, nothing to say. */
export function campTip(c: CampAt, t: number): string | undefined {
  if (c.state === "unspawned") return `Spawns ${inAt(c.at, t)}`;
  if (c.state === "cleared") return `Respawns ${inAt(c.at, t)}`;
  return undefined;
}

/** A rift site at t. The rift spawns when its cash-in opens (`live_s`, exploration round 7); open,
 * it fades at `giveUp` unless a team captures it first ("Rift Faded Away...", citadel_main
 * `Citadel_HUD_KothTimeRanOut`; feedback #13). Nothing timed: nothing to say. */
export function riftTip(r: RiftAt, key: string, t: number): string | undefined {
  if (r.state === "active") {
    if (r.capture?.captured) return `Captured by ${teamName(r.capture.captured)}`;
    return r.giveUp != null && r.giveUp > t ? `Fades ${inAt(r.giveUp, t)}` : undefined;
  }
  if (r.state === "elsewhere" || !r.next) return undefined;
  return r.next.key === key ? `Rift opens ${inAt(r.next.t, t)}` : `Rift opens at the other site ${inAt(r.next.t, t)}`;
}

/** A bridge powerup site at t: the buff that's up, by name; else when the next one comes. */
export function powerupTip(p: PowerupAt, t: number): string | undefined {
  if (p.state === "up") return `${buffInfo(p.buff)?.name ?? "Unknown"} buff`;
  if (!p.next) return undefined;
  return `Buff ${p.first ? "spawns" : "respawns"} ${inAt(p.next.t, t)}`;
}

/** A team's Rejuvenator at t, on its top-bar timer's hover (feedback #44): "Archmother
 * Rejuvenator ends in 1:40". The revives left are the marks beside it, so not here; the game's
 * own hover there (#RejuvenatorTimer, citadel_main `citadel_rejuvenator_hud_hint`) is a sentence
 * that explains, not a time. */
export function rejuvTip(r: RejuvNow, t: number): string {
  return `${teamName(r.team)} Rejuvenator ends ${inAt(r.ends, t)}`;
}

/** The Soul Urn itself at t, where it lies: when it walks back, once it has settled. */
export function urnItemTip(u: UrnNow, t: number): string {
  if (u.state !== "ground" || u.returns == null) return "Urn";
  return u.returns > t ? `Urn returns ${inAt(u.returns, t)}` : "Urn returning";
}

/** The urn's hover reference: not a marker, but labelled like one. */
export const URN_HOVER = "soul-urn";

/** Objectives with health, by marker kind: what their label calls them. */
const HEALTH_NAME: Partial<Record<Marker["kind"], string>> = { t1: "Guardian", t2: "Walker", barracks: "Base guardian", shrine: "Shrine", t3: "Patron", midboss: "Mid-Boss" };

/** "Walker 62%": an objective with health and its health now, rounded; `undefined` unknown. */
export function healthTip(kind: Marker["kind"], pct: number | undefined): string | undefined {
  const name = HEALTH_NAME[kind];
  return name && pct !== undefined ? `${name} ${Math.round(Math.max(0, Math.min(100, pct)))}%` : undefined;
}

/**
 * What marker `m` says at t in Player, if anything: a timer, an objective's health ("Walker
 * 62%", operator 2026-11-09), or a name that is the news (the buff that's up, an open delivery
 * point). Players know a camp when they see one, so one that's up says nothing; an objective
 * whose health isn't known (Health off, the API summary) or that's down says nothing either,
 * nor does anything in Sandbox, where the board sets no health.
 */
export function markerTip(m: Pick<Marker, "key" | "kind">, pv: MatchPreview | undefined, t: number): string | undefined {
  if (!pv) return undefined;
  const c = pv.camps.get(m.key);
  // A healing pickup has a camp's timers: taken, when it's back; up, nothing to say.
  if ((m.kind === "camp" || m.kind === "heal" || m.kind === "crate") && c) return campTip(c, t);
  const hp = pv.down.has(m.key) ? undefined : pv.health?.get(m.key)?.pct;
  if (m.kind === "midboss") {
    // Down: its respawn alone; up: its health. A held Rejuvenator's time is on its top-bar
    // timer's hover, its revives the marks beside it (feedback #44). The API summary has the
    // kills, not the respawns: nothing timed there.
    return (c ? campTip(c, t) : undefined) ?? healthTip(m.kind, hp);
  }
  if (HEALTH_NAME[m.kind]) return healthTip(m.kind, hp);
  const r = pv.rifts?.get(m.key);
  if (m.kind === "koth" && r) return riftTip(r, m.key, t);
  const b = pv.powerups?.get(m.key);
  if (m.kind === "powerup" && b) return powerupTip(b, t);
  if (m.kind === "urn" && pv.urn) return urnTip(pv.urn, m.key, t);
  return undefined;
}

/** `hidden`: a marker hidden from the map (an objective turned off), which has nothing to say.
 * `shown`: the healing pickups and heavy boxes this browser draws (their toggles); off, they
 * can't be hovered. */
export function MarkerTips(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; hidden: (key: string) => boolean; shown?: () => OptionalFurniture; preview: () => MatchPreview | undefined; t: () => number; k: number }) {
  let g!: SVGGElement;
  const markers = () => {
    const on = p.shown?.() ?? {};
    return p.art.model.markers.filter((m) => optionalShown(m.kind, on));
  };
  const urn = () => {
    const u = p.preview()?.urn;
    return u?.state === "ground" && u.at ? { u, at: worldToView(u.at, p.vp) } : undefined;
  };
  const near = (at: Pt) => {
    // The urn on the ground is drawn over the markers: it wins within its own size.
    const g = urn();
    if (g && Math.hypot(g.at.x - at.x, g.at.y - at.y) <= Math.max(8, (32 / HUD_MAP_PX) * 1000 * 0.3 * p.k)) return URN_HOVER;
    let best: { key: string; d: number } | undefined;
    for (const m of markers()) {
      if (p.hidden(m.key)) continue;
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
        if (p.hidden(m.key)) return undefined;
        // Nothing to say is still a marker under the pointer: an empty text, which the label
        // doesn't draw but which keeps the wave's handle under it from labelling.
        const text = markerTip(m, p.preview(), p.t()) ?? "";
        const at = mapToView(m.at, p.vp);
        return { x: at.x, y: at.y, gap: Math.max(10, (m.px / HUD_MAP_PX) * 1000 * 0.22 * p.k) + 6 * p.k, text };
      }),
    ),
  );
  createMemo(() => {
    const off = regs();
    onCleanup(() => off.forEach((f) => f()));
  });
  onCleanup(
    registerHover("marker", URN_HOVER, () => {
      const g = urn();
      return g ? { x: g.at.x, y: g.at.y, gap: Math.max(10, (32 / HUD_MAP_PX) * 1000 * 0.22 * p.k) + 6 * p.k, text: urnItemTip(g.u, p.t()) } : undefined;
    }),
  );
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

/**
 * A hovered teleporter's pair, shown only then and faintly: a dashed line to the other end, and a
 * ring on it. The tunnels cross the whole map, so the two ends of one aren't otherwise told apart
 * from the other pair's.
 */
export function TeleporterLink(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; k: number }) {
  const pair = createMemo(() => {
    const h = localHover();
    if (h?.kind !== "marker") return undefined;
    const a = p.art.model.markers.find((m) => m.key === h.id && m.kind === "teleporter");
    const b = a?.link ? p.art.model.markers.find((m) => m.key === a.link) : undefined;
    return a && b ? { a: mapToView(a.at, p.vp), b: mapToView(b.at, p.vp), key: b.key } : undefined;
  });
  return (
    <Show when={pair()}>
      {(x) => (
        <g class="tele-link" data-testid="teleporter-link" data-to={x().key}>
          <line x1={x().a.x} y1={x().a.y} x2={x().b.x} y2={x().b.y} />
          <circle cx={x().b.x} cy={x().b.y} r={Math.max(6, (20 / HUD_MAP_PX) * 1000 * 0.5 * p.k)} />
        </g>
      )}
    </Show>
  );
}
