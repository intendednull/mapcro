// One board: the header (title, save status, people), the map with its layers, and the side
// panel. The map is the interface: edits happen on it directly.

import { rosterTeamName, teamName } from "../map/model";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import type { Callout } from "../gen/Callout";
import { cx } from "../ui/cx";
import { type Me, colorOf, commentsOpen, setCommentsOpen, hasJoined, inkOn, loadColour, loadMe, saveColour, markJoined, rememberBoard, saveMe } from "../core/device";
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
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { PeerPresence } from "../gen/PeerPresence";
import { FIT, type ViewRect, clampView, fromViewport, presenters, sideOf, toViewport, zoomAt } from "./follow";
import { CloneDialog, JUST_CLONED } from "./CloneDialog";
import type { MatchPreview } from "../match/preview";
import { EventPings, Highlight, MapControls, Player, PlayerSide, PlayerSwitch, TierChip, TrooperDots } from "../player/Player";
import { createPlayerHost, playbackPresence } from "../player/host";
import { ReplayPrompt } from "../player/ReplayPrompt";
import { MarkerTips, TeleporterLink } from "../player/Camps";
import { HoverLabels, hoverFromWire, hoverWire, localHover, setRemoteHover } from "../map/HoverLabel";
import { UrnMark } from "../player/Urn";
import { DeathSkulls } from "../player/Skulls";
import { SkullRecap } from "../player/SkullRecap";
import { HeroCard, type HeroCardSlot } from "../player/HeroCard";
import { recapOf } from "../player/recap";
import { RiftRings } from "../player/Rift";
import { liveLayer } from "../player/layer";
import { PlayerTopBar } from "../player/PlayerTopBar";
import { OpenInApp, UpdateLink } from "../ui/OpenLink";
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


