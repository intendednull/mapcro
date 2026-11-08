// Player's state for one board (spec §6b): the attached matches, the open match's timeline and
// replay job, the playback clock, the mode (Player or Sandbox) and the jump highlight. The
// board creates one; Player renders it; following reads and writes its playback.

import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { type Timeline, downAt, playersAt, sitesAt, wavesAt } from "../match/timeline";
import type { MatchPreview } from "../match/preview";
import { slotKey } from "../match/save";
import type { Marker } from "../map/model";
import { Api, type JobState, busy } from "./api";
import { type Playback, clampT, follow, rebase, tAt } from "./clock";
import type { Pt } from "../map/transform";

export type Mode = "player" | "sandbox";

/** Presence's `playback` (crates/engine/src/wire.rs `Playback`). */
export interface PlaybackPresence {
  player: boolean;
  match_id: number;
  t: number;
  playing: boolean;
  speed: number;
}

export function createPlayerHost(board: string, token: string) {
  const api = new Api(board, token);
  const [matches, setMatches] = createSignal<number[]>([]);
  const [mode, setMode] = createSignal<Mode>("sandbox");
  const [matchId, setMatchId] = createSignal<string>();
  const [tl, setTl] = createSignal<Timeline>();
  const [status, setStatus] = createSignal("");
  const [job, setJob] = createSignal<JobState>();
  const [progress, setProgress] = createSignal<number>();
  const [playback, setPlayback] = createSignal<Playback>({ t: 0, playing: false, speed: 1, at: performance.now() });
  const [now, setNow] = createSignal(performance.now());
  const [highlight, setHighlight] = createSignal<{ at: Pt; key: number }>();
  const duration = () => tl()?.duration_s ?? 0;
  /** Playback position now, ticking each frame while it plays. */
  const t = createMemo(() => tAt(playback(), now(), duration()));

  // One frame clock while playing; it stops itself at the end.
  let raf = 0;
  createEffect(() => {
    cancelAnimationFrame(raf);
    if (!playback().playing) return setNow(performance.now());
    const tick = () => {
      setNow(performance.now());
      if (playback().playing && t() >= duration()) setPlayback({ ...playback(), t: duration(), playing: false, at: performance.now() });
      else raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  });
  onCleanup(() => cancelAnimationFrame(raf));

  const control = {
    seek(to: number) {
      const n = performance.now();
      setPlayback({ ...rebase(playback(), n, duration()), t: clampT(to, duration()), at: n });
    },
    play(on: boolean) {
      const n = performance.now();
      const p = rebase(playback(), n, duration());
      // Play at the end starts over.
      setPlayback({ ...p, t: on && p.t >= duration() ? 0 : p.t, playing: on });
    },
    speed(s: number) {
      setPlayback({ ...rebase(playback(), performance.now(), duration()), speed: s });
    },
  };

  let poll: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(poll));
  /** Follow the replay job until it settles; a finished one swaps the replay in. */
  const watch = async (id: string) => {
    clearTimeout(poll);
    try {
      const j = await api.job(id);
      if (!j || matchId() !== id) return;
      const was = job()?.state;
      setJob(j);
      if (j.state === "done" && was !== "done") await loadTimeline(id, true);
      if (busy(j)) poll = setTimeout(() => void watch(id), 1500);
    } catch {
      poll = setTimeout(() => void watch(id), 5000);
    }
  };

  const loadTimeline = async (id: string, keep: boolean) => {
    const r = await api.timeline(id);
    if (matchId() !== id) return;
    if ("error" in r) {
      setStatus(r.error);
      return;
    }
    const had = !!tl();
    setTl(r);
    setStatus("");
    if (!(keep && had)) setPlayback({ t: Math.min(r.duration_s, 600), playing: false, speed: playback().speed, at: performance.now() });
  };

  /** Open a match: attach it (editors), load its timeline and its replay job's state. */
  const open = async (id: string, opts: { attach: boolean; at?: number } = { attach: false }) => {
    if (!/^[1-9]\d{0,11}$/.test(id)) return setStatus("Invalid id");
    setMatchId(id);
    setTl(undefined);
    setJob(undefined);
    setStatus("Loading");
    setMode("player");
    try {
      if (opts.attach && (await api.attach(id))) setMatches([Number(id), ...matches().filter((m) => m !== Number(id))]);
      await loadTimeline(id, false);
      // A newer open() may have replaced this match meanwhile: don't seek it (finding 10).
      if (opts.at !== undefined && matchId() === id) control.seek(opts.at);
      await watch(id);
    } catch {
      setStatus("Offline");
    }
  };

  const upload = async (f: Blob) => {
    const id = matchId();
    if (!id) return;
    setJob({ state: "uploading", source: "upload" });
    setStatus("");
    setProgress(0);
    const e = await api.upload(id, f, setProgress);
    setProgress(undefined);
    if (e) setStatus(e);
    await watch(id);
  };

  const fetchReplay = async () => {
    const id = matchId();
    if (!id) return;
    const e = await api.fetchReplay(id);
    if (e) return setStatus(e);
    setStatus("");
    await watch(id);
  };

  /** Load the board's matches; a board with one opens in Player. */
  const init = async () => {
    const ms = await api.matches().catch(() => []);
    setMatches(ms);
    if (ms.length && !matchId()) await open(String(ms[0]), { attach: false });
  };

  /**
   * What presence carries (spec §6b): the mode and, with a match, the playback re-sampled now.
   * Nothing for a board without a match.
   */
  const presence = (): PlaybackPresence | undefined => {
    const id = matchId();
    // In Player with no match yet, still say so (match 0): others see you're in Player.
    if (!id && mode() !== "player") return undefined;
    const pb = playback();
    return { player: mode() === "player", match_id: id ? Number(id) : 0, t: Math.round(tAt(pb, performance.now(), duration()) * 100) / 100, playing: pb.playing, speed: pb.speed };
  };

  /**
   * A follower mirrors a presenter's mode, match and playback (spec §6b). Presence is resent
   * whole whenever anything in it changes, so the same playback arrives again and again with a
   * `t` that's older each time: a value is stamped when it first arrives and carried forward
   * from then; a repeat changes nothing (review 2026-11-08, finding 4).
   */
  let heard: { v: string; at: number } | undefined;
  const mirror = (theirs: PlaybackPresence | null | undefined) => {
    if (!theirs) return;
    const v = JSON.stringify(theirs);
    if (heard?.v !== v) heard = { v, at: performance.now() };
    if (!theirs.player) return setMode("sandbox");
    setMode("player");
    if (theirs.match_id === 0) return;
    const id = String(theirs.match_id);
    if (id !== matchId()) {
      void open(id, { attach: false, at: theirs.t });
      return;
    }
    if (!tl()) return;
    const next = follow(playback(), { ...theirs, at: heard.at }, performance.now(), duration());
    if (next !== playback()) setPlayback(next);
  };
  /** Following stopped: the next presenter's values are new. */
  const forget = () => (heard = undefined);

  let hl = 0;
  const flash = (at: Pt | undefined) => {
    if (!at) return setHighlight(undefined);
    const key = ++hl;
    setHighlight({ at, key });
    setTimeout(() => highlight()?.key === key && setHighlight(undefined), 4000);
  };

  return {
    api,
    matches,
    mode,
    setMode,
    matchId,
    tl,
    status,
    setStatus,
    job,
    progress,
    playback,
    setPlayback,
    t,
    duration,
    control,
    open,
    upload,
    fetchReplay,
    init,
    highlight,
    flash,
    presence,
    mirror,
    forget,
    /** The match at playback time t as the board draws it; empty with no timeline (finding 7). */
    preview: (markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane">>): MatchPreview => {
      const m = tl();
      if (!m) return { players: new Map(), down: new Set(), sites: new Map(), waves: new Map() };
      const at = t();
      const players = new Map(playersAt(m, at).map((x) => [slotKey(x.team, x.slot), { hero: x.hero_id, pos: x.pos }]));
      const waves = new Map([...wavesAt(m, at)].map(([k, w]) => [k, w.t]));
      return { players, down: downAt(m, at, markers), sites: sitesAt(m, at, markers), waves };
    },
  };
}

export type PlayerHost = ReturnType<typeof createPlayerHost>;

/**
 * Send the playback in presence (spec §6b): whenever the mode, match or playback changes, and
 * every two seconds while it plays, so followers can correct drift.
 */
export function playbackPresence(h: PlayerHost, send: (p: PlaybackPresence | undefined) => void) {
  createEffect(() => {
    h.mode();
    h.matchId();
    h.playback();
    send(h.presence());
  });
  const beat = setInterval(() => {
    if (h.playback().playing) send(h.presence());
  }, 2000);
  onCleanup(() => clearInterval(beat));
}
