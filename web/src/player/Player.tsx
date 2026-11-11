// Player (spec §6b): the default view of a board with a match. The map shows the match at
// playback time t (the board renders the preview this produces); this draws the transport, the
// roster with ult rings, the match source controls and the events list. Labels only.

import { For, Index, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import type { Art } from "../map/pack";
import { Dynamic } from "solid-js/web";
import { cx } from "../ui/cx";
import { boardKeys } from "../core/keys";
import type { BoardState } from "../board/state";
import type { SceneRow } from "../board/scenes";
import type { RecordId } from "../gen/RecordId";
import type { Op } from "../gen/Op";
import { type MatchEvent, clockLabel, playersAt, tierOf } from "../match/timeline";
import { UltRing } from "../match/preview";
import { matchSceneOps, matchScenesOps, slotKey, sourceOf } from "../match/save";
import { MAX_OPS_PER_TX, chunks, clearAnnotationsOps, copyAnnotationsOps, ensureLiveOps, liveIds, takeAnnotationsOps } from "./live";
import { FETCH_WHY, busy, jobLabel, queueLabel, staleUpload } from "./api";
import { PROMPT, sizeLabel } from "./notice";
import { DropOverlay, ReplayHelp, createDemDrop } from "./ReplayHelp";
import { FolderFound, FolderLink, FolderRecent, folderHas, useReplaysFolder } from "./ReplaysFolder";
import { ReplayPicker, pickerSource } from "./ReplayPicker";
import { SPEEDS } from "./clock";
import { type Dot, troopersAt } from "./troopers";
import { hoverUnit, registerHover } from "../map/HoverLabel";
import { svgPoint } from "../board/Tokens";
import { easedNumber } from "../board/smooth";
import { mapToView, worldToMap, worldToView } from "../map/transform";
import { EventsList } from "./Events";
import { eventKey, jumpTime, namesFor, placeOf, shortLabel, tierLabel } from "./events";
import type { PlayerHost } from "./host";
import { type Vision, VISIONS, hasVision } from "./vision";
import { teamName } from "../map/model";

/** ← → seek this far (seconds), with Shift the further one. */
const SEEK_KEY = 5;
const SEEK_KEY_SHIFT = 30;

export function Player(p: {
  host: PlayerHost;
  state: BoardState;
  art: Art;
  board: string;
  /** The scene the board shows (the one viewed, when not watching). */
  scene: SceneRow | undefined;
  /** View a scene (spec §6b: the map shows it, the bar stays). */
  onView: (id: RecordId) => void;
  mint: () => RecordId;
  /** A saved scene to show (the first, for several). */
  onSaved: (id: RecordId) => void;
  /** You changed the playback yourself (following stops). */
  onUserPlayback: () => void;
}) {
  const h = p.host;
  let idInput!: HTMLInputElement;
  let file!: HTMLInputElement;
  const canEdit = () => p.state.canEdit();
  const markers = () => p.art.model.markers;
  const lanes = () => p.art.model.lanes.map((l) => l.key);
  onMount(() => dismissDisclosure(() => document.querySelector<HTMLDetailsElement>(".pl-source")));

  const user = (f: () => void) => {
    p.onUserPlayback();
    f();
  };
  /** Your own Vision choice: made from what the map shows (a presenter's, while following), then
   * following stops, as any change to what you see does (spec §8). */
  const mine = (f: () => void) => {
    f();
    p.onUserPlayback();
  };
  const rows = (kind: string, scene: RecordId) => p.state.inScene(kind, scene) as never;

  /**
   * One scene at t: the timeline's state and its source, then the live annotations moved into
   * it, in transactions within the op cap (review 2026-11-08, finding 6).
   */
  const saveOne = () => {
    const m = h.tl();
    if (!m) return;
    const { id, ops } = matchSceneOps(p.state.roster(), p.state.scenes(), p.scene, m, h.t(), markers(), p.mint, lanes(), { source: sourceOf(m) });
    if (!p.state.edit(ops)) return h.setStatus("Not saved");
    const live = p.state.liveScene(h.tl()?.match_id);
    if (live) {
      const moves = takeAnnotationsOps(rows, live, id, p.mint);
      const pairs: Op[][] = [];
      for (let i = 0; i < moves.length; i += 2) pairs.push(moves.slice(i, i + 2));
      const txs = chunks(pairs, MAX_OPS_PER_TX);
      const kept = txs.filter((tx) => p.state.edit(tx)).length;
      if (kept < txs.length) h.setStatus("Some ink not moved");
    }
    p.onSaved(id);
  };
  const watching = () => h.mode() === "player";
  /** The viewed scene's moment in this match, if it has one. */
  const sourceHere = () => {
    const src = p.scene?.scene.source;
    const m = h.tl();
    return src && m && src.match_id === m.match_id ? src : undefined;
  };
  const transportTime = () => !watching() && sourceHere() ? sourceHere()!.t : h.t();
  const seekReplay = (t: number) => user(() => {
    const scene = !watching();
    h.setMode("player");
    if (scene) h.control.play(false);
    h.control.seek(t);
  });
  const toggleReplay = () => user(() => {
    if (!watching()) {
      const t = transportTime();
      h.setMode("player"); h.control.seek(t); h.control.play(true);
    } else h.control.play(!h.playback().playing);
  });
  /** Scenes saved from this match: markers on the scrubber. */
  const marks = createMemo(() => {
    const m = h.tl();
    return m ? p.state.scenes().flatMap((s) => (s.scene.source?.match_id === m.match_id ? [{ id: s.id, t: s.scene.source.t, name: s.scene.name }] : [])) : [];
  });
  /**
   * Play from here (spec §6b): the scene's drawings, copied (new ids, silent edits) over
   * whatever was in the match's live layer, then the match from the scene's moment, playing.
   * The heroes, objectives and waves are the match's: the plan over what happened.
   */
  const playFrom = () => {
    const src = sourceHere();
    const s = p.scene;
    if (!src || !s) return;
    if (canEdit() && p.state.roster().length === 12) {
      const roster = p.state.roster();
      const live = liveIds(p.board, src.match_id, roster).scene;
      const groups: Op[][] = [ensureLiveOps(p.state.records as never, p.board, src.match_id, roster)];
      const there = p.state.liveScene(src.match_id);
      if (there) groups.push(...clearAnnotationsOps(rows, there).map((o) => [o]));
      groups.push(...copyAnnotationsOps(rows, s.id, live, p.mint).map((o) => [o]));
      for (const tx of chunks(groups.filter((g) => g.length), MAX_OPS_PER_TX)) p.state.editSilent(tx);
    }
    user(() => {
      h.setMode("player");
      h.control.seek(src.t);
      h.control.play(true);
    });
  };
  const back = () => user(() => h.setMode("player"));

  // ---- the replay file: picked or dropped (spec §6b) ----
  /** An editor can give this match a replay: it has none, and nothing's on its way. */
  // A stale upload (an older parse) is upgraded by uploading the file again.
  const canUpload = () => canEdit() && !!h.matchId() && (!h.tl() || tierOf(h.tl()!) !== "replay" || staleUpload(h.job())) && !!h.job() && h.job()!.state !== "off" && !busy(h.job()) && !h.uploading();
  const take = (f: File) => h.take(f);
  // The linked replays folder (spec §6b): its file for this match, offered first when it's there.
  const folder = useReplaysFolder();
  const inFolder = () => !!folderHas(folder, h.matchId());
  // In the Windows app, the upload is its replay picker (spec §6b, The Windows app).
  const app = pickerSource();
  const [picking, setPicking] = createSignal(false);
  /** Upload replay: the app's picker, or the file dialog in a browser. */
  const UploadButton = () => (
    <Show
      when={app}
      fallback={
        <button class={cx("btn small", !inFolder() && "primary")} type="button" data-testid="match-upload" onClick={() => file.click()}>
          Upload replay file
        </button>
      }
    >
      <button class="btn small primary" type="button" data-testid="match-upload" onClick={() => setPicking(true)}>
        Upload replay
      </button>
    </Show>
  );
  // Dropped anywhere on the board while Player shows a match without its replay.
  const dragging = createDemDrop({ enabled: () => watching() && canUpload(), onFile: (f) => void take(f), onRefuse: (t) => h.setStatus(t) });

  // Keys while watching (spec §6b; the scene tree has ← → while viewing a scene): ↑ ↓ step
  // through events, ← → seek SEEK_KEY s (Shift: SEEK_KEY_SHIFT s), a Space tap plays or pauses.
  const events = createMemo(() => [...(h.tl()?.events ?? [])].sort((a, b) => a.t - b.t));
  /** The scrubber ticks' tags (shortLabel), with names as the events list has them. */
  const tickNames = createMemo(() => (h.tl() ? (h.showNames(), namesFor(h.tl()!, (id) => p.art.heroes.get(id)?.name ?? `Hero ${id}`, h.playerName)) : undefined));
  onMount(() => {
    const typing = (el: HTMLElement | null) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    const plain = (e: KeyboardEvent) => watching() && !!h.tl() && !e.altKey && !e.ctrlKey && !e.metaKey;
    const live = (e: KeyboardEvent) => plain(e) && !typing(e.target as HTMLElement | null);
    /** A Space tap so far: down, then nothing but up (no autorepeat, no pointer press: a
     * Space-drag pans the map, Board.tsx `spaceHeld`, and doesn't play). */
    let tap = false;
    /** Space plays or pauses wherever the focus is, but in a text field, a dialog or a menu
     * (#11, #3): a focused button, the scrubber, the speed or Vision list or a checkbox doesn't
     * take it. Enter still presses a focused button, for keyboard-only use (spec §6b). Captured,
     * so no control's own handler sees it first. */
    const space = (e: KeyboardEvent) => e.code === "Space" && plain(e) && boardKeys(e.target as Element | null);
    const spaceDown = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      tap = space(e) && !e.repeat;
      if (space(e)) e.preventDefault();
    };
    const key = (e: KeyboardEvent) => {
      // Arrows another handler took (the hero picker's grid) aren't ours.
      if (e.code === "Space" || e.defaultPrevented || !live(e)) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = (e.shiftKey ? SEEK_KEY_SHIFT : SEEK_KEY) * (e.key === "ArrowLeft" ? -1 : 1);
        user(() => h.control.seek(h.t() + step));
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        e.preventDefault();
        const t = h.t();
        const lead = h.lead();
        const next = e.key === "ArrowDown" ? events().find((x) => jumpTime(x, lead) > t + 0.5) : [...events()].reverse().find((x) => jumpTime(x, lead) < t - 0.5);
        if (next) jumpTo(next, lead);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== "Space" || !space(e)) return;
      // A focused button or summary takes Space as its click on keyup: never here.
      e.preventDefault();
      if (!tap) return;
      tap = false;
      user(() => h.control.play(!h.playback().playing));
    };
    const cancel = () => (tap = false);
    window.addEventListener("keydown", spaceDown, true);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", up, true);
    window.addEventListener("pointerdown", cancel, true);
    window.addEventListener("blur", cancel);
    onCleanup(() => {
      window.removeEventListener("keydown", spaceDown, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("pointerdown", cancel, true);
      window.removeEventListener("blur", cancel);
    });
  });
  const jumpTo = (e: MatchEvent, lead: number) => {
    user(() => {
      h.control.play(false);
      h.control.seek(jumpTime(e, lead));
    });
    h.flash(e, placeOf(e, markers()));
  };
  // A presenter's jump, heard while following: the same ring at the same place, and the same
  // row pinned (QA 2026-11-08). Once its timeline is here (a new match loads first).
  let rung = 0;
  createEffect(() => {
    const j = h.heardJump();
    const e = j && j.n !== rung ? events().find((x) => eventKey(x) === j.key) : undefined;
    if (!j || !e) return;
    rung = j.n;
    untrack(() => h.flash(e, placeOf(e, markers()), j.at));
  });

  return (
    <>
      <div class={cx("pl-bar", !watching() && "scene")} data-testid="player" data-state={watching() ? "match" : "scene"} role="region" aria-label="Player">
        <Show when={!watching()}>
          <div class="pl-scene-row">
            <span class="pl-scene-label" data-testid="pl-scene">
              Scene “{p.scene?.scene.name ?? ""}”
              <Show when={sourceHere()}>{(src) => <> · {clockLabel(src().t)}</>}</Show>
            </span>
            <span class="spacer" />
            <Show when={sourceHere() && h.tl()}>
              <button class="btn primary small" type="button" data-testid="play-from-here" onClick={playFrom}>
                ▶ Play with scene plan
              </button>
            </Show>
            <Show when={h.tl()}>
              <button class="btn small" type="button" data-testid="mode-player" onClick={back}>
                ↩ Back to {clockLabel(h.held()?.t ?? h.t())}
              </button>
            </Show>
          </div>
        </Show>
        <details class="pl-source" classList={{ "pl-hidden": !watching() }}>
          <summary class="btn ghost small">Match {h.matchId() || "source"} <span aria-hidden="true">▴</span></summary>
        <form
          class="pl-head"
          classList={{ "pl-hidden": !watching() }}
          onSubmit={(e) => {
            e.preventDefault();
            p.onUserPlayback();
            void h.open(idInput.value.trim(), { attach: canEdit() });
          }}
        >
          <button class="btn ghost small" type="button" data-testid="mode-sandbox" onClick={() => user(() => { const s = p.scene; h.setMode("sandbox"); if (s) p.onView(s.id); })} title="Current scene">
            Scenes
          </button>
          <Show when={canEdit()} fallback={<span class="pl-match">{h.matchId() ? `Match ${h.matchId()}` : ""}</span>}>
            <input ref={idInput} class="input pl-id" data-testid="match-id" inputMode="numeric" placeholder="Match id" aria-label="Match id" value={h.matchId() ?? ""} />
            <button class="btn small" type="submit" data-testid="match-load">
              Load
            </button>
          </Show>
          <span class="match-status" data-testid="match-status">
            {h.status()}
          </span>

          <span class="match-job pl-hidden" data-testid="match-job">
            {jobLabel(h.job(), h.progress())}
          </span>
          <Show when={canEdit() && !h.matchId()}>
            <FolderRecent onOpen={(id) => { p.onUserPlayback(); void h.open(id, { attach: true }); }} />
            <Show when={app}>
              <button class="btn small primary" type="button" data-testid="match-pick" onClick={() => setPicking(true)}>
                Select replay
              </button>
            </Show>
          </Show>
          <Show when={canUpload() && !h.notice()}>
            <FolderFound id={h.matchId()} onFile={(f) => void take(f)} />
            <UploadButton />
            <button class="btn ghost small" type="button" data-testid="match-fetch" onClick={() => void h.fetchReplay()} title="Fetch replay">
              Fetch replay
            </button>
            <ReplayHelp id={h.matchId()} />
            <FolderLink id={h.matchId()} />
          </Show>
          <span class="spacer" />
          <input
            ref={file}
            type="file"
            accept=".dem"
            hidden
            data-testid="match-file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (f) void take(f);
            }}
          />
        </form>
        </details>
        <Show when={watching() && h.uploading() && h.sent()}>
          {(u) => {
            // Changing values ease (spec §4a): the bar and its percent run to each progress event.
            const loaded = easedNumber(() => u().loaded);
            const pct = () => Math.floor(((loaded() ?? 0) / Math.max(1, u().total)) * 100);
            return (
              <div class="pl-upload" data-testid="upload-progress">
                {/* Before it's sent, the file waits for its turn (spec §6a, the queue). */}
                <Show
                  when={h.job()?.state !== "waiting"}
                  fallback={
                    <span class="pl-upload-label" data-testid="upload-waiting">
                      {queueLabel(h.job())}
                    </span>
                  }
                >
                  <span class="pl-upload-label">Uploading</span>
                  <progress class="pl-upload-bar" data-testid="upload-bar" max={u().total} value={loaded() ?? 0} data-loaded={u().loaded} />
                  <span class="pl-upload-size" data-testid="upload-size">
                    {pct()}% · {sizeLabel(u().loaded, u().total)}
                  </span>
                </Show>
                <button class="btn ghost small" type="button" data-testid="upload-cancel" onClick={() => h.cancelUpload()}>
                  Cancel
                </button>
              </div>
            );
          }}
        </Show>
        <Show when={watching() && h.notice()}>
          {(n) => (
            <div class="pl-notice" data-testid="match-notice" role="status">
              <span class="pl-notice-text">
                <b data-testid="match-notice-text">{n().text}</b>
                <Show when={n().line}>
                  <span class="pl-notice-line" data-testid="match-notice-line">
                    {n().line}
                  </span>
                </Show>
              </span>
              <Show when={n().actions.includes("retry") && (canEdit() || n().step === "load")}>
                <button class="btn small" type="button" data-testid="match-retry" onClick={() => h.retry(canEdit())}>
                  Try again
                </button>
              </Show>
              <Show when={n().actions.includes("upload") && canUpload()}>
                <FolderFound id={h.matchId()} onFile={(f) => void take(f)} />
                <UploadButton />
                <ReplayHelp id={h.matchId()} />
                <FolderLink id={h.matchId()} />
              </Show>
            </div>
          )}
        </Show>
        <DropOverlay over={dragging()} id={h.matchId()} />
        <Show when={app && picking()}>
          <ReplayPicker
            source={app!}
            art={p.art}
            current={h.matchId()}
            onClose={() => setPicking(false)}
            onPick={(r) => {
              setPicking(false);
              p.onUserPlayback();
              void h.pick(r);
            }}
          />
        </Show>
        <Show when={(watching() || sourceHere()) && h.tl()}>
          {(m) => (
            <div class="pl-transport">
              <button class="btn small" type="button" data-testid="match-back" aria-label="Back 10 s" title="−10 s (← 5 s, Shift+← 30 s)" onClick={() => seekReplay(transportTime() - 10)}>
                −10
              </button>
              <button class="btn small pl-play" type="button" data-testid="match-play" aria-label={!watching() ? "Resume replay" : h.playback().playing ? "Pause" : "Play"} title={!watching() ? "Resume replay" : "Play / Pause (Space)"} onClick={toggleReplay}>
                {!watching() ? "Resume" : h.playback().playing ? "Pause" : "Play"}
              </button>
              <button class="btn small" type="button" data-testid="match-forward" aria-label="Forward 10 s" title="+10 s (→ 5 s, Shift+→ 30 s)" onClick={() => seekReplay(transportTime() + 10)}>
                +10
              </button>
              <select class="input pl-speed" data-testid="match-speed" aria-label="Speed" value={String(h.playback().speed)} onChange={(e) => {
                  user(() => h.control.speed(Number(e.currentTarget.value)));
                  // Picked: hand the keys back to the board (← → seek, Space plays).
                  e.currentTarget.blur();
                }}>
                <For each={SPEEDS}>{(s) => <option value={String(s)}>{s}×</option>}</For>
              </select>
              <div class="pl-scrub">
                {/* Events (#6): a hover grows the tick and shows its tag; a press jumps there, as
                    ↑ ↓ do (which is the keyboard's way: the ticks aren't in the tab order). */}
                <div class="pl-ticks">
                  <For each={m().events ?? []}>{(e) => (
                    <button type="button" tabindex="-1" class={cx("pl-tick", e.kind, edge(e.t / Math.max(1, m().duration_s)))} data-testid="scrub-tick" data-t={e.t} data-kind={e.kind}
                      style={{ left: `${(e.t / Math.max(1, m().duration_s)) * 100}%` }}
                      aria-label={`${tickNames() ? shortLabel(e, tickNames()!) : e.kind}, ${clockLabel(e.t)}`}
                      onClick={() => jumpTo(e, h.lead())}>
                      <span class="pl-tick-tag" aria-hidden="true">{tickNames() ? shortLabel(e, tickNames()!) : ""}</span>
                    </button>
                  )}</For>
                </div>
                <div class="pl-marks">
                  <For each={marks()}>
                    {(k) => (
                      <button
                        type="button"
                        class={cx("pl-mark", !watching() && p.scene?.id === k.id && "current")}
                        data-testid="scene-mark"
                        data-t={k.t}
                        title={k.name}
                        aria-label={`Scene ${k.name}`}
                        style={{ left: `${(k.t / Math.max(1, m().duration_s)) * 100}%` }}
                        onClick={() => {
                          p.onUserPlayback();
                          p.onView(k.id);
                        }}
                      />
                    )}
                  </For>
                </div>
                <input
                  class="match-range"
                  data-testid="match-time"
                  type="range"
                  min="0"
                  max={m().duration_s}
                  step="1"
                  value={Math.floor(transportTime())}
                  aria-label="Match time"
                  onInput={(e) => seekReplay(Number(e.currentTarget.value))}
                />
              </div>
              {/* The toggles, the clock and Save scene go to a row of their own, as one, when the
                  bar is too narrow for them beside the scrubber (QA 2026-11-08). */}
              <div class="pl-tail">
              <span class="match-clock" data-testid="match-clock">
                {clockLabel(transportTime())} / {clockLabel(m().duration_s)}
              </span>
              <Show when={canEdit() && watching()}>
                <button class="btn primary small" type="button" data-testid="match-save" onClick={saveOne}>
                  Save scene
                </button>
              </Show>
              </div>
            </div>
          )}
        </Show>
      </div>
    </>
  );
}


