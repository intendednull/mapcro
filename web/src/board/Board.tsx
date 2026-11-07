// One board: the header (title, save status, people), the map with its layers, and the side
// panel. The map is the interface: edits happen on it directly.

import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import { type Me, colorOf, hasJoined, loadMe, markJoined, rememberBoard, saveMe } from "../core/device";
import type { RecordId } from "../gen/RecordId";
import { MapView } from "../map/MapView";
import type { Art } from "../map/pack";
import type { Viewpoint } from "../map/transform";
import { Wordmark } from "../ui/Wordmark";
import { DeadLink } from "../ui/DeadLink";
import { formatClock, parseClock } from "../core/clock";
import { InlineEdit } from "../ui/InlineEdit";
import { JoinCard } from "./JoinCard";
import { SceneStrip } from "./SceneStrip";
import { TopBar } from "./TopBar";
import { createBoardState } from "./state";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { PeerPresence } from "../gen/PeerPresence";
import { FIT, type ViewRect, clampView, fromViewport, presenters, toViewport, zoomAt } from "./follow";
import { CloneDialog, JUST_CLONED } from "./CloneDialog";
import { Layers, calloutOrder } from "./Layers";
import { FRESH_BOARD, randomRosterOps } from "./roster";
import { HeroPicker } from "./HeroPicker";
import { defaultSplit, project } from "../map/lanes";
import { worldToMap } from "../map/transform";
import { newRecordId } from "../wasm/mapcro_wasm.js";
import { ShareDialog } from "./ShareDialog";
import { rejection, statusView } from "./status";
import type { Reject } from "../gen/Reject";
import { Avatar, FollowChip, PeopleList, PresentingPill } from "./Presence";
import { Toolbar } from "./Toolbar";
import type { Tool } from "./tools";


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
  const [why, setWhy] = createSignal(false);
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
      <Show when={v().why}>
        {" "}
        <button class="why" data-testid="why" onClick={() => setWhy(!why())}>
          Why?
        </button>
        <Show when={why()}>
          <span class="why-pop" role="note">
            {v().why}{" "}
            <button
              class="link"
              onClick={() => {
                setWhy(false);
                p.dismiss();
              }}
            >
              OK
            </button>
          </span>
        </Show>
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
  const [tool, setTool] = createSignal<Tool>("move");
  const [ink, setInk] = createSignal(loadMe()?.color ?? 1);
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
    for (const pr of ps.slice(toasted)) if (!rejection(pr) && !pr.startsWith("protocol error")) say(pr[0]!.toUpperCase() + pr.slice(1) + ".");
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
    state.presence({ following: null });
    if (why && was) say(`You ${why}, so you stopped following ${nameOfPeer(was)}.`, { label: "Follow again", run: () => follow(was.peer) });
  };
  createEffect(() => {
    const f = following();
    if (f === undefined) return;
    const x = followed();
    if (!x) {
      setFollowing(undefined);
      state.presence({ following: null });
      say("The person you followed left the board.");
      return;
    }
    const s = x.state!;
    if (s.scene && s.scene !== sceneId()) setSceneId(s.scene);
    setView(fromViewport(s.view, viewpoint()));
  });
  createEffect(() => state.presence({ view: toViewport(view(), viewpoint()) }));
  const userFlip = (id: RecordId) => {
    if (id !== scene()?.id) stopFollowing("flipped the scene");
    setSceneId(id);
  };
  const userView = (v: ViewRect, why: string) => {
    stopFollowing(why);
    setView(clampView(v));
  };
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
    const s = scene();
    if (s) state.presence({ scene: s.id });
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
  const inkIds = createMemo(() => state.inScene("Stroke", scene()?.id).map(([id]) => id));
  const objectives = createMemo(() => {
    const m = new Map<string, { id: RecordId; status: ObjectiveStatus }>();
    for (const [id, r] of state.inScene("ObjectiveState", scene()?.id))
      if ("ObjectiveState" in r) m.set(r.ObjectiveState.key, { id, status: r.ObjectiveState.status });
    return m;
  });
  // ---- Move: selected heroes, Space to pan, lane splits ----
  const [selection, setSelection] = createSignal<Set<RecordId>>(new Set());
  const [spaceHeld, setSpaceHeld] = createSignal(false);
  createEffect(() => {
    scene();
    setSelection(new Set<RecordId>());
  });
  onMount(() => {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    };
    const kd = (e: KeyboardEvent) => {
      if (typing(e)) return;
      if (e.key === "Escape") setSelection(new Set<RecordId>());
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
  const splitOf = (key: string) => {
    const mine = waveDrag();
    if (mine?.key === key) return mine.t;
    const lane = p.art.model.lanes.find((l) => l.key === key);
    return remoteWaves().get(key) ?? waves().get(key)?.t ?? (lane ? defaultSplit(lane.line) : 500);
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
  const saveNote = (text: string) => {
    const s = scene();
    const n = note();
    if (!s || text === (n?.text ?? "")) return;
    if (n) state.edit([{ Set: { id: n.id, value: { NoteText: text } } }]);
    else if (text.trim()) state.edit([{ Create: { id: newRecordId(), record: { Note: { scene: s.id, text } } } }]);
  };
  const calloutList = createMemo(() => calloutOrder(state.inScene("Callout", scene()?.id)));

  const flipBy = (d: number) => {
    const all = state.scenes();
    const next = all[sceneIndex() + d];
    if (next) userFlip(next.id);
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
          {state.canEdit() ? "Can edit" : "View only"} · {viewpoint() === "amber" ? "Amber" : "Sapphire"} side
        </span>
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
          {scene()?.scene.name}
        </h1>
      </div>
      <TopBar state={state} art={p.art} vp={viewpoint()} scene={scene()?.id} compact onPickHero={setHeroPick} />
      <div class="p-map-wrap">
        {mapBox(true)}
        <div class="p-tools" role="toolbar" aria-label="Tools">
          <button class={cx("tb", tool() === "move" && "on")} data-testid="tool-move" onClick={() => setTool("move")}>
            <span>{state.canEdit() ? "Move" : "Look"}</span>
          </button>
          <button class={cx("tb", tool() === "laser" && "on")} data-testid="tool-laser" onClick={() => setTool("laser")}>
            <span>Laser</span>
          </button>
          <button class="tb" data-testid="viewpoint-flip" aria-label="Flip to the other side" onClick={() => setViewpoint(viewpoint() === "amber" ? "sapphire" : "amber")}>
            <span>⟲</span>
          </button>
        </div>
      </div>
      <Show when={calloutList().length > 0}>
        <ol class="p-callouts" data-testid="callout-list">
          <For each={calloutList()}>
            {(c, i) => (
              <li>
                <b>{i() + 1}</b>
                {c.text}
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
        <div class="p-hint">Swipe or tap to flip on your own. That stops following; tap Follow to come back.</div>
      </nav>
      {toastView()}
    </div>
  );

  const mapBox = (phone: boolean) => (
          <div class={phone ? "p-map" : "mapbox"} data-testid="map" data-view={`${Math.round(view().x)} ${Math.round(view().y)} ${Math.round(view().w)}`}>
            <MapView
              art={p.art}
              viewpoint={viewpoint()}
              view={view()}
              live={following() !== undefined}
              overlayRef={setOverlay}
              overlayProps={{ "data-tool": tool(), "data-pan": spaceHeld() ? "on" : undefined, onContextMenu: (e: MouseEvent) => e.preventDefault() } as never}
              overlayClass={!state.canEdit() && "readonly"}
              status={(k) => objectives().get(k)?.status}
              waveT={splitOf}
              raisedLane={waveDrag()?.key}
              showHidden={state.canEdit()}
            >
              <Layers
                state={state}
                art={p.art}
                vp={viewpoint()}
                scene={scene()?.id}
                tool={tool()}
                ink={ink()}
                myColor={me()?.color ?? 0}
                svg={overlay}
                objectives={objectives}
                k={(view().w / 1000) * (phone ? 1.4 : 1)}
                selection={selection}
                setSelection={setSelection}
                spaceHeld={spaceHeld}
                showHidden={state.canEdit()}
                waves={waves}
                waveDrag={waveDrag}
                setWaveDrag={setWaveDrag}
                splitOf={splitOf}
                compactCallouts={phone}
                onPan={(dx, dy) => userView({ ...view(), x: view().x - dx, y: view().y - dy }, "panned the map")}
                onZoom={(at, factor) => userView(zoomAt(view(), at, factor), "zoomed the map")}
              />
            </MapView>
            <button
              class="mm-flip"
              hidden={phone}
              data-testid="viewpoint-flip"
              title={`Flip to the ${viewpoint() === "amber" ? "Sapphire" : "Amber"} side (changes only your view)`}
              onClick={() => setViewpoint(viewpoint() === "amber" ? "sapphire" : "amber")}
            >
              <svg viewBox="-16 -16 32 32" aria-hidden="true">
                <path d="M-10 -4 A11 11 0 0 1 9 -6 M9 -6 L9 -14 M9 -6 L1 -6 M10 4 A11 11 0 0 1 -9 6 M-9 6 L-9 14 M-9 6 L-1 6" />
              </svg>
            </button>
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
        <div class="spacer" />
        <PresentingPill followers={followersOf(state.myPeer())} />
        <FollowChip following={followed()} presenters={presenterList()} sceneLabel={sceneLabel} follow={follow} stop={() => stopFollowing()} />
        <div class="spacer" />
        <SaveStatus state={state} rejected={rejected()} dismiss={() => setSeenProblems(state.problems().length)} />
        <div class="avatars" data-testid="avatars">
          <Show when={me() && joined()}>
            <span class="av ring" style={{ background: colorOf(me()!.color) }} title={`${me()!.name} (you)`}>
              {avatarLetter(me()!.name)}
            </span>
          </Show>
          <For each={people()}>{(peer) => <Avatar name={peer.state!.name || "?"} color={peer.state!.color} title={peer.state!.name || "Someone joining"} />}</For>
        </div>
        <Show when={state.role()}>
          <button class="btn ghost" data-testid="clone" title="Clone to a new board you own" onClick={() => setDialog("clone")}>
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
        <main class="stage">
          <div class="stage-head">
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
                  value={scene()?.scene.name ?? ""}
                  maxLength={24}
                  onEditing={(on) => state.presence({ focus: on ? (scene()?.id ?? null) : null })}
                  onCommit={(t) => {
                    const s = scene();
                    const name = t.trim();
                    if (!s || !name) return false;
                    state.edit([{ Set: { id: s.id, value: { SceneName: name } } }]);
                  }}
                />
              </h1>
            </div>
            <Show when={!p.art.packId}>
              <span class="ph-badge" data-testid="placeholder-note">
                Placeholder map: your server's map pack replaces it
              </span>
            </Show>
          </div>
          <TopBar state={state} art={p.art} vp={viewpoint()} scene={scene()?.id} onPickHero={setHeroPick} />
          {mapBox(false)}
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
            inkCount={inkIds().length}
            clearInk={() => {
              const ids = inkIds();
              if (!ids.length) return;
              state.edit(ids.map((id) => ({ Delete: { id } })));
              say(`Cleared ${ids.length} stroke${ids.length === 1 ? "" : "s"} on this scene`, { label: "Undo", run: () => state.undo() });
            }}
          />
          {toastView()}
        </main>
        <aside class="side">
          <section>
            <h2>
              Roster <small>shared by every scene</small>
            </h2>
            <div class="teams">
              <For each={["Amber", "Sapphire"] as const}>
                {(team) => (
                  <div>
                    <div class={`team-head ${team.toLowerCase()}`}>
                      <i />
                      {team}
                    </div>
                    <For each={state.roster().filter((s) => s.slot.team === team)}>
                      {(s) => {
                        const hero = () => (s.slot.hero != null ? p.art.heroes.get(s.slot.hero) : undefined);
                        return (
                          <div class="slot">
                            <span class={`chip ${team.toLowerCase()}`}>
                              {`${team[0]}${s.slot.slot + 1}`}
                              <Show when={hero()?.portrait}>
                                <i class="hero-mm" style={{ display: "block", "background-image": `url(${JSON.stringify(hero()!.portrait)})` }} />
                              </Show>
                            </span>
                            <span class="nm">
                              <b>{s.slot.name || `Player ${s.slot.slot + 1}`}</b>
                              <Show when={state.canEdit() && heroList().length > 0} fallback={<span>{hero()?.name ?? "No hero yet"}</span>}>
                                <select
                                  class="hero-pick"
                                  data-testid={`hero-pick-${team}-${s.slot.slot}`}
                                  aria-label={`Hero for ${s.slot.name || `${team} player ${s.slot.slot + 1}`}`}
                                  value={s.slot.hero ?? ""}
                                  onChange={(e) => {
                                    const v = e.currentTarget.value;
                                    state.edit([{ Set: { id: s.id, value: { RosterHero: v === "" ? null : Number(v) } } }]);
                                  }}
                                >
                                  <option value="">No hero yet</option>
                                  <For each={heroList()}>{(h) => <option value={h.id}>{h.name}</option>}</For>
                                </select>
                              </Show>
                            </span>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                )}
              </For>
            </div>
          </section>
          <section>
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
          <section class="note-section">
            <h2>Scene note</h2>
            <Show when={state.canEdit()} fallback={<div class="note">{note()?.text || <span class="muted">No note for this scene.</span>}</div>}>
              <textarea
                class="note note-edit"
                data-testid="scene-note-edit"
                aria-label="Scene note"
                placeholder="What should everyone know about this moment?"
                maxLength={4000}
                value={note()?.text ?? ""}
                onFocus={() => state.presence({ focus: note()?.id ?? scene()?.id ?? null })}
                onBlur={(e) => {
                  state.presence({ focus: null });
                  saveNote(e.currentTarget.value);
                }}
              />
            </Show>
          </section>
        </aside>
      </div>
      <SceneStrip state={state} art={p.art} vp={viewpoint()} current={scene()?.id} onFlip={userFlip} />
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
          <span>It has no links yet, so only you can open it. Share it to bring the right people in.</span>
        </div>
        <button class="btn primary small" onClick={() => (setJustCloned(false), setDialog("share"))}>
          Share
        </button>
        <button class="btn ghost small" aria-label="Dismiss" onClick={() => setJustCloned(false)}>
          Later
        </button>
      </div>
    </Show>
    <Show when={state.connection().kind === "closed"}>
      <DeadLink />
    </Show>
    <Show when={!joined() && state.connection().kind !== "closed"}>
      <JoinCard title={state.title()} others={people().map((x) => x.state!.name).filter(Boolean)} initial={me()} onJoin={join} />
    </Show>
    </>
  );
}
