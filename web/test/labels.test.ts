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

/** Every literal and template `title=` / `aria-label=` in a file, including inside `{...}` expressions. */
function labels(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:\btitle|aria-label)=(?:"([^"]*)"|\{)/g)) {
    if (m[1] !== undefined) {
      out.push(m[1]);
      continue;
    }
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
      i++;
    }
    const expr = text.slice(start, i - 1);
    for (const lit of expr.matchAll(/`((?:[^`\\]|\\.)*)`|"((?:[^"\\]|\\.)*)"/g)) {
      out.push(lit[1] ?? lit[2]!);
    }
  }
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
    const prose = files(SRC).flatMap((f) =>
      labels(readFileSync(f, "utf8"))
        .filter((l) => /\.\s|\.$|:\s+(?:0\s+)?[A-Za-z]+\s+[A-Za-z]+/.test(l.replace(/\$\{[^}]*\}/g, "0")))
        .map((l) => `${f.slice(SRC.length + 1)}: ${l}`),
    );
    expect(prose).toEqual([]);
  });
});
