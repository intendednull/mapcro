// Follow across tabs (sessions.md §6): the session's own view state, which is the open tab
// (`session.tab` in the registry, crates/engine/src/view_state.rs), and whom this page follows
// from one tab's board to the next. A board's follow is the board's (Board.tsx), and ends with
// its mount; the session holds the presenter's seat across the switch, moves this page when the
// presenter's tab changes, and hands the next board's mount the seat to follow there.
//
// The session's room says who is in the session and on which tab (its presence: name, colour,
// `tab`, `seat`, `following`), with each person's session role stamped by the server. A seat is
// not authority (§6.1): who can be followed is the stamped role.

import { type Accessor, batch, createEffect, createMemo, createSignal, untrack } from "solid-js";
import { presenters } from "../board/follow";
import { followable } from "../core/session";
import type { PeerPresence } from "../gen/PeerPresence";
import type { RecordId } from "../gen/RecordId";
import { type SessionKey, createViewState } from "../player/viewstate";
import type { TabRow } from "./tabs";

/** The session's follow, as a tab's board uses it (Board.tsx `InSession.follow`). */
export interface SessionFollow {
  /** The seat this page follows across tabs: a board that mounts follows it at once, while
   * the session `holds` them. */
  seat(): number | undefined;
  /** That person as last seen, to show while they're looked for in the board's room. */
  was(): PeerPresence | undefined;
  /** The board began a follow (of someone with a seat), or ended it. */
  begin(seat: number | undefined, was: PeerPresence | undefined): void;
  end(): void;
  /**
   * The followed person is in the session's room: on another tab (this page is moved to it, or
   * can't open it), or on their way into this board. The board keeps its follow while so.
   */
  holds(): boolean;
  /** They are on a tab this page can't open (§6.3): it stays where it is, following. */
  noAccess(): boolean;
  /** The session's presenters on other tabs, as a board's chip offers them: each with a
   * negative `peer` (no board's peer id is), their seat, name and colour. */
  far(): Array<{ peer: PeerPresence; followers: number }>;
  /** Everyone in the session's room on another tab (§8, the people list's "Session" group):
   * each as a board's chip takes them (`farPeer`), with their tab, whether they can be followed
   * from here, and how many follow them. Followed or not: the first follower starts here. */
  elsewhere(): Elsewhere[];
}

/** Someone on another tab of the session, as the people list's "Session" group shows them. */
export interface Elsewhere {
  peer: PeerPresence;
  tab: TabRow;
  /** The server says they can be followed, and they have a seat to be found by. */
  canFollow: boolean;
  followers: number;
}

/** A session peer as a board's follow chip takes it: never one of the board's peer ids. */
export const farPeer = (p: PeerPresence): PeerPresence => ({ ...p, peer: -1 - p.peer });

/** The person with `seat` in the session's room who can be followed: the newest, never me
 * (as board/follow.ts `locate` finds one in a board's room). */
export function seated(peers: PeerPresence[], seat: number | undefined, me: number | undefined): PeerPresence | undefined {
  if (seat === undefined) return undefined;
  let best: PeerPresence | undefined;
  for (const p of peers) if (p.peer !== me && followable(p) && p.state?.seat === seat && (!best || p.peer > best.peer)) best = p;
  return best;
}

export type Where =
  /** On this tab, on none, or on one this copy of the session doesn't have: nothing to do. */
  | { kind: "stay" }
  /** On a tab this page can open: go there. */
  | { kind: "go"; tab: RecordId }
  /** On one it can't (a withdrawn grant, a board that's gone, a junk tab). */
  | { kind: "no-access"; tab: TabRow }
  /** On one it hasn't asked about yet. */
  | { kind: "ask"; tab: TabRow };

/**
 * What a follower does about its presenter's tab (§6.2 "Apply", §6.3): the tab is resolved
 * against this copy of the session document, and against what this page may open (`access`:
 * yes, no, or not known yet).
 */
