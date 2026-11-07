// Synthetic asset packs for tests: generated 1×1 PNGs and made-up heroes, never game art.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A PACKS_DIR holding one schema-3 pack with `heroes` playable heroes and two unplayable ones. */
export function heroPack(heroes: number): string {
  const root = mkdtempSync(join(tmpdir(), "mapcro-packs-"));
  const dir = join(root, "heroes");
  const blobs: Record<string, unknown> = {};
  const blob = (key: string) => {
    const file = `${key}.png`;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    // Same pixels for every file; the manifest key is what tells them apart.
    writeFileSync(join(dir, file), PNG);
    blobs[key] = { sha256: createHash("sha256").update(PNG).digest("hex"), w: 1, h: 1, mime: "image/png", file };
    return key;
  };
  const list = Array.from({ length: heroes }, (_, i) => ({
    hero_id: i + 1,
    class_name: `hero_test${i + 1}`,
    name: `Testhero ${String.fromCharCode(65 + i)}`,
    disabled: false,
    minimap_blob: blob(`heroes/${i + 1}`),
    topbar_blob: blob(`topbar/heroes/${i + 1}`),
  }));
  list.push(
    { hero_id: 90, class_name: "hero_wip", name: "Unplayable One", disabled: false, minimap_blob: blob("heroes/90"), topbar_blob: null as never },
    { hero_id: 91, class_name: "hero_wip2", name: "Unplayable Two", disabled: false, minimap_blob: blob("heroes/91"), topbar_blob: null as never },
  );
  const manifest = { schema: 3, game: { client_version: 9100, source_revision: 1, date: "Nov 07 2026" }, blobs, heroes: list, entities: [] };
  writeFileSync(join(dir, "pack.json"), JSON.stringify(manifest));
  return root;
}