function dismissDisclosure(element: () => HTMLDetailsElement | null) {
  const close = (e: Event) => {
    const box = element();
    if (!box?.open) return;
    if (e instanceof KeyboardEvent) {
      if (e.key !== "Escape") return;
      box.open = false;
      box.querySelector("summary")?.focus();
    } else if (!box.contains(e.target as Node)) box.open = false;
  };
  window.addEventListener("pointerdown", close, true);
  window.addEventListener("keydown", close);
  onCleanup(() => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", close); });
}

/** Display preferences live beside the canvas, separate from annotation tools and transport. */
export function MapControls(p: {
  host: PlayerHost; heals: boolean; crates: boolean;
  toggleHeals: () => void; toggleCrates: () => void;
  flip: () => void; onUserPlayback: () => void;
}) {
  const h = p.host;
  let layers: HTMLDetailsElement | undefined;
  onMount(() => dismissDisclosure(() => layers ?? null));
  // A change to what the map draws is your own: following stops, and you keep what you were
  // seeing with that one change (spec §8). Player names are this browser's alone, never followed.
  const mine = (f: () => void) => { f(); p.onUserPlayback(); };
  useVisionKeys(h, mine);
  return <div class="map-controls" role="group" aria-label="Map view">
    <details class="map-layers" ref={layers}>
      <summary class="btn small" data-testid="map-layers-toggle">Map layers ▾</summary>
      <div class="map-layers-pop">
        <Show when={h.tl()}>{m => <>
          <h3>Replay layers</h3>
              <Show when={m().troopers}>
                <button
                  type="button"
                  class={cx("btn ghost small", h.showTroopers() && "on")}
                  data-testid="troopers-toggle"
                  aria-pressed={h.showTroopers()}
                  onClick={() => mine(() => h.setShowTroopers(!h.showTroopers()))}
                >
                  Lane troopers
                </button>
              </Show>
              <Show when={m().tier === "replay"}>
                <button
                  type="button"
                  class={cx("btn ghost small", h.showHealth() && "on")}
                  data-testid="health-toggle"
                  aria-pressed={h.showHealth()}
                  onClick={() => mine(() => h.setShowHealth(!h.showHealth()))}
                >
                  Health bars & arcs
                </button>
              </Show>
              <Show when={m().players.some((x) => x.name)}>
                <button
                  type="button"
                  class={cx("btn ghost small", h.showNames() && "on")}
                  data-testid="names-toggle"
                  aria-pressed={h.showNames()}
                  onClick={() => h.setShowNames(!h.showNames())}
                >
                  Player names
                </button>
              </Show>
              <button
                type="button"
                class={cx("btn ghost small", h.showPings() && "on")}
                data-testid="pings-toggle"
                aria-pressed={h.showPings()}
                onClick={() => mine(() => h.setShowPings(!h.showPings()))}
              >
                Event pings
              </button>

        </>}</Show>
        <Show when={h.tl()?.players.some(player => player.cc?.length)}><button class="btn ghost small" data-testid="cc-toggle" aria-pressed={h.showCC()} onClick={() => mine(() => h.setShowCC(!h.showCC()))}>Crowd control</button></Show>
        <Show when={h.tl()?.players.some(player => player.height?.length || player.zipline?.length)}><button class="btn ghost small" data-testid="movement-toggle" aria-pressed={h.showMovement()} onClick={() => mine(() => h.setShowMovement(!h.showMovement()))}>Elevation & ziplines</button></Show>
        <h3>Map pickups</h3>
        <button class="btn ghost small" data-testid="heals-toggle" aria-pressed={p.heals} onClick={() => mine(p.toggleHeals)}>Healing pickups</button>
        <button class="btn ghost small" data-testid="crates-toggle" aria-pressed={p.crates} onClick={() => mine(p.toggleCrates)}>Heavy boxes</button>
      </div>
    </details>
    <Show when={h.tl()}>{m => <>
              <Show when={hasVision(m())}>
                <>
                  <select
                    class="input pl-vision"
                    data-testid="vision-select"
                    aria-label="Vision"
                    aria-keyshortcuts="1 2 3"
                    title="Vision (1, 2, 3)"
                    value={h.vision()}
                    onChange={(e) => mine(() => h.setVision(e.currentTarget.value as Vision))}
                  >
                    <For each={VISIONS}>{(v) => <option value={v}>Vision: {v === "all" ? "All" : teamName(v)}</option>}</For>
                  </select>
                  <Show when={h.vision() !== "all"}>
                    <button
                      type="button"
                      class={cx("btn ghost small", h.showLastSeen() && "on")}
                      data-testid="last-seen-toggle"
                      aria-pressed={h.showLastSeen()}
                      onClick={() => mine(() => h.setShowLastSeen(!h.showLastSeen()))}
                    >
                      Last seen
                    </button>
                  </Show>
                </>
              </Show>
    </>}</Show>
    <button class="btn small map-flip" data-testid="viewpoint-flip" title="Flip map" aria-label="Flip map" onClick={p.flip}>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v11M2 10l3 3 3-3M11 14V3M8 6l3-3 3 3" /></svg>
      Flip map
    </button>
    <VisionMark host={h} />
  </div>;
}

/** The Vision in force, in its team's colour, and whether ghosts show (#12): a follower sees
 * the presenter's at a glance. Nothing under "All". */
function VisionMark(p: { host: PlayerHost }) {
  const h = p.host;
  return <Show when={h.tl() && hasVision(h.tl()!) && h.vision() !== "all" ? (h.vision() as "amber" | "sapphire") : undefined}>{team =>
    <span class={cx("vision-mark", team())} data-testid="vision-mark" data-team={team()} data-ghosts={h.showLastSeen() ? "on" : "off"} role="status" aria-label={`${teamName(team())} vision${h.showLastSeen() ? ", Last seen" : ""}`}>
      <i aria-hidden="true" />{teamName(team())}
      <Show when={h.showLastSeen()}><small>Last seen</small></Show>
    </span>
  }</Show>;
}

/** Vision's keys (#10): 1 All, 2 Hidden King, 3 Archmother, as the list orders them; off while
 * typing, in a dialog or a menu. Changing it is your own view, so following stops. */
function useVisionKeys(h: PlayerHost, mine: (f: () => void) => void) {
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.repeat || e.defaultPrevented) return;
      const i = ["Digit1", "Digit2", "Digit3", "Numpad1", "Numpad2", "Numpad3"].indexOf(e.code) % 3;
      const tl = h.tl();
      if (i < 0 || !tl || !hasVision(tl) || h.mode() !== "player" || !boardKeys(e.target as Element | null)) return;
      e.preventDefault();
      const v = VISIONS[i]!;
      if (v !== h.vision()) mine(() => h.setVision(v));
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
}

