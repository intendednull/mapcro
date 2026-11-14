// One board: the header (title, save status, people), the map with its layers, and the side
// panel. The map is the interface: edits happen on it directly.

import { rosterTeamName, teamName } from "../map/model";
import { type JSX, For, Match, Show, Switch, batch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Callout } from "../gen/Callout";
import { cx } from "../ui/cx";
import { type Me, colorOf, commentsOpen, setCommentsOpen, hasJoined, inkOn, loadColour, loadMe, saveColour, markJoined, rememberBoard, saveMe, takeRename } from "../core/device";
import type { RecordId } from "../gen/RecordId";
import { MapView } from "../map/MapView";
import type { Art } from "../map/pack";
import type { Viewpoint } from "../map/transform";
import { Wordmark } from "../ui/Wordmark";
import { DeadLink } from "../ui/DeadLink";
import { formatClock, parseClock } from "../core/clock";
import { InlineEdit } from "../ui/InlineEdit";
import { JoinCard } from "./JoinCard";
import { SceneTree } from "./SceneTree";
import { TopBar } from "./TopBar";
import { createBoardState } from "./state";
import { resetBoardModules } from "./reset";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { PeerPresence } from "../gen/PeerPresence";
import { FIT, type FollowTarget, type ViewRect, clampView, fromViewport, locate, presenters, sideOf, startFollow, toViewport, zoomAt } from "./follow";
import { CloneDialog, JUST_CLONED } from "./CloneDialog";
import type { MatchPreview } from "../match/preview";
import { EventPings, Highlight, MapControls, Player, PlayerSide, PlayerSwitch, TierChip, TrooperDots } from "../player/Player";
import { createPlayerHost, playbackPresence } from "../player/host";
import { ReplayPrompt } from "../player/ReplayPrompt";
import { MarkerTips, TeleporterLink } from "../player/Camps";
import { markerStates } from "../player/markerStates";
import { HoverLabels, hoverFromWire, hoverWire, localHover, setRemoteHover } from "../map/HoverLabel";
import { UrnMark } from "../player/Urn";
import { DeathSkulls } from "../player/Skulls";
import { SkullRecap } from "../player/SkullRecap";
import { HeroCard, type HeroCardSlot } from "../player/HeroCard";
import { beside, opening, paneOf, placeOf } from "../player/panelPlace";
import { type Place, placeToWire } from "../player/layers";
import { recapOf } from "../player/recap";
import { RiftRings } from "../player/Rift";
import { liveLayer } from "../player/layer";
import { PlayerTopBar } from "../player/PlayerTopBar";
import { MoreMenu, type MoreRow } from "./MoreMenu";
import { openInAppHref } from "../core/applink";
import { WINDOWS_APP_PORTABLE_URL, appUpdate, desktopAppLinks } from "../player/desktop";
import { downloadBoard } from "../core/boardfile";
import { Layers, calloutOrder } from "./Layers";
import { FRESH_BOARD, randomRosterOps, sceneMatchName } from "./roster";
import { HeroPicker } from "./HeroPicker";
import { defaultSplit, project } from "../map/lanes";
import { FIT_VIEW, worldToMap, worldToView } from "../map/transform";
import type { WorldPos } from "../gen/WorldPos";
import { slotKey } from "../match/save";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { ShareDialog } from "./ShareDialog";
import { FeedbackButton } from "../ui/Feedback";
import { ShareIcon } from "../ui/ShareIcon";
import { feedbackMatchOf } from "../core/feedback";
import { rejection, statusView } from "./status";
import type { Reject } from "../gen/Reject";
import { Avatar, FollowChip, PeopleList, PresentingPill } from "./Presence";
import { type ClearKind, Toolbar } from "./Toolbar";
import { Palette } from "./Palette";
import { isUnnamed, sceneName } from "./scenes";
import { easedNumber, smoothed } from "./smooth";
import type { Tool } from "./tools";
import { LIMITS } from "../gen/limits";
import type { Via } from "../gen/Via";
import type { UndoHistory } from "../session/history";
import { AddGameOnBoard } from "../session/AddGame";

/** The page's title, as index.html has it: what the tab says with no board open. */
const PAGE_TITLE = "mapcro";

/** `quiet`: the desktop header's look (spec §4b): saved, or a change under 400 ms old, is a 16 px
 * box, the check alone (its word the hover); a problem is the full pill. */
function SaveStatus(p: { state: ReturnType<typeof createBoardState>; rejected: Reject | undefined; dismiss: () => void; quiet?: boolean }) {
  // "Syncing" shows only once a change has waited 400 ms, so quick saves don't flicker; until
  // then the indicator is blank, never "Saved".
  const [slow, setSlow] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const syncing = p.state.status().kind === "syncing";
    clearTimeout(timer);
    if (!syncing) setSlow(false);
    else timer = setTimeout(() => setSlow(true), 400);
  });
  onCleanup(() => clearTimeout(timer));
  const v = () => statusView(p.state.status(), p.state.connection(), slow(), p.rejected);
  return (
    <span
      class={cx("save", v().kind === "connecting" ? "syncing" : v().kind === "closed" ? "rejected" : v().kind, p.quiet && (v().kind === "saved" || (v().kind === "syncing" && !v().text)) && "quiet")}
      title={p.quiet && v().kind === "saved" ? v().text : undefined}
      data-testid="save-status" data-state={v().kind} data-connection={p.state.connection().kind} data-can-edit={String(p.state.canEdit())} role="status">
      <Show when={v().kind === "saved"}>
        <svg class="ico glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </Show>
      <Show when={v().kind === "offline"}>
        <svg class="ico glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 3l18 18M8.5 16.5a5 5 0 017 0M5 12.5a10 10 0 015-2.6M14.5 10a10 10 0 014.5 2.5M2 8.8a15 15 0 015.3-3.2M12 5a15 15 0 0110 3.8" />
        </svg>
      </Show>
      <Show when={v().kind === "syncing" && v().text}>
        <svg class="ico glyph spin" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M20 12a8 8 0 11-2.3-5.7M20 4v4h-4" />
        </svg>
      </Show>
      {v().text}
      <Show when={v().kind === "rejected"}>
        {" "}
        <button class="why" data-testid="dismiss-rejection" aria-label="Dismiss" title="Dismiss" onClick={() => p.dismiss()}>
          ×
        </button>
      </Show>
    </span>
  );
}

const avatarLetter = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
/** A hero panel's slot key ("amber-0") as HeroCard takes it. */
const heroCardSlot = (key: string): HeroCardSlot => {
  const [team, n] = key.split("-");
  return { team: team!, slot: Number(n) };
};
/** Where a hero panel sits until it is placed: the pane's top left (one opened from a token is
 * always placed: beside the token on a desktop, panelPlace.ts `beside`; a step from the last on a phone, `cascade`). */
const HERO_HOME = { left: 12, top: 44 };

/**
 * A board mounted as a session's tab (sessions.md §4.1, §8): the session's header parts and strip
 * replace the board's title and Share, and its undo is the page's one history (§7.2). With
 * `via`, the board is opened through the tab's grant; without, through this device's own link.
 */
/** A toast's button; `live` false hides it (its step is no longer the newest). */
interface ToastAction {
  label: string;
  run: () => void;
  live?: () => boolean;
}

export interface InSession {
  via?: Via;
  history: UndoHistory;
  /** The join card shows once per session, not once per tab. */
  joinKey: string;
  title: () => JSX.Element;
  share: () => JSX.Element;
  strip: () => JSX.Element;
  /** The session's role: Share (its own) is the main action, else Clone (spec §4b). */
  canEdit: () => boolean;
}

