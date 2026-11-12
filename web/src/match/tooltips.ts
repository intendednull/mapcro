// Item and ability tooltips as the game shows them (docs/plans/2026-11-10-game-tooltips.md; spec
// §12 "Tooltips"): the pack's `data/tooltips.json` (crates/extract/src/tooltips.rs) holds each
// record's sections, property cards and rows, its values, the localised chrome and the icons. The
// replay's own patch reads its values through an overlay keyed like the stat tables
// (`tableKeyFor`); a build with none reads the pack's own. Everything but the loader is pure.

import type { StatIndex } from "../map/pack";
import { tableKeyFor } from "./stats";

/** `tooltips::TOOLTIP_FORMAT`: a table in another format isn't read. */
export const TOOLTIP_FORMAT = 1;

export interface TipProp {
  key: string;
  label: string;
  prefix?: string;
  postfix?: string;
  css?: string;
  scale?: [string, number];
  conditional?: boolean;
  negative?: boolean;
}

export interface TipBlock {
  text?: string;
  important?: TipProp[];
  basic?: TipProp[];
  requires?: string;
}

export interface TipSection {
  kind: "innate" | "passive" | "active" | "info";
  cooldown?: TipProp;
  blocks: TipBlock[];
}

export interface Tip {
  header?: TipProp[];
  sections: TipSection[];
  upgrades?: Array<{ text?: string; props: string[]; kinds?: Record<string, string> }>;
  /** `{s:Name}` names that are another property's token override → that property. */
  aliases?: Record<string, string>;
  /** The words before the stacks held on it (`m_sCustomStackLabel`): "Current Bonus:",
   * "Leeches Collected:", an item's "Current Stacks:". */
  stack_label?: string;
}

export interface TipValues {
  props: Record<string, string>;
  upgrades?: Array<Record<string, string>> | undefined;
}

export interface TipIcon { img?: string | undefined; wash?: string | undefined; color?: string | undefined }

export interface TooltipData {
  format: number;
  client_version: number;
  strings: Record<string, string>;
  icons: Record<string, TipIcon>;
  inline: Record<string, TipIcon>;
  art: Record<string, string>;
  records: Record<string, { tip: Tip; values: TipValues | null }>;
}

/** The pack's tooltips with URLs: none for a pack without them (no tooltips are shown). */
export interface TooltipIndex {
  url: string;
  /** Stat table key → overlay URL. */
  overlays: Map<string, string>;
  /** A blob key (icons, art) → its URL in this pack. */
  blob: (key: string | undefined) => string | undefined;
}

/** A loaded table for one patch: the install's tooltips with that patch's values merged in. */
export interface Tooltips {
  data: TooltipData;
  /** The build whose values these are (the overlay's, else the pack's own). */
  clientVersion: number;
  blob: TooltipIndex["blob"];
  tip(id: number): { tip: Tip; values: TipValues } | undefined;
  str(key: string, fallback: string): string;
}

const cache = new Map<string, Promise<unknown>>();
function fetchJson<T>(url: string): Promise<T | undefined> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then(r => (r.ok ? r.json() : undefined)).catch(() => undefined);
    cache.set(url, p);
  }
  return p as Promise<T | undefined>;
}

/** The tooltips for a replay build: the overlay of the stat table that build reads, if any. */
export async function loadTooltips(index: TooltipIndex | undefined, stats: StatIndex | undefined, build: number | undefined): Promise<Tooltips | undefined> {
  if (!index) return undefined;
  const data = await fetchJson<TooltipData>(index.url);
  if (!data || data.format !== TOOLTIP_FORMAT) return undefined;
  const key = tableKeyFor(stats, build);
  const url = key ? index.overlays.get(key) : undefined;
  const overlay = url ? await fetchJson<{ format: number; client_version: number; records: Record<string, TipValues> }>(url) : undefined;
  return withOverlay(data, overlay?.format === TOOLTIP_FORMAT ? overlay : undefined, index.blob);
}

