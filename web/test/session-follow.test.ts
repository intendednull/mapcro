// Follow across tabs (sessions.md §6, §10 phase 4): the registry's `session.tab` row in a store
// of its own, the session's follow built on it (src/session/follow.ts), who can be followed in
// a session's tab, and the note of tabs left with changes not sent (TD-101). The browser rows
// are e2e/session-follow.spec.ts; the server's stamping is crates/server/tests/sessions.rs.

import { describe, expect, it, vi } from "vitest";
// The browser build: the reactive one (node resolves solid-js to the server's, which doesn't
// track), as sessions-client.test.ts does.
vi.mock("solid-js", async () => await import(/* @vite-ignore */ "solid-js/dist/" + "solid.js"));
import { createRoot, createSignal } from "solid-js";
import { followable, locate, presenters } from "../src/board/follow";
import { VIEW_STATE } from "../src/gen/viewState";
import type { LinkRole } from "../src/gen/LinkRole";
import type { PeerPresence } from "../src/gen/PeerPresence";
import type { Presence } from "../src/gen/Presence";
import { SESSION_KEYS, type SessionKey, VIEW_KEYS, type Values, createViewState } from "../src/player/viewstate";
import { createSessionFollow, farPeer, farPresenters, seated, whereTo } from "../src/session/follow";
import type { TabRow } from "../src/session/tabs";
import { MAX_UNSENT, loadUnsent, saveUnsent, unsentKey, withUnsent } from "../src/session/unsent";

const id = (n: number) => n.toString(16).padStart(32, "0");
const [A, B, C, X] = [id(0xa), id(0xb), id(0xc), id(0xdead)];
const row = (tab: string, n: number): TabRow => ({ id: tab, board: `${"ABCDEFGH"[n]}`.repeat(22), grant: "G".repeat(22), name: `Game ${n}`, order: String.fromCharCode(98 + n) });
const TABS = [row(A, 0), row(B, 1), row(C, 2)];
const st = (more: Partial<Presence> = {}): Presence => ({ name: "x", color: 0, scene: null, floor: "surface", view: null, cursor: null, laser: [], drag: null, drag_group: [], focus: null, following: null, ...more });
const peer = (n: number, role: LinkRole, more: Partial<Presence> = {}): PeerPresence => ({ peer: n, role, state: st(more) });

describe("the registry's rooms", () => {
  it("a session's room has the open tab, and a board's every other key", () => {
    expect(SESSION_KEYS).toEqual(["session.tab"]);
    expect(VIEW_KEYS).not.toContain("session.tab");
    expect([...VIEW_KEYS, ...SESSION_KEYS].sort()).toEqual(Object.keys(VIEW_STATE).sort());
    // sessions.md §6.2's row.
    expect(VIEW_STATE["session.tab"]).toEqual({ room: "session", sync: "shared", kind: "id", field: "tab", mask: null, omit: false, unfollow: "keep", override: "stop", group: null, reset: false });
  });
  it("a store holds one room's keys, all of them", () => {
    const board = Object.fromEntries(VIEW_KEYS.map((k) => [k, undefined])) as unknown as Values;
    expect(() => createViewState(board)).not.toThrow();
    expect(() => createViewState<SessionKey>({ "session.tab": undefined })).not.toThrow();
    expect(() => createViewState({ ...board, "session.tab": undefined } as unknown as Values)).toThrow(/one room/);
    const { "layer.heals": _heals, ...rest } = board;
    expect(() => createViewState(rest as unknown as Values)).toThrow(/one room/);
    // As many keys as a board has, one of them the session's.
    expect(() => createViewState({ ...rest, "session.tab": undefined } as unknown as Values)).toThrow(/one room/);
    expect(() => createViewState({} as unknown as Values)).toThrow(/one room/);
  });
  it("a board's store carries no tab, and hears none", () => {
    const first = (kind: string) => (kind === "bool" ? false : kind === "text" ? "" : kind === "deaths" || kind === "heroes" ? [] : undefined);
    const s = createViewState(Object.fromEntries(VIEW_KEYS.map((k) => [k, first(VIEW_STATE[k].kind)])) as unknown as Values);
    expect(JSON.stringify(s.wire())).not.toContain("tab");
    expect(() => s.mirror({ tab: A, layers: 1 })).not.toThrow();
  });
});

