// Match import (docs/research/match-replay.md; spec §6a): load a match by id through our server,
// scrub its timeline as a local preview on the map, and save moments as ordinary scenes. Two
// tiers, one panel: a replay timeline (uploaded by an editor, or fetched from Valve's CDN, and
// parsed by the server's sandboxed worker) when there is one, else the match metadata.

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Art } from "../map/pack";
import { cx } from "../ui/cx";
import { type Timeline, clockLabel, downAt, playersAt, sitesAt, tierOf, wavesAt } from "./timeline";
import { rosterChanges, slotKey } from "./save";
import type { Slot } from "../board/state";

export interface MatchPreview {
  /** By "amber-0" … "sapphire-5": the hero there and where it is (`null`: dead, hidden). */
  players: Map<string, { hero: number; pos: { x: number; y: number } | null }>;
  /** Board objective keys down at this moment. */
  down: Set<string>;
  /** Replay tier: rifts and powerups at this moment, by key (absent: the board's own). */
  sites: Map<string, "Active" | "Destroyed">;
  /** Replay tier: lane splits (`Wave.t`) at this moment, by lane key. */
  waves: Map<string, number>;
}

const ERRORS: Record<string, string> = {
  bad_id: "Invalid id",
  not_found: "Not found",
  rate_limited: "Rate limited",
  busy: "Busy",
  upstream_limited: "Rate limited",
  upstream_down: "Upstream down",
  upstream_shape: "Upstream down",
  too_large: "Too large",
  queue_full: "Busy",
  in_progress: "In progress",
  not_a_replay: "Not a replay",
  view_only: "View only",
  replays_off: "Replays off",
};

/** A replay job's state as a label (spec §6a: labels only). */
const REASONS: Record<string, string> = {
  old_map: "Old map",
  not_a_replay: "Not a replay",
  too_large: "Too large",
  timeout: "Timed out",
  parse_failed: "Parse failed",
  no_replay: "No replay",
  upstream_down: "Upstream down",
  upstream_limited: "Rate limited",
  upstream_shape: "Upstream down",
};

interface JobState {
  state: "off" | "none" | "fetching" | "uploading" | "queued" | "parsing" | "done" | "failed";
  reason?: string;
  source?: "upload" | "cdn";
}

const jobLabel = (j: JobState | undefined, progress: number | undefined): string => {
  if (!j) return "";
  switch (j.state) {
    case "uploading":
      return progress === undefined ? "Uploading" : `Uploading ${progress}%`;
    case "fetching":
      return "Fetching";
    case "queued":
      return "Queued";
    case "parsing":
      return "Parsing";
    case "failed":
      return REASONS[j.reason ?? ""] ?? "Failed";
    default:
      return "";
  }
};

/** A small ring: the part still on cooldown, as the HUD draws it under a portrait. */
function UltRing(p: { left: number | null }) {
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg class={cx("match-ult", p.left === 0 && "ready")} viewBox="-8 -8 16 16" data-testid="match-ult" data-ult={p.left == null ? "untracked" : String(p.left)} aria-hidden="true">
      <circle r={r} class="match-ult-bg" />
      <Show when={p.left != null && p.left > 0}>
        <circle r={r} class="match-ult-left" stroke-dasharray={`${(c * (p.left ?? 0)) / 100} ${c}`} transform="rotate(-90)" />
      </Show>
    </svg>
  );
}