/** Merge a patch's overlay into the install's values (pure). */
export function withOverlay(data: TooltipData, overlay: { client_version: number; records: Record<string, TipValues> } | undefined, blob: TooltipIndex["blob"] = () => undefined): Tooltips {
  const merged = new Map<number, { tip: Tip; values: TipValues }>();
  return {
    data,
    clientVersion: overlay?.client_version ?? data.client_version,
    blob,
    tip(id) {
      const hit = merged.get(id);
      if (hit) return hit;
      const r = data.records[String(id)];
      if (!r) return undefined;
      const o = overlay?.records[String(id)];
      const base = r.values ?? { props: {} };
      const values: TipValues = {
        props: { ...base.props, ...o?.props },
        upgrades: (base.upgrades ?? []).map((u, i) => ({ ...u, ...o?.upgrades?.[i] })),
      };
      const out = { tip: r.tip, values };
      merged.set(id, out);
      return out;
    },
    str: (key, fallback) => data.strings[key] ?? fallback,
  };
}

/**
 * The ability points each upgrade tier costs, as the game's tier cards show them ("1 / 2 / 5" in
 * the operator's reference `item-djinns-mark.png`). Hard-coded: no file the extractor reads holds
 * it (`m_nAbilityPointsCost` is 0 on every ability). docs/backlog.md "To verify in the running game"
 * tracks it across patches.
 */
export const TIER_COSTS = [1, 2, 5] as const;

