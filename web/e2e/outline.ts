// An element's DOM as text, for the DOM pins (map-state-dom-pins.spec.ts,
// map-state-marker-pins.spec.ts).

import type { Page } from "./fixtures";

/**
 * An element as text, a line each, attributes in name order. Left out: what differs from run to
 * run and isn't what the pin is for (a person's own colour, the order of the hero tokens).
 * Record ids minted in the page become `#n` in the order met; an inline image becomes its length.
 */
export async function outline(p: Page, testid: string): Promise<string> {
  // Nothing hovered, and every transition done.
  await p.mouse.move(2, 2);
  await p.waitForTimeout(700);
  return p.getByTestId(testid).first().evaluate((root) => {
    const ids = new Map<string, string>();
    const tidy = (v: string) =>
      v
        .replace(/data:[a-z/+-]+[;,][^"')\s]*/g, (m) => `data:(${m.length})`)
        // This person's own colour, drawn at random when they join.
        .replace(/--me: #[0-9a-f]{6};\s*/g, "")
        .replace(/\b[0-9a-f]{32}\b/g, (m) => ids.get(m) ?? (ids.set(m, `#${ids.size + 1}`), ids.get(m)!))
        .replace(/-?\d+\.\d{2,}/g, (m) => String(Math.round(Number(m) * 10) / 10));
    const lines: string[] = [];
    const walk = (el: Element, depth: number) => {
      const attrs = [...el.attributes]
        .filter((a) => !["data-view", "data-tip-id"].includes(a.name))
        .sort((a, b) => (a.name < b.name ? -1 : 1))
        .map((a) => ` ${a.name}="${tidy(a.value)}"`)
        .join("");
      const text = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent!.trim()).filter(Boolean).join(" ");
      lines.push(`${"  ".repeat(depth)}<${el.tagName.toLowerCase()}${attrs}>${text ? ` ${tidy(text)}` : ""}`);
      // What is drawn per hero record comes in record-id order, and a board's ids are minted at
      // random when it is imported: in a fixed order here, so the pin holds each and not their order.
      const kids = [...el.children];
      // The element that names its hero record: `c`, or the one child of a bare wrapper.
      const hero = (c: Element) => (c.hasAttribute("data-player") ? c : c.attributes.length === 0 && c.children.length === 1 && c.children[0]!.hasAttribute("data-player") ? c.children[0]! : undefined);
      // A token by its slot; what hangs off one elsewhere (a respawn badge) by where it is.
      const place = (c: Element) => hero(c)!.getAttribute("data-slot") ?? hero(c)!.getAttribute("transform") ?? "";
      const tokens = kids.filter(hero).sort((a, b) => (place(a) < place(b) ? -1 : 1));
      for (const c of kids) walk(hero(c) ? tokens.shift()! : c, depth + 1);
    };
    walk(root, 0);
    return lines.join("\n") + "\n";
  });
}
