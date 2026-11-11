// The server's asset pack (spec §12): the only source of game art. With no pack, the board
// draws the schematic fallback, so everything here is optional.

import { FALLBACK } from "./fallback-data";
import { type MapModel, type PackEntity, modelFromEntities, modelFromFallback, withBuiltInFurniture } from "./model";

export interface PackBlob {
  sha256: string;
  mime: string;
  file: string;
  w?: number;
  h?: number;
}

export interface PackHero {
  hero_id: number;
  class_name?: string;
  name: string | null;
  disabled?: boolean;
  minimap_blob: string | null;
  /** Schema 3: the 120×200 top-bar portrait. */
  topbar_blob?: string | null;
  /** The 280×380 hero card (`m_strIconHeroCard`) the top bar's hero badge shows, when the pack has it. */
  card_blob?: string | null;
  /** The 280×380 low-health hero card (`m_strIconHeroCardCritical`), when the pack has it. */
  critical_blob?: string | null;
  /** The game HUD’s ordered signature abilities. */
  abilities?: number[] | undefined;
}

export interface PackManifest {
  schema?: number;
  game: { client_version: string | number; source_revision?: string | number; date?: string };
  blobs: Record<string, PackBlob>;
  heroes?: PackHero[];
  entities?: PackEntity[];
  abilities?: { blob: string };
  /** Per-patch stat tables (crates/extract/src/stats.rs); optional, no schema bump. */
  stats?: PackStats;
}

export interface PackStats {
  format: number;
  /** The newest build the sources have seen. */
  covered_through: number;
  /** Build → table key. */
  builds: Record<string, string>;
  tables: Record<string, { blob: string; client_version: number; source: string }>;
}

/** A pack's stat tables, with URLs: see match/stats.ts. */
export interface StatIndex {
  format: number;
  coveredThrough: number;
  /** Listed builds, ascending, with their table key. */
  builds: Array<[number, string]>;
  tables: Map<string, { url: string; clientVersion: number; source: string }>;
  /** The table of the pack's own build (its install), for the investment ladder's fallback. */
  installKey: string | undefined;
}

export interface BuildRecord {
  id: number;
  kind: "item" | "ability" | "modifier";
  name: string;
  label: string;
  icon?: string | undefined;
  ability_type?: string;
  /** Parent ability token for modifier icon fallback. */
  ability?: number;
  /** How the label was found; `internal` means no localised name exists. */
  label_from?: "localisation" | "ability" | "internal";
  cost?: number;
  slot?: "weapon" | "vitality" | "spirit";
  tier?: number;
  components?: number[];
  disabled?: boolean;
}

export interface BuildCatalog {
  records: Map<number, BuildRecord>;
}

/** Resolve catalog icons exclusively against the selected pack. */
export function buildCatalogFromData(base: string, packId: string, m: PackManifest, data: { records: Record<string, Omit<BuildRecord, "id">> }): BuildCatalog {
  const records = new Map<number, BuildRecord>();
  for (const [token, record] of Object.entries(data.records)) {
    const id = Number(token);
    if (!Number.isSafeInteger(id) || id < 0) continue;
    const blob = record.icon ? m.blobs[record.icon] : undefined;
    records.set(id, { ...record, id, icon: blob ? `${base}/packs/${packId}/${blob.file}` : undefined });
  }
  return { records };
}

export interface Hero {
  id: number;
  name: string;
  /** Minimap portrait URL, when the pack has one. */
  portrait: string | undefined;
  /** Top-bar portrait (vertical bust), when the pack has one. */
  topbar: string | undefined;
  /** The hero card the top bar's badge draws (`<hero>_card`), when the pack has one. Without it
   *  the bar keeps the vertical bust (`topbar`). */
  card?: string | undefined;
  /** The low-health hero card the HUD swaps in (`<hero>_card_critical`), when the pack has one. */
  critical?: string | undefined;
  /** In the game's pick list: schema-3 packs give playable heroes a top-bar portrait. */
  playable: boolean;
  abilities?: number[] | undefined;
}

export interface Art {
  buildCatalog?: BuildCatalog;
  stats?: StatIndex | undefined;
  packId: string | undefined;
  version: string | undefined;
  /** The game build's date, as the pack records it ("Nov 05 2026"). */
  date: string | undefined;
  model: MapModel;
  heroes: Map<number, Hero>;
  /** Image name (as minimap markers use it) → URL. Empty without a pack. */
  images: Map<string, string>;
}