describe("session.tab in its store: shared, kept on stopping, a pick stops", () => {
  const make = (first: string | undefined = A) => {
    let stops = 0;
    const s = createViewState<SessionKey>({ "session.tab": first }, { onStop: () => (stops += 1) });
    return { s, stops: () => stops };
  };
  it("presence carries it at `tab`: the id, or null for none", () => {
    expect(make(A).s.wire()).toEqual({ tab: A });
    expect(createViewState<SessionKey>({ "session.tab": undefined }).wire()).toEqual({ tab: null });
  });
  it("a follower takes the presenter's, and keeps it when the follow ends either way", () => {
    for (const how of ["restore", "keep"] as const) {
      const f = make(A);
      f.s.mirror({ tab: B });
      expect(f.s.get("session.tab")).toBe(B);
      expect(f.s.heard("session.tab")).toBe(true);
      expect(f.s.wire()).toEqual({ tab: B });
      f.s.forget(how);
      expect(f.s.get("session.tab"), how).toBe(B);
      expect(f.stops()).toBe(0);
    }
  });
  it("none, or anything that isn't an id as written, leaves the follower where it is", () => {
    const f = make(A);
    for (const w of [undefined, null, "", "abc", 7, {}, A.toUpperCase().replace(/^0/, "A"), `${A}0`, A.slice(1), `+${A.slice(1)}`]) {
      f.s.mirror({ tab: w });
      expect(f.s.get("session.tab"), JSON.stringify(w)).toBe(A);
    }
    f.s.mirror({});
    f.s.mirror(null);
    expect(f.s.get("session.tab")).toBe(A);
    expect(f.s.heard("session.tab")).toBe(false);
  });
  it("your own pick stops following, once, and is yours", () => {
    const f = make(A);
    f.s.mirror({ tab: B });
    f.s.set("session.tab", C);
    expect(f.stops()).toBe(1);
    expect(f.s.get("session.tab")).toBe(C);
    expect(f.s.heard("session.tab")).toBe(false);
  });
  it("where the app puts you is no pick: nothing stops", () => {
    const f = make(A);
    f.s.mirror({ tab: B });
    f.s.put("session.tab", C);
    expect(f.stops()).toBe(0);
    expect(f.s.get("session.tab")).toBe(C);
    expect(f.s.heard("session.tab")).toBe(false);
    f.s.put("session.tab", undefined);
    expect(f.s.get("session.tab")).toBeUndefined();
    expect(f.stops()).toBe(0);
  });
});

describe("who can be followed in a session's tab (§6.3)", () => {
  const stamped = (role: LinkRole, session_role?: LinkRole): PeerPresence => ({ peer: 1, role, ...(session_role ? { session_role } : {}), state: st({ seat: 7 }) });
  it("an editor of the board; or, by the stamped session role, an editor of the session on a view-only tab", () => {
    const table: Array<[LinkRole, LinkRole | undefined, boolean]> = [
      ["owner", undefined, true],
      ["edit", undefined, true],
      ["view", undefined, false],
      ["view", "view", false],
      ["view", "edit", true],
      ["view", "owner", true],
      ["edit", "view", true],
    ];
    for (const [role, session, want] of table) expect(followable(stamped(role, session)), `${role} ${session}`).toBe(want);
    expect(followable({ peer: 1, role: "view", session_role: "owner", state: null })).toBe(false);
  });
  it("a follow finds a session's editor on a view-only tab by seat, and counts them as presenting", () => {
    const coach = stamped("view", "owner");
    expect(locate({ peer: -1, seat: 7, joins: 0 }, [coach], 9, { n: 1, at: 0 }, 0)).toEqual({ kind: "here", peer: coach });
    // To a board's own viewer the same person comes unstamped: nobody to follow.
    const bare = stamped("view");
    expect(locate({ peer: -1, seat: 7, joins: 1 }, [bare], 9, { n: 1, at: 0 }, 0).kind).toBe("wait");
    expect(presenters([coach, peer(2, "view", { following: 1 })], 9, undefined).map((x) => x.peer.peer)).toEqual([1]);
    expect(presenters([bare, peer(2, "view", { following: 1 })], 9, undefined)).toEqual([]);
  });
});

