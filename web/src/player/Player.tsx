// Player (spec §6b): the default view of a board with a match. The map shows the match at
// playback time t (the board renders the preview this produces); this draws the transport, the
// roster with ult rings, the match source controls and the events list. Labels only.

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { cx } from "../ui/cx";
import type { BoardState } from "../board/state";
import type { SceneRow } from "../board/scenes";
import type { RecordId } from "../gen/RecordId";
import type { Op } from "../gen/Op";
import { type MatchEvent, clockLabel, playersAt, tierOf } from "../match/timeline";
import { UltRing } from "../match/preview";
import { matchSceneOps, matchScenesOps, slotKey, sourceOf } from "../match/save";
import { MAX_OPS_PER_TX, chunks, clearAnnotationsOps, copyAnnotationsOps, ensureLiveOps, liveIds, takeAnnotationsOps } from "./live";
import { busy, jobLabel } from "./api";
import { SPEEDS } from "./clock";
import { troopersAt } from "./troopers";
import { mapToView, worldToMap, worldToView } from "../map/transform";
import { EventsList } from "./Events";
import { eventKey, jumpTime, namesFor, placeOf, shortLabel, tierLabel } from "./events";
import type { PlayerHost } from "./host";

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

  const user = (f: () => void) => {
    p.onUserPlayback();
    f();
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

  // ← → step through events while watching (the scene tree steps scenes while viewing one).
  const events = createMemo(() => [...(h.tl()?.events ?? [])].sort((a, b) => a.t - b.t));
  onMount(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (!watching() || (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return;
      if (e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      const t = h.t();
      const lead = h.lead();
      const next = e.key === "ArrowRight" ? events().find((x) => jumpTime(x, lead) > t + 0.5) : [...events()].reverse().find((x) => jumpTime(x, lead) < t - 0.5);
      e.preventDefault();
      if (next) jumpTo(next, lead);
    };
    window.addEventListener("keydown", key);
    onCleanup(() => window.removeEventListener("keydown", key));
  });
  const jumpTo = (e: MatchEvent, lead: number) => {
    user(() => {
      h.control.play(false);
      h.control.seek(jumpTime(e, lead));
    });
    h.flash(e, placeOf(e, markers()));
  };

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
                ▶ Play from here
              </button>
            </Show>
            <Show when={h.tl()}>
              <button class="btn small" type="button" data-testid="mode-player" onClick={back}>
                ↩ Back to {clockLabel(h.held()?.t ?? h.t())}
              </button>
            </Show>
          </div>
        </Show>
        <form
          class="pl-head"
          classList={{ "pl-hidden": !watching() }}
          onSubmit={(e) => {
            e.preventDefault();
            p.onUserPlayback();
            void h.open(idInput.value.trim(), { attach: canEdit() });
          }}
        >
          <button class="btn ghost small" type="button" data-testid="mode-sandbox" onClick={() => user(() => { const s = p.scene; h.setMode("sandbox"); if (s) p.onView(s.id); })} title="View the current scene">
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
          <Show when={h.tl() || busy(h.job())}>
            <TierChip host={h} />
          </Show>
          <span class="match-job pl-hidden" data-testid="match-job">
            {jobLabel(h.job(), h.progress())}
          </span>
          <Show when={canEdit() && h.matchId() && (!h.tl() || tierOf(h.tl()!) !== "replay") && h.job() && h.job()!.state !== "off" && !busy(h.job())}>
            <button class="btn primary small" type="button" data-testid="match-upload" onClick={() => file.click()} title={REPLAY_HINT}>
              Upload replay file
            </button>
            <button class="btn ghost small" type="button" data-testid="match-fetch" onClick={() => void h.fetchReplay()} title="Fetch the replay from Valve">
              Fetch replay
            </button>
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
              if (!f) return;
              // The game names a replay after its match: refuse another match's file.
              const named = /^(\d+)/.exec(f.name)?.[1]?.replace(/^0+/, "");
              if (named && h.matchId() && named !== h.matchId()) return h.setStatus(`That file is match ${named}`);
              void h.upload(f);
            }}
          />
        </form>
        <Show when={watching() && h.tl()}>
          {(m) => (
            <div class="pl-transport">
              <button class="btn small" type="button" data-testid="match-back" aria-label="Back 10 s" title="−10 s" onClick={() => user(() => h.control.seek(h.t() - 10))}>
                −10
              </button>
              <button class="btn small" type="button" data-testid="match-play" aria-label={h.playback().playing ? "Pause" : "Play"} onClick={() => user(() => h.control.play(!h.playback().playing))}>
                {h.playback().playing ? "Pause" : "Play"}
              </button>
              <button class="btn small" type="button" data-testid="match-forward" aria-label="Forward 10 s" title="+10 s" onClick={() => user(() => h.control.seek(h.t() + 10))}>
                +10
              </button>
              <select class="input pl-speed" data-testid="match-speed" aria-label="Speed" value={String(h.playback().speed)} onChange={(e) => user(() => h.control.speed(Number(e.currentTarget.value)))}>
                <For each={SPEEDS}>{(s) => <option value={String(s)}>{s}×</option>}</For>
              </select>
              <div class="pl-scrub">
                <div class="pl-ticks" aria-hidden="true">
                  <For each={m().events ?? []}>{(e) => <i class={cx("pl-tick", e.kind)} style={{ left: `${(e.t / Math.max(1, m().duration_s)) * 100}%` }} />}</For>
                </div>
                <div class="pl-marks">
                  <For each={marks()}>
                    {(k) => (
                      <button
                        type="button"
                        class="pl-mark"
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
                  value={Math.floor(h.t())}
                  aria-label="Match time"
                  onInput={(e) => user(() => h.control.seek(Number(e.currentTarget.value)))}
                />
              </div>
              <Show when={m().troopers}>
                <button
                  type="button"
                  class={cx("btn ghost small", h.showTroopers() && "on")}
                  data-testid="troopers-toggle"
                  aria-pressed={h.showTroopers()}
                  title="The replay's lane troopers, to check the wave splits"
                  onClick={() => h.setShowTroopers(!h.showTroopers())}
                >
                  Troopers
                </button>
              </Show>
              <Show when={m().tier === "replay"}>
                <button
                  type="button"
                  class={cx("btn ghost small", h.showHealth() && "on")}
                  data-testid="health-toggle"
                  aria-pressed={h.showHealth()}
                  title="Heroes' and objectives' health"
                  onClick={() => h.setShowHealth(!h.showHealth())}
                >
                  Health
                </button>
              </Show>
              <button
                type="button"
                class={cx("btn ghost small", h.showPings() && "on")}
                data-testid="pings-toggle"
                aria-pressed={h.showPings()}
                title="Ping each event on the map as playback passes it"
                onClick={() => h.setShowPings(!h.showPings())}
              >
                Pings
              </button>
              <span class="match-clock" data-testid="match-clock">
                {clockLabel(h.t())} / {clockLabel(m().duration_s)}
              </span>
              <Show when={canEdit()}>
                <button class="btn primary small" type="button" data-testid="match-save" onClick={saveOne}>
                  Save scene
                </button>
              </Show>
            </div>
          )}
        </Show>
      </div>
    </>
  );
}