/** Marker image names → pack blob keys (design/parity/README.md, "Markers"). */
export const IMAGE_BLOBS: Record<string, string> = {
  "terrain-mid": "map/minimap_midtown_mid",
  frame: "icons/compass_frame_psd",
  "frame-mask": "icons/compass_frame_mask_psd",
  "boss-health": "icons/boss_health_psd",
  "boss-health-fill": "icons/boss_health_fill_psd",
  "boss-health-t2": "icons/boss_health_t2_psd",
  "boss-health-fill-t2": "icons/boss_health_fill_t2_psd",
  "boss-health-final": "icons/boss_health_final_psd",
  "boss-health-final-fill": "icons/boss_health_final_fill_psd",
  "boss-health-final-stage2": "icons/boss_health_final_stage2_psd",
  "boss-health-final-stage2-fill": "icons/boss_health_final_stage2_fill_psd",
  "super-neutral-marker": "icons/super_neutral_marker_psd",
  "neutral-small": "icons/neutral_small_psd",
  "neutral-medium": "icons/neutral_medium_psd",
  "neutral-large": "icons/neutral_large_psd",
  "neutral-vault": "icons/neutral_vault_psd",
  koth: "icons/minimap_icon_koth_png",
  // The star in the ring reads as a generic buff at HUD size; the spawners give random powerups.
  powerup: "icons/powerup_magic",
  // Each bridge buff's own icon, hud_minimap.vcss .map_button.powerup_<gun|survival|casting|movement>.
  "powerup-gun": "icons/powerup_weapon",
  "powerup-survival": "icons/powerup_health",
  "powerup-casting": "icons/powerup_magic",
  "powerup-movement": "icons/powerup_movement",
  // The Soul Urn (.idol_spawn, .held_idol_image) and its delivery point (.idol_return).
  // The Rejuvenator under its holder's souls (citadel_hud_top_bar.vcss #RejuvenatorCharges): one
  // image per revive count (.RejuvCount_N .rejuvIcon), and the timer's symbol (.statusEffectImage).
  "rejuv-1": "topbar/team_rejuv_1_png",
  "rejuv-2": "topbar/team_rejuv_2_png",
  "rejuv-3": "topbar/team_rejuv_3_png",
  "rejuv-4": "topbar/team_rejuv_4_png",
  "rejuv-timer": "topbar/rejuvenator",
  urn: "icons/soul_jar_marker_psd",
  "urn-return": "icons/soul_jar_marker_return_psd",
  // An open delivery point's glow (.idol_return pulse).
  "urn-return-pulse": "icons/soul_jar_marker_return_pulse_psd",
  // The map's furniture: .tier1_shop, .teleporter_nearby (and its pair's highlight,
  // .teleporter_active), and the health pad the minimap precaches for the healing pickups.
  shop: "icons/minimap_shop_psd",
  teleporter: "icons/minimap_teleporter_go_right",
  "teleporter-lit": "icons/minimap_teleporter_highlight",
  heal: "icons/health_pad_psd",
  "death-skull": "topbar/skull",
  "tb-mask": "topbar/hero_image_mask_psd",
  "tb-ult": "topbar/icon_ultimate",
  "tb-ult-off": "topbar/icon_ultimate_off",
  "tb-dust": "topbar/dust_01_psd",
  "tb-team1": "topbar/icon_team1_psd",
  "tb-team2": "topbar/icon_team2_psd",
  // #HealthBar_Contents / _Fill opacity-mask, and #HealthBar_Border.
  "tb-hb-mask": "topbar/healthbar_backer_vert_mask",
  "tb-hb-border": "topbar/healthbar_backer_vert_border",
};

export function fallbackArt(): Art {
  return { packId: undefined, version: undefined, date: undefined, model: modelFromFallback(FALLBACK), heroes: new Map(), images: new Map() };
}

/** Build the renderer's view of a pack. Pure: the manifest and its id in, art out. */
export function artFromManifest(base: string, packId: string, m: PackManifest): Art {
  const url = (key: string | null | undefined) => {
    const b = key ? m.blobs[key] : undefined;
    return b ? `${base}/packs/${packId}/${b.file}` : undefined;
  };
  const images = new Map<string, string>();
  for (const [name, key] of Object.entries(IMAGE_BLOBS)) {
    const u = url(key);
    if (u) images.set(name, u);
  }
  const heroes = new Map<number, Hero>();
  const schema3 = (m.heroes ?? []).some((h) => "topbar_blob" in h);
  for (const h of m.heroes ?? []) {
    if (h.disabled) continue;
    heroes.set(h.hero_id, { id: h.hero_id, name: h.name ?? h.class_name ?? `Hero ${h.hero_id}`, portrait: url(h.minimap_blob), topbar: url(h.topbar_blob), card: url(h.card_blob), critical: url(h.critical_blob), abilities: h.abilities, playable: schema3 ? !!h.topbar_blob : true });
  }
  const entities = m.entities ?? [];
  // A pack without map entities still has portraits; its map falls back to the schematic.
  const model = entities.length ? modelFromEntities(withBuiltInFurniture(entities)) : modelFromFallback(FALLBACK);
  return { packId, version: String(m.game.client_version), date: m.game.date ? String(m.game.date) : undefined, model, heroes, images, stats: statIndex(m, url) };
}

