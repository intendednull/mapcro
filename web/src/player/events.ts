// Match events for Player's list (spec §6b): labels, search, filters, where each happened, when
// what it marks began, and the jump time. Pure.

import type { BuildCatalog } from "../map/pack";
import { buffInfo, buffLabel } from "../match/buffs";
import { type Marker, teamName } from "../map/model";
import { type Pt, worldToMap } from "../map/transform";
import { type MatchEvent, type Timeline, type TimelineRift, clockLabel, markerKey, tierOf } from "../match/timeline";

export type EventGroup = "purchase" | "death" | "ult" | "objective" | "mid_boss" | "rift" | "powerup" | "urn" | "souls";

export const GROUPS: Array<{ id: EventGroup; label: string }> = [
  { id: "death", label: "Deaths" },
  { id: "ult", label: "Ults" },
  { id: "objective", label: "Objectives" },
  { id: "mid_boss", label: "Mid-Boss" },
  { id: "rift", label: "Rifts" },
  { id: "powerup", label: "Powerups" },
  { id: "urn", label: "Urn" },
  { id: "souls", label: "Souls" },
  { id: "purchase", label: "Major buys (T4+)" },
];

export function groupOf(e: Pick<MatchEvent, "kind">): EventGroup {
  if (e.kind === "item_buy") return "purchase";
  if (e.kind === "rift_up" || e.kind === "rift_capture") return "rift";
  if (e.kind === "powerup_spawn" || e.kind === "powerup_taken") return "powerup";
  if (e.kind === "souls_swing") return "souls";
  if (e.kind === "urn_pickup" || e.kind === "urn_drop" || e.kind === "urn_delivered") return "urn";
  // The Rejuvenator is the mid boss's reward.
  if (e.kind === "rejuv_taken" || e.kind === "rejuv_revive" || e.kind === "rejuv_expired") return "mid_boss";
  return e.kind as EventGroup;
}

