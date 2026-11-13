// Player's state for one board (spec §6b): the attached matches, the open match's timeline and
// replay job, the playback clock, the mode (Player or Sandbox) and the jump highlight. The
// board creates one; Player renders it; following reads and writes its playback.

import type { Via } from "../gen/Via";
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { type CampAt, type MatchEvent, type PowerupAt, type RiftAt, type Timeline, tierOf, campsAt, downAt, lanesAt, markerKey, objectiveHealthAt, playersAt, powerupAt, rejuvAt, riftAt, shopsClosed, sitesAt, urnAt } from "../match/timeline";
import { movementAt } from "./movement";
import type { MatchPreview } from "../match/preview";
import { slotKey } from "../match/save";
import type { Marker } from "../map/model";
import { Api, type JobState, MODE_CODES, busy } from "./api";
import { markOutdated } from "./reparse";
import { type Notice, type Step, type Unavailable, idFromName, isDem, looksLikeDemo, noticeFor, unavailableFor } from "./notice";
import { NOT_DEM } from "./ReplayHelp";
import { type Handoff, takeHandoff } from "./handoff";
import { type Playback, clampT, follow, rebase, tAt } from "./clock";
import { type Pt, worldToMap } from "../map/transform";
import { type EventGroup, GROUPS, eventKey } from "./events";
import { mapCratesShown, mapHealsShown, setMapCratesShown, setMapHealsShown, chooseSummary, markOpened, openedHere, playerLastSeenShown, playerNamesShown, playerVision, setPlayerLastSeenShown, setPlayerNamesShown, setPlayerVision, summaryChosen } from "../core/device";
import { type Vision, hasVision, seenAt } from "./vision";
import { skullsAt } from "./skulls";
import { crowdControlAt } from "./cc";
import type { PlayerVision } from "../gen/PlayerVision";
import type { DeathRef } from "../gen/DeathRef";
import type { SlotRef } from "../gen/SlotRef";
import type { BuildPopover } from "../gen/BuildPopover";
import type { HeroPanel } from "../gen/HeroPanel";
import type { PanelPlace } from "../gen/PanelPlace";
import { type Death, type HeroPanelOpen, type Place, deathKey } from "./layers";
import { type ValueOf, clipText, createViewState } from "./viewstate";
import { VIEW_STATE, type ViewKey } from "../gen/viewState";

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
  /** Whose vision the map draws (`null` team: All) and Show last seen location. */
  vision?: PlayerVision | null;
  /** The open panels (wire.rs `Playback`): left out when closed. */
  skull_recap?: DeathRef;
  event_recap?: DeathRef;
  inspect?: SlotRef;
  all_builds?: boolean;
  build_popover?: BuildPopover;
  event_filters?: number;
  event_search?: string;
  /** Where the map's death recap and the hero panels were moved to (#35, #37). */
  skull_place?: PanelPlace;
  hero_panels?: HeroPanel[];
}