/**
 * Which tier the match is loaded at, in words (operator, 2026-11-08): "Full replay" or "API
 * summary", or the upgrade under way. Tap or hover the summary for what it lacks.
 */
export function TierChip(p: { host: PlayerHost }) {
  const h = p.host;
  const [why, setWhy] = createSignal(false);
  const [fresh, setFresh] = createSignal(false);
  const replay = () => (h.tl() ? tierOf(h.tl()!) === "replay" : false);
  let was: boolean | undefined;
  createEffect(() => {
    const r = replay();
    if (was === false && r) {
      setFresh(true);
      setTimeout(() => setFresh(false), 2500);
    }
    was = r;
  });
  const text = () => {
    const j = h.job();
    if (j?.state === "uploading") return h.progress() === undefined ? "Uploading…" : `Uploading ${h.progress()}%`;
    // A stale fetched replay being fetched again in the newer format: shown meanwhile.
    if (j?.state === "fetching") return replay() ? "Updating replay…" : "Fetching replay…";
    // Where it is in the queue (spec §6a): "Queued · 3 ahead · ~1 min", "Waiting for a slot · 2 ahead".
    const q = queueLabel(j);
    if (q) return q;
    if (j?.state === "parsing") return "Parsing replay…";
    return replay() ? "Full replay" : "API summary";
  };
  /** Why the full replay isn't coming, when the fetch said (a label). */
  const fetchWhy = () => {
    const j = h.job();
    return !replay() && j?.state === "failed" && j.source === "cdn" ? FETCH_WHY[j.reason ?? ""] : undefined;
  };
  const hint = () => (replay() ? (staleUpload(h.job()) ? `Parsed from the replay file · ${OLDER_PARSE}` : "Parsed from the replay file") : [fetchWhy(), WHAT_SUMMARY_LACKS].filter(Boolean).join(" · "));
  // A button only where a press opens something (#36): the tab that opened the match gets its
  // prompt back (spec §6b), and at the API summary everyone else gets the "why". At the full
  // replay it's a tag with its hover hint.
  const opens = () => h.canPrompt() || !replay();
  return (
    <span class="pl-tier-wrap">
      <Dynamic
        component={opens() ? "button" : "span"}
        type={opens() ? "button" : undefined}
        class={cx("pl-tier", replay() ? "replay" : "summary", busy(h.job()) && "busy", fresh() && "fresh", !opens() && "tag")}
        data-testid="match-tier"
        data-tier={replay() ? "replay" : "metadata"}
        data-why={fetchWhy() ?? ""}
        data-stale={staleUpload(h.job()) ? "true" : undefined}
        title={h.canPrompt() ? PROMPT.chip : hint()}
        onClick={opens() ? () => (h.canPrompt() ? h.prompt.open() : setWhy(!why())) : undefined}
      >
        {text()}
      </Dynamic>
      <Show when={why() && !replay()}>
        <span class="pl-tier-why" data-testid="tier-why">
          <Show when={fetchWhy()}>
            {(w) => (
              <b class="pl-tier-reason" data-testid="tier-reason">
                {w()}
              </b>
            )}
          </Show>
          {WHAT_SUMMARY_LACKS}
        </span>
      </Show>
    </span>
  );
}

