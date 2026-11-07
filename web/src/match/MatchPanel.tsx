// Match import (docs/research/match-replay.md, v1): load a match by id through our server,
// scrub its timeline as a local preview on the map, and save moments as ordinary scenes.

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { cx } from "../ui/cx";
import { type Timeline, clockLabel, downAt, playersAt } from "./timeline";
import { rosterChanges, slotKey } from "./save";
import type { Slot } from "../board/state";

export interface MatchPreview {
  /** By "amber-0" … "sapphire-5": the hero there and where it is (`null`: dead, hidden). */
  players: Map<string, { hero: number; pos: { x: number; y: number } | null }>;
  /** Board objective keys down at this moment. */
  down: Set<string>;
}

const ERRORS: Record<string, string> = {
  bad_id: "Invalid id",
  not_found: "Not found",
  rate_limited: "Rate limited",
  busy: "Rate limited",
  upstream_limited: "Rate limited",
  upstream_down: "Upstream down",
  upstream_shape: "Upstream down",
  too_large: "Too large",
};

export function MatchPanel(p: {
  art: Art;
  roster: Slot[];
  onPreview: (v: MatchPreview | undefined) => void;
  onSave: (tl: Timeline, t: number) => void;
  onClose: () => void;
}) {
  const [id, setId] = createSignal("");
  const [tl, setTl] = createSignal<Timeline>();
  const [status, setStatus] = createSignal("");
  const [t, setT] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  let input!: HTMLInputElement;
  onMount(() => input.focus());

  const load = async (e: Event) => {
    e.preventDefault();
    const v = id().trim();
    if (!/^[1-9]\d{0,11}$/.test(v)) return setStatus("Invalid id");
    setStatus("Loading");
    try {
      const r = await fetch(`/api/matches/${v}`);
      const body = (await r.json()) as Timeline & { error?: string };
      if (!r.ok) return setStatus(ERRORS[body.error ?? ""] ?? "Failed");
      setTl(body);
      setT(Math.min(body.duration_s, 600));
      setStatus("");
    } catch {
      setStatus("Offline");
    }
  };

  // The preview follows the scrubber; it's local only and goes when the panel closes.
  createEffect(() => {
    const m = tl();
    if (!m) return p.onPreview(undefined);
    const players = new Map(playersAt(m, t()).map((x) => [slotKey(x.team, x.slot), { hero: x.hero_id, pos: x.pos }]));
    p.onPreview({ players, down: downAt(m, t(), p.art.model.markers) });
  });
  onCleanup(() => p.onPreview(undefined));

  let timer: ReturnType<typeof setInterval> | undefined;
  createEffect(() => {
    clearInterval(timer);
    if (!playing()) return;
    // Ten match seconds per real second.
    timer = setInterval(() => {
      const m = tl();
      if (!m) return;
      const next = Math.min(m.duration_s, t() + 1);
      setT(next);
      if (next >= m.duration_s) setPlaying(false);
    }, 100);
  });
  onCleanup(() => clearInterval(timer));

  const step = (d: number) => {
    const m = tl();
    if (m) setT(Math.max(0, Math.min(m.duration_s, t() + d)));
  };
  const olderMap = createMemo(() => {
    const m = tl();
    const date = p.art.date ? Date.parse(p.art.date) : NaN;
    return !!m && !Number.isNaN(date) && m.start_time * 1000 < date;
  });
  const changes = createMemo(() => (tl() ? rosterChanges(p.roster, tl()!) : []));
  const heroName = (h: number) => p.art.heroes.get(h)?.name ?? `Hero ${h}`;

  return (
    <div
      class="match-panel"
      data-testid="match-panel"
      role="dialog"
      aria-label="Match"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") p.onClose();
      }}
    >
      <form class="match-head" onSubmit={load}>
        <input
          ref={input}
          class="input"
          data-testid="match-id"
          inputMode="numeric"
          placeholder="Match id"
          aria-label="Match id"
          value={id()}
          onInput={(e) => setId(e.currentTarget.value)}
        />
        <button class="btn small" type="submit" data-testid="match-load">
          Load
        </button>
        <span class="match-status" data-testid="match-status">
          {status()}
        </span>
        <span class="spacer" />
        <button class="btn ghost small" type="button" aria-label="Close" title="Close" onClick={() => p.onClose()}>
          ×
        </button>
      </form>
      <Show when={tl()}>
        {(m) => (
          <>
            <div class="match-scrub">
              <button class="btn small" type="button" data-testid="match-back" onClick={() => step(-10)} aria-label="Back 10 s" title="−10 s">
                −10
              </button>
              <button class="btn small" type="button" data-testid="match-play" onClick={() => setPlaying(!playing())} aria-label={playing() ? "Pause" : "Play"}>
                {playing() ? "Pause" : "Play"}
              </button>
              <button class="btn small" type="button" data-testid="match-forward" onClick={() => step(10)} aria-label="Forward 10 s" title="+10 s">
                +10
              </button>
              <input
                class="match-range"
                data-testid="match-time"
                type="range"
                min="0"
                max={m().duration_s}
                step="1"
                value={t()}
                aria-label="Match time"
                onInput={(e) => {
                  setPlaying(false);
                  setT(Number(e.currentTarget.value));
                }}
              />
              <span class="match-clock" data-testid="match-clock">
                {clockLabel(t())} / {clockLabel(m().duration_s)}
              </span>
            </div>
            <div class="match-teams">
              <For each={["amber", "sapphire"] as const}>
                {(team) => (
                  <div class={cx("match-team", team)}>
                    <For each={m().players.filter((x) => x.team === team)}>{(x) => <span class="match-hero">{heroName(x.hero_id)}</span>}</For>
                  </div>
                )}
              </For>
            </div>
            <div class="match-foot">
              <button class="btn primary small" type="button" data-testid="match-save" onClick={() => p.onSave(m(), t())}>
                Save as scene
              </button>
              <Show when={changes().length > 0}>
                <span class="match-note" data-testid="match-roster">
                  Roster → match heroes
                </span>
              </Show>
              <Show when={olderMap()}>
                <span class="match-note" data-testid="match-older">
                  Older map
                </span>
              </Show>
              <span class="spacer" />
              <span class="match-credit">Match data: deadlock-api.com</span>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