/** Where Deadlock keeps replays (the landing page's "Select replay file" says the same). */
export const REPLAY_HINT = "Deadlock saves replays in …/steamapps/common/Deadlock/game/citadel/replays/ (the file name is the match id)";

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
    if (j?.state === "fetching") return "Fetching replay…";
    if (j?.state === "queued" || j?.state === "parsing") return "Parsing replay…";
    return replay() ? "Full replay" : "API summary";
  };
  return (
    <span class="pl-tier-wrap">
      <button
        type="button"
        class={cx("pl-tier", replay() ? "replay" : "summary", busy(h.job()) && "busy", fresh() && "fresh")}
        data-testid="match-tier"
        data-tier={replay() ? "replay" : "metadata"}
        title={replay() ? "Parsed from the replay file" : WHAT_SUMMARY_LACKS}
        onClick={() => setWhy(!why())}
      >
        {text()}
      </button>
      <Show when={why() && !replay()}>
        <span class="pl-tier-why" data-testid="tier-why">
          {WHAT_SUMMARY_LACKS}
        </span>
      </Show>
    </span>
  );
}

const WHAT_SUMMARY_LACKS = "No health, ult timers, zipline colours, camps, rifts or powerups";

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
  const names = createMemo(() => (h.tl() ? namesFor(h.tl()!, heroName) : undefined));
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
              <EventsList tl={m()} names={names()!} tier={tierLabel(m())} canSave={canEdit()} onJump={jump} onSave={saveMany} lead={h.lead} setLead={h.setLead} t={h.t} playing={() => h.playback().playing} onShown={h.setPingable} />
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

/** The replay's lane troopers as small team dots, under the heroes (spec §6b; a wave debug view). */
export function TrooperDots(p: { host: PlayerHost; vp: "amber" | "sapphire" | "neutral" }) {
  const dots = createMemo(() => {
    const m = p.host.tl();
    return m && p.host.showTroopers() ? troopersAt(m, p.host.t()) : [];
  });
  return (
    <g class="pl-troopers" data-testid="troopers">
      <For each={dots()}>
        {(d) => {
          const at = () => worldToView({ x: d.x, y: d.y }, p.vp);
          return <circle class={cx("pl-trooper", d.team)} data-testid="trooper" cx={at().x} cy={at().y} r="7" />;
        }}
      </For>
    </g>
  );
}