export function Board(p: { board: string; token: string; art: Art; session?: InSession }) {
  // Fixed for the mount: another tab, or another credential, is a new mount (SessionView).
  const inSession = p.session;
  const via = inSession?.via;
  const history = inSession?.history;
  const state = createBoardState(p.board, p.token, { ...(via ? { via } : {}), ...(history ? { onEdit: () => history.edited(p.board) } : {}) });
  if (history) onCleanup(history.attach(p.board, { canUndo: () => state.canUndo(), canRedo: () => state.canRedo(), undo: () => state.undo(), redo: () => state.redo() }));
  const undo = () => (history ? void history.undo() : state.undo());
  const redo = () => (history ? void history.redo() : state.redo());
  const canUndo = () => (history ? history.canUndo() : state.canUndo());
  const canRedo = () => (history ? history.canRedo() : state.canRedo());
  const joinKey = inSession?.joinKey ?? p.board;
  const [me, setMe] = createSignal<Me | undefined>(loadMe());
  const [joined, setJoined] = createSignal(hasJoined(joinKey) && !!loadMe());
  const [viewpoint, setViewpoint] = createSignal<Viewpoint>("amber");
  const [sceneId, setSceneId] = createSignal<RecordId | undefined>();
  const [sideTab, setSideTab] = createSignal<"events" | "notes">("events");
  const [tool, setTool] = createSignal<Tool>("select");
  // The palette colour for Draw, Arrow, Comment and Laser: per person, per board.
  const [ink, setInkSignal] = createSignal(loadColour(p.board) ?? loadMe()?.color ?? 1);
  const setInk = (i: number) => {
    setInkSignal(i);
    saveColour(p.board, i);
  };
  const [toast, setToast] = createSignal<{ text: string; action?: ToastAction }>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string, action?: ToastAction) => {
    setToast(action ? { text, action } : { text });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 6000);
  };
  onCleanup(() => clearTimeout(toastTimer));
  const [overlay, setOverlay] = createSignal<SVGSVGElement>();
  const [dialog, setDialog] = createSignal<"share" | "clone">();
  // ---- Player (spec §6b): a board with a match opens on it; its preview drives the map ----
  const player = createPlayerHost(p.board, p.token, via);
  onMount(() => void player.init());
  const inPlayer = () => player.mode() === "player";
  /** The match open in Player, for the feedback form (spec §11a); none in sandbox. */
  const feedbackMatch = () => feedbackMatchOf(inPlayer(), player.matchId(), player.tl(), player.t());
  // Player draws the match alone, an empty map while there's no timeline (review finding 7).
  const matchPreview = createMemo<MatchPreview | undefined>(() => (inPlayer() ? player.preview(p.art.model.markers) : undefined));
  const liveScene = liveLayer(state, player, p.board, inPlayer);
  /** Where annotation goes: the scene, or in Player the match's live layer, never a fallback. */
  const annScene = () => (inPlayer() ? liveScene() : scene()?.id);
  // Problems the session reports: rejections show in the save status until dismissed; local
  // refusals (nothing to undo, couldn't save locally) are a toast.
  const [seenProblems, setSeenProblems] = createSignal(0);
  let toasted = 0;
  const rejected = createMemo(() => {
    const ps = state.problems().slice(seenProblems());
    for (let i = ps.length - 1; i >= 0; i--) {
      const r = rejection(ps[i]!);
      if (r) return r;
    }
    return undefined;
  });
  createEffect(() => {
    const ps = state.problems();
    for (const pr of ps.slice(toasted)) if (!rejection(pr) && !pr.startsWith("protocol error")) say(pr[0]!.toUpperCase() + pr.slice(1).split(":")[0]!);
    toasted = ps.length;
  });
  const [justCloned, setJustCloned] = createSignal(sessionStorage.getItem(JUST_CLONED) === p.board);
  if (justCloned()) sessionStorage.removeItem(JUST_CLONED);

  const scene = createMemo(() => {
    const all = state.scenes();
    return all.find((s) => s.id === sceneId()) ?? all[0];
  });

  // ---- view and follow (spec §8): following mirrors a presenter's scene and viewport; any
  // change you make to what you see stops it, and following again is one click ----
  const [view, setView] = createSignal<ViewRect>(FIT);
  const [following, setFollowing] = createSignal<number | undefined>();
  // Whom the follow is on, by seat as well as peer id: peer ids are per connection, so after a
  // reconnect (a server restart: every deploy) the presenter is found again by seat (spec §8).
  let target: FollowTarget | undefined;
  /** The presenter's presence: live, or the last seen while waiting for them to come back. */
  const [followedNow, setFollowedNow] = createSignal<PeerPresence | undefined>();
  const followed = () => (following() === undefined ? undefined : followedNow());
  /** Looks for a presenter who's away again when its wait ends. */
  const [recheck, setRecheck] = createSignal(0);
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(recheckTimer));
  /** The join the followed peer id is from: on an earlier one, the id names nobody now. */
  const [followJoin, setFollowJoin] = createSignal(0);
  /** The followed peer, while its id is from this join (the people list and presenters). */
  const followingHere = () => (followJoin() === state.joined().n ? following() : undefined);
  /** What our presence last said we follow, so it's sent on change only. */
  let told: number | null = null;
  const tell = (peer: number | null) => {
    if (told === peer) return;
    told = peer;
    state.presence({ following: peer });
  };
  const nameOfPeer = (x: PeerPresence | undefined) => x?.state?.name || "them";
  /** `was`: their presence when last seen ("Follow again"), shown while they're looked for. */
  const follow = (peer: number, seat?: number, was?: PeerPresence) => {
    const joins = state.joined().n;
    const begun = startFollow(peer, seat, state.peerList(), joins);
    target = begun.target;
    setFollowJoin(joins);
    setFollowedNow(begun.seen ?? was);
    setFollowing(peer);
    // Not `peer` if that id is someone else now: the effect below says whom, once found.
    tell(begun.seen ? peer : null);
    setToast(undefined);
  };
  /** `why`: your own change stopped it, and you keep what you were seeing with it (operator
   * 2026-11-11); none (the Stop button): your own layers and Vision come back. */
  const stopFollowing = (why?: string) => {
    const was = followed();
    if (following() === undefined) return;
    target = undefined;
    setFollowing(undefined);
    player.forget(why ? "keep" : "restore");
    tell(null);
    if (why && was) say(`Stopped following ${nameOfPeer(was)}`, { label: "Follow again", run: () => follow(was.peer, was.state?.seat, was) });
  };
  createEffect(() => {
    recheck();
    const f = following();
    if (f === undefined || !target) return;
    const now = Date.now();
    const at = locate(target, state.peerList(), state.myPeer(), state.joined(), now);
    if (at.kind === "gone") {
      target = undefined;
      setFollowing(undefined);
      player.forget("restore");
      tell(null);
      say("Presenter left");
      return;
    }
    if (at.kind === "wait") {
      // Away, maybe reconnecting: keep showing what they showed, and look again at the end.
      target.lostAt ??= now;
      // An id from an earlier join may be someone else's now: say we follow nobody meanwhile.
      if (target.joins !== state.joined().n) tell(null);
      clearTimeout(recheckTimer);
      recheckTimer = setTimeout(() => setRecheck((n) => n + 1), at.until - now + 1);
      return;
    }
    const x = at.peer;
    const joins = state.joined().n;
    target = { peer: x.peer, seat: x.state?.seat ?? target.seat, joins };
    setFollowJoin(joins);
    setFollowedNow(x);
    tell(x.peer);
    if (x.peer !== f) {
      // Found again on another connection: follow it there (the effect runs again on it).
      setFollowing(x.peer);
      return;
    }
    const s = x.state!;
    // A presenter in Player is on the live layer, which isn't a scene to flip to.
    if (s.scene && s.scene !== sceneId() && state.scenes().some((x) => x.id === s.scene)) setSceneId(s.scene);
    // The presenter's side too: their map turned the same way (older peers: Amber).
    const side = sideOf(s.view);
    if (side && side !== viewpoint()) setViewpoint(side);
    setView(fromViewport(s.view, side ?? viewpoint()));
    // Player too: the presenter's mode, match and playback (spec §6b), and the registry's view
    // state (map layers, Vision, panels, events filters).
    player.mirror(s);
  });
  // A change of your own to a view-state key that stops following (the registry's `stop`
  // keys: the map layers, Vision) stops it here.
  player.onStop(() => stopFollowing("changed map view"));
  createEffect(() => state.presence({ view: toViewport(view(), viewpoint()) }));
  createEffect(() => state.presence({ layers: player.layersWire() }));
  playbackPresence(player, (playback) => state.presence(playback ? { playback } : ({ playback: undefined } as never)));
  // The map's hover label (spec §8): yours goes out as a key alone; a presenter's shows here,
  // in their colour, worded from this board's own state (yours wins while you hover).
  createEffect(() => state.presence({ hover: hoverWire(localHover()) }));
  createEffect(() => {
    const x = followed();
    const r = hoverFromWire(x?.state?.hover);
    setRemoteHover(r && x ? { ref: r, name: x.state!.name || "them", color: colorOf(x.state!.color) } : undefined);
  });
  onCleanup(() => setRemoteHover(undefined));
  /** Your own flip changes what you see, so it stops following; you keep the side you chose. */
  const flipSide = () => {
    stopFollowing("flipped");
    setViewpoint(viewpoint() === "amber" ? "sapphire" : "amber");
  };
  /** Picking a scene shows it: in Player that means Sandbox, on that scene (review: scenes
   * picked in Player never showed). Followers follow, as they follow the mode. */
  const pickScene = (id: RecordId) => {
    if (inPlayer()) player.setMode("sandbox");
    userFlip(id);
  };
  /** A scene saved from the replay: shown (its drawings moved into it), with a toast to go back. */
  const savedScene = (id: RecordId) => {
    pickScene(id);
    const n = state.scenes().findIndex((s) => s.id === id) + 1;
    say(n ? `Saved scene ${n}` : "Scene saved", {
      label: "Back to replay",
      run: () => {
        stopFollowing("changed the playback");
        player.setMode("player");
      },
    });
  };
  const userFlip = (id: RecordId) => {
    if (id !== scene()?.id) stopFollowing("flipped the scene");
    setSceneId(id);
  };
  const userView = (v: ViewRect, why: string) => {
    cancelAnimationFrame(gliding);
    stopFollowing(why);
    setView(clampView(v));
  };
  /** Glide the view to `to` (an ease-out over GLIDE_MS); any pan or zoom of yours cuts it. */
  const GLIDE_MS = 360;
  let gliding = 0;
  const glideView = (to: ViewRect) => {
    cancelAnimationFrame(gliding);
    const from = view();
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / GLIDE_MS);
      const e = 1 - (1 - k) ** 3;
      setView(clampView({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, w: from.w + (to.w - from.w) * e }));
      if (k < 1) gliding = requestAnimationFrame(step);
    };
    gliding = requestAnimationFrame(step);
  };
  onCleanup(() => cancelAnimationFrame(gliding));

  // ---- hero focus (operator, 2026-11-09: "when I click on a hero, it should focus them"): a
  // click on a hero's portrait (either top bar) pans a zoomed-in view to
  // centre it, pings its spot (everyone sees the ping), and flashes its token. Following
  // someone, the view stays theirs: only the ping and the flash. A hero with nowhere on the
  // map (not placed; in Player, dead or not in the match at t) gets nothing. ----
  /** Where a roster slot's hero stands now: in Player the match at t, else the scene's token. */
  const heroAt = (team: string, n: number): WorldPos | undefined => {
    if (inPlayer()) return matchPreview()?.players.get(slotKey(team, n))?.pos ?? undefined;
    const s = state.roster().find((x) => x.slot.team === team && x.slot.slot === n);
    const pl = s && state.playersIn(scene()?.id).find((x) => x.state.slot === s.id);
    return pl?.state.placed ? pl.state.pos : undefined;
  };
  let pingAt: ((w: WorldPos) => void) | undefined;
  // The top bar's hero menu, opened from a token on the map too (feedback #53); unset in Player.
  let heroMenu: ((player: RecordId, at: { x: number; y: number }) => void) | undefined;
  const [focused, setFocused] = createSignal<{ slot: string; n: number }>();
  let focusN = 0;
  let unflash: ReturnType<typeof setTimeout> | undefined;
  const focusHero = (team: string, n: number) => {
    const w = heroAt(team, n);
    if (!w) return;
    const v = view();
    if (following() === undefined && v.w < FIT_VIEW.w - 0.5) {
      const c = worldToView(w, viewpoint());
      glideView({ x: c.x - v.w / 2, y: c.y - v.w / 2, w: v.w });
    }
    pingAt?.(w);
    setFocused({ slot: `${team}-${n}`, n: ++focusN });
    clearTimeout(unflash);
    unflash = setTimeout(() => setFocused(undefined), 1200);
  };
  onCleanup(() => clearTimeout(unflash));
  /** A build-order row: the replay to that moment, as a scrub does (following stops). */
  const seekMatch = (t: number) => {
    stopFollowing("changed the playback");
    player.control.seek(t);
  };
  /** The death recap opened from a skull on the map (SkullRecap.tsx): the host's, so followers
   * open it too; gone with the match. */
  const skullRecap = player.skullRecap;
  const setSkullRecap = player.setSkullRecap;
  /** The hero panels opened from tokens on the map (HeroCard.tsx, #37): the host's, so followers
   * open and place them too; gone with the match. In the page by slot, so bringing one to the
   * front (its z-index) never moves it in the DOM mid-press; back to front in the host's list. */
  // Only those with a player in the match: a slot it hasn't (a presenter's from a newer client)
  // has no panel, so it neither takes Escape nor keeps the recap from it.
  const heroesShown = createMemo(() => player.heroPanels().filter((h) => player.tl()?.players.some((q) => slotKey(q.team, q.slot) === h.slot)));
  const heroSlots = createMemo(() => heroesShown().map((h) => h.slot).sort(), undefined, { equals: (a, b) => a.join() === b.join() });
  const heroPanel = (slot: string) => player.heroPanels().find((h) => h.slot === slot);
  const heroZ = (slot: string) => 8 + Math.max(0, heroesShown().findIndex((h) => h.slot === slot));
  const openHero = (team: string, slot: number, token?: Element) => {
    // The pane the panels are placed in: the board area on a desktop (#40), the map on a phone.
    const el = boardEl?.isConnected ? boardEl : mapEl;
    const measure = () => (el && paneOf(el, el.parentElement?.querySelectorAll(".map-controls > *") ?? [])) || { w: 1, h: 1, top: 0, bottom: 0 };
    const key = slotKey(team, slot);
    // On a desktop, a new panel opens beside the token clicked (#48); on a phone (and one open
    // already, which only comes to the front), a step from the last.
    if (!token || !el || el !== boardEl || player.heroPanels().some((h) => h.slot === key)) {
      player.openHeroPanel(key, opening(player.heroPanels().map((h) => h.at), measure()));
      return;
    }
    const cards = () => [...el.querySelectorAll<HTMLElement>(".hero-panel")];
    const besideToken = (w: number, h: number) => {
      const pane = measure();
      const at = el.getBoundingClientRect();
      const t = token.getBoundingClientRect();
      const open = cards().filter((c) => c.dataset.slot !== key).map((c) => {
        const r = c.getBoundingClientRect();
        return { left: r.left - at.left, top: r.top - at.top };
      });
      return placeOf(beside({ left: t.left - at.left, top: t.top - at.top, right: t.right - at.left, bottom: t.bottom - at.top }, w, h, pane, open), w, h, pane);
    };
    // Its size is known once it is in: open it the size of another (or about a panel's), then
    // on the next frame, unless it was moved meanwhile, put it beside the token at its own size.
    const like = cards()[0]?.getBoundingClientRect();
    const first = besideToken(like?.width ?? 256, like?.height ?? 360);
    player.openHeroPanel(key, first);
    const same = (a: Place | undefined, b: Place | undefined) => JSON.stringify(placeToWire(a) ?? null) === JSON.stringify(placeToWire(b) ?? null);
    requestAnimationFrame(() => {
      const card = cards().find((c) => c.dataset.slot === key);
      if (!card || !token.isConnected || !same(player.heroPanels().find((h) => h.slot === key)?.at, first)) return;
      const r = card.getBoundingClientRect();
      const at = besideToken(r.width, r.height);
      if (!same(at, first)) player.placeHeroPanel(key, at);
    });
  };
  const hasRecap = (slot: string, t: number) => !!recapOf(player.tl()?.players.find((q) => slotKey(q.team, q.slot) === slot), t);
  /** In a scene, the open match's in-game name for a slot (spec §6b "Names"); a typed one wins. */
  const matchName = (team: string, n: number) => sceneMatchName(player.tl(), scene()?.scene.source, player.playerName, team, n);
  const presenterList = createMemo(() => presenters(state.peerList(), state.myPeer(), followingHere()));
  const followersOf = (peer: number | undefined) =>
    peer === undefined ? 0 : state.peerList().filter((x) => x.state?.following === peer).length;
  const sceneLabel = (id: RecordId | null | undefined) => {
    const i = state.scenes().findIndex((x) => x.id === id);
    return i < 0 ? "" : `scene ${i + 1}/${state.scenes().length}`;
  };
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey && !e.altKey && following() === undefined) {
        const lead = presenterList()[0];
        if (lead) follow(lead.peer.peer);
      }
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });

  onMount(() => {
    const m = me();
    if (m && joined()) state.presence({ name: m.name, color: m.color });
    void state.start();
  });
  onCleanup(() => state.stop());
  // Unmounted (another board, or back to the landing): module state goes back to its defaults.
  onCleanup(resetBoardModules);

  createEffect(() => {
    // In Player, presence is on the live layer, so cursors, lasers, pings and ink in progress
    // show to the others in Player (review finding 3).
    const s = annScene();
    state.presence({ scene: s ?? null });
  });
  // The tab's title is this board's while it's mounted: until its meta arrives, and after it
  // leaves (the landing, another board, a dead link), the page's own.
  document.title = PAGE_TITLE;
  onCleanup(() => (document.title = PAGE_TITLE));
  // "Your boards" keeps the current title (a rename here or by anyone else), the match on the
  // board, and whether this link can edit (the list's Rename).
  createEffect(() => {
    const t = state.title();
    if (t) {
      document.title = `${t} · mapcro`;
      // A tab opened through the session isn't this device's link: Your boards lists only links
      // the device holds (§7.3).
      if (via) return;
      const r = state.role();
      const m = player.matchId();
      rememberBoard({ board: p.board, token: p.token, title: t, ...(m ? { match: m } : {}), ...(r ? { edit: state.canEdit() } : {}) });
    }
  });
  // The board's title, renamed in the header by an editor: one undoable edit, synced live.
  let openTitle: (() => void) | undefined;
  const renameBoard = (text: string) => {
    const t = text.trim();
    const id = state.metaId();
    if (!t || !id || t === state.title()) return;
    state.edit([{ Set: { id, value: { Title: t } } }]);
  };

  const join = (m: Me) => {
    saveMe(m);
    markJoined(joinKey);
    setMe(m);
    setJoined(true);
    state.presence({ name: m.name, color: m.color });
  };

  const people = () => state.peerList();
  // Clear acts on what's drawn: in Player, the live layer, never the hidden scene (finding 2).
  const inkIds = createMemo(() => state.inScene("Stroke", annScene()).map(([id]) => id));
  const arrowIds = createMemo(() => state.inScene("Arrow", annScene()).map(([id]) => id));
  const commentIds = createMemo(() => state.inScene("Callout", annScene()).map(([id]) => id));
  const clearIds = (what: ClearKind) =>
    what === "ink" ? inkIds() : what === "arrows" ? arrowIds() : what === "comments" ? commentIds() : [...inkIds(), ...arrowIds(), ...commentIds()];
  /** The schema's cap on ops per transaction (`LIMITS.max_ops_per_tx`). */
  const MAX_OPS_PER_TX = LIMITS.max_ops_per_tx;
  const CLEARED: Record<ClearKind, string> = { ink: "Ink cleared", arrows: "Arrows cleared", comments: "Comments cleared", all: "Scene cleared" };
  const objectives = createMemo(() => {
    const m = new Map<string, { id: RecordId; status: ObjectiveStatus }>();
    for (const [id, r] of state.inScene("ObjectiveState", scene()?.id))
      if ("ObjectiveState" in r) m.set(r.ObjectiveState.key, { id, status: r.ObjectiveState.status });
    return m;
  });
  // ---- Select: selected heroes, Space to pan, lane splits ----
  const [selection, setSelection] = createSignal<Set<RecordId>>(new Set());
  // ---- comments: bubbles by default; your open one (presence `focus`, so followers see it
  // open too), or all of them with the Comments toggle (per board, on this device) ----
  const [openComment, setOpenComment] = createSignal<RecordId>();
  const [allOpen, setAllOpen] = createSignal(commentsOpen(p.board));
  // The healing pickups (the Heals toggle): this browser's, or a followed presenter's.
  const heals = player.showHeals;
  // The tough crates, likewise (the Heavy boxes toggle).
  const crates = player.showCrates;
  createEffect(() => state.presence({ focus: openComment() ?? null }));
  const followFocus = () => followed()?.state?.focus ?? undefined;
  const isOpen = (id: RecordId) => allOpen() || openComment() === id || followFocus() === id;
  // Objectives selected as a group, by key; others see whose (presence `picked`).
  const [objSelection, setObjSelection] = createSignal<Set<string>>(new Set());
  createEffect(() => state.presence({ picked: [...objSelection()] }));
  const [spaceHeld, setSpaceHeld] = createSignal(false);
  // Selections belong to a scene: flipping clears them. (Keyed on the scene's id: the scene
  // object itself is rebuilt on every edit, which once cleared the selection after each toggle.)
  const sceneKey = createMemo(() => scene()?.id);
  createEffect(() => {
    sceneKey();
    setSelection(new Set<RecordId>());
    setObjSelection(new Set<string>());
  });
  /** Give up the keyboard focus a control holds, so the board's own keys work (operator,
   * 2026-11-08). The page itself, or nothing, keeps it. */
  const leaveControl = () => {
    const f = document.activeElement;
    if (f instanceof HTMLElement && f !== document.body) f.blur();
  };
  onMount(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    };
    const kd = (e: KeyboardEvent) => {
      // Escape leaves whatever control has the focus (a text field, the speed list, a slider, a
      // button), so the board's keys work again at once (operator, 2026-11-08).
      if (e.key === "Escape") leaveControl();
      if (typing(e)) return;
      if (e.key === "Escape") {
        setOpenComment(undefined);
        setSelection(new Set<RecordId>());
        setObjSelection(new Set<string>());
      }
      if (e.code === "Space") {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const ku = (e: KeyboardEvent) => e.code === "Space" && setSpaceHeld(false);
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", kd);
    window.addEventListener("keyup", ku);
    window.addEventListener("blur", blur);
    onCleanup(() => {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
    });
  });
  const waves = createMemo(() => {
    const m = new Map<string, { id: RecordId; t: number }>();
    for (const [id, r] of state.inScene("Wave", scene()?.id)) if ("Wave" in r) m.set(r.Wave.lane, { id, t: r.Wave.t });
    return m;
  });
  const [waveDrag, setWaveDrag] = createSignal<{ key: string; t: number; id: RecordId }>();
  /** Others' live split drags, by lane: a known wave's id, or a new one matched by position. */
  const remoteWaves = createMemo(() => {
    const m = new Map<string, number>();
    const byId = new Map([...waves()].map(([k, w]) => [w.id, k]));
    for (const x of state.peerList()) {
      const d = x.state?.drag;
      if (!d || x.state?.scene !== scene()?.id) continue;
      const at = worldToMap(d.pos);
      for (const l of p.art.model.lanes) {
        const q = project(l.line, at);
        if (byId.get(d.id) === l.key || (!state.records[d.id] && q.dist < 4)) m.set(l.key, q.t);
      }
    }
    return m;
  });
  /** Others' splits, gliding between presence updates like their tokens (render only). */
  const remoteSmooth = createMemo(() => {
    const m = new Map<string, () => number | undefined>();
    for (const l of p.art.model.lanes) {
      const at = smoothed(() => {
        const t = remoteWaves().get(l.key);
        return t === undefined ? undefined : { x: t, y: 0 };
      });
      m.set(l.key, () => at()?.x);
    }
    return m;
  });
  /** Player, replay tier: each lane's zipline colours, easing to each second's edges (changing
   *  values ease, spec §4a). In the map's own units, so a zoom isn't eased. */
  const laneEdges = createMemo(() => {
    const m = new Map<string, () => { amber: number; sapphire: number } | undefined>();
    for (const l of p.art.model.lanes) {
      const amber = easedNumber(() => matchPreview()?.lanes.get(l.key)?.amber);
      const sapphire = easedNumber(() => matchPreview()?.lanes.get(l.key)?.sapphire);
      m.set(l.key, () => {
        const a = amber();
        const s = sapphire();
        return a == null || s == null ? undefined : { amber: a, sapphire: s };
      });
    }
    return m;
  });
  const splitOf = (key: string) => {
    const mine = waveDrag();
    if (mine?.key === key) return mine.t;
    const lane = p.art.model.lanes.find((l) => l.key === key);
    // Player shows only the match's lanes (replay tier: the zipline colours, drawn by `laneEdges`;
    // this is their gap's middle), never the scene's (spec §6b).
    const pv = matchPreview();
    const edges = pv?.lanes.get(key);
    if (pv) return edges ? (edges.amber + edges.sapphire) / 2 : lane ? defaultSplit(lane.line) : 500;
    return remoteSmooth().get(key)?.() ?? waves().get(key)?.t ?? (lane ? defaultSplit(lane.line) : 500);
  };

  // ---- a board this device just made gets twelve random heroes, once ----
  const [heroPick, setHeroPick] = createSignal<RecordId>();
  createEffect(() => {
    if (sessionStorage.getItem(FRESH_BOARD) !== p.board || state.role() !== "owner" || state.roster().length !== 12) return;
    sessionStorage.removeItem(FRESH_BOARD);
    const ops = randomRosterOps(state.roster(), [...p.art.heroes.values()]);
    if (ops.length) state.edit(ops);
  });

  const heroList = createMemo(() => [...p.art.heroes.values()].sort((a, b) => a.name.localeCompare(b.name)));
  /** Heroes held by other slots than `slot`, with who holds them: a hero is unique in a match. */
  const takenBy = (slot: RecordId | undefined) =>
    new Map(
      state
        .roster()
        .filter((s) => s.id !== slot && s.slot.hero != null)
        .map((s) => [s.slot.hero!, `${rosterTeamName(s.slot.team)} ${s.slot.name || `Player ${s.slot.slot + 1}`}`] as const),
    );
  const sceneIndex = () => state.scenes().findIndex((s) => s.id === scene()?.id);

  // ---- the phone layout (design/v1-board/phone-following.html) below 700 px ----
  // Phones, and touch-first tablets up to 1400 px; mouse-first screens keep the desktop layout.
  const mq = window.matchMedia("(max-width: 700px), (pointer: coarse) and (max-width: 1400px)");
  const [phoneEdit, setPhoneEdit] = createSignal(false);
  /** The phone's one open sheet besides a build (a build is the host's, and follows). */
  const [phoneSheet, setPhoneSheet] = createSignal<"events" | "layers" | "more">();
  // Landscape docks a panel beside the map: Events, unless a build or another sheet is open.
  const wide = window.matchMedia("(orientation: landscape)");
  const [landscape, setLandscape] = createSignal(wide.matches);
  const onWide = () => setLandscape(wide.matches);
  wide.addEventListener("change", onWide);
  onCleanup(() => wide.removeEventListener("change", onWide));
  const docked = () => !phoneSheet() && landscape() && !player.openBuild() && !player.allBuilds() && !player.tabHeld();
  const sheet = () => phoneSheet() ?? (docked() ? "events" : undefined);
  const phoneEvents = () => sheet() === "events";
  const openSheet = (k: "events" | "layers" | "more") => {
    if (phoneSheet() === k) return setPhoneSheet(undefined);
    setPhoneSheet(k);
    if (player.openBuild()) player.setOpenBuild(undefined);
    if (player.allBuilds()) player.setAllBuilds(false);
  };
  // Landscape's Build tab reopens the last build looked at (personal layout state).
  const [lastBuild, setLastBuild] = createSignal<string>();
  createEffect(() => { const b = player.openBuild(); if (b) setLastBuild(b); });
  /** Landscape's dock tab: Events (the default), a build, or the scene list. */
  const dockEvents = () => batch(() => {
    setPhoneSheet(undefined);
    if (player.openBuild()) player.setOpenBuild(undefined);
    if (player.allBuilds()) player.setAllBuilds(false);
  });
  const dockBuild = () => batch(() => { setPhoneSheet(undefined); player.setAllBuilds(false); player.setOpenBuild(lastBuild()); });
  // A build opened (a portrait, a token, or following) closes the other sheet: one at a time.
  createEffect(on(() => player.openBuild() || player.allBuilds(), (b) => b && setPhoneSheet(undefined), { defer: true }));
  const [phone, setPhone] = createSignal(mq.matches);
  const onMq = () => setPhone(mq.matches);
  mq.addEventListener("change", onMq);
  onCleanup(() => mq.removeEventListener("change", onMq));
  // Sheets sit on the transport (one row or two, by orientation) and stop at the roster: live.
  let phoneEl: HTMLDivElement | undefined;
  createEffect(() => {
    if (!phone() || !(inPlayer() || player.matchId())) return;
    landscape();
    let ro: ResizeObserver | undefined;
    const frame = requestAnimationFrame(() => {
      const bar = phoneEl?.querySelector<HTMLElement>(".pl-bar");
      if (!bar || !phoneEl) return;
      const root = phoneEl;
      // The sheets stop at the roster's foot, so a second portrait swaps the hero in place.
      const roster = root.querySelector<HTMLElement>(".phone-roster");
      // On the root element: the game tooltip floats outside the board.
      const html = document.documentElement.style;
      ro = new ResizeObserver(() => {
        html.setProperty("--transport-h", `${bar.offsetHeight}px`);
        // Landscape: under the dock's tab row.
        const foot = root.querySelector<HTMLElement>(".p-dock-tabs") ?? roster;
        if (foot) html.setProperty("--sheet-top", `${Math.round(foot.getBoundingClientRect().bottom)}px`);
      });
      ro.observe(bar);
      if (roster) ro.observe(roster);
      const tabs = root.querySelector<HTMLElement>(".p-dock-tabs");
      if (tabs) ro.observe(tabs);
    });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      document.documentElement.style.removeProperty("--transport-h");
      document.documentElement.style.removeProperty("--sheet-top");
    });
  });
  createEffect(() => {
    // Viewing keeps editing gestures out of the map.
    if (phone() && !phoneEdit() && tool() !== "select" && tool() !== "laser") setTool("select");
  });

  // Rename from "Your boards": the title's editor opens once the board can take the edit. A
  // link that turns out view-only drops the ask.
  const [renameAsked, setRenameAsked] = createSignal(takeRename(p.board));
  createEffect(() => {
    if (!renameAsked() || !state.role()) return;
    if (!state.canEdit()) return setRenameAsked(false);
    if (!joined() || !state.metaId() || phone()) return;
    setRenameAsked(false);
    queueMicrotask(() => openTitle?.());
  });

  // ---- the scene note: free text, one per scene ----
  const note = createMemo(() => {
    const n = state.inScene("Note", scene()?.id)[0];
    return n && "Note" in n[1] ? { id: n[0], text: n[1].Note.text } : undefined;
  });
  // Two people in one note: last writer wins on blur, as before, but an incoming save no longer
  // replaces what you've typed and not saved yet. Presence `focus` says who is in it: the note,
  // or the board record while the scene has no note yet.
  const noteFocus = () => note()?.id ?? state.metaId() ?? null;
  const [noteDraft, setNoteDraft] = createSignal<string>();
  createEffect(on(() => scene()?.id, () => setNoteDraft(undefined), { defer: true }));
  const noteEditors = createMemo(() => {
    const s = scene()?.id;
    const ids = new Set([note()?.id, state.metaId()].filter(Boolean));
    return state.peerList().filter((x) => {
      const f = x.state?.focus;
      return x.state?.scene === s && f != null && ids.has(f);
    });
  });
  const saveNote = (text: string) => {
    const s = scene();
    const n = note();
    if (!s || text === (n?.text ?? "")) return;
    if (n) state.edit([{ Set: { id: n.id, value: { NoteText: text } } }]);
    else if (text.trim()) state.edit([{ Create: { id: newRecordId(), record: { Note: { scene: s.id, text } } } }]);
  };
  const calloutList = createMemo(() => calloutOrder(state.rowsIn<Callout>("Callout", scene()?.id)));

  const [sceneDrawer, setSceneDrawer] = createSignal(false);
  /** This tab is from another build than the server's (see core/reload.ts). */
  const outdated = () => {
    const c = state.connection();
    return c.kind === "closed" && c.reason === "outdated";
  };
  const flipBy = (d: number) => {
    const all = state.scenes();
    const next = all[sceneIndex() + d];
    if (next) pickScene(next.id);
  };
  const swipe = (e: PointerEvent) => {
    const x0 = e.clientX;
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointerup", up);
      const dx = ev.clientX - x0;
      if (Math.abs(dx) > 60) flipBy(dx < 0 ? 1 : -1);
    };
    window.addEventListener("pointerup", up);
  };

  const followChip = () => (
      <Show
      when={followed()}
      fallback={
        <Show when={presenterList()[0]}>
          {(lead) => (
            <div class="p-follow off" data-testid="follow-chip">
              <span>
                <b>{lead().peer.state?.name || "Someone"}</b> is presenting
              </span>
              <span class="where">{sceneLabel(lead().peer.state?.scene)}</span>
              <button class="go" data-testid="follow-presenter" onClick={() => follow(lead().peer.peer)}>
                Follow
              </button>
            </div>
          )}
        </Show>
      }
    >
      {(f) => (
        <div class="p-follow" data-testid="follow-chip">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={'<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'} />
          <span>
            <b>Following {f().state?.name || "them"}</b>
          </span>
          <span class="where">{sceneLabel(f().state?.scene)}</span>
          <button data-testid="stop-following" onClick={() => stopFollowing()}>
            Stop
          </button>
        </div>
      )}
    </Show>
  );
  /** Player's phone transport, row 2's end: Events, Map layers, More; or the tool rail. */
  const rail = () => phoneEdit() || tool() === "laser";
  const phoneTail = () => (
    <Show when={!rail()} fallback={
      <div class="p-rail" role="toolbar" aria-label="Tools">
        <div class="p-rail-tools">
        <button class={cx("btn ghost", tool() === "select" && "on")} data-testid="tool-select" onClick={() => setTool("select")}>Look</button>
        <button class={cx("btn ghost", tool() === "laser" && "on")} data-testid="tool-laser" onClick={() => setTool("laser")}>Laser</button>
        <Show when={state.canEdit() && phoneEdit()}>
          <For each={["draw", "arrow", "erase"] as const}>{t =>
            <button class={cx("btn ghost", tool() === t && "on")} data-testid={`tool-${t}`} onClick={() => setTool(t)}>{t === "draw" ? "Draw" : t === "arrow" ? "Arrow" : "Erase"}</button>
          }</For>
          <button class="btn ghost" data-testid="phone-undo" onClick={undo}>Undo</button>
          <button class="btn ghost" data-testid="phone-redo" onClick={redo}>Redo</button>
        </Show>
        </div>
        {/* Pinned outside the scrolling tools: the ink and the way out are always on screen. */}
        <Show when={state.canEdit() && phoneEdit()}><Palette value={ink()} set={setInk} /></Show>
        <button class="btn ghost" data-testid="phone-done" onClick={() => { setPhoneEdit(false); setTool("select"); }}>Done</button>
      </div>
    }>
      <div class="p-tail">
        <button class="btn ghost" data-testid="phone-events" aria-expanded={sheet() === "events"} onClick={() => openSheet("events")}>Events</button>
        <button class="btn ghost" data-testid="phone-layers" aria-expanded={phoneSheet() === "layers"} onClick={() => openSheet("layers")}>Map layers</button>
        <button class="btn ghost" data-testid="phone-more" aria-label="More" aria-expanded={phoneSheet() === "more"} onClick={() => openSheet("more")}>⋯</button>
      </div>
    </Show>
  );
  /** A phone sheet: edge to edge on the transport, a title and a close. */
  const PhoneSheet = (q: { title: string; testid: string; children: JSX.Element }) => (
    <section class="p-sheet" data-testid={q.testid} aria-label={q.title}>
      <header class="p-sheet-head">
        <b>{q.title}</b>
        <Show when={!docked()}>
          <button class="btn ghost" data-testid="p-sheet-close" aria-label="Close" onClick={() => setPhoneSheet(undefined)}>×</button>
        </Show>
      </header>
      <div class="p-sheet-body">{q.children}</div>
    </section>
  );
  const PlayerSheets = () => (
    <>
      <Show when={landscape()}>
        <nav class="p-dock-tabs" role="tablist" aria-label="Panel">
          <button class="btn ghost" role="tab" data-testid="dock-events" aria-selected={sheet() === "events"} onClick={dockEvents}>Events</button>
          <button class="btn ghost" role="tab" data-testid="dock-build" aria-selected={!!player.openBuild()} disabled={!lastBuild()} onClick={dockBuild}>Build</button>
          <button class="btn ghost" role="tab" data-testid="dock-scenes" aria-selected={sceneDrawer()} onClick={() => setSceneDrawer(true)}>Scenes</button>
          {/* Tab's stand-in on a tablet: the same all-builds state as the roster's toggle. */}
          <button class="btn ghost phone-all" data-testid="dock-all-builds" aria-pressed={player.allBuilds() || player.tabHeld()}
            onClick={() => batch(() => { setPhoneSheet(undefined); player.setOpenBuild(undefined); player.setAllBuilds(!player.allBuilds()); player.setBuildPopover("none"); })}>All builds</button>
        </nav>
      </Show>
      <Show when={sheet() === "events"}>
        <PhoneSheet title="Events" testid="phone-events-sheet">
          <PlayerSide host={player} state={state} art={p.art} scene={scene()} mint={newRecordId} onSaved={savedScene} onUserPlayback={() => stopFollowing("changed the playback")} />
        </PhoneSheet>
      </Show>
      <Show when={phoneSheet() === "layers"}>
        <PhoneSheet title="Map layers" testid="phone-layers-sheet">{mapControls()}</PhoneSheet>
      </Show>
      <Show when={phoneSheet() === "more"}>
        <PhoneSheet title="More" testid="phone-more-sheet">
          <div class="p-more">
            <span class="viewonly" data-testid="role-chip">
              {state.canEdit() ? "Can edit" : "View only"} · {teamName(viewpoint() === "sapphire" ? "sapphire" : "amber")} side
            </span>
            <button class="btn ghost" data-testid="phone-match" onClick={() => { setPhoneSheet(undefined); const d = phoneEl?.querySelector<HTMLDetailsElement>(".pl-source"); if (d) d.open = true; }}>Match</button>
            <button class="btn ghost" data-testid="scene-drawer" onClick={() => { setPhoneSheet(undefined); setSceneDrawer(true); }}>Scenes</button>
            <button class="btn ghost" data-testid="phone-laser" onClick={() => { setPhoneSheet(undefined); setTool("laser"); }}>Laser</button>
            <Show when={state.canEdit()}>
              <button class="btn ghost" data-testid="phone-edit" aria-pressed={phoneEdit()} onClick={() => { setPhoneSheet(undefined); setPhoneEdit(true); }}>Edit</button>
            </Show>
            <FeedbackButton variant="bar" match={feedbackMatch} />
          </div>
        </PhoneSheet>
      </Show>
    </>
  );

  const PhoneBoard = () => (
    <div class="phone" ref={phoneEl} classList={{ "phone-player": inPlayer(), "phone-editing": phoneEdit() }} data-testid="board" data-board={p.board} data-layout="phone">
      <header class="p-top">
        <Wordmark />
        <Show when={!inPlayer()}>
          <span class="viewonly" data-testid="role-chip">
            {state.canEdit() ? "Can edit" : "View only"} · {teamName(viewpoint() === "sapphire" ? "sapphire" : "amber")} side
          </span>
        </Show>
        {/* The tier left the Player bar for the header (prototype): the phone's header too. */}
        <Show when={player.matchId()}><TierChip host={player} /></Show>
        {/* Player: the status strip holds the follow pill; the rest is in More. */}
        <Show when={inPlayer()}>{followChip()}</Show>
        <div class="spacer" />
        <SaveStatus state={state} rejected={rejected()} dismiss={() => setSeenProblems(state.problems().length)} />
        <Show when={!inPlayer()}><FeedbackButton variant="bar" match={feedbackMatch} /></Show>
      </header>
      {/* Sessions on a phone are out of scope: the strip shows on the phone board, not in Player's shell. */}
      <Show when={inSession && !inPlayer()}>{inSession!.strip()}</Show>
      <Show when={!inPlayer()}>{followChip()}</Show>
      <Show when={!inPlayer()}><div class="p-title" onPointerDown={swipe}>
        <div class="ord">
          Scene {sceneIndex() + 1} of {state.scenes().length} · {state.title()}
        </div>
        <h1>
          <Show when={scene()?.scene.clock != null}>
            <span class="clock">{formatClock(scene()!.scene.clock)}</span>
          </Show>
          {sceneName(scene()?.scene.name ?? "", sceneIndex())}
        </h1>
      </div>
      </Show>
      <Show when={!inPlayer()} fallback={<PlayerTopBar host={player} state={state} art={p.art} vp={viewpoint()} compact onFocus={focusHero} onSeek={seekMatch} />}>
        <TopBar state={state} host={player} art={p.art} vp={viewpoint()} scene={scene()?.id} compact readOnly onPickHero={setHeroPick} onFocus={focusHero} matchName={matchName} />
      </Show>
      <div class="p-map-wrap">
        <Show when={!inPlayer()}>{mapControls()}</Show>
        {mapBox(true)}
        {/* Not over the join card (it would take the focus from your name). */}
        <Show when={joined()}>
          <ReplayPrompt host={player} art={p.art} />
        </Show>
        <Show when={!inPlayer()}><div class="p-tools" role="toolbar" aria-label="Tools">
          <button class={cx("tb", tool() === "select" && "on")} data-testid="tool-select" onClick={() => setTool("select")}>
            <span>{state.canEdit() && phoneEdit() ? "Select" : "Look"}</span>
          </button>
          <button class={cx("tb", tool() === "laser" && "on")} data-testid="tool-laser" onClick={() => setTool("laser")}>
            <span>Laser</span>
          </button>
          <Show when={state.canEdit()}>
            <button class="tb" data-testid="phone-edit" aria-pressed={phoneEdit()} onClick={() => setPhoneEdit(!phoneEdit())}>Edit</button>
            <Show when={phoneEdit()}>
              <For each={["draw", "arrow", "erase"] as const}>{t =>
                <button class={cx("tb", tool() === t && "on")} data-testid={`tool-${t}`} onClick={() => setTool(t)}>{t === "draw" ? "Draw" : t === "arrow" ? "Arrow" : "Erase"}</button>
              }</For>
              <button class="tb" data-testid="phone-undo" onClick={undo}>Undo</button>
              <button class="tb" data-testid="phone-redo" onClick={redo}>Redo</button>
            </Show>
          </Show>
          <Palette value={ink()} set={setInk} />
        </div></Show>
      </div>
      <Show when={!inPlayer() && calloutList().length > 0}>
        <ol class="p-callouts" data-testid="callout-list">
          <For each={calloutList()}>
            {(c, i) => (
              <li style={c.r.color != null ? { "--comment": colorOf(c.r.color), "--comment-ink": inkOn(colorOf(c.r.color)) } : {}}>
                <b>{i() + 1}</b>
                {c.r.text}
              </li>
            )}
          </For>
        </ol>
      </Show>
      <Show when={!inPlayer() && note()?.text}>
        <p class="p-note" data-testid="scene-note">
          {note()!.text}
        </p>
      </Show>
      {playerBar(phoneTail())}
      <Show when={inPlayer()}><PlayerSheets /></Show>
      <Show when={!inPlayer()}>
      <nav class="p-nav" onPointerDown={swipe}>
        <div class="row">
          <button class="btn" data-testid="p-prev" disabled={sceneIndex() <= 0} onClick={() => flipBy(-1)}>
            Prev
          </button>
          <div class="dots" aria-label={`Scene ${sceneIndex() + 1} of ${state.scenes().length}`}>
            <For each={state.scenes()}>{(x) => <i class={cx(x.id === scene()?.id && "on")} />}</For>
          </div>
          <button class="btn" data-testid="p-next" disabled={sceneIndex() >= state.scenes().length - 1} onClick={() => flipBy(1)}>
            Next
          </button>
        </div>
        <button class="btn ghost p-scenes" data-testid="scene-drawer" onClick={() => setSceneDrawer(true)}>
          Scenes
        </button>
      </nav>
      </Show>
      <Show when={sceneDrawer()}>
        <div class="drawer-scrim" onClick={() => setSceneDrawer(false)} />
        <SceneTree state={state} art={p.art} vp={viewpoint()} board={p.board} current={scene()?.id} onFlip={pickScene} chip={sceneChip} keys={() => !inPlayer()} drawer onClose={() => setSceneDrawer(false)} />
      </Show>
      {toastView()}
    </div>
  );

  // The map's width on screen, so comments can be drawn at screen size.
  const [mapPx, setMapPx] = createSignal(500);
  /** The map pane (on a phone, the panels are placed relative to it). */
  let mapEl: HTMLDivElement | undefined;
  /** The board area round the map on a desktop: the panels are placed relative to it (#40). */
  let boardEl: HTMLDivElement | undefined;
  const measureBoard = (el: HTMLDivElement) => {
    boardEl = el;
    // A press on a panel leaves the focused control, as a press on the map does (the panels
    // were on the map before #40).
    const onPress = (e: PointerEvent) => {
      const panel = (e.target as Element | null)?.closest?.(".hero-panel, .skull-recap");
      if (panel && !panel.contains(document.activeElement)) leaveControl();
    };
    el.addEventListener("pointerdown", onPress, true);
    onCleanup(() => el.removeEventListener("pointerdown", onPress, true));
  };
  const measureMap = (el: HTMLDivElement) => {
    mapEl = el;
    // A press on the map leaves the focused control too (operator, 2026-11-08); capture, so it
    // happens before the map's own handlers, which may stop the event. A field on the map (a
    // callout being written) keeps its focus.
    const onPress = () => {
      if (!el.contains(document.activeElement)) leaveControl();
    };
    el.addEventListener("pointerdown", onPress, true);
    onCleanup(() => el.removeEventListener("pointerdown", onPress, true));
    queueMicrotask(() => setMapPx(el.clientWidth || 500));
    const ro = new ResizeObserver(() => setMapPx(el.clientWidth || 500));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };
  /** Player's transport (desktop and phone), or the way back to it from Sandbox. */
  // On a board with a match the bar never goes: it watches the match, or says which scene is
  // shown and how to get back (spec §6b).
  const playerBar = (tail?: JSX.Element) => (
    <Show when={inPlayer() || player.matchId()} fallback={<PlayerSwitch host={player} state={state} onSwitch={() => stopFollowing("switched to Player")} />}>
      <Player
        host={player}
        state={state}
        art={p.art}
        board={p.board}
        scene={scene()}
        mint={newRecordId}
        onSaved={savedScene}
        onView={(id) => {
          stopFollowing("viewed a scene");
          pickScene(id);
        }}
        onUserPlayback={() => stopFollowing("changed the playback")}
        tail={tail}
      />
    </Show>
  );
  /** A scene saved from the open match: its tree row's chip jumps the match there. */
  const sceneChip = (id: RecordId) => {
    const sc = state.scenes().find((s) => s.id === id)?.scene;
    const src = sc?.source;
    const m = player.matchId();
    if (!src || !m || src.match_id !== Number(m)) return undefined;
    return {
      // The row shows the scene's clock already: the chip repeats the time only if it differs.
      label: sc?.clock === src.t ? "▶" : `▶ ${formatClock(src.t)}`,
      go: () => {
        stopFollowing("changed the playback");
        player.setMode("player");
        player.control.seek(src.t);
      },
    };
  };
  // Each marker's status, health, camp and buff at t: changing when one does, not with every
  // frame's preview (#39).
  const markerKeys = createMemo(() => p.art.model.markers.map((m) => m.key));
  const marks = markerStates(matchPreview, markerKeys, (k) => objectives().get(k)?.status);
  const markerStatus = marks.status;
  const mapControls = () => (<MapControls host={player} heals={heals()} crates={crates()}
              toggleHeals={() => player.setShowHeals(!heals())}
              toggleCrates={() => player.setShowCrates(!crates())}
              flip={flipSide} />);
  /** The death recap and the hero panels (#35, #37): placed relative to the pane they are in
   * (panelPlace.ts `movable`, their offset parent). On a desktop that is the board area round
   * the map, so they move anywhere in it (#40); on a phone, the map pane (it has no room
   * beside it). */
  const panelsView = () => (
          <>
            <Show when={inPlayer() && player.tl() && skullRecap()}>
              {(d) => <SkullRecap death={d()} timeline={player.tl()!} vision={player.vision()} art={p.art} name={player.playerName} onSeek={seekMatch} onClose={() => setSkullRecap(undefined)} place={player.skullPlace()} onPlace={player.setSkullPlace} escape={heroesShown().length === 0} />}
            </Show>
            <Show when={inPlayer() && player.tl()}>
              <For each={heroSlots()}>
                {(slot) => (
                  <HeroCard
                    open={heroCardSlot(slot)}
                    timeline={player.tl()!}
                    t={player.t()}
                    vision={player.vision()}
                    art={p.art}
                    name={player.playerName}
                    onSeek={seekMatch}
                    onClose={() => player.closeHeroPanel(slot)}
                    place={heroPanel(slot)?.at}
                    home={HERO_HOME}
                    onPlace={(at) => player.placeHeroPanel(slot, at)}
                    onPress={() => player.raiseHeroPanel(slot)}
                    z={heroZ(slot)}
                    front={heroesShown().at(-1)?.slot === slot}
                  />
                )}
              </For>
            </Show>
          </>
  );
  const mapBox = (phone: boolean) => (
          <div
            ref={measureMap}
            class={phone ? "p-map" : "mapbox"}
            data-testid="map"
            data-view={`${Math.round(view().x)} ${Math.round(view().y)} ${Math.round(view().w)}`}
            // My presence colour (avatar, cursor): what I select is highlighted in it.
            style={{ "--me": colorOf(me()?.color ?? 0) }}
          >
            <MapView
              art={p.art}
              viewpoint={viewpoint()}
              view={view()}
              live={following() !== undefined}
              overlayRef={setOverlay}
              overlayProps={{ "data-tool": tool(), "data-pan": spaceHeld() ? "on" : undefined, onContextMenu: (e: MouseEvent) => e.preventDefault() } as never}
              overlayClass={!state.canEdit() && "readonly"}
              status={markerStatus}
              // Replay tier, Health on: each objective's icon filled to its health (operator, 2026-11-08).
              health={marks.health}
              waveT={splitOf}
              laneEdges={(k) => laneEdges().get(k)?.()}
              camp={marks.camp}
              buff={marks.buff}
              raisedLane={waveDrag()?.key}
              picked={(k) => objSelection().has(k)}
              showHidden={state.canEdit()}
              heals={heals()}
              crates={crates()}
            >
              <Show when={inPlayer()}>
                <TrooperDots host={player} vp={viewpoint()} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} />
              </Show>
              <Layers
                state={state}
                editing={!phone || phoneEdit()}
                art={p.art}
                vp={viewpoint()}
                // In Player, annotation goes to the live layer (spec §6b).
                scene={annScene()}
                tokenScene={scene()?.id}
                tool={tool()}
                ink={ink()}
                myColor={me()?.color ?? 0}
                bindPing={(f) => (pingAt = f)}
                focused={focused}
                matchName={matchName}
                onOpenHero={openHero}
                onHeroMenu={(id, at) => heroMenu?.(id, at)}
                svg={overlay}
                objectives={objectives}
                k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)}
                selection={selection}
                setSelection={setSelection}
                spaceHeld={spaceHeld}
                showHidden={state.canEdit()}
                waves={waves}
                waveDrag={waveDrag}
                setWaveDrag={setWaveDrag}
                splitOf={splitOf}
                objSelection={objSelection}
                setObjSelection={setObjSelection}
                isOpen={isOpen}
                preview={matchPreview}
                unitsPerPx={() => view().w / (mapPx() * 0.9)}
                visible={view}
                openComment={openComment}
                setOpenComment={setOpenComment}
                compactCallouts={phone}
                onPan={(dx, dy) => userView({ ...view(), x: view().x - dx, y: view().y - dy }, "panned the map")}
                onZoom={(at, factor) => userView(zoomAt(view(), at, factor), "zoomed the map")}
              />
              <Show when={inPlayer()}>
                <RiftRings art={p.art} vp={viewpoint()} preview={matchPreview} mk={Math.min(1, view().w / 1000)} />
                <UrnMark art={p.art} vp={viewpoint()} preview={matchPreview} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} mk={Math.min(1, view().w / 1000)} />
                <DeathSkulls art={p.art} vp={viewpoint()} preview={matchPreview} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} hit={phone ? 26 * view().w / mapPx() / (Math.min(1, view().w / 1000) * 1.4) : undefined} hasRecap={hasRecap} onOpenRecap={(slot, t) => setSkullRecap({ slot, t })} />
              </Show>
              <TeleporterLink art={p.art} vp={viewpoint()} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} />
              <MarkerTips art={p.art} vp={viewpoint()} hidden={(k) => markerStatus(k) === "Hidden"} shown={() => ({ heals: heals(), crates: crates() })} preview={matchPreview} t={player.t} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} />
              <Highlight at={inPlayer() ? player.ring() : undefined} vp={viewpoint()} />
              <Show when={inPlayer()}>
                <EventPings host={player} art={p.art} vp={viewpoint()} />
              </Show>
              <HoverLabels k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} />
            </MapView>
            {phone && panelsView()}
          </div>
  );
  // The desktop header's right side (spec §4b, The board header): at most 5 avatars (3 at 1440 px
  // and under) and "+N"; one main action; the rest in More.
  const wideQuery = window.matchMedia("(min-width: 1441px)");
  const [wideHeader, setWideHeader] = createSignal(wideQuery.matches);
  const onWideHeader = () => setWideHeader(wideQuery.matches);
  wideQuery.addEventListener("change", onWideHeader);
  onCleanup(() => wideQuery.removeEventListener("change", onWideHeader));
  const shownPeople = () => people().slice(0, (wideHeader() ? 5 : 3) - (me() && joined() ? 1 : 0));
  const [update] = createResource(() => appUpdate());
  const updateLink = () => update()?.kind === "link";
  const editsHere = () => (inSession ? inSession.canEdit() : state.canEdit());
  const mainClone = () => !!state.role() && !editsHere();
  const cloneIcon = () => (
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" />
    </svg>
  );
  const cloneButton = () => (
    <button class="btn ghost" data-testid="clone" onClick={() => setDialog("clone")}>
      {cloneIcon()}
      Clone
    </button>
  );
  const shareButton = () => (
    <button class="btn primary" data-testid="share" onClick={() => setDialog("share")}>
      <ShareIcon />
      Share
    </button>
  );
  const rowIcon = (d: string) => <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" innerHTML={d} />;
  const DOWN = '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>';
  const moreGroups = createMemo((): MoreRow[][] => {
    const app = !via ? openInAppHref({ board: p.board, token: p.token }) : undefined;
    return [
      updateLink() ? [{ label: "Update available", testid: "app-update", href: WINDOWS_APP_PORTABLE_URL, download: true, brass: true, icon: () => rowIcon(DOWN) }] : [],
      state.role()
        ? [
            ...(mainClone() ? [] : [{ label: "Clone", testid: "clone", icon: cloneIcon, run: () => setDialog("clone") }]),
            // The board as a file (spec §6): anyone who can see it, as for Clone.
            { label: "Download", testid: "download", icon: () => rowIcon(DOWN), run: () => void downloadBoard(p.board, p.token, state.title(), via).then((why) => why && say(why)) },
          ]
        : [],
      app
        ? [
            { label: "Open in app", testid: "open-in-app", href: app, icon: () => rowIcon('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/>') },
            { label: "Get the app", testid: "open-in-app-get", href: desktopAppLinks()?.href, download: true, icon: () => rowIcon('<rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/>') },
          ]
        : [],
    ].filter((g) => g.length > 0);
  });
  const toastView = () => (
          <Show when={toast()}>
            {(t) => (
              <div class="toast" role="status" data-testid="toast">
                {t().text}
                <Show when={t().action && (t().action!.live?.() ?? true) ? t().action : undefined}>
                  {(a) => (
                    <button
                      class="link"
                      data-testid="toast-action"
                      onClick={() => {
                        a().run();
                        setToast(undefined);
                      }}
                    >
                      {a().label}
                    </button>
                  )}
                </Show>
              </div>
            )}
          </Show>
  );

  return (
    <>
    <Show when={!phone()} fallback={<PhoneBoard />}>
    <div class="app board-app" data-testid="board" data-board={p.board}>
      <header class="top">
        <Wordmark />
        <Show when={!inSession} fallback={inSession!.title()}>
        <div class="board-title">
          <b title={state.title()}>
            <InlineEdit
              class="title"
              label="Board title"
              testid="board-title"
              editable={state.canEdit() && !!state.metaId()}
              value={state.title()}
              placeholder="…"
              maxLength={LIMITS.max_title}
              bindOpen={(o) => (openTitle = o)}
              onCommit={renameBoard}
            />
          </b>
          <span>
            {state.scenes().length} scene{state.scenes().length === 1 ? "" : "s"}
          </span>
        </div>
        </Show>
        <SaveStatus quiet state={state} rejected={rejected()} dismiss={() => setSeenProblems(state.problems().length)} />
        <Show when={!inSession}>
        <AddGameOnBoard board={p.board} token={p.token} title={state.title()} ready={!!state.role()} />
        </Show>
        <Show when={player.matchId()}><TierChip host={player} /></Show>
        <div class="spacer" />
        <PresentingPill followers={followersOf(state.myPeer())} />
        <FollowChip following={followed()} presenters={presenterList()} sceneLabel={sceneLabel} follow={follow} stop={() => stopFollowing()} />
        <div class="spacer" />
        <div class="avatars" data-testid="avatars">
          <Show when={me() && joined()}>
            <span class="av ring" style={{ background: colorOf(me()!.color) }} title={me()!.name}>
              {avatarLetter(me()!.name)}
            </span>
          </Show>
          <For each={shownPeople()}>{(peer) => <Avatar name={peer.state!.name || "?"} color={peer.state!.color} title={peer.state!.name || "Joining"} />}</For>
          <Show when={people().length - shownPeople().length}>
            {(n) => <span class="av more-people" data-testid="avatars-more">+{n()}</span>}
          </Show>
        </div>
        {/* Feedback stays in sight, next to the main action (feedback #52; spec §4b). */}
        <FeedbackButton variant="bar" match={feedbackMatch} />
        {/* The main action (spec §4b): Share for anyone who can edit, Clone for a view link. */}
        <Show when={mainClone()}>{cloneButton()}</Show>
        <Show when={inSession} fallback={<Show when={state.canEdit()}>{shareButton()}</Show>}>{inSession!.share()}</Show>
        <MoreMenu groups={moreGroups()} dot={updateLink()} />
      </header>
      <Show when={inSession}>{inSession!.strip()}</Show>
      <div class="main">
        <SceneTree
          state={state}
          art={p.art}
          vp={viewpoint()}
          board={p.board}
          current={inPlayer() ? undefined : scene()?.id}
          replay={player.matchId() ? { active: inPlayer(), label: `Match ${player.matchId()}`, go: () => { stopFollowing("returned to replay"); player.setMode("player"); } } : undefined}
          onFlip={pickScene}
          chip={sceneChip}
          keys={() => !inPlayer()}
        />
        <main class="stage">
          <div class="stage-head" classList={{ "pl-hidden": inPlayer() }}>
            <div class="scene-title">
              <span class="ord">
                Scene {sceneIndex() + 1} of {state.scenes().length}
              </span>
              <h1>
                <InlineEdit
                  class="clock"
                  label="scene clock"
                  testid="scene-clock"
                  placeholder={state.canEdit() ? "–:––" : ""}
                  editable={state.canEdit()}
                  value={formatClock(scene()?.scene.clock)}
                  maxLength={8}
                  onEditing={(on) => state.presence({ focus: on ? (scene()?.id ?? null) : null })}
                  onCommit={(t) => {
                    const c = parseClock(t);
                    const s = scene();
                    if (c === undefined || !s) return false;
                    state.edit([{ Set: { id: s.id, value: { SceneClock: c } } }]);
                  }}
                />{" "}
                <InlineEdit
                  class="scene-name"
                  label="scene name"
                  testid="scene-name"
                  editable={state.canEdit()}
                  value={isUnnamed(scene()?.scene.name ?? "") ? "" : scene()!.scene.name}
                  placeholder={`Scene ${sceneIndex() + 1}`}
                  maxLength={LIMITS.max_name}
                  onEditing={(on) => state.presence({ focus: on ? (scene()?.id ?? null) : null })}
                  onCommit={(t) => {
                    const s = scene();
                    const name = t.trim();
                    if (!s) return false;
                    state.edit([{ Set: { id: s.id, value: { SceneName: name } } }]);
                  }}
                />
              </h1>
            </div>
          </div>
          <Show when={!inPlayer()} fallback={<PlayerTopBar host={player} state={state} art={p.art} vp={viewpoint()} onFocus={focusHero} onSeek={seekMatch} />}>
            <TopBar state={state} host={player} art={p.art} vp={viewpoint()} scene={scene()?.id} onPickHero={setHeroPick} onFocus={focusHero} matchName={matchName} bindMenu={(f) => (heroMenu = f)} />
          </Show>
          {/* The map takes all the room left, as the largest square that fits. */}
          <div class="mapfit" ref={measureBoard} data-testid="board-area">
            {mapBox(false)}
            {mapControls()}
            {panelsView()}
            <Show when={joined()}>
              <ReplayPrompt host={player} art={p.art} />
            </Show>
          </div>
          {/* One dock under the map, in the page's flow: the tools, then Player's bar. They can't
              overlap whatever their heights; the map shrinks to leave them room. */}
          <div class="dock" data-testid="dock">
          <Toolbar
            tool={tool()}
            setTool={setTool}
            editor={state.canEdit()}
            ink={ink()}
            setInk={setInk}
            canUndo={canUndo()}
            canRedo={canRedo()}
            undo={undo}
            redo={redo}
            undoKeysElsewhere={!!inSession}
            counts={{ ink: inkIds().length, arrows: arrowIds().length, comments: commentIds().length, all: clearIds("all").length }}
            commentsOpen={allOpen()}
            toggleComments={() => {
              setAllOpen(!allOpen());
              setCommentsOpen(p.board, allOpen());
            }}
            clear={(what) => {
              // In transactions that each fit the cap (one undo step each); the toast speaks for
              // what committed, and its Undo takes back exactly those steps.
              const ids = clearIds(what);
              let done = 0;
              let steps = 0;
              for (let i = 0; i < ids.length; i += MAX_OPS_PER_TX) {
                const part = ids.slice(i, i + MAX_OPS_PER_TX);
                if (!state.edit(part.map((id) => ({ Delete: { id } })))) break;
                done += part.length;
                steps += 1;
              }
              if (!steps) return; // refused: the problem toast says why
              const text = done < ids.length ? `${CLEARED[what]}: ${done} of ${ids.length}` : CLEARED[what];
              // In a session, the one history: its Undo is for these steps alone, and goes once
              // anything else is done (review 2026-11-12, finding 3).
              const at = history?.at();
              if (history && at !== undefined) say(text, { label: "Undo", run: () => void history.undoSince(at, p.board, steps), live: () => history.live(at) });
              else say(text, { label: "Undo", run: () => Array.from({ length: steps }).forEach(() => undo()) });
            }}
          />
          {playerBar()}
          </div>
          {toastView()}
        </main>
        <aside class="side">
          <div class="side-tabs" role="tablist" aria-label="Board sidebar" onKeyDown={e => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
            e.preventDefault();
            const tab = e.key === "Home" ? "events" : e.key === "End" ? "notes" : sideTab() === "events" ? "notes" : "events";
            setSideTab(tab);
            document.getElementById(`${tab}-tab`)?.focus();
          }}>
            <button id="events-tab" role="tab" tabIndex={sideTab() === "events" ? 0 : -1} aria-selected={sideTab() === "events"} aria-controls="events-panel" onClick={() => setSideTab("events")}>Events</button>
            <button id="notes-tab" role="tab" tabIndex={sideTab() === "notes" ? 0 : -1} aria-selected={sideTab() === "notes"} aria-controls="notes-panel" onClick={() => setSideTab("notes")}>Scene Notes</button>
          </div>
          <div id="events-panel" role="tabpanel" aria-labelledby="events-tab" hidden={sideTab() !== "events"}>
          <Show when={player.tl()} fallback={<section class="side-empty">Load a match to browse its events.</section>}>
            <PlayerSide host={player} state={state} art={p.art} scene={scene()} mint={newRecordId} onSaved={savedScene} onUserPlayback={() => stopFollowing("changed the playback")} />
          </Show>
          </div>
          <section class="people-section">
            <h2>
              People here <small>{people().length + (joined() ? 1 : 0)} online{presenterList().length ? ` · ${presenterList().length} presenting` : ""}</small>
            </h2>
            <PeopleList
              me={joined() ? me() : undefined}
              myRole={state.role()}
              myPeer={state.myPeer()}
              peers={people()}
              following={followingHere()}
              followersOf={followersOf}
              sceneLabel={sceneLabel}
              follow={follow}
              stop={() => stopFollowing()}
              rename={() => setJoined(false)}
            />
          </section>
          <section id="notes-panel" role="tabpanel" aria-labelledby="notes-tab" class="note-section" hidden={sideTab() !== "notes"}>
            <Show when={inPlayer()}><p class="side-empty">Notes for {scene()?.scene.name || "the selected scene"}. Select a scene to view its plan.</p></Show>
            <h2>
              Scene note
              <For each={noteEditors()}>
                {(x) => (
                  <span class="note-tag" data-testid="note-editing" style={{ background: colorOf(x.state!.color) }}>
                    {x.state!.name || "Someone"} · editing
                  </span>
                )}
              </For>
            </h2>
            <Show when={state.canEdit()} fallback={<div class="note">{note()?.text}</div>}>
              <textarea
                class="note note-edit"
                data-testid="scene-note-edit"
                aria-label="Scene note"
                maxLength={LIMITS.max_note}
                value={noteDraft() ?? note()?.text ?? ""}
                onFocus={() => state.presence({ focus: noteFocus() })}
                onInput={(e) => setNoteDraft(e.currentTarget.value)}
                onBlur={(e) => {
                  state.presence({ focus: null });
                  saveNote(e.currentTarget.value);
                  setNoteDraft(undefined);
                }}
              />
            </Show>
          </section>
        </aside>
      </div>
    </div>
    </Show>
    <Show when={dialog() === "share" && state.canEdit() && !inSession}>
      <ShareDialog
        board={p.board}
        token={p.token}
        role={state.role() === "owner" ? "owner" : "edit"}
        onClose={() => setDialog(undefined)}
        onClone={() => setDialog("clone")}
      />
    </Show>
    <Show when={heroPick() && state.canEdit()}>
      <HeroPicker
        heroes={heroList().filter((h) => h.playable)}
        slot={state.roster().find((x) => x.id === heroPick())}
        takenBy={takenBy(heroPick())}
        onPick={(hero) => {
          const id = heroPick();
          setHeroPick(undefined);
          if (id) state.edit([{ Set: { id, value: { RosterHero: hero } } }]);
        }}
        onClose={() => setHeroPick(undefined)}
      />
    </Show>
    <Show when={dialog() === "clone"}>
      <CloneDialog board={p.board} token={p.token} {...(via ? { via } : {})} title={state.title()} onClose={() => setDialog(undefined)} />
    </Show>
    <Show when={justCloned() && state.role() === "owner" && joined() && !dialog()}>
      <div class="owner-note landed-note" data-testid="owner-note">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z" />
        </svg>
        <div>
          <b>You own this copy</b>
        </div>
        <button class="btn primary small" onClick={() => (setJustCloned(false), setDialog("share"))}>
          Share
        </button>
        <button class="btn ghost small" aria-label="Dismiss" onClick={() => setJustCloned(false)}>
          Later
        </button>
      </div>
    </Show>
    <Show when={state.connection().kind === "closed" && !outdated()}>
      <Show when={inSession} fallback={<DeadLink />}>
        <div class="banner revoked no-access" role="alert" data-testid="no-access">
          <b>No access</b>
        </div>
      </Show>
    </Show>
    <Show when={outdated()}>
      <div class="update-banner" role="alert" data-testid="update-available">
        Update available
        <button class="btn small" data-testid="update-reload" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </Show>
    <Show when={!joined() && state.connection().kind !== "closed"}>
      <JoinCard title={state.title()} others={people().map((x) => x.state!.name).filter(Boolean)} initial={me()} onJoin={join} />
    </Show>
    </>
  );
}
