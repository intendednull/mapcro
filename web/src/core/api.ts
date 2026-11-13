// The HTTP API (crates/server/src/api.rs).

import type { LinkRole } from "../gen/LinkRole";
import type { RecordId } from "../gen/RecordId";
import type { Via } from "../gen/Via";
import { authHeader } from "./cred";

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

  mintLink(board: string, owner: string, role: "edit" | "view", label: string, kind: "boards" | "sessions" = "boards") {
    return fetch(`${this.base}/api/${kind}/${board}/links`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner}` },
      body: JSON.stringify({ role, label }),
    }).then((r) => json<{ link_id: string; token: string }>(r));
  }

  listLinks(board: string, owner: string, kind: "boards" | "sessions" = "boards") {
    return fetch(`${this.base}/api/${kind}/${board}/links`, { headers: { authorization: `Bearer ${owner}` } }).then((r) =>
      json<LinkInfo[]>(r),
    );
  }

  /** Copy a board's current state into a new board with fresh links; any valid link may (a
   * session's tab too: sessions.md §3.5). */
  cloneBoard(board: string, token: string, title?: string, via?: Via) {
    return fetch(`${this.base}/api/boards/${board}/clone`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader(token, via) },
      body: JSON.stringify(title ? { title } : {}),
    }).then((r) => json<{ board: string; owner_token: string }>(r));
  }

  async revoke(board: string, owner: string, linkId: string, kind: "boards" | "sessions" = "boards") {
    const r = await fetch(`${this.base}/api/${kind}/${board}/links/${linkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${owner}` },
    });
    if (r.status !== 204) throw new Error(`revoke failed: ${r.status}`);
  }
}

// ---- sessions (sessions.md §3, server crates/server/src/sessions.rs) ----

/** What `POST /api/sessions` answers; `tab` and `grant` when it was made from a board (§7.3). */
export interface CreatedSession {
  session: string;
  owner_token: string;
  tab?: RecordId;
  grant?: Grant;
}

/** A board's access delegated to a session (§3.2). Never a token. */
export interface Grant {
  grant_id: string;
  board: string;
  role: LinkRole;
}

/** A session API refusal, with the server's status and its words. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly text: string,
  ) {
    super(`${status}: ${text}`);
  }
}

async function answer<T>(r: Response): Promise<T> {
  if (!r.ok) {
    const body = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new ApiError(r.status, typeof body?.error === "string" ? body.error : "");
  }
  return (await r.json()) as T;
}

/** A new session; made from a board, its first tab is that board (§7.3). */
export function createSession(title: string, from?: { board: string; token: string }) {
  return fetch(`/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(from ? { title, board: from.board, board_token: from.token } : { title }),
  }).then((r) => answer<CreatedSession>(r));
}

/** Delegate a board to a session with a link for it (§3.2): the token goes once, in the body. */
export function addGrant(session: string, token: string, board: string, boardToken: string, role?: "view") {
  return fetch(`/api/sessions/${session}/grants`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(role ? { board, board_token: boardToken, role } : { board, board_token: boardToken }),
  }).then((r) => answer<Grant>(r));
}

/** Withdraw a grant (§3.7, "Remove and revoke"): the session's owner or the grant's adder. */
export async function withdrawGrant(session: string, token: string, grant: string) {
  const r = await fetch(`/api/sessions/${session}/grants/${grant}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
  if (r.status !== 204) throw new ApiError(r.status, "");
}

/** Session links: `https://host/s/<session>?tab=<tab>#<token>` (§3.1, §7.1). */
export function sessionUrl(origin: string, session: string, token: string, tab?: string) {
  return `${origin}/s/${session}${tab ? `?tab=${tab}` : ""}#${token}`;
}

export function parseSessionUrl(href: string): { session: string; token: string; tab: string | undefined } | undefined {
  const u = new URL(href);
  const m = /^\/s\/([A-Za-z0-9_-]{22})$/.exec(u.pathname);
  const token = u.hash.slice(1);
  const tab = u.searchParams.get("tab") ?? undefined;
  return m?.[1] && /^[A-Za-z0-9_-]{43}$/.test(token) ? { session: m[1], token, tab: tab && /^[0-9a-f]{32}$/.test(tab) ? tab : undefined } : undefined;
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