/** The manifest's `stats` section with blob URLs; undefined when the pack has none. */
export function statIndex(m: PackManifest, url: (key: string) => string | undefined): StatIndex | undefined {
  const s = m.stats;
  if (!s) return undefined;
  const tables = new Map<string, { url: string; clientVersion: number; source: string }>();
  for (const [key, t] of Object.entries(s.tables)) {
    const u = url(t.blob);
    if (u) tables.set(key, { url: u, clientVersion: t.client_version, source: t.source });
  }
  const builds = Object.entries(s.builds).map(([b, k]) => [Number(b), k] as [number, string]).filter(([b, k]) => Number.isSafeInteger(b) && tables.has(k)).sort((a, b) => a[0] - b[0]);
  const own = Number(m.game.client_version);
  const installKey = builds.find(([b]) => b === own)?.[1] ?? builds.at(-1)?.[1];
  return { format: s.format, coveredThrough: s.covered_through, builds, tables, installKey };
}

/** The newest pack the server has, or the fallback if it has none (or can't be reached). */
export async function loadArt(base = ""): Promise<Art> {
  try {
    const list = (await (await fetch(`${base}/api/packs`)).json()) as Array<{ pack_id: string }>;
    const id = list[0]?.pack_id;
    if (!id) return fallbackArt();
    const r = await fetch(`${base}/packs/${id}/pack.json`);
    if (!r.ok) return fallbackArt();
    const manifest = (await r.json()) as PackManifest;
    const art = artFromManifest(base, id, manifest);
    const blob = manifest.abilities && manifest.blobs[manifest.abilities.blob];
    if (blob) {
      // Catalog failure should not discard an otherwise usable map/portrait pack.
      try {
        const response = await fetch(`${base}/packs/${id}/${blob.file}`);
        if (response.ok) art.buildCatalog = buildCatalogFromData(base, id, manifest, await response.json());
      } catch { /* Old packs and unavailable catalogs still render the existing HUD. */ }
    }
    return art;
  } catch {
    return fallbackArt();
  }
}

/**
 * CSS that puts the pack's images on the minimap's `[data-img]` (washed: image plus its own
 * alpha as mask) and `[data-pimg]` (plain) layers. URLs live only here, never in user data.
 */
export function artCss(art: Art): string {
  const css: string[] = [];
  const img = (name: string) => {
    const u = art.images.get(name);
    return u ? `url(${JSON.stringify(u)})` : undefined;
  };
  const mask = (u: string) => `-webkit-mask-image: ${u}; mask-image: ${u};`;
  // The top bar's own images (pack schema 3), independent of the map's.
  if (img("tb-mask")) {
    css.push(".tb-host.pack-art { --tb-display: block; --tb-fb-display: none; }");
    css.push(`.tb-host.pack-art .tb-img { ${mask(img("tb-mask")!)} }`);
    const rules: Array<[string, string]> = [
      [".tb-ult.ready .tb-ult-icon", "tb-ult"],
      [".tb-ult.cooldown .tb-ult-icon", "tb-ult-off"],
      [".tb-score.amber .tb-team-icon", "tb-team1"],
      [".tb-score.sapphire .tb-team-icon", "tb-team2"],
    ];
    for (const [sel, name] of rules) if (img(name)) css.push(`.tb-host.pack-art ${sel} { background-image: ${img(name)}; }`);
    if (img("tb-dust")) css.push(`.tb-host.pack-art .tb-score-bg { ${mask(img("tb-dust")!)} }`);
    if (img("tb-hb-mask")) css.push(`.tb-host.pack-art .tb-health-back, .tb-host.pack-art .tb-health-fill { ${mask(img("tb-hb-mask")!)} }`);
    if (img("tb-hb-border")) css.push(`.tb-host.pack-art .tb-health-border { ${mask(img("tb-hb-border")!)} }`);
  }
  if (!art.images.has("terrain-mid")) return css.join("\n");
  css.push(".mm-host.pack-art { --pa-display: block; --pa-fb-display: none; }");
  for (const [name, u] of art.images) {
    const q = JSON.stringify(u);
    css.push(`.mm-host.pack-art [data-img="${name}"] { background-image: url(${q}); -webkit-mask-image: url(${q}); mask-image: url(${q}); }`);
    css.push(`.mm-host.pack-art [data-pimg="${name}"] { background-image: url(${q}); }`);
  }
  const frame = img("frame");
  const frameMask = img("frame-mask");
  if (frame) {
    css.push(`.mm-host.pack-art .mm-frame .frame-art { background-image: ${frame}; }`);
    if (frameMask) css.push(`.mm-host.pack-art .mm-frame .frame-art { ${mask(frameMask)} }`);
    if (frameMask) css.push(`.mm-host.pack-art.zoomed .mm-clip { ${mask(frameMask)} }`);
  }
  return css.join("\n");
}