const LANE: Record<string, string> = { lane1: "west", lane4: "mid", lane6: "east" };
const OBJECTIVE: Record<string, string> = { guardian: "guardian", walker: "walker", base_guardian: "base guardian", shrine: "shrine", patron: "patron" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const team = (t: string | null | undefined) => (t === "amber" || t === "sapphire" ? teamName(t) : "");
const laneOf = (key: string | null | undefined) => LANE[key?.split(":")[2] ?? ""] ?? "";
/** "citadel_ability_haze_bullet_dance" → "bullet dance" for the hero Haze: the game's internal
 * name, made readable (display names need the game's item data). */
export function abilityName(raw: string | null | undefined, hero = ""): string {
  let s = (raw ?? "").toLowerCase().replace(/^(citadel_)?ability_/, "");
  const h = hero.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (h && s.startsWith(`${h}_`)) s = s.slice(h.length + 1);
  return s.replace(/_/g, " ").trim();
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export interface Named {
  hero: (id: number | null | undefined) => string;
  /** The player's in-game name, if the timeline has one. */
  player: (team: string | null | undefined, slot: number | null | undefined) => string | undefined;
}

/** `player` overrides the timeline's own names (Player's host, which hides them while Names is
 * off: then no label, and no search, finds a player by name). */
export function namesFor(tl: Timeline, heroName: (id: number) => string, player?: Named["player"]): Named {
  return {
    hero: (id) => (id == null ? "" : heroName(id)),
    player: player ?? ((t, s) => tl.players.find((p) => p.team === t && p.slot === s)?.name ?? undefined),
  };
}

/** The list's label: "Haze killed by Vindicta", "Amber walker down (west)". */
export function label(e: MatchEvent, n: Named): string {
  switch (e.kind) {
    case "item_buy": return `${n.hero(e.hero_id) || "Hero"} bought ${e.ability || "an item"}`;
    case "death": {
      const who = n.hero(e.hero_id) || "A hero";
      return e.by ? `${who} killed by ${n.hero(e.by.hero_id) || "a hero"}` : `${who} died`;
    }
    case "objective": {
      const kind = OBJECTIVE[e.key?.split(":")[0] ?? ""] ?? "objective";
      const lane = laneOf(e.key);
      return `${team(e.team)} ${kind} down${lane && kind !== "patron" ? ` (${lane})` : ""}`.trim();
    }
    case "mid_boss":
      return e.team && e.team !== "neutral" && e.team !== "unknown" ? `Mid-Boss killed by ${team(e.team)}` : "Mid-Boss killed";
    case "rift_up":
      return `Rift up (${laneOf(e.key) || "?"})`;
    case "rift_capture":
      return `Rift captured by ${team(e.team) || "?"}`;
    case "powerup_spawn": {
      const b = buffLabel(e.buff);
      return `Powerup up (${laneOf(e.key) || "?"})${b ? `: ${b}` : ""}`;
    }
    case "powerup_taken": {
      const b = buffInfo(e.buff)?.name ?? e.buff;
      return `Powerup taken (${laneOf(e.key) || "?"})${b ? `: ${b} buff` : ""}`;
    }
    case "souls_swing":
      return `Souls swing ${team(e.team)} +${k(e.amount ?? 0)}`;
    case "ult": {
      const who = n.hero(e.hero_id) || "A hero";
      const what = abilityName(e.ability, n.hero(e.hero_id));
      return what ? `${who} ult (${what})` : `${who} ult`;
    }
    case "urn_pickup":
    case "urn_drop":
    case "urn_delivered": {
      const verb = e.kind === "urn_pickup" ? "picked up" : e.kind === "urn_drop" ? "dropped" : "delivered";
      const who = n.hero(e.hero_id) || team(e.team);
      return who ? `Urn ${verb} by ${who}` : `Urn ${verb}`;
    }
    case "rejuv_taken":
      return `Rejuvenator taken by ${team(e.team) || "?"}`;
    case "rejuv_revive": {
      const who = n.hero(e.hero_id) || team(e.team) || "A hero";
      return `${who} revived by the Rejuvenator`;
    }
    case "rejuv_expired":
      return `${team(e.team)} Rejuvenator expired`.trim();
    default:
      return cap(String(e.kind).replace(/_/g, " "));
  }
}

/** The list's label in parts: names, where the timeline has them, beside their heroes (muted). */
export function labelParts(e: MatchEvent, n: Named): Array<{ text: string; muted?: boolean }> {
  if (e.kind !== "death" && e.kind !== "ult" && e.kind !== "rejuv_revive" && !e.kind.startsWith("urn_")) return [{ text: label(e, n) }];
  const who = n.player(e.team, e.slot);
  if (e.kind !== "death") return [{ text: label(e, n) }, ...(who ? [{ text: ` ${who}`, muted: true }] : [])];
  const by = e.by ? n.player(e.by.team, e.by.slot) : undefined;
  const parts: Array<{ text: string; muted?: boolean }> = [{ text: n.hero(e.hero_id) || "A hero" }];
  if (who) parts.push({ text: ` ${who}`, muted: true });
  if (e.by) {
    parts.push({ text: ` killed by ${n.hero(e.by.hero_id) || "a hero"}` });
    if (by) parts.push({ text: ` ${by}`, muted: true });
  } else parts.push({ text: " died" });
  return parts;
}

/** A short label for a scene name ("<event> @ mm:ss"). */
export function shortLabel(e: MatchEvent, n: Named): string {
  switch (e.kind) {
    case "death":
      return `${n.hero(e.hero_id) || "Hero"} died`;
    case "objective":
      return `${cap(OBJECTIVE[e.key?.split(":")[0] ?? ""] ?? "objective")} down`;
    case "mid_boss":
      return "Mid-Boss";
    case "rift_up":
      return "Rift up";
    case "rift_capture":
      return "Rift taken";
    case "powerup_spawn":
      return `${buffInfo(e.buff)?.name ?? "Powerup"}${e.buff ? " buff" : ""} up`;
    case "powerup_taken":
      return `${buffInfo(e.buff)?.name ?? "Powerup"}${e.buff ? " buff" : ""} taken`;
    case "ult":
      return `${n.hero(e.hero_id) || "Hero"} ult`;
    case "urn_pickup":
      return "Urn picked up";
    case "urn_drop":
      return "Urn dropped";
    case "urn_delivered":
      return "Urn delivered";
    case "rejuv_taken":
      return "Rejuvenator taken";
    case "rejuv_revive":
      return `${n.hero(e.hero_id) || "Hero"} revived`;
    case "rejuv_expired":
      return "Rejuvenator expired";
    default:
      return "Souls swing";
  }
}

/** Everything a search may match: label, heroes, player names, type, team and the clock. */
export function haystack(e: MatchEvent, n: Named): string {
  const parts = [
    label(e, n),
    n.hero(e.hero_id),
    n.player(e.team, e.slot) ?? "",
    e.by ? n.hero(e.by.hero_id) : "",
    e.by ? (n.player(e.by.team, e.by.slot) ?? "") : "",
    GROUPS.find((g) => g.id === groupOf(e))?.label ?? "",
    e.kind.replace(/_/g, " "),
    team(e.team),
    e.by ? team(e.by.team) : "",
    // The old names (the wire's keys) still find a team: "amber", "sapphire".
    e.team ?? "",
    e.ability ? abilityName(e.ability) : "",
    clockLabel(e.t),
  ];
  return parts.join(" ").toLowerCase();
}

/** Events matching every word of `query`, in the groups `on` (all when empty). */
export function search(events: MatchEvent[], n: Named, query: string, on: Set<EventGroup>): MatchEvent[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return events.filter((e) => (on.size === 0 || on.has(groupOf(e))) && words.every((w) => haystack(e, n).includes(w)));
}

/** A key that names an event across timeline tiers and reloads: when, what, and about whom. */
export const eventKey = (e: MatchEvent) => `${e.t}:${e.kind}:${e.team ?? ""}:${e.slot ?? ""}:${e.key ?? ""}:${e.hero_id ?? ""}`;

/** The parser's souls-swing window (`crates/replay/src/timeline.rs`): an event fires when the
 * lead moved by its `SWING_SOULS` within this many seconds. Only the window is needed here. */
const SWING_WINDOW_S = 60;

/** Seconds each side of a second averaged to smooth the lead: players' souls samples land on
 * different seconds, so the raw lead jumps by thousands between neighbours. */
const SWING_SMOOTH_S = 2;

/** How long an objective's health must stand still for the next change to be a new push. */
const OBJECTIVE_QUIET_S = 20;

/** The team-souls lead at t: Amber's net worth minus Sapphire's, each player's last sample at or
 * before t (0 before the first), as `souls_swings` reads it. */
export function soulsLead(tl: Pick<Timeline, "players">, t: number): number {
  let lead = 0;
  for (const p of tl.players) lead += (p.team === "amber" ? 1 : -1) * worthAt(p.souls, t);
  return lead;
}

/** A player's net worth at t: the last sample at or before it (0 before the first). */
function worthAt(souls: ReadonlyArray<readonly [number, number]>, t: number): number {
  let lo = 0;
  let hi = souls.length - 1;
  let v = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [s, n] = souls[mid]!;
    if (s <= t) {
      v = n;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return v;
}

/**
 * When a souls swing began: the turning point of the lead in the parser's window (the last
 * minimum on the way up, the last maximum on the way down), on a 5 s mean so one player's late
 * sample isn't the turn. The window's first second when the lead was still moving then: the true
 * turn is earlier, and this is the earliest the timeline can say (docs/research/event-starts.md).
 */
export function swingStart(tl: Pick<Timeline, "players">, t: number): number | undefined {
  const from = Math.max(0, t - SWING_WINDOW_S);
  const vals: number[] = [];
  for (let s = from; s <= t; s++) vals.push(soulsLead(tl, s));
  if (vals.length < 2) return undefined;
  const total = vals[vals.length - 1]! - vals[0]!;
  if (total === 0) return undefined;
  const up = total > 0;
  const smooth = (i: number) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - SWING_SMOOTH_S); j <= Math.min(vals.length - 1, i + SWING_SMOOTH_S); j++) {
      sum += vals[j]!;
      n++;
    }
    return sum / n;
  };
  let best = 0;
  let bestV = smooth(0);
  for (let i = 1; i < vals.length; i++) {
    const v = smooth(i);
    if (up ? v < bestV : v > bestV) {
      best = i;
      bestV = v;
    }
  }
  return from + best;
}

