// One board: the header (title, save status, people), the map with its layers, and the side
// panel. The map is the interface: edits happen on it directly.

import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
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
import { createBoardState } from "./state";
import { Tokens } from "./Tokens";


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
  const [tool] = createSignal("move");
  const [overlay, setOverlay] = createSignal<SVGSVGElement>();

  const scene = createMemo(() => {
    const all = state.scenes();
    return all.find((s) => s.id === sceneId()) ?? all[0];
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
        <SaveStatus state={state} />
        <div class="avatars" data-testid="avatars">
          <Show when={me() && joined()}>
            <span class="av ring" style={{ background: colorOf(me()!.color) }} title={`${me()!.name} (you)`}>
              {avatarLetter(me()!.name)}
            </span>
          </Show>
          <For each={people()}>
            {(peer) => (
              <span class="av" style={{ background: colorOf(peer.state!.color) }} title={peer.state!.name || "Someone joining"}>
                {avatarLetter(peer.state!.name)}
              </span>
            )}
          </For>
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
          <div class="mapbox" data-testid="map">
            <MapView
              art={p.art}
              viewpoint={viewpoint()}
              overlayRef={setOverlay}
              overlayProps={{ "data-tool": tool(), classList: { readonly: !state.canEdit() } } as never}
            >
              <Tokens state={state} art={p.art} vp={viewpoint()} scene={scene()?.id} tool={tool()} k={1} svg={overlay} />
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
          <div class="tb-hint">
            <b>Move</b> Drag a hero to move it; everyone sees it live.
          </div>
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
              People here <small>{people().length + (joined() ? 1 : 0)} online</small>
            </h2>
            <div class="people" data-testid="people">
              <Show when={me() && joined()}>
                <div class="person">
                  <span class="av" style={{ background: colorOf(me()!.color) }}>
                    {avatarLetter(me()!.name)}
                  </span>
                  <span class="nm">
                    <b>
                      {me()!.name} <span class="you-tag">(you)</span>
                    </b>
                    <span class="state">{state.role() ?? ""}</span>
                  </span>
                </div>
              </Show>
              <For each={people()}>
                {(peer) => (
                  <div class="person">
                    <span class="av" style={{ background: colorOf(peer.state!.color) }}>
                      {avatarLetter(peer.state!.name)}
                    </span>
                    <span class="nm">
                      <b>{peer.state!.name || "Someone joining"}</b>
                      <span class="state">{peer.role}</span>
                    </span>
                  </div>
                )}
              </For>
            </div>
          </section>
        </aside>
      </div>
      <SceneStrip state={state} art={p.art} vp={viewpoint()} current={scene()?.id} onFlip={setSceneId} />
      <Show when={!joined()}>
        <JoinCard title={state.title()} others={people().map((x) => x.state!.name).filter(Boolean)} initial={me()} onJoin={join} />
      </Show>
    </div>
  );
}
