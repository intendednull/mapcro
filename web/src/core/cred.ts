// How a board is opened (sessions.md §3.4): with its own link token (`Bearer`), or as a session's
// tab, with the session's token and the grant the tab names (`Grant <session>.<grant>.<token>`).
// The socket says the same with `Auth.via`. A tab's board never sees a board token.

import type { Via } from "../gen/Via";

/** The `authorization` header for a board route. */
export function authHeader(token: string, via?: Via): string {
  return via ? `Grant ${via.session}.${via.grant}.${token}` : `Bearer ${token}`;
}