/**
 * When the push that took an objective down began: the first health row after the last gap of
 * [`OBJECTIVE_QUIET_S`] seconds before the destruction. The objective's first drop from 100 is
 * not it: chip damage runs for most of the match, and its health goes back up (regeneration).
 * The last push wins when there were several.
 */
export function objectiveStart(at: ReadonlyArray<readonly [number, number]>, t: number): number | undefined {
  let prev: number | undefined;
  let start: number | undefined;
  for (const [s] of at) {
    if (s > t) break;
    if (prev !== undefined && s - prev >= OBJECTIVE_QUIET_S) start = s;
    prev = s;
  }
  return start;
}

/**
 * When the Mid-Boss fight that killed it began: its first health drop after the last time it was
 * at 100 before the kill. It regenerates to full between attempts, so the last full health is the
 * one this fight started from.
 */
export function midBossStart(at: ReadonlyArray<readonly [number, number]>, t: number): number | undefined {
  let lastFull: number | undefined;
  for (const [s, v] of at) {
    if (s > t) break;
    if (v >= 100) lastFull = s;
  }
  if (lastFull === undefined) return undefined;
  for (const [s, v] of at) {
    if (s >= lastFull && s <= t && v < 100) return s;
  }
  return undefined;
}

/** When a rift's capture began: the first capture row where the capturing team's progress is
 * above 0 (its cash-in's start), else when the cash-in opened. */
