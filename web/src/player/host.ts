// Player's state for one board (spec §6b): the attached matches, the open match's timeline and
// replay job, the playback clock, the mode (Player or Sandbox) and the jump highlight. The
// board creates one; Player renders it; following reads and writes its playback.

import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { type CampAt, type MatchEvent, type Timeline, campsAt, downAt, lanesAt, markerKey, objectiveHealthAt, playersAt, sitesAt } from "../match/timeline";
import type { MatchPreview } from "../match/preview";
import { slotKey } from "../match/save";
import type { Marker } from "../map/model";
import { Api, type JobState, MODE_REFUSED, busy } from "./api";
import { type Playback, clampT, follow, rebase, tAt } from "./clock";
import { type Pt, worldToMap } from "../map/transform";
import { eventKey } from "./events";

export type Mode = "player" | "sandbox";

/** Presence's `playback` (crates/engine/src/wire.rs `Playback`). */
export interface PlaybackPresence {
  player: boolean;
  match_id: number;
  t: number;
  playing: boolean;
  speed: number;
  /** The event jumped to while it's pinned: its `eventKey`, and the match time it landed at. */
  jump?: { key: string; at: number } | null;
}

export function createPlayerHost(board: string, token: string) {
  const api = new Api(board, token);
  const [matches, setMatches] = createSignal<number[]>([]);
  const [mode, setModeRaw] = createSignal<Mode>("sandbox");
  /**
   * Watching the match ("player") or viewing a scene ("sandbox"; spec §6b). Leaving the match
   * holds its playback where it was, paused, and coming back resumes it as it was.
   */
  const [held, setHeld] = createSignal<{ t: number; playing: boolean }>();
  const setMode = (m: Mode) => {
    if (m === mode()) return;
    jumped();
    const n = performance.now();
    if (m === "sandbox") {
      const p = rebase(playback(), n, duration());
      setHeld({ t: p.t, playing: p.playing });
      setPlayback({ ...p, playing: false });
    } else {
      const h = held();
      if (h) setPlayback({ ...playback(), t: h.t, playing: h.playing, at: n });
      setHeld(undefined);
    }
    setModeRaw(m);
  };
  /** The trooper dots (replay tier), on by default. */
  const [showTroopers, setShowTroopers] = createSignal(true);
  // Health bars and rings (replay tier), on by default (operator, 2026-11-08).
  const [showHealth, setShowHealth] = createSignal(true);
  /** Event pings while playing (spec §6b), on by default. */
  const [showPings, setShowPings] = createSignal(true);
  /** The events the list shows under its filters and search (absent: every event). */
  const [pingable, setPingable] = createSignal<MatchEvent[]>();
  const [pings, setPings] = createSignal<EventPing[]>([]);
  /**
   * Bumped on every break in the playback clock (a seek, a scrub, a jump, a new match, a mode
   * switch, a presenter's jump a follower adopts): pings fire only on a continuous run.
   */
  let jumps = 0;
  const jumped = () => void jumps++;
  /** The events list's lead, shared with the arrow keys (spec §6b). */
  const [lead, setLead] = createSignal(5);
  const [matchId, setMatchId] = createSignal<string>();
  const [tl, setTl] = createSignal<Timeline>();
  const [status, setStatus] = createSignal("");
  const [job, setJob] = createSignal<JobState>();
  const [progress, setProgress] = createSignal<number>();
  const [playback, setPlayback] = createSignal<Playback>({ t: 0, playing: false, speed: 1, at: performance.now() });
  const [now, setNow] = createSignal(performance.now());
  const [highlight, setHighlight] = createSignal<{ event: MatchEvent; place: Pt | undefined; key: number }>();
  const duration = () => tl()?.duration_s ?? 0;
  /** Playback position now, ticking each frame while it plays. */
  // `now` isn't ticking while paused: read the wall clock afresh when the playback changes.
  const t = createMemo(() => {
    const pb = playback();
    return tAt(pb, Math.max(now(), pb.at), duration());
  });

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
      jumped();
      // Any seek but a jump's own lets the list follow playback again (a jump re-pins after it).
      setPinned(undefined);
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
    if (!(keep && had)) {
      jumped();
      setPinned(undefined);
    }
    if (!(keep && had)) setPlayback({ t: Math.min(r.duration_s, 600), playing: false, speed: playback().speed, at: performance.now() });
  };

  // On the API summary, keep an eye out for the replay: someone else's upload or fetch upgrades
  // this view too, in place (operator, 2026-11-08).
  createEffect(() => {
    const id = matchId();
    const m = tl();
    if (!id || !m || m.tier === "replay" || busy(job())) return;
    const timer = setInterval(() => {
      void api.job(id).then((j) => {
        if (!j || matchId() !== id) return;
        if (j.state === "done") void loadTimeline(id, true);
        if (j.state !== job()?.state) setJob(j);
        if (busy(j)) void watch(id);
      });
    }, 5000);
    onCleanup(() => clearInterval(timer));
  });

  /** Open a match: attach it (editors), load its timeline and its replay job's state. */
  const open = async (id: string, opts: { attach: boolean; at?: number } = { attach: false }) => {
    if (!/^[1-9]\d{0,11}$/.test(id)) return setStatus("Invalid id");
    setMatchId(id);
    setTl(undefined);
    setJob(undefined);
    setStatus("Loading");
    setMode("player");
    try {
      // The timeline first: a match refused for its mode is never attached (2026-11-08).
      await loadTimeline(id, false);
      if (opts.attach && matchId() === id && !MODE_REFUSED.has(status()) && (await api.attach(id))) setMatches([Number(id), ...matches().filter((m) => m !== Number(id))]);
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
    const jumpedTo = pin();
    return {
      player: mode() === "player",
      match_id: id ? Number(id) : 0,
      t: Math.round(tAt(pb, performance.now(), duration()) * 100) / 100,
      playing: pb.playing,
      speed: pb.speed,
      jump: jumpedTo ? { key: eventKey(jumpedTo.event), at: jumpedTo.at } : null,
    };
  };

  /**
   * A follower mirrors a presenter's mode, match and playback (spec §6b). Presence is resent
   * whole whenever anything in it changes, so the same playback arrives again and again with a
   * `t` that's older each time: a value is stamped when it first arrives and carried forward
   * from then; a repeat changes nothing (review 2026-11-08, finding 4).
   */
  let heard: { v: string; at: number; pb: PlaybackPresence } | undefined;
  const mirror = (theirs: PlaybackPresence | null | undefined) => {
    if (!theirs) return;
    const v = JSON.stringify(theirs);
    if (heard?.v !== v) {
      const at = performance.now();
      // Did the presenter jump? Where their last playback would be now, against where it is: a
      // seek is ±10 s or more, network jitter a fraction of a second times the speed.
      const was = heard?.pb;
      const expect = was && tAt({ ...was, at: heard!.at }, at, duration());
      const seeked = !was || was.match_id !== theirs.match_id || Math.abs(theirs.t - expect!) > 1 + 0.25 * theirs.speed;
      if (seeked) jumped();
      // The presenter's jump (QA 2026-11-08: a follower saw no ring and marked another row): a
      // new one, or the same one again (their seek back to it), rings here and pins its row;
      // none means they seeked elsewhere, and the row unpins.
      const j = theirs.jump;
      if (!j) setPinned(undefined);
      else if (seeked || j.key !== was?.jump?.key || j.at !== was?.jump?.at) setHeardJump({ key: j.key, at: j.at, n: (untrack(heardJump)?.n ?? 0) + 1 });
      // A copy: `theirs` is the peers store's own object, which the next presence updates in
      // place, so a kept reference would read the new `t` as the old one's. Every presence
      // over ¾ s apart then looked like a jump: the follower's run broke on each heartbeat
      // (dropping an event it crossed in that frame), and a real seek right after a heartbeat
      // didn't, so the catch-up pinged what the presenter skipped.
      heard = { v, at, pb: { ...theirs, jump: theirs.jump ? { ...theirs.jump } : null } };
    }
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

  /**
   * Event pings (spec §6b): each event the playback passes while it runs, under the list's
   * filters and search, gets its own short ring. Only a continuous forward run counts: a seek,
   * scrub or jump fires nothing for what it skipped, and nor does a step after five seconds
   * without a frame (a tab back from the background), however far it went. A follower's small
   * corrections keep a high-water mark, so stepping back a little never pings an event twice.
   * (A cap on the step in match seconds dropped real events when a busy box stalled a frame.)
   */
  let mark = { t: 0, jumps: -1, wall: 0 };
  let pingN = 0;
  createEffect(() => {
    const cur = t();
    const pb = playback();
    const wall = performance.now();
    const from = mark.t;
    const same = mark.jumps === jumps;
    if (same && pb.playing && cur <= from && from - cur < 2 * Math.max(1, pb.speed)) return;
    const stalled = wall - mark.wall > 5000;
    mark = { t: cur, jumps, wall };
    const m = untrack(tl);
    if (!same || stalled || !pb.playing || !m || !untrack(showPings) || untrack(mode) !== "player") return;
    const hit = (untrack(pingable) ?? m.events ?? []).filter((e) => e.t > from && e.t <= cur);
    if (!hit.length) return;
    const life = pingLife(pb.speed);
    const add = hit.map((event) => ({ key: ++pingN, event, life }));
    untrack(() => setPings([...pings(), ...add].slice(-MAX_PINGS)));
    setTimeout(() => setPings(pings().filter((x) => !add.includes(x))), life);
  });

  let hl = 0;
  /**
   * The event you jumped to: the list marks it, not the earlier one the lead lands after, until
   * playback passes the next listed event or you seek elsewhere (operator bug, 2026-11-08).
   * With the match time the jump landed at: presence carries both, so followers pin it too.
   */
  const [pin, setPinned] = createSignal<{ event: MatchEvent; at: number }>();
  const pinned = () => pin()?.event;
  /** A presenter's jump a follower heard, for Player to ring where it happened (`n` counts). */
  const [heardJump, setHeardJump] = createSignal<{ key: string; at: number; n: number }>();
  /**
   * Mark where an event happens (its own place, else its objective's): the ring follows the
   * event's hero until the event, then stays on the place (review: the jump lands seconds
   * early, when the hero is elsewhere). It goes a few seconds after the playback passes it.
   */
  const flash = (event: MatchEvent, place: Pt | undefined, at = untrack(t)) => {
    const key = ++hl;
    setHighlight({ event, place, key });
    setPinned({ event, at });
  };
  createEffect(() => {
    const h = highlight();
    if (h && t() > h.event.t + 4) setHighlight(undefined);
  });
  /** Where the ring is now, in map units. */
  const ring = createMemo((): Pt | undefined => {
    const h = highlight();
    const m = tl();
    if (!h || !m) return undefined;
    const e = h.event;
    if (e.team && e.slot != null && t() < e.t) {
      const p = playersAt(m, t()).find((x) => x.team === e.team && x.slot === e.slot);
      const w = p?.pos ?? p?.last;
      if (w) return worldToMap(w);
    }
    return h.place;
  });

  return {
    api,
    matches,
    mode,
    setMode,
    held,
    showTroopers,
    setShowTroopers,
    showHealth,
    setShowHealth,
    showPings,
    setShowPings,
    setPingable,
    pings,
    lead,
    setLead,
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
    pinned,
    heardJump,
    ring,
    presence,
    mirror,
    forget,
    /** The match at playback time t as the board draws it; empty with no timeline (finding 7). */
    preview: (markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>): MatchPreview => {
      const m = tl();
      if (!m) return { players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map() };
      const at = t();
      const health = showHealth() && m.tier === "replay";
      const players = new Map(playersAt(m, at).map((x) => [slotKey(x.team, x.slot), { hero: x.hero_id, pos: x.pos, health: health ? x.health : null }]));
      // Everything by the board's marker keys: a pack can key a site differently from the
      // timeline (match/timeline.ts `markerKey`).
      const byMarker = <V,>(src: Map<string, V>) => {
        const out = new Map<string, V>();
        for (const [k, v] of src) {
          const key = markerKey(k, markers);
          if (key) out.set(key, v);
        }
        return out;
      };
      const camps: Map<string, CampAt> = byMarker(campsAt(m, at));
      return { players, down: downAt(m, at, markers), sites: sitesAt(m, at, markers), lanes: lanesAt(m, at), camps, ...(health ? { health: byMarker(objectiveHealthAt(m, at)) } : {}) };
    },
  };
}

export type PlayerHost = ReturnType<typeof createPlayerHost>;

/** One event's ping on the map (spec §6b): the event, and how long its ring lasts (ms). */
export interface EventPing {
  key: number;
  event: MatchEvent;
  life: number;
}
const MAX_PINGS = 24;
/** A ping lasts 1.5 s, shorter at 4× and 8× (1.06 s, 0.75 s), so a fast run doesn't pile up. */
export const pingLife = (speed: number) => Math.round(1500 / Math.sqrt(Math.max(1, speed / 2)));

/**
 * Send the playback in presence (spec §6b): whenever the mode, match, playback or jump changes, and
 * every two seconds while it plays, so followers can correct drift.
 */
export function playbackPresence(h: PlayerHost, send: (p: PlaybackPresence | undefined) => void) {
  createEffect(() => {
    h.mode();
    h.matchId();
    h.playback();
    h.pinned();
    send(h.presence());
  });
  const beat = setInterval(() => {
    if (h.playback().playing) send(h.presence());
  }, 2000);
  onCleanup(() => clearInterval(beat));
}