/** A tick near the scrubber's ends: its tag opens inward, so it stays on screen. */
const edge = (at: number) => (at < 0.1 ? "near-start" : at > 0.9 ? "near-end" : undefined);

const WHAT_SUMMARY_LACKS = "No health, ult timers, zipline colours, camps, rifts or powerups";
/** A stale upload's hint (spec §6a, format versions): the newer layers come with the file. */
const OLDER_PARSE = "An older parse: upload the replay file again for the newest layers";

/** Where a jump landed: a ring that pulses there for a few seconds (map → view units). */
export function Highlight(p: { at: { x: number; y: number } | undefined; vp: "amber" | "sapphire" | "neutral" }) {
  const v = () => (p.at ? (p.vp === "sapphire" ? { x: 1000 - p.at.x, y: 1000 - p.at.y } : p.at) : undefined);
  return (
    <Show when={v()}>
      {(c) => (
        <g class="pl-highlight" data-testid="event-highlight" transform={`translate(${c().x} ${c().y})`}>
          <circle r="22" />
          <circle r="10" />
        </g>
      )}
    </Show>
  );
}

/**
 * Event pings (spec §6b): a short ring where each event the playback passes happened, one per
 * event so overlapping ones all show. Deaths at the victim's place (the event's own, else where
 * the hero was then), objectives on their icon; an event with no place has no ring.
 */
