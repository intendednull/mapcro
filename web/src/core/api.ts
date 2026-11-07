// The HTTP API (crates/server/src/api.rs).

import type { LinkRole } from "../gen/LinkRole";

export interface LinkInfo {
  link_id: string;
  role: LinkRole;
  label: string;
  created_at: number;
  revoked: boolean;
  /** Public id of the link that minted this one (null for the owner's). */
  minted_by: string | null;
}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}

export class Api {
  constructor(private readonly base: string) {}

  createBoard(title: string) {
    return fetch(`${this.base}/api/boards`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }).then((r) => json<{ board: string; owner_token: string }>(r));
  }

  mintLink(board: string, owner: string, role: "edit" | "view", label: string) {
    return fetch(`${this.base}/api/boards/${board}/links`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
      body: JSON.stringify({ role, label }),
    }).then((r) => json<{ link_id: string; token: string }>(r));
  }

  listLinks(board: string, owner: string) {
    return fetch(`${this.base}/api/boards/${board}/links`, { headers: { authorization: `Bearer ${owner}` } }).then((r) =>
      json<LinkInfo[]>(r),
    );
  }

  /** Copy a board's current state into a new board with fresh links; any valid link may. */
  cloneBoard(board: string, token: string, title?: string) {
    return fetch(`${this.base}/api/boards/${board}/clone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(title ? { title } : {}),
    }).then((r) => json<{ board: string; owner_token: string }>(r));
  }

  async revoke(board: string, owner: string, linkId: string) {
    const r = await fetch(`${this.base}/api/boards/${board}/links/${linkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner}` },
    });
    if (r.status !== 204) throw new Error(`revoke failed: ${r.status}`);
  }
}

/** Share links look like `https://host/b/<board>#<token>`: the token never reaches the server's logs. */
export function shareUrl(origin: string, board: string, token: string) {
  return `${origin}/b/${board}#${token}`;
}

export function parseShareUrl(href: string): { board: string; token: string } | undefined {
  const u = new URL(href);
  const m = /^\/b\/([A-Za-z0-9_-]{22})$/.exec(u.pathname);
  const token = u.hash.slice(1);
  return m?.[1] && /^[A-Za-z0-9_-]{43}$/.test(token) ? { board: m[1], token } : undefined;
}
