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
import { formatClock, parseClock } from "../core/clock";
import { InlineEdit } from "../ui/InlineEdit";
import { JoinCard } from "./JoinCard";
import { SceneStrip } from "./SceneStrip";
import { TopBar } from "./TopBar";
import { createBoardState } from "./state";
import type { ObjectiveStatus } from "../gen/ObjectiveStatus";
import type { PeerPresence } from "../gen/PeerPresence";
import { FIT, type ViewRect, clampView, fromViewport, presenters, toViewport, zoomAt } from "./follow";
import { Layers } from "./Layers";
import { Avatar, FollowChip, PeopleList, PresentingPill } from "./Presence";
import { Toolbar } from "./Toolbar";
import type { Tool } from "./tools";


function SaveStatus(p: { state: ReturnType<typeof createBoardState> }) {
  const st = () => p.state.status();
  const conn = () => p.state.connection();
  return (
    <span
      class="save"
      classList={{
        saved: st().kind === "saved" && conn().kind === "live",
        syncing: st().kind === "syncing" || conn().kind === "connecting",
        offline: st().kind === "offline" || conn().kind === "waiting",
        rejected: conn().kind === "closed",
      }}
      data-testid="save-status"
      data-state={conn().kind === "closed" ? "closed" : st().kind}
    >
      <Switch>
        <Match when={conn().kind === "closed"}>This link no longer opens the board</Match>
        <Match when={st().kind === "offline"}>
          {(() => {
            const n = (st() as { pending: number }).pending;
            return n ? `Offline: ${n} change${n === 1 ? "" : "s"} kept on this device` : "Offline";
          })()}
        </Match>
        <Match when={st().kind === "syncing"}>Syncing ({(st() as { pending: number }).pending})</Match>
        <Match when={conn().kind !== "live"}>Connecting…</Match>
        <Match when={true}>
          <svg class="ico glyph" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
          Saved
        </Match>
      </Switch>
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
  const heroList = createMemo(() => [...p.art.heroes.values()].sort((a, b) => a.name.localeCompare(b.name)));
  const sceneIndex = () => state.scenes().findIndex((s) => s.id === scene()?.id);

  return (
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
        <SaveStatus state={state} />
        <div class="avatars" data-testid="avatars">
          <Show when={me() && joined()}>
            <span class="av ring" style={{ background: colorOf(me()!.color) }} title={`${me()!.name} (you)`}>
              {avatarLetter(me()!.name)}
            </span>
          </Show>
          <For each={people()}>{(peer) => <Avatar name={peer.state!.name || "?"} color={peer.state!.color} title={peer.state!.name || "Someone joining"} />}</For>
        </div>
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
          <TopBar state={state} art={p.art} vp={viewpoint()} scene={scene()?.id} />
          <div class="mapbox" data-testid="map" data-view={`${Math.round(view().x)} ${Math.round(view().y)} ${Math.round(view().w)}`}>
            <MapView
              art={p.art}
              viewpoint={viewpoint()}
              view={view()}
              live={following() !== undefined}
              overlayRef={setOverlay}
              overlayProps={{ "data-tool": tool() } as never}
              overlayClass={!state.canEdit() && "readonly"}
              status={(k) => objectives().get(k)?.status}
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
                k={view().w / 1000}
                onPan={(dx, dy) => userView({ ...view(), x: view().x - dx, y: view().y - dy }, "panned the map")}
                onZoom={(at, factor) => userView(zoomAt(view(), at, factor), "zoomed the map")}
              />
            </MapView>
            <button
              class="mm-flip"
              data-testid="viewpoint-flip"
              title={`Flip to the ${viewpoint() === "amber" ? "Sapphire" : "Amber"} side (changes only your view)`}
              onClick={() => setViewpoint(viewpoint() === "amber" ? "sapphire" : "amber")}
            >
              <svg viewBox="-16 -16 32 32" aria-hidden="true">
                <path d="M-10 -4 A11 11 0 0 1 9 -6 M9 -6 L9 -14 M9 -6 L1 -6 M10 4 A11 11 0 0 1 -9 6 M-9 6 L-9 14 M-9 6 L-1 6" />
              </svg>
            </button>
          </div>
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
        </aside>
      </div>
      <SceneStrip state={state} art={p.art} vp={viewpoint()} current={scene()?.id} onFlip={userFlip} />
      <Show when={!joined()}>
        <JoinCard title={state.title()} others={people().map((x) => x.state!.name).filter(Boolean)} initial={me()} onJoin={join} />
      </Show>
    </div>
  );
}