export function MatchPanel(p: {
  art: Art;
  board: string;
  token: string;
  roster: Slot[];
  onPreview: (v: MatchPreview | undefined) => void;
  onSave: (tl: Timeline, t: number) => void;
  onClose: () => void;
}) {
  const [id, setId] = createSignal("");
  const [loaded, setLoaded] = createSignal("");
  const [tl, setTl] = createSignal<Timeline>();
  const [status, setStatus] = createSignal("");
  const [job, setJob] = createSignal<JobState>();
  const [progress, setProgress] = createSignal<number>();
  const [t, setT] = createSignal(0);
  const [playing, setPlaying] = createSignal(false);
  let input!: HTMLInputElement;
  let file!: HTMLInputElement;
  onMount(() => input.focus());
  const auth = () => ({ authorization: `Bearer ${p.token}` });
  const base = (m: string) => `/api/boards/${p.board}/replays/${m}`;

  /** The richest timeline the board has for `m` (its replay, else the metadata). */
  const fetchTimeline = async (m: string, keepTime: boolean) => {
    const r = await fetch(`/api/boards/${p.board}/matches/${m}`, { headers: auth() });
    const body = (await r.json()) as Timeline & { error?: string };
    if (!r.ok) {
      setStatus(ERRORS[body.error ?? ""] ?? "Failed");
      return false;
    }
    // A replay arriving for a match already open keeps the scrubber where it is.
    const had = !!tl();
    setTl(body);
    setT(Math.min(body.duration_s, keepTime && had ? t() : 600));
    setStatus("");
    return true;
  };

  let poll: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(poll));
  /** Follow the replay job until it settles; a finished one swaps the timeline in. */
  const watch = async (m: string) => {
    clearTimeout(poll);
    try {
      const r = await fetch(base(m), { headers: auth() });
      if (!r.ok || loaded() !== m) return;
      const j = (await r.json()) as JobState;
      const was = job()?.state;
      setJob(j);
      if (j.state === "done" && was !== "done") await fetchTimeline(m, true);
      if (["fetching", "uploading", "queued", "parsing"].includes(j.state)) poll = setTimeout(() => void watch(m), 1500);
    } catch {
      poll = setTimeout(() => void watch(m), 5000);
    }
  };

  const load = async (e: Event) => {
    e.preventDefault();
    const v = id().trim();
    if (!/^[1-9]\d{0,11}$/.test(v)) return setStatus("Invalid id");
    setStatus("Loading");
    setLoaded(v);
    setJob(undefined);
    setTl(undefined);
    try {
      await fetchTimeline(v, false);
      // The replay tier's state too, also when there's no metadata: an upload needs none.
      await watch(v);
    } catch {
      setStatus("Offline");
    }
  };

  const fetchReplay = async () => {
    const m = loaded();
    if (!m) return;
    const r = await fetch(`${base(m)}/fetch`, { method: "POST", headers: auth() });
    const body = (await r.json().catch(() => ({}))) as JobState & { error?: string };
    if (!r.ok) return setStatus(ERRORS[body.error ?? ""] ?? "Failed");
    setStatus("");
    await watch(m);
  };

  /** Upload a `.dem` with progress (XHR: fetch has no upload progress). */
  const upload = (f: File) => {
    const m = loaded();
    if (!m) return;
    setJob({ state: "uploading", source: "upload" });
    setStatus("");
    setProgress(0);
    const x = new XMLHttpRequest();
    x.open("POST", `${base(m)}/upload`);
    x.setRequestHeader("authorization", `Bearer ${p.token}`);
    x.setRequestHeader("content-type", "application/octet-stream");
    x.upload.onprogress = (ev) => ev.lengthComputable && setProgress(Math.floor((ev.loaded / ev.total) * 100));
    x.onload = () => {
      setProgress(undefined);
      if (x.status >= 200 && x.status < 300) return void watch(m);
      let code = "";
      try {
        code = (JSON.parse(x.responseText) as { error?: string }).error ?? "";
      } catch {
        /* not JSON */
      }
      setStatus(ERRORS[code] ?? "Failed");
      void watch(m);
    };
    x.onerror = () => {
      setProgress(undefined);
      setStatus("Offline");
      void watch(m);
    };
    x.send(f);
  };

  // The preview follows the scrubber; it's local only and goes when the panel closes.
  createEffect(() => {
    const m = tl();
    if (!m) return p.onPreview(undefined);
    const players = new Map(playersAt(m, t()).map((x) => [slotKey(x.team, x.slot), { hero: x.hero_id, pos: x.pos }]));
    const waves = new Map([...wavesAt(m, t())].map(([k, w]) => [k, w.t]));
    p.onPreview({ players, down: downAt(m, t(), p.art.model.markers), sites: sitesAt(m, t(), p.art.model.markers), waves });
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
    // A replay's map is checked by the worker (an old map is refused); demos carry no date.
    return !!m && tierOf(m) === "metadata" && !Number.isNaN(date) && m.start_time * 1000 < date;
  });
  const changes = createMemo(() => (tl() ? rosterChanges(p.roster, tl()!) : []));
  const heroName = (h: number) => p.art.heroes.get(h)?.name ?? `Hero ${h}`;
  const at = createMemo(() => (tl() ? new Map(playersAt(tl()!, t()).map((x) => [slotKey(x.team, x.slot), x])) : new Map()));
  const stale = createMemo(() => (tl() ? [...wavesAt(tl()!, t()).values()].some((w) => w.stale) : false));
  const busy = () => ["fetching", "uploading", "queued", "parsing"].includes(job()?.state ?? "");
  const canReplay = () => !!loaded() && job() !== undefined && job()!.state !== "off" && job()!.state !== "done" && !busy();

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
        <Show when={tl()}>{(m) => <span class={cx("match-tier", tierOf(m()))} data-testid="match-tier">{tierOf(m()) === "replay" ? "Replay" : "Metadata"}</span>}</Show>
        <span class="match-job" data-testid="match-job">
          {jobLabel(job(), progress())}
        </span>
        <span class="spacer" />
        <Show when={canReplay()}>
          <button class="btn ghost small" type="button" data-testid="match-fetch" onClick={() => void fetchReplay()} title="Fetch the replay from Valve">
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
            if (f) upload(f);
          }}
        />
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
              <Show when={stale()}>
                <span class="match-note" data-testid="match-stale">
                  Waves held
                </span>
              </Show>
              <span class="spacer" />
              <span class="match-credit">{tierOf(m()) === "replay" ? (job()?.source === "cdn" ? "Replay: Valve, via deadlock-api.com" : "Replay: uploaded") : "Match data: deadlock-api.com"}</span>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