describe("where a follower goes (§6.2 Apply, §6.3)", () => {
  const all = () => true;
  it("to the presenter's tab, when this page can open it", () => {
    expect(whereTo(B, A, TABS, all)).toEqual({ kind: "go", tab: B });
  });
  it("nowhere when it is there already, the presenter has none open, or this copy has no such tab", () => {
    expect(whereTo(A, A, TABS, all)).toEqual({ kind: "stay" });
    expect(whereTo(null, A, TABS, all)).toEqual({ kind: "stay" });
    expect(whereTo(undefined, A, TABS, all)).toEqual({ kind: "stay" });
    expect(whereTo(X, A, TABS, all)).toEqual({ kind: "stay" });
    expect(whereTo(B, undefined, TABS, all)).toEqual({ kind: "go", tab: B });
  });
  it("it stays when the tab can't be opened, and asks when that isn't known", () => {
    expect(whereTo(B, A, TABS, (t) => t.id !== B)).toEqual({ kind: "no-access", tab: TABS[1] });
    expect(whereTo(B, A, TABS, () => undefined)).toEqual({ kind: "ask", tab: TABS[1] });
    // Asked of the presenter's tab only.
    const asked: string[] = [];
    whereTo(C, A, TABS, (t) => (asked.push(t.id), true));
    expect(asked).toEqual([C]);
  });
});

describe("the session's room: who is followed, and who presents elsewhere", () => {
  it("the followed person is the newest editor with the seat, never me or a viewer", () => {
    const peers = [peer(1, "edit", { seat: 7 }), peer(4, "owner", { seat: 7 }), peer(5, "view", { seat: 7 }), peer(6, "edit", { seat: 8 }), peer(9, "edit", { seat: 7 }), peer(11, "edit")];
    expect(seated(peers, 7, 9)?.peer).toBe(4);
    expect(seated(peers, 8, 9)?.peer).toBe(6);
    expect(seated(peers, 7, undefined)?.peer).toBe(9);
    expect(seated(peers, 3, 9)).toBeUndefined();
    expect(seated(peers, undefined, 9)).toBeUndefined();
    expect(seated([peer(5, "view", { seat: 7 })], 7, 9)).toBeUndefined();
  });
  it("presenters on other tabs are offered: followed, seated, on a tab, not the one already followed", () => {
    const coach = peer(1, "owner", { name: "Coach", seat: 7, tab: B });
    const peers = [
      coach,
      peer(2, "view", { following: 1, tab: B }),
      peer(3, "edit", { name: "Here", seat: 8, tab: A }), // on my tab: the board's room offers them
      peer(4, "view", { following: 3 }),
      peer(5, "edit", { name: "Seatless", tab: C }), // an older page: can't be found in the next room
      peer(6, "view", { following: 5 }),
      peer(7, "edit", { name: "Tabless", seat: 9 }),
      peer(8, "view", { following: 7 }),
      peer(10, "view", { name: "Viewer", seat: 10, tab: C }), // a viewer is never followed
      peer(11, "view", { following: 10 }),
      peer(12, "edit", { name: "Alone", seat: 11, tab: C }), // nobody follows them
    ];
    const far = farPresenters(peers, 9, undefined, A);
    expect(far.map((x) => [x.peer.state?.name, x.followers])).toEqual([["Coach", 1]]);
    // As a board's chip takes them: a peer id no board's room gives out, the seat to follow by.
    expect(far[0]!.peer).toEqual({ ...coach, peer: -2 });
    expect(farPeer(coach).peer).toBeLessThan(0);
    expect(farPeer(peer(0, "edit")).peer).toBe(-1);
    // On another tab of mine, the one on A is far and Coach is not.
    expect(farPresenters(peers, 9, undefined, B).map((x) => x.peer.state?.name)).toEqual(["Here"]);
    // The one I follow already isn't offered again (my follow alone doesn't make an offer).
    expect(farPresenters(peers, 9, 1, A)).toEqual([]);
    expect(farPresenters([peer(12, "edit", { name: "Alone", seat: 11, tab: C })], 9, 12, A)).toEqual([]);
    // Never me.
    expect(farPresenters(peers, 1, undefined, A)).toEqual([]);
  });
});