/** A property value as a number, if it is one. */
export function num(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** At most two decimals, no trailing zeros (the extractor's `number`). */
export function fmt(n: number): string {
  const s = (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * The values with the first `tiers` upgrade tiers applied, as the game's tooltip shows an owned
 * ability (`m_eUpgradeType`: added to the base unless it says otherwise), and each property's
 * scale factor after `EAddToScale` / `EMultiplyScale` bonuses.
 */
export function upgraded(tip: Tip, values: TipValues, tiers: number | null | undefined): { values: TipValues; scale: Record<string, number> } {
  const props = { ...values.props };
  const scale: Record<string, number> = {};
  const base = (key: string) => {
    for (const s of tip.sections) for (const b of s.blocks) for (const p of [...(b.important ?? []), ...(b.basic ?? [])]) if (p.key === key && p.scale) return p.scale[1];
    return 0;
  };
  for (let i = 0; i < Math.min(tiers ?? 0, tip.upgrades?.length ?? 0); i++) {
    const u = tip.upgrades![i]!;
    for (const [key, raw] of Object.entries(values.upgrades?.[i] ?? {})) {
      const bonus = num(raw);
      if (bonus == null) continue;
      const kind = u.kinds?.[key] ?? "EAddToBase";
      if (kind === "EAddToScale") scale[key] = (scale[key] ?? base(key)) + bonus;
      else if (kind === "EMultiplyScale") scale[key] = (scale[key] ?? base(key)) * bonus;
      else {
        const now = num(props[key]) ?? 0;
        props[key] = fmt(kind === "EMultiplyBase" ? now * bonus : now + bonus);
      }
    }
  }
  return { values: { props, upgrades: values.upgrades }, scale };
}

export interface Shown {
  prefix: string;
  value: string;
  postfix: string;
  /** Scaled by a calculated stat (spirit power): shown with "≈" (spec §4b). */
  calc: boolean;
}

/**
 * A property as the tooltip writes it, or null when the game hides it (zero or no value).
 * `spirit`: the hero's calculated spirit power, for a property that scales with it.
 */
export function shown(p: TipProp, values: TipValues, spirit?: number | null, scale?: number): Shown | null {
  const raw = values.props[p.key];
  const n = num(raw);
  if (raw == null || n === 0) return null;
  let value = raw;
  let calc = false;
  const factor = scale ?? p.scale?.[1];
  if (n != null && factor && (p.scale?.[0] ?? "ETechPower") === "ETechPower" && spirit != null) {
    value = String(Math.round(n + factor * spirit));
    calc = true;
  }
  const sign = (p.prefix ?? "").includes("{s:sign}") ? (n != null && n > 0 ? "+" : "") : "";
  return { prefix: (p.prefix ?? "").replace("{s:sign}", sign), value, postfix: p.postfix ?? "", calc };
}

/** `{s:Prop}` replaced from `values` (an alias reads its property; unknown ones read ""), as
 * the game substitutes them. */
export function substitute(text: string, values: Record<string, string>, aliases: Record<string, string> = {}): string {
  return text.replace(/\{s:([A-Za-z0-9_]+)\}/g, (_, k: string) => values[k] ?? (aliases[k] ? values[aliases[k]!] : undefined) ?? "");
}

export type MarkupNode =
  | { t: "text"; s: string }
  | { t: "br" }
  | { t: "span"; cls: string[]; kids: MarkupNode[] }
  | { t: "b" | "i"; kids: MarkupNode[] }
  | { t: "icon"; cls: string[] }
  | { t: "attr"; name: string }
  | { t: "key"; name: string };

/**
 * The game's tooltip markup as a tree: `<span class>`, `<b>`, `<i>`, `<br>`, `<Panel class>` (an
 * icon), `{g:citadel_inline_attribute:'X'}` and `{g:citadel_binding:'X'}`. Anything else is text,
 * so nothing is ever read as HTML. An unclosed tag closes at the end.
 */
export function parseMarkup(src: string): MarkupNode[] {
  const root: MarkupNode[] = [];
  const stack: Array<{ tag: string; kids: MarkupNode[] }> = [{ tag: "", kids: root }];
  const top = () => stack[stack.length - 1]!.kids;
  const text = (s: string) => {
    if (!s) return;
    const last = top().at(-1);
    if (last?.t === "text") last.s += s;
    else top().push({ t: "text", s });
  };
  const re = /<\s*(\/?)\s*([A-Za-z]+)([^>]*?)(\/?)\s*>|\{g:citadel_(inline_attribute|binding):'([^']*)'\}/g;
  let at = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    text(src.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[5]) {
      top().push(m[5] === "binding" ? { t: "key", name: m[6]! } : { t: "attr", name: m[6]! });
      continue;
    }
    const [, close, rawTag, attrs, self] = m;
    const tag = rawTag!.toLowerCase();
    const cls = (/class\s*=\s*["']([^"']*)["']/.exec(attrs ?? "")?.[1] ?? "").split(/\s+/).filter(Boolean);
    if (tag === "br") { top().push({ t: "br" }); continue; }
    if (close) {
      const i = stack.map(s => s.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    if (tag === "panel") {
      top().push({ t: "icon", cls });
      if (!self) stack.push({ tag, kids: [] });
      continue;
    }
    if (tag === "span" || tag === "b" || tag === "i") {
      if (self) continue;
      const node: MarkupNode = tag === "span" ? { t: "span", cls, kids: [] } : { t: tag, kids: [] };
      top().push(node);
      stack.push({ tag, kids: node.kids });
      continue;
    }
    text(m[0]);
  }
  text(src.slice(at));
  return root;
}

/** An item's "Upgrades to": the items that list it as a component (the reverse of `components`). */
export function upgradesTo(id: number, records: Iterable<{ id: number; components?: number[]; disabled?: boolean }>): number[] {
  const out: number[] = [];
  for (const r of records) if (!r.disabled && r.components?.includes(id)) out.push(r.id);
  return out;
}

/** Whether a block that needs an upgrade (`requires`) shows: the hero has a tier whose upgrade
 * changes that property. Without the hero's tiers it doesn't. */
export function blockShown(b: TipBlock, tip: Tip, tier: number | null | undefined): boolean {
  if (!b.requires) return true;
  if (tier == null) return false;
  return (tip.upgrades ?? []).some((u, i) => i < tier && u.props.includes(b.requires!));
}
