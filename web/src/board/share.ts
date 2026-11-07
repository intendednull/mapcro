// Sharing (spec §11): the link tree the share dialog shows, and the tokens this device minted.
// The server keeps only hashes, so a link's URL can be shown again only on the device that made it.

import type { LinkInfo } from "../core/api";

export interface TreeRow {
  link: LinkInfo;
  depth: number;
  /** The label of the link it was shared from, when that's in the list. */
  from: string | undefined;
  mine: boolean;
}

/** The public id of a link token: the first 16 hex digits of its SHA-256 (server `links::link_id`). */
export async function linkIdOf(token: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/** Depth-first, oldest first; owner links and your own link are the roots, not rows. */
export function linkTree(links: LinkInfo[], mine: string): TreeRow[] {
  const shown = links.filter((l) => l.role !== "owner" && l.link_id !== mine);
  const ids = new Set(shown.map((l) => l.link_id));
  const byId = new Map(links.map((l) => [l.link_id, l]));
  const kids = new Map<string | null, LinkInfo[]>();
  for (const l of shown) {
    const parent = l.minted_by && ids.has(l.minted_by) ? l.minted_by : null;
    kids.set(parent, [...(kids.get(parent) ?? []), l]);
  }
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const l of (kids.get(parent) ?? []).sort((a, b) => a.created_at - b.created_at)) {
      const from = l.minted_by ? byId.get(l.minted_by) : undefined;
      out.push({ link: l, depth, from: from && from.role !== "owner" ? from.label : undefined, mine: l.minted_by === mine });
      walk(l.link_id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

const KEY = "mapcro.minted";

/** Tokens this device minted, by board and link id, so their URLs can be copied again. */
export function mintedTokens(board: string): Record<string, string> {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Record<string, string>>)[board] ?? {};
  } catch {
    return {};
  }
}

export function rememberMinted(board: string, linkId: string, token: string) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Record<string, string>>;
    all[board] = { ...(all[board] ?? {}), [linkId]: token };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Not remembered: the link still works, it just can't be copied again here.
  }
}