export function EventPings(p: { host: PlayerHost; art: Art; vp: "amber" | "sapphire" | "neutral" }) {
  const placeFor = (e: MatchEvent) => {
    const own = placeOf(e, p.art.model.markers);
    if (own) return own;
    const m = p.host.tl();
    if (!m || !e.team || e.slot == null) return undefined;
    const x = playersAt(m, e.t).find((q) => q.team === e.team && q.slot === e.slot);
    const w = x?.pos ?? x?.last;
    return w ? worldToMap(w) : undefined;
  };
  return (
    <g class="pl-pings" data-testid="event-pings">
      <For each={p.host.showPings() ? p.host.pings() : []}>
        {(q) => {
          const at = placeFor(q.event);
          if (!at) return null;
          const v = () => mapToView(at, p.vp);
          return (
            <g
              class={cx("pl-ping", q.event.team ?? "neutral")}
              data-testid="event-ping"
              data-kind={q.event.kind}
              data-t={q.event.t}
              transform={`translate(${v().x} ${v().y})`}
              style={{ "--life": `${q.life}ms` }}
            >
              <circle class="halo" r="20" />
              <circle r="20" />
            </g>
          );
        }}
      </For>
    </g>
  );
}

/**
 * In Sandbox, the way back to Player: for this board's match, or one someone here is playing
 * (the board learned of it after you opened it).
 */
