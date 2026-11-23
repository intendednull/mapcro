// What a hovered map marker says (spec §6b), through the map's one hover label
// (map/HoverLabel.tsx), in Player. A label is short, and only there when it says something a
// player can't see (operator 2026-11-08): a timer ("Respawns in 1:20", "Buff respawns in 0:35",
// "Rift opens in 0:46", "Fades in 0:41", "Urn returns in 2:13"), an objective's health ("Walker 62%") or a name that is the news ("Casting buff", "Urn
// delivery point"). A camp that's up says nothing, and nor does any marker in Sandbox. Hovering
// one, or tapping it on the phone, shows it; the map never stops a pointer for it.

import { Show, createMemo, onCleanup, onMount } from "solid-js";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { Art } from "../map/pack";
import { HUD_MAP_PX, type Marker, type OptionalFurniture, optionalShown, teamName } from "../map/model";
import { type Pt, mapToView, worldToView } from "../map/transform";
import { svgPoint } from "../board/Tokens";
import { type CampAt, type PowerupAt, type RejuvNow, type RiftAt, type UrnNow, clockLabel } from "../match/timeline";
import type { TokenFrame } from "../board/Tokens";
import type { MapState } from "../mapstate/state";
import { shownUrn } from "../mapstate/shown";
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

/**
 * What the top bar's centre timer draws at t, as the game's #RejuvenatorTimer does
 * (citadel_hud_top_bar.vcss): a held Rejuvenator's timer (`.has_rejuv`, with revives left), else
 * the Mid-Boss's respawn while it's dead (`.midboss_cooldown`, the circle greyed with the time
 * under it), else nothing (`.midboss_available` collapses it). `boss` is the mid boss's camp at t
 * (the timeline's cleared pairs, as its map hover's "Respawns in").
 */
export type CentreTimer = { kind: "rejuv" } | { kind: "respawn"; at: number } | { kind: "none" };
export function centreTimer(held: RejuvNow[], boss: CampAt | undefined): CentreTimer {
  if (held.some((r) => r.left > 0)) return { kind: "rejuv" };
  if (boss?.state === "cleared") return { kind: "respawn", at: boss.at };
  return { kind: "none" };
}

/** The greyed centre timer's hover: "Mid-Boss respawns in 4:40". */
export const respawnTip = (at: number, t: number) => `Mid-Boss respawns ${inAt(at, t)}`;

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

/** What a marker's hover reads of the frame at t. */
export interface TipFacts {
  down: boolean;
  camp?: CampAt | undefined;
  /** Its health, under the viewer's Health. */
  health?: number | undefined;
  rift?: RiftAt | undefined;
  powerup?: PowerupAt | undefined;
  urn?: UrnNow | undefined;
}

/** Baseline camp compatible with a scene's stored `ObjectiveState`: suppress only when `own`
 * contradicts the baseline (revived cleared camp or manually killed live camp). Keeps matching
 * respawn timers on legacy-save → Retake scenes where `ObjectiveState: Destroyed` was already stored. */
export function effectiveCamp(own: ObjectiveStatus | undefined, base: CampAt | undefined): CampAt | undefined {
  if (!base || own === undefined) return base;
  if (own === "Active") return base.state === "alive" ? base : undefined;
  if (own === "Destroyed") return base.state !== "alive" ? base : undefined;
  return undefined;
}

/** Baseline rift compatible with a scene's stored `ObjectiveState`. When `baseSite` is provided,
 * an announced pre-live rift (`baseSite === "Active"` with `base.state === "waiting"`) treats a
 * matching `ObjectiveState: Active` (e.g. from legacy R1/R2 replay-scene Retake) as compatible,
 * while contradicting overrides (`Destroyed` on an active/announced site, or `Active` on a dark
 * site) suppress the baseline. */
export function effectiveRift(
  own: ObjectiveStatus | undefined,
  base: RiftAt | undefined,
  baseSite?: ObjectiveStatus | undefined,
): RiftAt | undefined {
  if (!base || own === undefined) return base;
  const baseOn = baseSite !== undefined ? baseSite === "Active" : base.state === "active";
  if (own === "Active") return baseOn ? base : undefined;
  if (own === "Destroyed") return !baseOn ? base : undefined;
  return undefined;
}