function SaveStatus(p: { state: ReturnType<typeof createBoardState>; rejected: Reject | undefined; dismiss: () => void }) {
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
    <span class={cx("save", v().kind === "connecting" ? "syncing" : v().kind === "closed" ? "rejected" : v().kind)} data-testid="save-status" data-state={v().kind} data-connection={p.state.connection().kind} data-can-edit={String(p.state.canEdit())} role="status">
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

export function Board(p: { board: string; token: string; art: Art }) {
  const state = createBoardState(p.board, p.token);
  const [me, setMe] = createSignal<Me | undefined>(loadMe());
  const [joined, setJoined] = createSignal(hasJoined(p.board) && !!loadMe());
  const [viewpoint, setViewpoint] = createSignal<Viewpoint>("amber");
  const [sceneId, setSceneId] = createSignal<RecordId | undefined>();
  const [sideTab, setSideTab] = createSignal<"events" | "notes">("events");
  const [tool, setTool] = createSignal<Tool>("move");
  // The palette colour for Draw, Arrow, Comment and Laser: per person, per board.
  const [ink, setInkSignal] = createSignal(loadColour(p.board) ?? loadMe()?.color ?? 1);
  const setInk = (i: number) => {
    setInkSignal(i);
    saveColour(p.board, i);
  };
  const [toast, setToast] = createSignal<{ text: string; action?: { label: string; run: () => void } }>();
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string, action?: { label: string; run: () => void }) => {
    setToast(action ? { text, action } : { text });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(undefined), 6000);
  };
  onCleanup(() => clearTimeout(toastTimer));
  const [overlay, setOverlay] = createSignal<SVGSVGElement>();
  const [dialog, setDialog] = createSignal<"share" | "clone">();
  // ---- Player (spec §6b): a board with a match opens on it; its preview drives the map ----
  const player = createPlayerHost(p.board, p.token);
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
  const followed = () => {
    const f = following();
    return f === undefined ? undefined : state.peerList().find((x) => x.peer === f);
  };
  const nameOfPeer = (x: PeerPresence | undefined) => x?.state?.name || "them";
  const follow = (peer: number) => {
    setFollowing(peer);
    state.presence({ following: peer });
    setToast(undefined);
  };
  const stopFollowing = (why?: string) => {
    const was = followed();
    if (following() === undefined) return;
    setFollowing(undefined);
    player.forget();
    state.presence({ following: null });
    if (why && was) say(`Stopped following ${nameOfPeer(was)}`, { label: "Follow again", run: () => follow(was.peer) });
  };
  createEffect(() => {
    const f = following();
    if (f === undefined) return;
    const x = followed();
    if (!x) {
      setFollowing(undefined);
      player.forget();
      state.presence({ following: null });
      say("Presenter left");
      return;
    }
    const s = x.state!;
    // A presenter in Player is on the live layer, which isn't a scene to flip to.
    if (s.scene && s.scene !== sceneId() && state.scenes().some((x) => x.id === s.scene)) setSceneId(s.scene);
    // The presenter's side too: their map turned the same way (older peers: Amber).
    const side = sideOf(s.view);
    if (side && side !== viewpoint()) setViewpoint(side);
    setView(fromViewport(s.view, side ?? viewpoint()));
    // Player too: the presenter's mode, match and playback (spec §6b), and their map layers.
    player.mirrorLayers(s.layers);
    player.mirror(s.playback);
  });
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
  /** The hero panel opened from a token on the map (HeroCard.tsx); this browser's, gone with the
   * match. */
  const [heroCard, setHeroCard] = createSignal<HeroCardSlot>();
  createEffect(on(() => player.matchId(), () => setHeroCard(undefined), { defer: true }));
  const hasRecap = (slot: string, t: number) => !!recapOf(player.tl()?.players.find((q) => slotKey(q.team, q.slot) === slot), t);
  /** In a scene, the open match's in-game name for a slot (spec §6b "Names"); a typed one wins. */
  const matchName = (team: string, n: number) => sceneMatchName(player.tl(), scene()?.scene.source, player.playerName, team, n);
  const presenterList = createMemo(() => presenters(state.peerList(), state.myPeer(), following()));
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

  createEffect(() => {
    // In Player, presence is on the live layer, so cursors, lasers, pings and ink in progress
    // show to the others in Player (review finding 3).
    const s = annScene();
    state.presence({ scene: s ?? null });
  });
  createEffect(() => {
    const t = state.title();
    if (t) {
      document.title = `${t} · mapcro`;
      rememberBoard({ board: p.board, token: p.token, title: t });
    }
  });

  const join = (m: Me) => {
    saveMe(m);
    markJoined(p.board);
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
  // ---- Move: selected heroes, Space to pan, lane splits ----
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
  const mq = window.matchMedia("(max-width: 700px)");
  const [phone, setPhone] = createSignal(mq.matches);
  const onMq = () => setPhone(mq.matches);
  mq.addEventListener("change", onMq);
  onCleanup(() => mq.removeEventListener("change", onMq));
  createEffect(() => {
    // The phone picker is Look/Move and Laser; drawing tools need the desktop.
    if (phone() && tool() !== "move" && tool() !== "laser") setTool("move");
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

  const PhoneBoard = () => (
    <div class="phone" data-testid="board" data-board={p.board} data-layout="phone">
      <header class="p-top">
        <Wordmark />
        <span class="viewonly" data-testid="role-chip">
          {state.canEdit() ? "Can edit" : "View only"} · {teamName(viewpoint() === "sapphire" ? "sapphire" : "amber")} side
        </span>
        {/* The tier left the Player bar for the header (prototype): the phone's header too. */}
        <Show when={player.matchId()}><TierChip host={player} /></Show>
        <div class="spacer" />
        <SaveStatus state={state} rejected={rejected()} dismiss={() => setSeenProblems(state.problems().length)} />
      </header>
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
      <div class="p-title" onPointerDown={swipe}>
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
      <Show when={!inPlayer()} fallback={<PlayerTopBar host={player} state={state} art={p.art} vp={viewpoint()} compact onFocus={focusHero} onSeek={seekMatch} />}>
        <TopBar state={state} art={p.art} vp={viewpoint()} scene={scene()?.id} compact onPickHero={setHeroPick} onFocus={focusHero} matchName={matchName} />
      </Show>
      <div class="p-map-wrap">
        {mapControls()}
        {mapBox(true)}
        {/* Not over the join card (it would take the focus from your name). */}
        <Show when={joined()}>
          <ReplayPrompt host={player} art={p.art} />
        </Show>
        <div class="p-tools" role="toolbar" aria-label="Tools">
          <button class={cx("tb", tool() === "move" && "on")} data-testid="tool-move" onClick={() => setTool("move")}>
            <span>{state.canEdit() ? "Move" : "Look"}</span>
          </button>
          <button class={cx("tb", tool() === "laser" && "on")} data-testid="tool-laser" onClick={() => setTool("laser")}>
            <span>Laser</span>
          </button>
          <Palette value={ink()} set={setInk} />

        </div>
      </div>
      <Show when={calloutList().length > 0}>
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
      <Show when={note()?.text}>
        <p class="p-note" data-testid="scene-note">
          {note()!.text}
        </p>
      </Show>
      {playerBar()}
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
      <Show when={sceneDrawer()}>
        <div class="drawer-scrim" onClick={() => setSceneDrawer(false)} />
        <SceneTree state={state} art={p.art} vp={viewpoint()} board={p.board} current={scene()?.id} onFlip={pickScene} chip={sceneChip} keys={() => !inPlayer()} drawer onClose={() => setSceneDrawer(false)} />
      </Show>
      {toastView()}
    </div>
  );

  // The map's width on screen, so comments can be drawn at screen size.
  const [mapPx, setMapPx] = createSignal(500);
  const measureMap = (el: HTMLDivElement) => {
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
  const playerBar = () => (
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
  const markerStatus = (k: string) => {
    const pv = matchPreview();
    // A shop is up on a board; in Player a lane shop is gone once its guardian falls.
    if (k.startsWith("shop:")) return pv?.shops?.has(k) ? "Hidden" : undefined;
    const own = objectives().get(k)?.status;
    // Player shows only the match at t (spec §6b): what was down, and from a replay
    // the rifts and powerups; never the scene's states. Without a replay, rifts are off.
    if (!pv) return own;
    const site = pv.sites.get(k);
    if (site) return site;
    if (k.startsWith("rift:") || k.startsWith("urn:")) return "Destroyed";
    if (pv.down.has(k)) return "Destroyed";
    // The patron's stage from the replay: its shield (stage 1) or its core (stage 2).
    return pv.health?.get(k)?.stage === 2 ? "Stage2" : "Active";
  };
  const mapControls = () => (<MapControls host={player} heals={heals()} crates={crates()}
              toggleHeals={() => player.setShowHeals(!heals())}
              toggleCrates={() => player.setShowCrates(!crates())}
              flip={flipSide} onUserPlayback={() => stopFollowing("changed map view")} />);
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
              health={(k) => matchPreview()?.health?.get(k)?.pct}
              waveT={splitOf}
              laneEdges={(k) => laneEdges().get(k)?.()}
              camp={(k) => matchPreview()?.camps.get(k)?.state}
              buff={(k) => {
                const b = matchPreview()?.powerups?.get(k);
                return b?.state === "up" ? b.buff : undefined;
              }}
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
                onOpenHero={(team, slot) => setHeroCard({ team, slot })}
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
                <DeathSkulls art={p.art} vp={viewpoint()} preview={matchPreview} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} hasRecap={hasRecap} onOpenRecap={(slot, t) => setSkullRecap({ slot, t })} />
              </Show>
              <TeleporterLink art={p.art} vp={viewpoint()} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} />
              <MarkerTips art={p.art} vp={viewpoint()} hidden={(k) => markerStatus(k) === "Hidden"} shown={() => ({ heals: heals(), crates: crates() })} preview={matchPreview} t={player.t} k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} />
              <Highlight at={inPlayer() ? player.ring() : undefined} vp={viewpoint()} />
              <Show when={inPlayer()}>
                <EventPings host={player} art={p.art} vp={viewpoint()} />
              </Show>
              <HoverLabels k={Math.min(1, view().w / 1000) * (phone ? 1.4 : 1)} />
            </MapView>
            <Show when={inPlayer() && player.tl() && skullRecap()}>
              {(d) => <SkullRecap death={d()} timeline={player.tl()!} vision={player.vision()} art={p.art} name={player.playerName} onSeek={seekMatch} onClose={() => setSkullRecap(undefined)} />}
            </Show>
            <Show when={inPlayer() && player.tl() && heroCard()}>
              {(c) => <HeroCard open={c()} timeline={player.tl()!} t={player.t()} vision={player.vision()} art={p.art} name={player.playerName} onSeek={seekMatch} onClose={() => setHeroCard(undefined)} />}
            </Show>
          </div>
  );
  const toastView = () => (
          <Show when={toast()}>
            {(t) => (
              <div class="toast" role="status" data-testid="toast">
                {t().text}
                <Show when={t().action}>
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
        <div class="board-title">
          <b data-testid="board-title">{state.title() || "…"}</b>
          <span>
            {state.scenes().length} scene{state.scenes().length === 1 ? "" : "s"}
          </span>
        </div>
        <Show when={player.matchId()}><TierChip host={player} /></Show>
        <div class="spacer" />
        <PresentingPill followers={followersOf(state.myPeer())} />
        <FollowChip following={followed()} presenters={presenterList()} sceneLabel={sceneLabel} follow={follow} stop={() => stopFollowing()} />
        <div class="spacer" />
        <SaveStatus state={state} rejected={rejected()} dismiss={() => setSeenProblems(state.problems().length)} />
        <div class="avatars" data-testid="avatars">
          <Show when={me() && joined()}>
            <span class="av ring" style={{ background: colorOf(me()!.color) }} title={me()!.name}>
              {avatarLetter(me()!.name)}
            </span>
          </Show>
          <For each={people()}>{(peer) => <Avatar name={peer.state!.name || "?"} color={peer.state!.color} title={peer.state!.name || "Joining"} />}</For>
        </div>
        <FeedbackButton variant="bar" match={feedbackMatch} />
        <OpenInApp board={p.board} token={p.token} />
        <UpdateLink />
        <Show when={state.role()}>
          <button class="btn ghost" data-testid="clone" onClick={() => setDialog("clone")}>
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
              <rect x="8" y="8" width="12" height="12" rx="2" />
              <path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3" />
            </svg>
            Clone
          </button>
        </Show>
        <Show when={state.canEdit()}>
          <button class="btn primary" data-testid="share" onClick={() => setDialog("share")}>
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" />
              <path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
            </svg>
            Share
          </button>
        </Show>
      </header>
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
            <TopBar state={state} art={p.art} vp={viewpoint()} scene={scene()?.id} onPickHero={setHeroPick} onFocus={focusHero} matchName={matchName} />
          </Show>
          {/* The map takes all the room left, as the largest square that fits. */}
          <div class="mapfit">
            {mapBox(false)}
            {mapControls()}
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
            canUndo={state.canUndo()}
            canRedo={state.canRedo()}
            undo={() => state.undo()}
            redo={() => state.redo()}
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
              say(text, { label: "Undo", run: () => Array.from({ length: steps }).forEach(() => state.undo()) });
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
              following={following()}
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
    <Show when={dialog() === "share" && state.canEdit()}>
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
      <CloneDialog board={p.board} token={p.token} title={state.title()} onClose={() => setDialog(undefined)} />
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
      <DeadLink />
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