export function PlayerSwitch(p: { host: PlayerHost; state: BoardState; onSwitch: () => void }) {
  const peerMatch = () => p.state.peerList().find((x) => x.state?.playback)?.state?.playback?.match_id;
  const target = () => p.host.matchId() ?? (peerMatch() !== undefined ? String(peerMatch()) : undefined);
  return (
    <Show when={target() || p.state.canEdit()}>
      <button
        class="btn small pl-switch"
        data-testid="mode-player"
        onClick={() => {
          p.onSwitch();
          // No match yet: an editor gets Player with the match-id prompt.
          if (p.host.matchId() || !target()) p.host.setMode("player");
          else void p.host.open(target()!, { attach: false });
        }}
      >
        Player
      </button>
    </Show>
  );
}

type Props = {
  host: PlayerHost;
  state: BoardState;
  art: Art;
  scene: SceneRow | undefined;
  mint: () => RecordId;
  onSaved: (id: RecordId) => void;
  onUserPlayback: () => void;
};

/** Player's sidebar: the roster with ult rings, the events list and the credit line. The board
 * puts it in its right column, above the people list. */
export function PlayerSide(p: Props) {
  const h = p.host;
  const canEdit = () => p.state.canEdit();
  const markers = () => p.art.model.markers;
  const lanes = () => p.art.model.lanes.map((l) => l.key);
  const heroName = (id: number) => p.art.heroes.get(id)?.name ?? `Hero ${id}`;
  // Re-made when Names flips, so the list's labels and search follow it.
  const names = createMemo(() => (h.tl() ? (h.showNames(), namesFor(h.tl()!, heroName, h.playerName)) : undefined));
  const at = createMemo(() => (h.tl() ? new Map(playersAt(h.tl()!, h.t()).map((x) => [slotKey(x.team, x.slot), x])) : new Map()));
  const user = (f: () => void) => {
    p.onUserPlayback();
    f();
  };
  /**
   * One scene per event, in transactions within the op cap (one undo each; review 2026-11-08,
   * finding 6). Scenes in a refused transaction aren't made; the rest stand, and it says so.
   */
  const saveMany = (events: MatchEvent[], lead: number): Set<string> => {
    const m = h.tl();
    const n = names();
    const saved = new Set<string>();
    if (!m || !n || !events.length) return saved;
    const sorted = [...events].sort((a, b) => a.t - b.t);
    const moments = sorted.map((e) => ({ t: jumpTime(e, lead), name: shortLabel(e, n) }));
    const { ids, groups } = matchScenesOps(p.state.roster(), p.state.scenes(), p.scene, m, moments, markers(), p.mint, lanes());
    // Chunk whole scenes, remembering which events each transaction carries.
    let i = 0;
    let first: RecordId | undefined;
    for (const tx of chunks(groups, MAX_OPS_PER_TX)) {
      const inTx: number[] = [];
      let count = 0;
      while (i < groups.length && count + groups[i]!.length <= tx.length) {
        count += groups[i]!.length;
        inTx.push(i++);
      }
      if (p.state.edit(tx)) {
        for (const k of inTx) saved.add(eventKey(sorted[k]!));
        first ??= ids[inTx[0] ?? 0];
      }
    }
    if (saved.size < events.length) h.setStatus(`Saved ${saved.size} of ${events.length}`);
    if (first) p.onSaved(first);
    return saved;
  };
  const jump = (e: MatchEvent, lead: number) => {
    user(() => {
      h.setMode("player");
      h.control.play(false);
      h.control.seek(jumpTime(e, lead));
    });
    h.flash(e, placeOf(e, markers()));
  };

  return (
    <>
      <section class="pl-side" data-testid="player-side">
        <Show when={h.tl()}>
          {(m) => (
            <>
              <EventsList art={p.art} tl={m()} names={names()!} tier={tierLabel(m())} canSave={canEdit()} onJump={jump} onSave={saveMany} lead={h.lead} setLead={h.setLead} t={h.t} playing={() => h.playback().playing} onShown={h.setPingable} pinned={h.pinned} recapOpen={h.eventRecapOpen} onRecap={h.setEventRecapOpen} />
              <span class="match-credit" data-testid="match-credit">
                {tierOf(m()) === "replay" ? (h.job()?.source === "cdn" ? "Replay: Valve, via deadlock-api.com" : "Replay: uploaded") : "Match data: deadlock-api.com"}
              </span>
            </>
          )}
        </Show>
      </section>
    </>
  );
}