export function riftCaptureStart(r: TimelineRift, team: string | null | undefined): number | undefined {
  if (team !== "amber" && team !== "sapphire") return undefined;
  const col = team === "amber" ? 1 : 2;
  for (const c of r.capture ?? []) if ((c[col] ?? 0) > 0) return c[0] / 10;
  return r.live_s ?? undefined;
}

/**
 * When what an event marks began, from data the timeline already holds; `e.t` when it has none
 * (docs/research/event-starts.md). A death keeps its second: its recap sums the 10 s before with
 * no per-hit times. The other kinds are instants (a cast, a spawn, a pickup) or already start at
 * their start (a rift coming up, a Rejuvenator taken).
 */
export function eventStart(tl: Timeline, e: MatchEvent): number {
  switch (e.kind) {
    case "souls_swing":
      return swingStart(tl, e.t) ?? e.t;
    case "objective": {
      // A patron's "down" at the match's end is the game ending, and its health restarts between
      // stages: there is no push to start at.
      if (e.key?.startsWith("patron:")) return e.t;
      const track = tl.objective_health?.find((o) => o.key === e.key);
      return (track && objectiveStart(track.at, e.t)) ?? e.t;
    }
    case "mid_boss": {
      const track = tl.objective_health?.find((o) => o.key.startsWith("mid_boss:"));
      return (track && midBossStart(track.at, e.t)) ?? e.t;
    }
    case "rift_capture": {
      const rift = tl.rifts?.find((r) => r.key === e.key && e.t >= r.start_s && e.t <= r.end_s);
      return (rift && riftCaptureStart(rift, e.team)) ?? e.t;
    }
    default:
      return e.t;
  }
}

/** Where to scrub to for a second: `lead` seconds before it, never before the start. */
export const jumpAt = (t: number, lead: number) => Math.max(0, t - Math.max(0, lead));

/** Where a click on the event scrubs to: its start less the lead, not the event's own second. */
export const jumpTarget = (tl: Timeline, e: MatchEvent, lead: number) => jumpAt(eventStart(tl, e), lead);

/** Where it happened, in map units: its own place, else its objective's marker. */
export function placeOf(e: MatchEvent, markers: Array<Pick<Marker, "key" | "at" | "kind" | "team">>): Pt | undefined {
  if (e.x != null && e.y != null) return worldToMap({ x: e.x, y: e.y });
  if (!e.key) return undefined;
  // The board's marker for the key, though a pack may spell it differently (`markerKey`).
  const k = markerKey(e.key, markers);
  const m = (k ? markers.find((x) => x.key === k) : undefined) ?? markers.find((x) => e.key && x.key.startsWith(`${e.key}:`));
  return m?.at;
}

export const tierLabel = (tl: Timeline) => (tierOf(tl) === "replay" ? "Replay" : "Metadata");

/** Opt-in event rows; never infer a purchase from a currently equipped item. Tier is from the selected pack. */
export function majorPurchases(timeline: Timeline, catalog: BuildCatalog | undefined): MatchEvent[] {
  if (!catalog) return [];
  return timeline.players.flatMap(p => (p.items ?? []).flatMap(([ds, id, kind]) => {
    const item = catalog.records.get(id);
    return kind === 0 && item?.kind === "item" && (item.tier ?? 0) >= 4
      ? [{ t: ds / 10, kind: "item_buy" as const, team: p.team, slot: p.slot, hero_id: p.hero_id, key: String(id), ability: item.label }]
      : [];
  })).sort((a, b) => a.t - b.t);
}
