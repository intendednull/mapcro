// Spec §4b: hover text and aria-labels are tags (1–3 words naming the thing), not sentences. A
// sweep over every literal `title` and `aria-label` in web/src: a key hint in parentheses
// ("Play / Pause (Space)") doesn't count, and a value tag after a comma is allowed.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "../src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "gen" || f === "wasm" ? [] : files(p)) : p.endsWith(".tsx") ? [p] : [];
  });

/** Every literal and template `title=` / `aria-label=` in a file, as written. */
function labels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\btitle|aria-label)=(?:"([^"]*)"|\{`([^`]*)`\})/g)) out.push(m[1] ?? m[2]!);
  return out;
}

const words = (label: string) =>
  label
    .replace(/\([^)]*\)/g, " ") // key hints
    .replace(/\$\{[^}]*\}/g, "X") // a value: one word
    .split(",")[0]! // a value tag after a comma
    .split(/\s+/)
    .filter((w) => /\w/.test(w)).length;

describe("labels are tags (spec §4b)", () => {
  it("no literal title or aria-label in web/src runs past four words", () => {
    const long = files(SRC).flatMap((f) => labels(readFileSync(f, "utf8")).filter((l) => words(l) > 4).map((l) => `${f.slice(SRC.length + 1)}: ${l}`));
    expect(long).toEqual([]);
  });
  it("none is a sentence: no full stop, no colon before more words", () => {
    const prose = files(SRC).flatMap((f) => labels(readFileSync(f, "utf8")).filter((l) => /\.\s|\.$|:\s+\w+\s+\w+/.test(l.replace(/\$\{[^}]*\}/g, "X"))).map((l) => `${f.slice(SRC.length + 1)}: ${l}`));
    expect(prose).toEqual([]);
  });
});