/**
 * The replay's lane troopers, as the in-game minimap draws them: small dots in the team's colour
 * with a dark rim, under the heroes, sliding between samples and gone when they die (spec §6b).
 * A captured rift's troopers are bigger and darker, as in game (feedback #5), and say so on hover
 * (a follower resolves the presenter's hover from its key). Like the map's icons they keep their
 * size on screen as you zoom (`k`). Drawn with `Index`, so a frame moves the same circles rather
 * than making new ones (100+ at 8×).
 */
export function TrooperDots(p: { host: PlayerHost; vp: "amber" | "sapphire" | "neutral"; k?: number }) {
  const dots = createMemo(() => {
    const m = p.host.tl();
    return m && p.host.showTroopers() ? troopersAt(m, p.host.t()) : [];
  });
  const r = () => TROOPER_R * (p.k ?? 1);
  const rifts = createMemo(() => dots().filter((d) => d.rift));
  const key = (d: Dot) => `${RIFT_HOVER}${d.team}:${d.id}`;
  const spot = (d: Dot) => worldToView(d, p.vp);
  // The rift troopers drawn now can say what they are, from this browser's own playback.
  const keys = createMemo(() => rifts().map(key).join(" "), "", { equals: (a, b) => a === b });
  createMemo(() => {
    const offs = keys()
      .split(" ")
      .filter(Boolean)
      .map((k) =>
        registerHover("marker", k, () => {
          const d = rifts().find((x) => key(x) === k);
          return d ? { x: spot(d).x, y: spot(d).y, gap: r() * RIFT_SCALE + 8 * (p.k ?? 1), text: "Rift trooper" } : undefined;
        }),
      );
    onCleanup(() => offs.forEach((f) => f()));
  });
  let g!: SVGGElement;
  onMount(() => {
    // Hit-tested on the overlay, never intercepting: drawing and the tools work over a dot.
    const svg = g.ownerSVGElement;
    if (!svg) return;
    const near = (at: { x: number; y: number }) => {
      let best: { k: string; d: number } | undefined;
      for (const d of rifts()) {
        const v = spot(d);
        const dist = Math.hypot(v.x - at.x, v.y - at.y);
        if (dist <= r() * RIFT_SCALE + 3 * (p.k ?? 1) && (!best || dist < best.d)) best = { k: key(d), d: dist };
      }
      return best?.k;
    };
    const set = (k: string | undefined) => hoverUnit(k ? { kind: "marker", id: k } : undefined);
    const move = (e: PointerEvent) => {
      if (e.pointerType === "mouse" || e.pointerType === "pen") set(near(svgPoint(svg, e)));
    };
    const leave = () => set(undefined);
    svg.addEventListener("pointermove", move, { passive: true });
    svg.addEventListener("pointerleave", leave, { passive: true });
    onCleanup(() => {
      svg.removeEventListener("pointermove", move);
      svg.removeEventListener("pointerleave", leave);
      set(undefined);
    });
  });
  return (
    <g ref={g} class="pl-troopers" data-testid="troopers">
      <Index each={dots()}>
        {(d) => {
          const at = () => worldToView(d(), p.vp);
          return <circle class={cx("pl-trooper", d().team, d().rift && "rift")} data-testid="trooper" data-rift={d().rift ? "" : undefined} cx={at().x} cy={at().y} r={d().rift ? r() * RIFT_SCALE : r()} />;
        }}
      </Index>
    </g>
  );
}
/** A trooper's radius in map units at the default view: about a third of a hero token's. */
const TROOPER_R = 5;
/** A rift trooper's dot against a lane trooper's: the game draws the unit at 1.57 to 1.66 times
 * the scale (docs/research/replay-parsing-exploration.md round 8). */
const RIFT_SCALE = 1.6;
/** A rift trooper's hover key: `rift-trooper:<team>:<id>`. */
const RIFT_HOVER = "rift-trooper:";