export function whereTo(theirs: RecordId | null | undefined, mine: RecordId | undefined, tabs: TabRow[], access: (t: TabRow) => boolean | undefined): Where {
  const row = theirs == null ? undefined : tabs.find((t) => t.id === theirs);
  if (!row || row.id === mine) return { kind: "stay" };
  const ok = access(row);
  return ok === undefined ? { kind: "ask", tab: row } : ok ? { kind: "go", tab: row.id } : { kind: "no-access", tab: row };
}

/**
 * What a follow knows of the boards this page may open, once the strip has heard about one (§6.3).
 * A refusal is known at once. A yes isn't trusted: the strip asks as the page opens, and a grant
 * withdrawn after that would land the follower on a dead tab, so a follow still asks before it
 * goes. A yes only clears a refusal heard before (the tab opens again: undo put it back).
 */
export function stripHeard(known: ReadonlyMap<string, boolean>, key: string, ok: boolean): ReadonlyMap<string, boolean> {
  if (!ok) return known.get(key) === false ? known : new Map(known).set(key, false);
  if (known.get(key) !== false) return known;
  const next = new Map(known);
  next.delete(key);
  return next;
}

/**
 * Drop any one-shot "yes" entries from the openable map while keeping refusals (TD-153): a
 * follow always asks `canOpen` before moving to another tab so a grant revoked since the last
 * visit never lands the follower on a dead tab.
 */
export function dropAllowed(known: ReadonlyMap<string, boolean>): ReadonlyMap<string, boolean> {
  let hasYes = false;
  for (const ok of known.values()) if (ok) { hasYes = true; break; }
  if (!hasYes) return known;
  const next = new Map<string, boolean>();
  for (const [k, ok] of known) if (!ok) next.set(k, false);
  return next;
}

/** The session's presenters this page could follow onto another tab: followed, seated, on a
 * tab that isn't `mine`, and not the one already followed. */
export function farPresenters(peers: PeerPresence[], me: number | undefined, iFollow: number | undefined, mine: RecordId | undefined) {
  return presenters(peers, me, iFollow)
    .filter((x) => x.peer.peer !== iFollow && x.peer.state?.seat != null && x.peer.state.tab != null && x.peer.state.tab !== mine)
    .map((x) => ({ peer: farPeer(x.peer), followers: x.followers }));
}

/**
 * The session's people on a tab other than `mine` (§8): live tabs only, never me, in the strip's
 * order and then by name. `iFollow`: the session peer this page follows, counted as a follower.
 */
export function elsewhere(peers: PeerPresence[], me: number | undefined, iFollow: number | undefined, mine: RecordId | undefined, tabs: TabRow[]): Elsewhere[] {
  const at = new Map(tabs.map((t, i) => [t.id, i] as const));
  const count = new Map<number, number>();
  for (const p of peers) if (p.peer !== me && p.state?.following != null) count.set(p.state.following, (count.get(p.state.following) ?? 0) + 1);
  if (iFollow !== undefined) count.set(iFollow, (count.get(iFollow) ?? 0) + 1);
  return peers
    .filter((p) => p.peer !== me && p.state?.tab != null && p.state.tab !== mine && at.has(p.state.tab))
    .map((p) => ({ peer: farPeer(p), tab: tabs[at.get(p.state!.tab!)!]!, canFollow: followable(p) && p.state!.seat != null, followers: count.get(p.peer) ?? 0 }))
    .sort((a, b) => at.get(a.tab.id)! - at.get(b.tab.id)! || (a.peer.state!.name < b.peer.state!.name ? -1 : a.peer.state!.name > b.peer.state!.name ? 1 : b.peer.peer - a.peer.peer));
}

/** Who is on each tab, by the session's presence (§8: a tab's avatar dots), never me. */
export function onTabs(peers: PeerPresence[], me: number | undefined): ReadonlyMap<RecordId, PeerPresence[]> {
  const out = new Map<RecordId, PeerPresence[]>();
  for (const p of peers) {
    const t = p.state?.tab;
    if (p.peer === me || t == null) continue;
    const list = out.get(t);
    if (list) list.push(p);
    else out.set(t, [p]);
  }
  return out;
}