export function createPlayerHost(board: string, token: string, via?: Via) {
  const api = new Api(board, token, via);
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
  /**
   * The view state the registry holds (player/viewstate.ts; crates/engine/src/view_state.rs has
   * each key's follow policy). While you follow, a presenter's values are drawn (spec §8); a
   * change of your own to what the map draws stops following and keeps what you saw with it;
   * Stop following, or the presenter leaving, brings your own back. Map layers: troopers, health
   * and pings on by default (operator, 2026-11-08), CC and movement off; Heals and Heavy boxes
   * remembered in this browser. Vision (spec §6b): every hero, or one team's view, where an enemy
   * out of its sight isn't drawn (with Last seen, a ghost where it was last seen); remembered
   * here. Players' names (spec §6b "Names"): this browser's alone, never in presence. The panels
   * (the skull's recap, the events list's recaps, the top bar's builds and the popover open in
   * one, operator 2026-11-11) and the events list's filters and search: a follower opens,
   * closes and filters with its presenter, and may change its own without stopping; the
   * presenter's next change wins.
   */
  const REMEMBER: Partial<Record<ViewKey, (v: never) => void>> = {
    "layer.heals": setMapHealsShown,
    "layer.crates": setMapCratesShown,
    names: setPlayerNamesShown,
    "vision.team": setPlayerVision,
    "vision.last_seen": setPlayerLastSeenShown,
  };
  /** Your own change that stops following: Board says how (`onStop`). */
  let stopFollow: (() => void) | undefined;
  const viewState = createViewState(
    {
      "layer.troopers": true,
      "layer.health": true,
      "layer.pings": true,
      "layer.cc": false,
      "layer.movement": false,
      "layer.heals": mapHealsShown(),
      "layer.crates": mapCratesShown(),
      "builds.all": false,
      names: playerNamesShown(),
      "vision.team": playerVision(),
      "vision.last_seen": playerLastSeenShown(),
      "recap.skull": undefined,
      "recap.event": [],
      "builds.inspect": undefined,
      "builds.popover": "none",
      "recap.skull.place": undefined,
      "heroes.panels": [],
      "events.filter.death": false,
      "events.filter.ult": false,
      "events.filter.objective": false,
      "events.filter.mid_boss": false,
      "events.filter.rift": false,
      "events.filter.powerup": false,
      "events.filter.urn": false,
      "events.filter.souls": false,
      "events.filter.purchase": false,
      "events.search": "",
      "events.search.names": playerNamesShown() ? "on" : "off",
    },
    { onOwn: (k, v) => REMEMBER[k]?.(v as never), onStop: () => stopFollow?.() },
  );
  /** A key's value, and your own choice of it. */
  const showing = <K extends ViewKey>(k: K) => () => viewState.get(k);
  const choosing = <K extends ViewKey>(k: K) => (v: ValueOf<K>) => viewState.set(k, v);
  const showTroopers = showing("layer.troopers");
  const setShowTroopers = choosing("layer.troopers");
  const showHealth = showing("layer.health");
  const setShowHealth = choosing("layer.health");
  const showCC = showing("layer.cc");
  const setShowCC = choosing("layer.cc");
  const showMovement = showing("layer.movement");
  const setShowMovement = choosing("layer.movement");
  const showPings = showing("layer.pings");
  const setShowPings = choosing("layer.pings");
  const showHeals = showing("layer.heals");
  const setShowHeals = choosing("layer.heals");
  const showCrates = showing("layer.crates");
  const setShowCrates = choosing("layer.crates");
  const showNames = showing("names");
  const setShowNames = choosing("names");
  const vision = showing("vision.team") as () => Vision;
  const setVision = choosing("vision.team") as (v: Vision) => void;
  const showLastSeen = showing("vision.last_seen");
  const setShowLastSeen = choosing("vision.last_seen");
  /** What presence's `layers` says. */
  const layersWire = () => viewState.wire("layers").layers as number;
  const skullRecap = showing("recap.skull");
  const setSkullRecap = choosing("recap.skull");
  const eventRecapOpen = (d: Death) => viewState.get("recap.event").some((x) => deathKey(x) === deathKey(d));
  const setEventRecapOpen = (d: Death, open: boolean) => {
    // The details' toggle event fires for a change made here too: a repeat changes nothing.
    if (open === untrack(() => eventRecapOpen(d))) return;
    const rest = untrack(() => viewState.get("recap.event")).filter((x) => deathKey(x) !== deathKey(d));
    viewState.set("recap.event", open ? [...rest, d] : rest);
  };
  /** Where the map's death recap was moved to (#35): none, where it opens. */
  const skullPlace = showing("recap.skull.place");
  const setSkullPlace = choosing("recap.skull.place");
  /** The hero panels open from the map's tokens (#37), back to front, each where it was put. */
  const heroPanels = showing("heroes.panels");
  const setHeroPanels = (f: (list: HeroPanelOpen[]) => HeroPanelOpen[]) => viewState.set("heroes.panels", f(untrack(heroPanels)));
  /** A hero's panel: opened at `at`, or brought to the front when it is open. Past every
   * hero's, the one at the back closes. */
  const openHeroPanel = (slot: string, at: Place) =>
    setHeroPanels((list) => {
      const was = list.find((h) => h.slot === slot);
      return [...list.filter((h) => h.slot !== slot), was ?? { slot, at }].slice(-VIEW_STATE["heroes.panels"].max);
    });
  const closeHeroPanel = (slot: string) => setHeroPanels((list) => list.filter((h) => h.slot !== slot));
  const placeHeroPanel = (slot: string, at: Place) => setHeroPanels((list) => list.map((h) => (h.slot === slot ? { ...h, at } : h)));
  /** A press on a hero panel brings it to the front. */
  const raiseHeroPanel = (slot: string) => setHeroPanels((list) => (list.at(-1)?.slot === slot || !list.some((h) => h.slot === slot) ? list : [...list.filter((h) => h.slot !== slot), list.find((h) => h.slot === slot)!]));
  const openBuild = showing("builds.inspect");
  const setOpenBuild = choosing("builds.inspect");
  const allBuilds = showing("builds.all");
  const setAllBuilds = (on: boolean | ((was: boolean) => boolean)) => viewState.set("builds.all", typeof on === "function" ? on(untrack(allBuilds)) : on);
  const [tabHeld, setTabHeld] = createSignal(false);
  /** Which of Effects and Build order is open in the inspected build (BuildColumn.tsx). */
  const buildPopover = showing("builds.popover");
  const setBuildPopover = choosing("builds.popover");
  /** The events list's filter chips (events.ts `GROUPS`) and search. */
  const eventFilters = () => new Set(GROUPS.filter((g) => viewState.get(`events.filter.${g.id}`)).map((g) => g.id));
  const setEventFilter = (g: EventGroup, on: boolean) => viewState.set(`events.filter.${g}`, on);
  const eventSearch = showing("events.search");
  /** Your own search finds by name as your Names says, and says so to followers. */
  const ownSearchNames = () => (untrack(showNames) ? "on" : "off");
  const setEventSearch = (q: string) =>
    batch(() => {
      viewState.set("events.search.names", ownSearchNames());
      viewState.set("events.search", clipText(q, VIEW_STATE["events.search"].max));
    });
  // While the search's way of finding is your own, it follows your Names.
  createEffect(() => {
    if (!viewState.heard("events.search.names")) viewState.set("events.search.names", showNames() ? "on" : "off");
  });
  /** The search is a presenter's (operator 2026-11-11): it may hold a player's name, so with
   * Names off its box shows none of it. */
  const eventSearchHeard = () => viewState.heard("events.search");
  /** Whether the search finds players by name: as the presenter's Names, for theirs (an older
   * presenter's says nothing: your own Names). */
  const eventSearchByName = () => {
    const n = viewState.get("events.search.names");
    return n === "own" ? showNames() : n === "on";
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

  /**
   * Whether this moment continues the last in playback (MatchPreview `fade`): the same match,
   * view and run (no seek, scrub or jump), and under a second since the last (a tab back from
   * the background, a stalled box, snaps). A memo on t, however many read it.
   */
  let run: { jumps: number; view: Vision; ghosts: boolean; tl: Timeline | undefined; wall: number } | undefined;
  const continuous = createMemo(() => {
    t();
    const now = { jumps, view: vision(), ghosts: showLastSeen(), tl: tl(), wall: performance.now() };
    const was = run;
    run = now;
    return !!was && was.jumps === now.jumps && was.view === now.view && was.ghosts === now.ghosts && was.tl === now.tl && now.wall - was.wall < 1000;
  });

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
  // The board unmounted (sessions.md §4.1): nothing of this host runs on. The upload in flight
  // stops (waiting for its turn too: its place is given back), as a page left would stop it, and
  // no poll is set again by an answer that comes after. Every step that makes a request checks
  // `gone` first and again after each wait, so an answer that comes after the board left (its
  // matches, a timeline, an attach) starts nothing: no request, and no upload its cleanup could
  // no longer stop.
  let gone = false;
  onCleanup(() => {
    gone = true;
    clearTimeout(poll);
    inflight?.ctl.abort();
  });
  /** Follow the replay job until it settles; a finished one swaps the replay in. */
  const watch = async (id: string) => {
    clearTimeout(poll);
    if (gone) return;
    try {
      // This tab's own upload (waiting for its turn, then sending) is the truth while it runs;
      // its end watches again.
      if (inflight?.id === id) return;
      const j = await api.job(id);
      if (gone || !j || matchId() !== id) return;
      const was = job()?.state;
      setJob(j);
      if (j.state === "done" && was !== "done") await loadTimeline(id, true);
      if (busy(j)) poll = setTimeout(() => void watch(id), 1500);
    } catch {
      poll = setTimeout(() => void watch(id), 5000);
    }
  };

  const loadTimeline = async (id: string, keep: boolean) => {
    if (gone) return;
    const r = await api.timeline(id);
    if (gone || matchId() !== id) return;
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
        if (gone || !j || matchId() !== id) return;
        if (j.state === "done") void loadTimeline(id, true);
        if (j.state !== job()?.state) setJob(j);
        if (busy(j)) void watch(id);
      });
    }, 5000);
    onCleanup(() => clearInterval(timer));
  });

  /** Open a match: attach it (editors), load its timeline and its replay job's state. */
  const open = async (id: string, opts: { attach: boolean; at?: number } = { attach: false }) => {
    if (gone) return;
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
      if (gone) return;
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
    if (gone || !id || inflight) return;
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
      if (gone || matchId() !== id) return;
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
        for (let i = 0; i < 20 && !ended && !gone; i++) {
          const j = await api.job(id).catch(() => undefined);
          if (j?.source === "upload" && j.state !== "none") break;
          await new Promise((r) => setTimeout(r, 250));
        }
        if (gone || failed || !(await api.attach(id).catch(() => false))) return;
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
    if (gone || matchId() !== id) return;
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
  /**
   * The open match's replay from the Windows app (`desktop.ts`): parsed on this machine, and
   * only its timeline sent (spec §6a, Timelines parsed on the user's machine). A server without
   * the route gets the `.dem` instead, through `take`. The chip says Parsing meanwhile.
   */
  const takeLocal = async (id: string, timeline: () => Promise<Blob>, file: () => Promise<File>, opts: { attach?: boolean; opened?: () => void } = {}) => {
    if (gone || matchId() !== id || inflight) return;
    const ctl = new AbortController();
    inflight = { id, ctl };
    setStatus("");
    setProblem(undefined);
    setJob({ state: "parsing", source: "upload" });
    const end = (code?: string) => {
      inflight = undefined;
      if (matchId() !== id) return;
      setJob(undefined);
      // This run's parser is older than the server's: Reparse can't help (`reparse.ts`).
      if (code === "outdated_parser") markOutdated();
      if (code) setProblem({ code, step: "upload" });
    };
    let gz: Blob;
    try {
      gz = await timeline();
    } catch (e) {
      // The app's `not_found`: the file left the folder (not the match's metadata).
      const code = (e as { code?: string }).code ?? "parse_failed";
      end(code === "not_found" ? "file_gone" : code);
      // The job as it stands again (the board's stale upload, say), not none: without it the
      // upload and Reparse aren't offered after a failed parse.
      return void (gone || matchId() !== id || (await watch(id)));
    }
    if (gone || ctl.signal.aborted) return end("aborted");
    const e = await api.uploadTimeline(id, gz, ctl.signal);
    if (gone) return end();
    if (e === "missing") {
      end();
      let f: File;
      try {
        f = await file();
      } catch {
        return setProblem({ code: "file_gone", step: "upload" });
      }
      if (gone) return;
      return void (opts.attach ? await upload(f, opts) : await take(f));
    }
    end(e);
    if (!e && opts.attach && (await api.attach(id).catch(() => false))) {
      setMatches([Number(id), ...matches().filter((m) => m !== Number(id))]);
      opts.opened?.();
    }
    if (matchId() !== id) return;
    if (!e && problem()?.step === "load") setProblem(undefined);
    await watch(id);
  };
  /**
   * A replay picked in the Windows app's picker (`ReplayPicker.tsx`): the open match's is parsed
   * and sent; another match's is opened (and attached) first, then sent if that match has no
   * full replay yet.
   */
  const pick = async (r: { id: string; timeline: () => Promise<Blob>; file: () => Promise<File> }) => {
    if (gone) return;
    if (r.id !== matchId()) {
      await open(r.id, { attach: true });
      if (gone || matchId() !== r.id || MODE_CODES.has(problem()?.code ?? "")) return;
      const now = tl();
      // It has its replay, or Valve's is on its way.
      if ((now && tierOf(now) === "replay") || busy(job())) return;
    }
    await takeLocal(r.id, r.timeline, r.file);
  };
  const cancelUpload = () => inflight?.ctl.abort();
  /** An upload refused before it started (the file isn't a replay). */
  const refuse = (code: string) => setProblem({ code, step: "upload" });
  /** This tab is uploading the open match. */
  const uploading = () => sent()?.id === matchId() && !!matchId();

  const fetchReplay = async () => {
    const id = matchId();
    if (gone || !id) return;
    setProblem(undefined);
    const e = await api.fetchReplay(id);
    if (gone || matchId() !== id) return;
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
    const opts = { attach: true, opened: h.opened };
    const up = h.local ? takeLocal(h.id, h.local.timeline, h.local.file, opts) : h.file ? upload(h.file, opts) : Promise.resolve();
    // The summary, if deadlock-api has one, to watch meanwhile.
    await loadTimeline(h.id, false).catch(() => undefined);
    await up;
  };

  /** Load the board's matches; a board with one opens in Player. */
  const init = async () => {
    if (gone) return;
    const handed = takeHandoff(board);
    if (handed) return startHandoff(handed);
    const ms = await api.matches().catch(() => []);
    if (gone) return;
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
      // The registry's keys: Vision, and the open panels and events filters only (presence is
      // resent whole on every change, so closed ones cost nothing).
      ...viewWire(),
    };
  };
  const viewWire = (): Partial<PlaybackPresence> => {
    const out = (viewState.wire("playback").playback ?? {}) as Partial<PlaybackPresence>;
    // Tab held is sent as All builds; with every build open, none is the inspected one.
    if (tabHeld()) out.all_builds = true;
    if (out.all_builds) delete out.inspect;
    return out;
  };
  /**
   * A follower mirrors a presenter's mode, match and playback (spec §6b). Presence is resent
   * whole whenever anything in it changes, so the same playback arrives again and again with a
   * `t` that's older each time: a value is stamped when it first arrives and carried forward
   * from then; a repeat changes nothing (review 2026-11-08, finding 4).
   */
  let heard: { v: string; at: number; pb: PlaybackPresence } | undefined;
  const mirror = (s: { playback?: PlaybackPresence | null; layers?: number | null }) => {
    // Their layers and Vision, or, from an older presenter (or one without a match), your own.
    viewState.mirror(s);
    const theirs = s.playback;
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
    // The panels and the events list, once the match is here: each group as it changes.
    viewState.mirror(s, "panels");
    viewState.mirror(s, "events");
  };
  /**
   * Following stopped: the next presenter's values are new. `restore` (Stop following, or the
   * presenter left): your own layers and Vision come back. `keep` (your own change stopped it):
   * you keep what you were seeing. The panels stay as they are either way.
   */
  const forget = (how: "restore" | "keep") => {
    heard = undefined;
    viewState.forget(how);
  };
  // Another match: its panels are gone (they name its deaths and slots).
  createEffect(on(matchId, () => viewState.reset(), { defer: true }));

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
    showCC,
    setShowCC,
    showMovement,
    setShowMovement,
    showPings,
    setShowPings,
    showNames,
    setShowNames,
    vision,
    setVision,
    showLastSeen,
    setShowLastSeen,
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
    takeLocal,
    pick,
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
    /** What to do when your own change stops a follow (Board's `stopFollowing`). */
    onStop: (f: () => void) => {
      stopFollow = f;
    },
    showHeals,
    setShowHeals,
    showCrates,
    setShowCrates,
    layersWire,
    skullRecap,
    setSkullRecap,
    skullPlace,
    setSkullPlace,
    heroPanels,
    openHeroPanel,
    closeHeroPanel,
    placeHeroPanel,
    raiseHeroPanel,
    eventRecapOpen,
    setEventRecapOpen,
    openBuild,
    setOpenBuild,
    allBuilds,
    setAllBuilds,
    tabHeld,
    setTabHeld,
    buildPopover,
    setBuildPopover,
    eventFilters,
    setEventFilter,
    eventSearch,
    setEventSearch,
    eventSearchHeard,
    eventSearchByName,
    /** The match at playback time t as the board draws it; empty with no timeline (finding 7). */
    preview: (markers: Array<Pick<Marker, "key" | "kind" | "team" | "lane" | "at">>): MatchPreview => {
      const m = tl();
      if (!m) return { players: new Map(), down: new Set(), sites: new Map(), lanes: new Map(), camps: new Map(), rifts: new Map(), powerups: new Map() };
      const at = t();
      const health = showHealth() && m.tier === "replay";
      // One team's view: its enemies as it saw them. Out of sight: not drawn, or, with Show last
      // seen location, a ghost where last seen; one not seen since it came into the match,
      // never drawn.
      const view = vision() !== "all" && hasVision(m) ? vision() : null;
      const ghosts = showLastSeen();
      const players = new Map(
        playersAt(m, at).map((x, i) => {
          const shown = { hero: x.hero_id, name: showNames() ? x.name : null, pos: x.pos, health: health ? x.health : null, respawn: x.respawn };
          const s = view && x.team !== view ? seenAt(m.players[i]!, at) : { seen: true as const };
          // Only living heroes currently in sight receive live status. Never attach it to
          // last-seen ghosts: that would reveal a new effect applied outside the team's view.
          if (s?.seen) return [slotKey(x.team, x.slot), { ...shown, ...(showMovement() && m.tier === "replay" && x.pos ? movementAt(m.players[i]!, at) : {}), ...(showCC() && m.tier === "replay" && x.pos ? { cc: crowdControlAt(m.players[i]!, at) } : {}) }];
          return [slotKey(x.team, x.slot), ghosts && s ? { ...shown, pos: s.at, health: null, ghost: s.ago } : { ...shown, pos: null, health: null, ghost: null, unseen: true }];
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
      // is would give the carrier away (operator 2026-11-09), ghost or undrawn alike: the urn
      // never follows a ghost.
      // `at: null` draws nothing and can't be hovered (Urn.tsx, Camps.tsx).
      const carrier = u?.state === "carried" && view && u.team !== view ? m.players.findIndex((q) => q.team === u.team && q.slot === u.slot) : -1;
      const unseen = carrier >= 0 && !seenAt(m.players[carrier]!, at)?.seen;
      const urn = u ? { ...u, ...(unseen ? { at: null, unseen: true } : {}), delivery: site(u.delivery), next: u.next ? { t: u.next.t, key: site(u.next.key) ?? u.next.key } : null } : undefined;
      const rifts = new Map<string, RiftAt>();
      if (m.rifts) for (const mk of markers) if (mk.kind === "koth") rifts.set(mk.key, riftAt(m, mk.key, at, markers)!);
      const powerups = new Map<string, PowerupAt>();
      for (const p of m.powerups ?? []) {
        const v = powerupAt(p, at);
        const key = markerKey(p.key, markers);
        if (v && key) powerups.set(key, v);
      }
      const down = downAt(m, at, markers);
      // A death the view saw: a skull fading where it fell (spec §6b "Death skulls").
      const skulls = skullsAt(m.players, at, view);
      return { fade: continuous(), skulls, players, down, shops: shopsClosed(down, markers), sites: sitesAt(m, at, markers), lanes: lanesAt(m, at), camps, rifts, powerups, ...(health ? { health: byMarker(objectiveHealthAt(m, at)) } : {}), ...(urn ? { urn } : {}), ...(m.rejuv ? { rejuv: rejuvAt(m, at) } : {}) };
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
    // presence() reads the registry's shared keys (Vision, the panels, the events filters), so
    // a change to any of them sends.
    h.tabHeld();
    send(h.presence());
  });
  const beat = setInterval(() => {
    if (h.playback().playing) send(h.presence());
  }, 2000);
  onCleanup(() => clearInterval(beat));
}
