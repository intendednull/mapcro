// Player's state for one board (spec §6b): the attached matches, the open match's timeline and
// replay job, the playback clock, the mode (Player or Sandbox) and the jump highlight. The
// board creates one; Player renders it; following reads and writes its playback.

import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { type CampAt, type MatchEvent, type PowerupAt, type RiftAt, type Timeline, campsAt, downAt, lanesAt, markerKey, objectiveHealthAt, playersAt, powerupAt, rejuvAt, riftAt, sitesAt, urnAt } from "../match/timeline";
import type { MatchPreview } from "../match/preview";
import { slotKey } from "../match/save";
import type { Marker } from "../map/model";
import { Api, type JobState, MODE_CODES, busy } from "./api";
import { type Notice, type Step, type Unavailable, idFromName, isDem, looksLikeDemo, noticeFor, unavailableFor } from "./notice";
import { NOT_DEM } from "./ReplayHelp";
import { type Handoff, takeHandoff } from "./handoff";
import { type Playback, clampT, follow, rebase, tAt } from "./clock";
import { type Pt, worldToMap } from "../map/transform";
import { eventKey } from "./events";
import { chooseSummary, markOpened, openedHere, playerNamesShown, playerVision, setPlayerNamesShown, setPlayerVision, summaryChosen } from "../core/device";
import { type Vision, hasVision, seenAt } from "./vision";

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
  /**
   * Players' names (spec §6b "Names"), on by default; off, nothing on screen names a player (for
   * recording without them). This browser's alone: remembered here, never in presence.
   */
  const [showNames, setShowNamesRaw] = createSignal(playerNamesShown());
  const setShowNames = (on: boolean) => {
    setPlayerNamesShown(on);
    setShowNamesRaw(on);
  };
  /**
   * Whose vision the map draws (spec §6b "Vision"): every hero, or one team's view, where an enemy
   * out of its sight is ghosted where it was last seen. Like Names, this browser's alone.
   */
  const [vision, setVisionRaw] = createSignal<Vision>(playerVision());
  const setVision = (v: Vision) => {
    setPlayerVision(v);
    setVisionRaw(v);
  };
  /** The player's name in a slot when names are shown and the timeline has one: the top bar and
   * the events read names here, the tokens through `preview` (which checks `showNames` too). */
  const playerName = (team: string | null | undefined, slot: number | null | undefined): string | undefined =>
    (showNames() && tl()?.players.find((p) => p.team === team && p.slot === slot)?.name) || undefined;
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
  /** What went wrong with the open match: its metadata, its fetch, or an upload (a code). */
  const [problem, setProblem] = createSignal<{ code: string; step: Step }>();
  /** This tab's upload in flight: the match, the bytes sent and the total. */
  const [sent, setSent] = createSignal<{ id: string; loaded: number; total: number }>();
  let inflight: { id: string; ctl: AbortController } | undefined;
  /** The upload's percent, for this match. */
  const progress = () => {
    const s = sent();
    return s && s.id === matchId() ? Math.floor((s.loaded / Math.max(1, s.total)) * 100) : undefined;
  };
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
      // This tab's own upload (waiting for its turn, then sending) is the truth while it runs;
      // its end watches again.
      if (inflight?.id === id) return;
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
      setStatus("");
      // An upload's failure says more (a handed-off upload can fail before this answers).
      if (problem()?.step !== "upload") setProblem({ code: r.error, step: "load" });
      return;
    }
    const had = !!tl();
    setTl(r);
    setStatus("");
    if (problem()?.step === "load") setProblem(undefined);
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
    setProblem(undefined);
    setOpener(undefined);
    setPrompted(false);
    setArmed(false);
    setStatus("Loading");
    setMode("player");
    try {
      // The timeline first: a match refused for its mode is never attached (2026-11-08).
      await loadTimeline(id, false);
      let attached = false;
      if (opts.attach && matchId() === id && !MODE_CODES.has(problem()?.code ?? "") && (await api.attach(id))) {
        attached = true;
        setMatches([Number(id), ...matches().filter((m) => m !== Number(id))]);
      }
      // This tab opened the match (Load here, or the landing's Open match before the reload):
      // the prompt is its to see (spec §6b), unless this browser chose the summary already.
      if (matchId() === id && (attached || openedHere(board, id))) {
        markOpened(board, id);
        setOpener(id);
        setArmed(!summaryChosen(id));
      }
      // A newer open() may have replaced this match meanwhile: don't seek it (finding 10).
      if (opts.at !== undefined && matchId() === id) control.seek(opts.at);
      await watch(id);
    } catch {
      setStatus("Offline");
    }
  };

  /**
   * This tab's turn to upload `bytes` (spec §6a, the queue): asked for, then asked again every
   * two seconds while waiting, which keeps it, showing how many are ahead. Resolves to `ready`,
   * `done` (the board has the match's fetched replay: nothing to send), or an error code
   * (`aborted` when cancelled meanwhile, which gives the place, or a turn just given, up). A
   * request that gets no answer is tried again a few times, further apart, before the wait
   * ends as `offline`: the place outlasts them (`REPLAY_RESERVE_TTL_S`).
   */
  const turn = async (id: string, bytes: number, signal: AbortSignal): Promise<"ready" | "done" | { error: string }> => {
    const pause = (ms: number) =>
      new Promise<void>((done) => {
        const t = setTimeout(done, ms);
        signal.addEventListener("abort", () => (clearTimeout(t), done()), { once: true });
      });
    let misses = 0;
    for (;;) {
      if (signal.aborted) {
        void api.release(id);
        return { error: "aborted" };
      }
      const r = await api.reserve(id, bytes);
      // Cancelled while it was asking: a turn it was just given goes back too.
      if (signal.aborted) {
        void api.release(id);
        return { error: "aborted" };
      }
      if ("error" in r && r.error === "offline" && misses < OFFLINE_RETRIES.length) {
        await pause(OFFLINE_RETRIES[misses++]!);
        continue;
      }
      if ("error" in r) return r;
      misses = 0;
      if (r.state !== "waiting") return r.state;
      if (matchId() === id) setJob({ state: "waiting", source: "upload", ahead: r.ahead });
      await pause(2000);
    }
  };

  /**
   * Upload a replay of the open match, with progress, while the board stays in use (one at a
   * time from this tab; `cancelUpload` stops it). It waits for its turn first (the file isn't
   * sent while the queue is full). With `attach`, the match is attached once the server has the
   * upload under way, so attaching doesn't also start a fetch from Valve.
   */
  const upload = async (f: Blob, opts: { attach?: boolean; opened?: () => void } = {}) => {
    const id = matchId();
    if (!id || inflight) return;
    const ctl = new AbortController();
    inflight = { id, ctl };
    setJob({ state: "waiting", source: "upload" });
    setStatus("");
    setProblem(undefined);
    setSent({ id, loaded: 0, total: f.size });
    const got = await turn(id, f.size, ctl.signal);
    if (got !== "ready") {
      inflight = undefined;
      setSent(undefined);
      if (matchId() !== id) return;
      if (got === "done") {
        // The match's replay came from Valve meanwhile: the board shows it, nothing to send.
        if (opts.attach && (await api.attach(id).catch(() => false))) {
          setMatches([Number(id), ...matches().filter((m) => m !== Number(id))]);
          opts.opened?.();
        }
        setJob(undefined);
        await loadTimeline(id, true);
      } else {
        setJob(undefined);
        setProblem({ code: got.error, step: "upload" });
      }
      return void (await watch(id));
    }
    if (matchId() === id) setJob({ state: "uploading", source: "upload" });
    let ended = false;
    let failed = false;
    let attaching: Promise<void> | undefined;
    const attach = () =>
      (attaching ??= (async () => {
        for (let i = 0; i < 20 && !ended; i++) {
          const j = await api.job(id).catch(() => undefined);
          if (j?.source === "upload" && j.state !== "none") break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (failed || !(await api.attach(id).catch(() => false))) return;
        setMatches([Number(id), ...matches().filter((m) => m !== Number(id))]);
        opts.opened?.();
      })());
    const e = await api.upload(
      id,
      f,
      (loaded, total) => {
        setSent({ id, loaded, total });
        // Past the first MiB the server has seen the file's header (a non-replay is refused
        // there), so a match isn't attached for a file that was never a replay.
        if (opts.attach && loaded >= Math.min(total, 1 << 20) && loaded < total) void attach();
      },
      ctl.signal,
    );
    ended = true;
    failed = !!e;
    inflight = undefined;
    setSent(undefined);
    if (opts.attach && !e) await attach();
    else await attaching;
    if (matchId() !== id) return;
    if (e) {
      setJob(undefined);
      setProblem({ code: e, step: "upload" });
    } else if (problem()?.step === "load") setProblem(undefined); // the replay stands alone
    await watch(id);
  };
  /** A replay file picked or dropped for the open match (spec §6b): checked, then uploaded. */
  const take = async (f: File) => {
    if (!isDem(f.name)) return setStatus(NOT_DEM);
    // The game names a replay after its match: refuse another match's file.
    const named = idFromName(f.name);
    const id = matchId();
    if (named && id && named !== id) return setStatus(`That file is match ${named}, not ${id}`);
    setStatus("");
    if (!(await looksLikeDemo(f))) return refuse("not_a_replay");
    void upload(f);
  };
  const cancelUpload = () => inflight?.ctl.abort();
  /** An upload refused before it started (the file isn't a replay). */
  const refuse = (code: string) => setProblem({ code, step: "upload" });
  /** This tab is uploading the open match. */
  const uploading = () => sent()?.id === matchId() && !!matchId();

  const fetchReplay = async () => {
    const id = matchId();
    if (!id) return;
    setProblem(undefined);
    const e = await api.fetchReplay(id);
    if (matchId() !== id) return;
    if (e) return setProblem({ code: e, step: "fetch" });
    setStatus("");
    await watch(id);
  };

  /**
   * The full-replay prompt (spec §6b): why the replay isn't coming from Valve, for the tab that
   * opened the match (`opener`). It opens on its own once (`armed`: on open, and after Try
   * again), when the fetch fails or the match is past Valve's three weeks; the chip reopens it.
   */
  const [opener, setOpener] = createSignal<string>();
  const [armed, setArmed] = createSignal(false);
  const [prompted, setPrompted] = createSignal(false);
  const unavailable = createMemo((): Unavailable | undefined => {
    const j = job();
    const m = tl();
    if (!m || m.tier === "replay" || uploading() || busy(j)) return undefined;
    const p = problem();
    if (p) return p.step === "fetch" ? unavailableFor(p.code) : undefined;
    return j?.state === "failed" && j.source === "cdn" && j.reason ? unavailableFor(j.reason) : undefined;
  });
  /** This tab can see the prompt: it opened the match, and the replay can't come. */
  const canPrompt = () => !!unavailable() && !!opener() && opener() === matchId();
  createEffect(() => {
    if (armed() && canPrompt()) {
      setArmed(false);
      setPrompted(true);
    }
  });
  // An upload started (from the prompt or anywhere) answers it.
  createEffect(() => uploading() && setPrompted(false));
  const prompt = {
    shown: () => prompted() && canPrompt(),
    open: () => setPrompted(true),
    /** Use API summary: closed, and not again on its own for this match in this browser. */
    dismiss: () => {
      const id = matchId();
      if (id) chooseSummary(id);
      setArmed(false);
      setPrompted(false);
    },
    /** Try again: closed, the fetch started again, and the prompt back if that fails too. */
    retry: async () => {
      const id = matchId();
      if (!id) return;
      setPrompted(false);
      setArmed(false);
      setJob({ state: "fetching", source: "cdn" });
      await fetchReplay();
      if (matchId() !== id) return;
      // Refused at once: the server's own state again, for the chip.
      if (problem()) await watch(id);
      setArmed(true);
    },
  };

  /** Try the failed step again: the match's metadata (`attach` for an editor), or the fetch. */
  const retry = (attach: boolean) => {
    const id = matchId();
    if (!id) return;
    if (problem()?.step === "load" || !tl()) return void open(id, { attach });
    return void fetchReplay();
  };

  /**
   * What to tell the user about the open match (operator, 2026-11-08): nothing while a replay
   * is on its way or shown; else an upload's or parse's failure, what failed last, or why the
   * fetch from Valve isn't coming.
   */
  const notice = createMemo((): (Notice & { step: Step }) | undefined => {
    const j = job();
    const m = tl();
    if (uploading() || busy(j) || (m && m.tier === "replay")) return undefined;
    const p = problem();
    const failedUpload = j?.state === "failed" && j.source === "upload" ? j.reason : undefined;
    const pick = failedUpload && p?.step !== "upload" ? { code: failedUpload, step: "upload" as Step } : p ?? (j?.state === "failed" && j.reason ? { code: j.reason, step: "fetch" as Step } : undefined);
    // Why Valve's replay isn't coming is the prompt's to say (and the chip's), not a notice.
    if (pick?.step === "fetch" && unavailableFor(pick.code)) return undefined;
    const n = pick && noticeFor(pick.code, pick.step);
    return n && { ...n, step: pick.step };
  });

  /** A replay the landing page handed this board: upload it in Player, then attach the match. */
  const startHandoff = async (h: Handoff) => {
    setMatchId(h.id);
    setTl(undefined);
    setJob(undefined);
    setProblem(undefined);
    setStatus("");
    setMode("player");
    const up = upload(h.file, { attach: true, opened: h.opened });
    // The summary, if deadlock-api has one, to watch meanwhile.
    await loadTimeline(h.id, false).catch(() => undefined);
    await up;
  };

  /** Load the board's matches; a board with one opens in Player. */
  const init = async () => {
    const handed = takeHandoff(board);
    if (handed) return startHandoff(handed);
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
    showNames,
    setShowNames,
    vision,
    setVision,
    playerName,
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
    sent,
    uploading,
    cancelUpload,
    refuse,
    problem,
    notice,
    retry,
    unavailable,
    canPrompt,
    prompt,
    playback,
    setPlayback,
    t,
    duration,
    control,
    open,
    upload,
    take,
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
      if (!m) return { players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map(), rifts: new Map(), powerups: new Map() };
      const at = t();
      const health = showHealth() && m.tier === "replay";
      // One team's view: its enemies as it saw them (ghosted out of sight, undrawn unseen).
      const view = vision() !== "all" && hasVision(m) ? vision() : null;
      const players = new Map(
        playersAt(m, at).map((x, i) => {
          const shown = { hero: x.hero_id, name: showNames() ? x.name : null, pos: x.pos, health: health ? x.health : null, respawn: x.respawn };
          const s = view && x.team !== view ? seenAt(m.players[i]!, at) : { seen: true as const };
          return [slotKey(x.team, x.slot), s?.seen ? shown : { ...shown, pos: s?.at ?? null, health: null, ghost: s?.ago ?? null }];
        }),
      );
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
      const u = urnAt(m, at);
      const site = (k: string | null | undefined) => (k ? (markerKey(k, markers) ?? null) : null);
      // In one team's view, an urn carried by an enemy out of its sight isn't drawn: where it
      // is would give the carrier away (operator 2026-11-09), ghost or undrawn alike.
      // `at: null` draws nothing and can't be hovered (Urn.tsx, Camps.tsx).
      const carrier = u?.state === "carried" && view && u.team !== view ? m.players.findIndex((q) => q.team === u.team && q.slot === u.slot) : -1;
      const unseen = carrier >= 0 && !seenAt(m.players[carrier]!, at)?.seen;
      const urn = u ? { ...u, ...(unseen ? { at: null } : {}), delivery: site(u.delivery), next: u.next ? { t: u.next.t, key: site(u.next.key) ?? u.next.key } : null } : undefined;
      const rifts = new Map<string, RiftAt>();
      if (m.rifts) for (const mk of markers) if (mk.kind === "koth") rifts.set(mk.key, riftAt(m, mk.key, at, markers)!);
      const powerups = new Map<string, PowerupAt>();
      for (const p of m.powerups ?? []) {
        const v = powerupAt(p, at);
        const key = markerKey(p.key, markers);
        if (v && key) powerups.set(key, v);
      }
      return { players, down: downAt(m, at, markers), sites: sitesAt(m, at, markers), lanes: lanesAt(m, at), camps, rifts, powerups, ...(health ? { health: byMarker(objectiveHealthAt(m, at)) } : {}), ...(urn ? { urn } : {}), ...(m.rejuv ? { rejuv: rejuvAt(m, at) } : {}) };
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
/** Waits before asking for a turn again after a request got no answer (a blip, a restart): 14 s
 * in all, well inside the 90 s a place is kept unasked. */
const OFFLINE_RETRIES = [2000, 4000, 8000];
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