export interface SessionFollowOptions {
  /** The tab the address asked for. */
  first: RecordId | undefined;
  /** Everyone else in the session's room. */
  peers: Accessor<PeerPresence[]>;
  myPeer: Accessor<number | undefined>;
  tabs: Accessor<TabRow[]>;
  /** Whether this page can open a tab: known from having opened it, or asked (`ask`, which
   * answers into what `access` reads). */
  access: (t: TabRow) => boolean | undefined;
  ask: (t: TabRow) => void;
  /** Called in the same batch when a follow moves to `tab`, so a one-shot `canOpen` yes is
   * cleared and never cached stale after leaving that tab (TD-153). */
  went?: (tab: RecordId) => void;
  /** The follower picked a tab itself, which stopped the follow on `was` (§6.2 "Stop").
   * `seat`: theirs, when they are in the session, so the follow can be taken up again. */
  onPicked: (was: PeerPresence | undefined, seat: number | undefined) => void;
}

export function createSessionFollow(o: SessionFollowOptions) {
  const [seat, setSeat] = createSignal<number>();
  const [was, setWas] = createSignal<PeerPresence>();
  const [noAccess, setNoAccess] = createSignal(false);
  const drop = () => {
    setSeat(undefined);
    setWas(undefined);
    setNoAccess(false);
  };
  // The session's store: its one key is the open tab. Picking a tab is a change to what you
  // see, so the store stops the follow (`onStop`), as it does for a board's `stop` keys.
  const view = createViewState<SessionKey>(
    { "session.tab": o.first },
    {
      onStop: () => {
        const s = untrack(seat);
        if (s === undefined) return;
        const last = untrack(was);
        const here = untrack(presenter) !== undefined;
        drop();
        o.onPicked(last, here ? s : undefined);
      },
    },
  );
  const tab = () => view.get("session.tab");
  /** The followed person in the session's room, while they are there. */
  const presenter = createMemo(() => seated(o.peers(), seat(), o.myPeer()));
  createEffect(() => {
    const x = presenter();
    if (x) setWas(farPeer(x));
  });
  // The presenter's tab, applied (§6.2): this page goes where they are, when it can.
  createEffect(() => {
    const x = presenter();
    if (!x) return setNoAccess(false);
    const to = whereTo(x.state?.tab, tab(), o.tabs(), o.access);
    setNoAccess(to.kind === "no-access");
    // A refusal is asked about again each time the presenter is heard there: what was refused
    // can open later (a removed tab put back by undo), and then this page goes.
    if (to.kind === "ask" || to.kind === "no-access") o.ask(to.tab);
    if (to.kind === "go") {
      batch(() => {
        view.mirror({ tab: to.tab });
        o.went?.(to.tab);
      });
    }
  });
  const board: SessionFollow = {
    seat,
    was,
    begin: (s, seen) => {
      if (s === undefined) return drop();
      // Together: the session's room has them as they are now, which is newer than `seen`.
      batch(() => {
        setWas(seen);
        setSeat(s);
      });
    },
    end: drop,
    holds: () => presenter() !== undefined,
    noAccess,
    far: createMemo(() => farPresenters(o.peers(), o.myPeer(), presenter()?.peer, tab())),
    elsewhere: createMemo(() => elsewhere(o.peers(), o.myPeer(), presenter()?.peer, tab(), o.tabs())),
  };
  return {
    /** The open tab. */
    tab,
    /** The user's own pick (the strip, a key, the address, a game just added): it stops a follow. */
    pick: (id: RecordId) => {
      if (id !== untrack(tab)) view.set("session.tab", id);
    },
    /** Where the session puts this page (its first tab; the neighbour of one removed): not a
     * choice of the user's, so a follow goes on (§6.3). */
    place: (id: RecordId | undefined) => view.put("session.tab", id),
    /** What the session's presence carries of the view state: `tab`. */
    wire: () => view.wire() as { tab: RecordId | null },
    /** The session peer this page follows, for its presence's `following`. */
    presenter,
    /** Follow the person with `seat` again ("Follow again" after a pick). */
    again: (s: number, seen: PeerPresence | undefined) => board.begin(s, seen),
    board,
  };
}

export type SessionFollowState = ReturnType<typeof createSessionFollow>;