/** A session's follow over signals a test drives: the room's peers, the tabs, what opens. */
function harness(first: string | undefined = A) {
  const [peers, setPeers] = createSignal<PeerPresence[]>([]);
  const [tabs, setTabs] = createSignal<TabRow[]>(TABS);
  const [opens, setOpens] = createSignal<Record<string, boolean>>({ [A]: true });
  const asked: string[] = [];
  const picked: Array<[string | undefined, number | undefined]> = [];
  const { f, dispose } = createRoot((dispose) => ({
    dispose,
    f: createSessionFollow({
      first,
      peers,
      myPeer: () => 9,
      tabs,
      access: (t) => opens()[t.id],
      ask: (t) => void asked.push(t.id),
      onPicked: (was, seat) => void picked.push([was?.state?.name, seat]),
    }),
  }));
  const coach = (tab: string | null, more: Partial<Presence> = {}) => peer(1, "owner", { name: "Coach", seat: 7, tab, ...more });
  return { f, dispose, setPeers, setTabs, setOpens, asked, picked, coach, open: (tab: string, ok: boolean) => setOpens((o) => ({ ...o, [tab]: ok })) };
}

describe("the session's follow (src/session/follow.ts)", () => {
  it("opens on the tab asked for, and says so to the room", () => {
    const h = harness(B);
    expect(h.f.tab()).toBe(B);
    expect(h.f.wire()).toEqual({ tab: B });
    expect(h.f.presenter()).toBeUndefined();
    expect(h.f.board.seat()).toBeUndefined();
    expect(h.f.board.holds()).toBe(false);
    h.dispose();
  });
  it("the presenter switches tab, and the follower switches: the next board gets the seat to follow", () => {
    const h = harness();
    h.open(B, true);
    h.setPeers([h.coach(A)]);
    h.f.board.begin(7, peer(3, "edit", { name: "Coach", seat: 7 }));
    expect(h.f.presenter()?.peer).toBe(1);
    // Shown as the session's room has them, which is newer than what the board last saw.
    expect(h.f.board.was()).toEqual({ ...h.coach(A), peer: -2 });
    expect(h.f.board.holds()).toBe(true);
    expect(h.f.tab()).toBe(A);
    h.setPeers([h.coach(B)]);
    expect(h.f.tab()).toBe(B);
    expect(h.f.wire()).toEqual({ tab: B });
    expect(h.f.board.seat()).toBe(7);
    // As last seen in the session's room, for the chip until the board's room has them.
    expect(h.f.board.was()).toEqual({ ...h.coach(B), peer: -2 });
    expect(h.f.board.noAccess()).toBe(false);
    expect(h.picked).toEqual([]);
    h.setPeers([h.coach(A)]);
    expect(h.f.tab()).toBe(A);
    h.dispose();
  });
  it("following someone already on another tab goes there at once (a late joiner)", () => {
    const h = harness();
    h.open(C, true);
    h.setPeers([h.coach(C), peer(2, "view", { following: 1, tab: C })]);
    expect(h.f.board.far().map((x) => [x.peer.peer, x.peer.state?.seat])).toEqual([[-2, 7]]);
    const offered = h.f.board.far()[0]!.peer;
    h.f.board.begin(offered.state!.seat, offered);
    expect(h.f.tab()).toBe(C);
    expect(h.f.board.far()).toEqual([]);
    h.dispose();
  });
  it("a tab not known to open is asked about once, and gone to when it does", () => {
    const h = harness();
    h.setPeers([h.coach(B)]);
    h.f.board.begin(7, undefined);
    expect(h.asked).toEqual([B]);
    expect(h.f.tab()).toBe(A);
    expect(h.f.board.noAccess()).toBe(false);
    h.open(B, true);
    expect(h.f.tab()).toBe(B);
    expect(h.asked).toEqual([B]);
    h.dispose();
  });
  it("a tab this page can't open: it stays, still following, and says No access; the follow resumes", () => {
    const h = harness();
    h.open(B, false);
    h.open(C, true);
    h.setPeers([h.coach(A)]);
    h.f.board.begin(7, undefined);
    h.setPeers([h.coach(B)]);
    expect(h.f.tab()).toBe(A);
    expect(h.f.board.noAccess()).toBe(true);
    expect(h.f.board.seat()).toBe(7);
    expect(h.f.board.holds()).toBe(true);
    expect(h.picked).toEqual([]);
    // The presenter moves to a tab that opens: the follower goes, and the chip clears.
    h.setPeers([h.coach(C)]);
    expect(h.f.tab()).toBe(C);
    expect(h.f.board.noAccess()).toBe(false);
    // And comes back to the follower's old tab.
    h.setPeers([h.coach(A)]);
    expect(h.f.tab()).toBe(A);
    h.dispose();
  });
  it("No access is said only while the presenter is in the session's room, on that tab", () => {
    const h = harness();
    h.open(B, false);
    h.setPeers([h.coach(B)]);
    h.f.board.begin(7, undefined);
    expect(h.f.board.noAccess()).toBe(true);
    h.setPeers([]);
    expect(h.f.board.noAccess()).toBe(false);
    h.setPeers([h.coach(B)]);
    expect(h.f.board.noAccess()).toBe(true);
    // They have no tab open (an empty strip, a page still loading): nothing to say.
    h.setPeers([h.coach(null)]);
    expect(h.f.board.noAccess()).toBe(false);
    expect(h.f.tab()).toBe(A);
    h.f.board.end();
    h.setPeers([h.coach(B)]);
    expect(h.f.board.noAccess()).toBe(false);
    h.dispose();
  });
  it("a refusal is asked about again whenever the presenter is heard there, and one withdrawn is gone to", () => {
    const h = harness();
    h.open(B, false);
    h.setPeers([h.coach(B)]);
    h.f.board.begin(7, undefined);
    expect(h.asked).toEqual([B]);
    expect(h.f.board.noAccess()).toBe(true);
    h.setPeers([h.coach(B, { name: "Coach!" })]);
    expect(h.asked).toEqual([B, B]);
    h.open(B, true);
    expect(h.f.tab()).toBe(B);
    expect(h.f.board.noAccess()).toBe(false);
    h.dispose();
  });
  it("a tab this copy of the session doesn't have yet is gone to once it does", () => {
    const h = harness();
    h.setOpens({ [A]: true, [X]: true });
    h.setPeers([h.coach(X)]);
    h.f.board.begin(7, undefined);
    expect(h.f.tab()).toBe(A);
    expect(h.f.board.noAccess()).toBe(false);
    expect(h.asked).toEqual([]);
    h.setTabs([...TABS, row(X, 3)]);
    expect(h.f.tab()).toBe(X);
    h.dispose();
  });
  it("picking a tab stops the follow and keeps the tab picked; the follow can be taken up again", () => {
    const h = harness();
    h.open(B, true);
    h.setPeers([h.coach(B)]);
    h.f.board.begin(7, undefined);
    expect(h.f.tab()).toBe(B);
    h.f.pick(C);
    expect(h.f.tab()).toBe(C);
    expect(h.f.board.seat()).toBeUndefined();
    expect(h.f.board.was()).toBeUndefined();
    expect(h.f.presenter()).toBeUndefined();
    expect(h.picked).toEqual([["Coach", 7]]);
    // The presenter moving on moves nobody now.
    h.setPeers([h.coach(A)]);
    expect(h.f.tab()).toBe(C);
    // "Follow again".
    h.f.again(7, undefined);
    expect(h.f.tab()).toBe(A);
    expect(h.f.board.seat()).toBe(7);
    h.dispose();
  });
  it("picking the tab already open is no change: the follow goes on", () => {
    const h = harness();
    h.setPeers([h.coach(A)]);
    h.f.board.begin(7, undefined);
    h.f.pick(A);
    expect(h.f.board.seat()).toBe(7);
    expect(h.picked).toEqual([]);
    h.dispose();
  });
  it("a pick while following someone who isn't in the session offers no way back across tabs", () => {
    const h = harness();
    h.f.board.begin(5, peer(3, "edit", { name: "Guest", seat: 5 }));
    expect(h.f.board.holds()).toBe(false);
    h.f.pick(B);
    expect(h.picked).toEqual([["Guest", undefined]]);
    expect(h.f.board.seat()).toBeUndefined();
    h.dispose();
  });
  it("a pick with no follow on says nothing", () => {
    const h = harness();
    h.f.pick(B);
    expect(h.f.tab()).toBe(B);
    expect(h.picked).toEqual([]);
    h.dispose();
  });
  it("where the session puts the page is no pick: the follow goes on (the tab was removed, both move left)", () => {
    const h = harness();
    h.open(B, true);
    h.setPeers([h.coach(B)]);
    h.f.board.begin(7, undefined);
    expect(h.f.tab()).toBe(B);
    // B is removed here first; the presenter's presence still names it.
    h.setTabs([TABS[0]!, TABS[2]!]);
    h.f.place(A);
    expect(h.f.tab()).toBe(A);
    expect(h.f.board.seat()).toBe(7);
    expect(h.f.board.holds()).toBe(true);
    expect(h.picked).toEqual([]);
    h.setPeers([h.coach(A)]);
    expect(h.f.tab()).toBe(A);
    expect(h.f.board.noAccess()).toBe(false);
    h.dispose();
  });
  it("the presenter leaves the session: the follower stays where it is, and the board ends the follow", () => {
    const h = harness();
    h.open(B, true);
    h.setPeers([h.coach(B)]);
    h.f.board.begin(7, undefined);
    h.setPeers([]);
    expect(h.f.tab()).toBe(B);
    expect(h.f.board.holds()).toBe(false);
    expect(h.f.board.noAccess()).toBe(false);
    // Held by seat while the board waits for a reconnect: they come back under another id.
    expect(h.f.board.seat()).toBe(7);
    h.setPeers([peer(4, "owner", { name: "Coach", seat: 7, tab: A })]);
    expect(h.f.presenter()?.peer).toBe(4);
    expect(h.f.tab()).toBe(A);
    h.setPeers([]);
    h.f.board.end();
    expect(h.f.board.seat()).toBeUndefined();
    expect(h.f.tab()).toBe(A);
    expect(h.picked).toEqual([]);
    h.dispose();
  });
  it("only someone the server says can be followed moves the page: not a viewer with the seat, not this page", () => {
    const h = harness();
    h.open(B, true);
    h.setPeers([peer(5, "view", { seat: 7, tab: B }), peer(9, "owner", { seat: 7, tab: B })]);
    h.f.board.begin(7, undefined);
    expect(h.f.presenter()).toBeUndefined();
    expect(h.f.tab()).toBe(A);
    h.dispose();
  });
  it("a follow on someone with no seat is the board's alone", () => {
    const h = harness();
    h.setPeers([h.coach(B)]);
    h.f.board.begin(7, undefined);
    h.f.board.begin(undefined, undefined);
    expect(h.f.board.seat()).toBeUndefined();
    expect(h.f.board.holds()).toBe(false);
    h.dispose();
  });
  it("two presenters on different tabs: a follower goes with its own", () => {
    const h = harness();
    h.setOpens({ [A]: true, [B]: true, [C]: true });
    const other = (tab: string) => peer(2, "edit", { name: "Other", seat: 8, tab });
    h.setPeers([h.coach(A), other(B)]);
    h.f.board.begin(7, undefined);
    h.setPeers([h.coach(A), other(C)]);
    expect(h.f.tab()).toBe(A);
    h.setPeers([h.coach(C), other(B)]);
    expect(h.f.tab()).toBe(C);
    h.dispose();
  });
});