/** Baseline powerup compatible with a scene's stored `ObjectiveState`. */
export function effectivePowerup(own: ObjectiveStatus | undefined, base: PowerupAt | undefined): PowerupAt | undefined {
  if (!base || own === undefined) return base;
  if (own === "Active") return base.state === "up" ? base : undefined;
  if (own === "Destroyed") return base.state === "down" ? base : undefined;
  return undefined;
}

/** Baseline urn detail on an `urn:*` marker compatible with a scene's stored `ObjectiveState`. */
export function effectiveUrn(own: ObjectiveStatus | undefined, key: string, urn: UrnNow | undefined): UrnNow | undefined {
  if (!urn || own === undefined || !key.startsWith("urn:")) return urn;
  if (own === "Active") return urn.delivery === key ? urn : undefined;
  if (own === "Destroyed") return urn.delivery !== key ? urn : undefined;
  return undefined;
}

/** Marker `key`'s facts in the frame. Contradicting status overrides win over baseline timers/buffs/rifts (plan §4). */
export function tipFacts(ms: MapState, key: string, health: boolean, urn: UrnNow | undefined): TipFacts {
  const m = ms.marker(key);
  const own = m.status();
  const down = own !== undefined ? own === "Destroyed" : m.down();
  return {
    down,
    camp: effectiveCamp(own, m.camp()),
    health: health && !down ? m.health()?.pct : undefined,
    rift: effectiveRift(own, m.rift(), m.site()),
    powerup: effectivePowerup(own, m.powerup()),
    urn: effectiveUrn(own, key, urn),
  };
}

/**
 * What marker `m` says at t, if anything: a timer, an objective's health ("Walker 62%", operator
 * 2026-11-09), or a name that is the news (the buff that's up, an open delivery point). Players
 * know a camp when they see one, so one that's up says nothing; an objective whose health isn't
 * known (Health off, the API summary) or that's down says nothing either, nor does anything in a
 * scene, whose frame holds no timers or health.
 */
export function markerTip(m: Pick<Marker, "key" | "kind">, f: TipFacts, t: number): string | undefined {
  const c = f.camp;
  // A healing pickup has a camp's timers: taken, when it's back; up, nothing to say.
  if ((m.kind === "camp" || m.kind === "heal" || m.kind === "crate") && c) return campTip(c, t);
  const hp = f.down ? undefined : f.health;
  if (m.kind === "midboss") {
    // Down: its respawn alone; up: its health. A held Rejuvenator's time is on its top-bar
    // timer's hover, its revives the marks beside it (feedback #44). The API summary has the
    // kills, not the respawns: nothing timed there.
    return (c ? campTip(c, t) : undefined) ?? healthTip(m.kind, hp);
  }
  if (HEALTH_NAME[m.kind]) return healthTip(m.kind, hp);
  if (m.kind === "koth" && f.rift) return riftTip(f.rift, m.key, t);
  if (m.kind === "powerup" && f.powerup) return powerupTip(f.powerup, t);
  if (m.kind === "urn" && f.urn) return urnTip(f.urn, m.key, t);
  return undefined;
}

/** `hidden`: a marker hidden from the map (an objective turned off), which has nothing to say.
 * `shown`: the healing pickups and heavy boxes this browser draws (their toggles); off, they
 * can't be hovered. */
export function MarkerTips(p: { art: Art; vp: "amber" | "sapphire" | "neutral"; hidden: (key: string) => boolean; shown?: () => OptionalFurniture; frame: TokenFrame; t: () => number; k: number }) {
  let g!: SVGGElement;
  const markers = () => {
    const on = p.shown?.() ?? {};
    return p.art.model.markers.filter((m) => optionalShown(m.kind, on));
  };
  const shownNow = () => shownUrn(p.frame.ms(), p.frame.shown().vision);
  const urn = () => {
    const u = shownNow();
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
        const text = markerTip(m, tipFacts(p.frame.ms(), m.key, p.frame.shown().health, shownNow()), p.t()) ?? "";
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
