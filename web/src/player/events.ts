// Match events for Player's list (spec §6b): labels, search, filters, where each happened, and
// the jump time. Pure.

import type { Marker } from "../map/model";
import { type Pt, worldToMap } from "../map/transform";
import { type MatchEvent, type Timeline, clockLabel, tierOf } from "../match/timeline";

export type EventGroup = "death" | "ult" | "objective" | "mid_boss" | "rift" | "powerup" | "souls";

export const GROUPS: Array<{ id: EventGroup; label: string }> = [
  { id: "death", label: "Deaths" },
  { id: "ult", label: "Ults" },
  { id: "objective", label: "Objectives" },
  { id: "mid_boss", label: "Mid boss" },
  { id: "rift", label: "Rifts" },
  { id: "powerup", label: "Powerups" },
  { id: "souls", label: "Souls" },
];

export function groupOf(e: Pick<MatchEvent, "kind">): EventGroup {
  if (e.kind === "rift_up" || e.kind === "rift_capture") return "rift";
  if (e.kind === "powerup_spawn" || e.kind === "powerup_taken") return "powerup";
  if (e.kind === "souls_swing") return "souls";
  return e.kind as EventGroup;
}

const LANE: Record<string, string> = { lane1: "west", lane4: "mid", lane6: "east" };
const OBJECTIVE: Record<string, string> = { guardian: "guardian", walker: "walker", base_guardian: "base guardian", shrine: "shrine", patron: "patron" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const team = (t: string | null | undefined) => (t === "amber" ? "Amber" : t === "sapphire" ? "Sapphire" : "");
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

export function namesFor(tl: Timeline, heroName: (id: number) => string): Named {
  return {
    hero: (id) => (id == null ? "" : heroName(id)),
    player: (t, s) => tl.players.find((p) => p.team === t && p.slot === s)?.name ?? undefined,
  };
}

/** The list's label: "Haze killed by Vindicta", "Amber walker down (west)". */
export function label(e: MatchEvent, n: Named): string {
  switch (e.kind) {
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
      return e.team && e.team !== "neutral" && e.team !== "unknown" ? `Mid boss killed by ${team(e.team)}` : "Mid boss killed";
    case "rift_up":
      return `Rift up (${laneOf(e.key) || "?"})`;
    case "rift_capture":
      return `Rift captured by ${team(e.team) || "?"}`;
    case "powerup_spawn":
      return `Powerup up (${laneOf(e.key) || "?"})`;
    case "powerup_taken":
      return `Powerup taken (${laneOf(e.key) || "?"})`;
    case "souls_swing":
      return `Souls swing ${team(e.team)} +${k(e.amount ?? 0)}`;
    case "ult": {
      const who = n.hero(e.hero_id) || "A hero";
      const what = abilityName(e.ability, n.hero(e.hero_id));
      return what ? `${who} ult (${what})` : `${who} ult`;
    }
    default:
      return cap(String(e.kind).replace(/_/g, " "));
  }
}

/** A short label for a scene name ("<event> @ mm:ss"). */
export function shortLabel(e: MatchEvent, n: Named): string {
  switch (e.kind) {
    case "death":
      return `${n.hero(e.hero_id) || "Hero"} died`;
    case "objective":
      return `${cap(OBJECTIVE[e.key?.split(":")[0] ?? ""] ?? "objective")} down`;
    case "mid_boss":
      return "Mid boss";
    case "rift_up":
      return "Rift up";
    case "rift_capture":
      return "Rift taken";
    case "powerup_spawn":
      return "Powerup up";
    case "powerup_taken":
      return "Powerup taken";
    case "ult":
      return `${n.hero(e.hero_id) || "Hero"} ult`;
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

/** Where to scrub to: `lead` seconds before the event, never before the start. */
export const jumpTime = (e: Pick<MatchEvent, "t">, lead: number) => Math.max(0, e.t - Math.max(0, lead));

/** Where it happened, in map units: its own place, else its objective's marker. */
export function placeOf(e: MatchEvent, markers: Array<Pick<Marker, "key" | "at">>): Pt | undefined {
  if (e.x != null && e.y != null) return worldToMap({ x: e.x, y: e.y });
  if (!e.key) return undefined;
  const m = markers.find((x) => x.key === e.key) ?? markers.find((x) => e.key && x.key.startsWith(`${e.key}:`));
  return m?.at;
}

export const tierLabel = (tl: Timeline) => (tierOf(tl) === "replay" ? "Replay" : "Metadata");