describe("tabs left with changes not sent (TD-101)", () => {
  class Mem {
    m = new Map<string, string>();
    getItem = (k: string) => this.m.get(k) ?? null;
    setItem = (k: string, v: string) => void this.m.set(k, v);
    removeItem = (k: string) => void this.m.delete(k);
  }
  const S = "S".repeat(22);
  const b = (c: string) => c.repeat(22);
  it("a board is noted while it has some, and no longer once it has none", () => {
    const none: ReadonlySet<string> = new Set();
    const one = withUnsent(none, b("A"), 2);
    expect([...one]).toEqual([b("A")]);
    expect(withUnsent(one, b("A"), 1)).toBe(one);
    expect(withUnsent(none, b("A"), 0)).toBe(none);
    const two = withUnsent(one, b("B"), 1);
    expect([...two]).toEqual([b("A"), b("B")]);
    expect([...withUnsent(two, b("A"), 0)]).toEqual([b("B")]);
  });
  it("outlasts a reload, per session", () => {
    const s = new Mem();
    expect([...loadUnsent(s, S)]).toEqual([]);
    saveUnsent(s, S, new Set([b("A"), b("B")]));
    expect([...loadUnsent(s, S)]).toEqual([b("A"), b("B")]);
    expect([...loadUnsent(s, "T".repeat(22))]).toEqual([]);
    saveUnsent(s, S, new Set());
    expect(s.m.has(unsentKey(S))).toBe(false);
  });
  it("reads only board ids, from a list, and holds a session's worth", () => {
    const s = new Mem();
    for (const raw of ["{", "7", '{"a":1}', "null"]) {
      s.setItem(unsentKey(S), raw);
      expect([...loadUnsent(s, S)], raw).toEqual([]);
    }
    s.setItem(unsentKey(S), JSON.stringify([b("A"), 7, "short", `${b("B")}x`, b("C"), "<".repeat(22)]));
    expect([...loadUnsent(s, S)]).toEqual([b("A"), b("C")]);
    const many = Array.from({ length: MAX_UNSENT + 3 }, (_, i) => i.toString().padStart(22, "0"));
    let set: ReadonlySet<string> = new Set();
    for (const m of many) set = withUnsent(set, m, 1);
    expect(set.size).toBe(MAX_UNSENT);
    expect(set.has(many[0]!)).toBe(false);
    expect(set.has(many.at(-1)!)).toBe(true);
    s.setItem(unsentKey(S), JSON.stringify(many));
    expect(loadUnsent(s, S).size).toBe(MAX_UNSENT);
    expect(loadUnsent(s, S).has(many.at(-1)!)).toBe(true);
  });
  it("storage that refuses is no note, and no error", () => {
    const refuses = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
    expect([...loadUnsent(refuses, S)]).toEqual([]);
    expect(() => saveUnsent(refuses, S, new Set([b("A")]))).not.toThrow();
    expect(() => saveUnsent(refuses, S, new Set())).not.toThrow();
  });
});
