// Player (spec §6b): the default view of a board with a match. The map shows the match at
// playback time t (the board renders the preview this produces); this draws the transport, the
// roster with ult rings, the match source controls and the events list. Labels only.

import { For, Show, createEffect, createMemo, onCleanup } from "solid-js";
import type { Art } from "../map/pack";
import { cx } from "../ui/cx";
import type { BoardState } from "../board/state";
import type { SceneRow } from "../board/scenes";
import type { RecordId } from "../gen/RecordId";
import { type MatchEvent, clockLabel, downAt, playersAt, sitesAt, tierOf, wavesAt } from "../match/timeline";
import { type MatchPreview, UltRing } from "../match/preview";
import { matchSceneOps, matchScenesOps, slotKey, sourceOf } from "../match/save";
import { clearAnnotationsOps, liveSceneOps, takeAnnotationsOps } from "./live";
import { busy, jobLabel } from "./api";
import { SPEEDS } from "./clock";
import { EventsList } from "./Events";
import { jumpTime, namesFor, placeOf, shortLabel, tierLabel } from "./events";
import type { PlayerHost } from "./host";

export function Player(p: {
  host: PlayerHost;
  state: BoardState;
  art: Art;
  scene: SceneRow | undefined;
  mint: () => RecordId;
  onPreview: (v: MatchPreview | undefined) => void;
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

  // The map follows the playback; the preview is local, and goes with Player.
  createEffect(() => {
    const m = h.tl();
    if (!m) return p.onPreview(undefined);
    const t = h.t();
    const players = new Map(playersAt(m, t).map((x) => [slotKey(x.team, x.slot), { hero: x.hero_id, pos: x.pos }]));
    const waves = new Map([...wavesAt(m, t)].map(([k, w]) => [k, w.t]));
    p.onPreview({ players, down: downAt(m, t, markers()), sites: sitesAt(m, t, markers()), waves });
  });
  onCleanup(() => p.onPreview(undefined));

  const stale = createMemo(() => (h.tl() ? [...wavesAt(h.tl()!, h.t()).values()].some((w) => w.stale) : false));
  const user = (f: () => void) => {
    p.onUserPlayback();
    f();
  };

  // The live annotation layer: made by the first editor in Player, cleared by the last to leave.
  let making = false;
  createEffect(() => {
    if (!canEdit() || p.state.liveScene() || making || p.state.roster().length !== 12 || !p.state.scenes().length) return;
    making = true;
    p.state.edit(liveSceneOps(p.state.roster(), p.state.scenes(), p.mint).ops);
  });
  const rows = (kind: string, scene: RecordId) => p.state.inScene(kind, scene) as never;
  onCleanup(() => {
    const live = p.state.liveScene();
    const others = p.state.peerList().some((x) => x.peer !== p.state.myPeer() && x.state?.playback?.player);
    if (live && canEdit() && !others) {
      const ops = clearAnnotationsOps(rows, live);
      if (ops.length) p.state.edit(ops);
    }
  });

  /** One scene at t: the timeline's state, the scene's source, and the live annotations. */
  const saveOne = () => {
    const m = h.tl();
    if (!m) return;
    const { id, ops } = matchSceneOps(p.state.roster(), p.state.scenes(), p.scene, m, h.t(), markers(), p.mint, lanes(), { source: sourceOf(m) });
    const live = p.state.liveScene();
    if (live) ops.push(...takeAnnotationsOps(rows, live, id, p.mint));
    p.state.edit(ops); // one transaction: one undo
    p.onSaved(id);
  };
  return (
    <>
      <div class="pl-bar" data-testid="player" role="region" aria-label="Player">
        <form
          class="pl-head"
          onSubmit={(e) => {
            e.preventDefault();
            p.onUserPlayback();
            void h.open(idInput.value.trim(), { attach: canEdit() });
          }}
        >
          <button class="btn ghost small" type="button" data-testid="mode-sandbox" onClick={() => user(() => h.setMode("sandbox"))} title="Edit scenes freely">
            Sandbox
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
          <Show when={h.tl()}>{(m) => <span class={cx("match-tier", tierOf(m()))} data-testid="match-tier">{tierLabel(m())}</span>}</Show>
          <span class="match-job" data-testid="match-job">
            {jobLabel(h.job(), h.progress())}
          </span>
          <span class="spacer" />
          <Show when={canEdit() && h.matchId() && h.job() && h.job()!.state !== "off" && h.job()!.state !== "done" && !busy(h.job())}>
            <button class="btn ghost small" type="button" data-testid="match-fetch" onClick={() => void h.fetchReplay()} title="Fetch the replay from Valve">
              Fetch replay
            </button>
            <button class="btn ghost small" type="button" data-testid="match-upload" onClick={() => file.click()} title="Upload a .dem from your replays folder">
              Upload .dem
            </button>
          </Show>
          <input
            ref={file}
            type="file"
            accept=".dem"
            hidden
            data-testid="match-file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (f) void h.upload(f);
            }}
          />
        </form>
        <Show when={h.tl()}>
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
              <span class="match-clock" data-testid="match-clock">
                {clockLabel(h.t())} / {clockLabel(m().duration_s)}
              </span>
              <Show when={stale()}>
                <span class="match-note" data-testid="match-stale">
                  Waves held
                </span>
              </Show>
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
 * In Sandbox, the way back to Player: for this board's match, or one someone here is playing
 * (the board learned of it after you opened it).
 */
export function PlayerSwitch(p: { host: PlayerHost; state: BoardState; onSwitch: () => void }) {
  const peerMatch = () => p.state.peerList().find((x) => x.state?.playback)?.state?.playback?.match_id;
  const target = () => p.host.matchId() ?? (peerMatch() !== undefined ? String(peerMatch()) : undefined);
  return (
    <Show when={target()}>
      <button
        class="btn small pl-switch"
        data-testid="mode-player"
        onClick={() => {
          p.onSwitch();
          if (p.host.matchId()) p.host.setMode("player");
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
  const saveMany = (events: MatchEvent[], lead: number) => {
    const m = h.tl();
    const n = names();
    if (!m || !n || !events.length) return;
    const moments = [...events].sort((a, b) => a.t - b.t).map((e) => ({ t: jumpTime(e, lead), name: shortLabel(e, n) }));
    const { ids, ops } = matchScenesOps(p.state.roster(), p.state.scenes(), p.scene, m, moments, markers(), p.mint, lanes());
    p.state.edit(ops); // one transaction: one undo removes them all
    if (ids[0]) p.onSaved(ids[0]);
  };
  const jump = (e: MatchEvent, lead: number) => {
    user(() => {
      h.control.play(false);
      h.control.seek(jumpTime(e, lead));
    });
    h.flash(placeOf(e, markers()));
  };

  return (
    <>
      <section class="pl-side" data-testid="player-side">
        <Show when={h.tl()}>
          {(m) => (
            <>
              <div class="pl-teams">
                <For each={["amber", "sapphire"] as const}>
                  {(team) => (
                    <div class={cx("match-team", team)}>
                      <For each={m().players.filter((x) => x.team === team)}>
                        {(x) => (
                          <span class="match-hero" data-slot={slotKey(x.team, x.slot)} title={x.name ?? undefined}>
                            <Show when={tierOf(m()) === "replay"}>
                              <UltRing left={at().get(slotKey(x.team, x.slot))?.ult ?? null} />
                            </Show>
                            {heroName(x.hero_id)}
                          </span>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
              <EventsList tl={m()} names={names()!} tier={tierLabel(m())} canSave={canEdit()} onJump={jump} onSave={saveMany} />
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
