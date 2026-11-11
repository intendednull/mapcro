// The Windows app's replay picker (spec §6b, "The Windows app"; operator, 2026-11-10): the
// upload opens this list of the replays folder's replays as small cards, newest first (the open
// match's first), and a pick is the upload. Desktop app only: a browser keeps its file input,
// drop and linked folder. The folder is listed when the picker opens, on focus and every
// PICKER_POLL_MS while it's open and shown; nothing runs while it's closed. Each card's preview
// (heroes, kills, souls, the winner) is fetched once it's in view (`picker.ts`). Labels per §4b.

import { For, Match, Show, Switch, createSignal, onCleanup, onMount } from "solid-js";
import { cx } from "../ui/cx";
import { ModalScrim } from "../ui/ModalScrim";
import { dialogKeys } from "../ui/modal";
import { type Art, loadArt } from "../map/pack";
import { teamName } from "../map/model";
import { formatSouls } from "../core/souls";
import type { Replay } from "./folder";
import { DesktopError, type LocalSource, bridge, desktopSource } from "./desktop";
import { type CardData, PAGE, PICKER_POLL_MS, type Preview, type PreviewTeam, lengthLabel, modeLabel, pickerList, previews, whenLabel } from "./picker";

/** A replay picked from the folder: its id, its parse (gzipped timeline) and its file. */
export interface Picked {
  id: string;
  timeline: () => Promise<Blob>;
  file: () => Promise<File>;
}

/** The app's folder, as a source, when this page is in the app's window. */
let appSource: LocalSource | null | undefined;
export function pickerSource(): LocalSource | undefined {
  if (appSource === undefined) {
    const b = bridge();
    appSource = b ? desktopSource(b) : null;
  }
  return appSource ?? undefined;
}

/** The newest pack's art, loaded once for pages that have none (the landing). */
let art: Promise<Art> | undefined;
const packArt = () => (art ??= loadArt());

export function ReplayPicker(p: { source: LocalSource; art?: Art | undefined; current?: string | undefined; onPick: (r: Picked) => void; onClose: () => void }) {
  const [list, setList] = createSignal<Replay[]>();
  const [missing, setMissing] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [shown, setShown] = createSignal(PAGE);
  const [heroes, setHeroes] = createSignal<Art | undefined>(p.art);
  if (!p.art) void packArt().then(setHeroes);

  let looking = false;
  const look = async () => {
    if (looking) return;
    looking = true;
    try {
      const l = await p.source.list();
      setMissing(false);
      setList(l);
    } catch (e) {
      setMissing(e instanceof DesktopError && e.code === "not_found");
      setList([]);
    } finally {
      setNow(Date.now());
      looking = false;
    }
  };
  onMount(() => {
    void look();
    const again = () => document.visibilityState === "visible" && void look();
    const timer = setInterval(again, PICKER_POLL_MS);
    addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    onCleanup(() => {
      clearInterval(timer);
      removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    });
  });
  const cards = () => pickerList(list() ?? [], p.current, now());
  const change = async () => {
    try {
      if ((await p.source.chooseFolder()) === "chosen") {
        setShown(PAGE);
        await look();
      }
    } catch {
      // The chooser couldn't open: the folder stays as it was.
    }
  };
  const pick = (id: string) => p.onPick({ id, timeline: () => p.source.timeline(id), file: () => p.source.read(id) });

  return (
    <ModalScrim testid="replay-picker-scrim" class="picker-scrim" onClose={p.onClose}>
      <div class="dialog picker" role="dialog" aria-modal="true" aria-labelledby="picker-h" data-testid="replay-picker" onKeyDown={dialogKeys(p.onClose)}>
        <header>
          <h2 id="picker-h">Replays</h2>
          <button class="x" type="button" aria-label="Close" data-testid="picker-close" onClick={() => p.onClose()}>
            <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        <div class="body picker-body">
          <Switch>
            <Match when={list() === undefined}>
              <p class="picker-note" data-testid="picker-loading">
                Loading
              </p>
            </Match>
            <Match when={missing()}>
              <p class="picker-note" data-testid="picker-missing">
                Replays folder not found
              </p>
            </Match>
            <Match when={!cards().length}>
              <p class="picker-note" data-testid="picker-empty">
                No replays
              </p>
            </Match>
            <Match when={cards().length}>
              <ol class="picker-list" data-testid="picker-list">
                <For each={cards().slice(0, shown())}>{(r) => <Card replay={r} art={heroes()} now={now()} current={r.id === p.current} onPick={() => pick(r.id)} />}</For>
              </ol>
              <Show when={cards().length > shown()}>
                <button class="btn ghost small picker-more" type="button" data-testid="picker-more" onClick={() => setShown(shown() + PAGE)}>
                  More
                </button>
              </Show>
            </Match>
          </Switch>
        </div>
        <footer>
          <span />
          <button class="btn ghost small" type="button" data-testid="picker-folder" onClick={() => void change()}>
            Change folder
          </button>
        </footer>
      </div>
    </ModalScrim>
  );
}

/** One replay: its id, file time, then the preview once it's in view. */
function Card(p: { replay: Replay; art: Art | undefined; now: number; current: boolean; onPick: () => void }) {
  const id = p.replay.id;
  const [data, setData] = createSignal<CardData>(previews.peek(id) ?? { kind: "loading" });
  let el!: HTMLButtonElement;
  const ask = () => void previews.ask(id).then(setData);
  onMount(() => {
    if (typeof IntersectionObserver !== "function") return ask();
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        io.disconnect();
        ask();
      }
    });
    io.observe(el);
    onCleanup(() => io.disconnect());
  });
  const preview = () => {
    const d = data();
    return d.kind === "preview" ? d.preview : undefined;
  };
  const when = () => whenLabel(preview()?.start_time, p.replay.lastModified, p.now);
  return (
    <li>
      <button ref={el} type="button" class={cx("picker-card", p.current && "current")} data-testid="picker-card" data-match={id} data-state={data().kind} onClick={() => p.onPick()}>
        <span class="picker-head">
          <b class="picker-id">{id}</b>
          <Show when={p.current}>
            <span class="picker-tag" data-testid="picker-current">
              This match
            </span>
          </Show>
          <Show when={(() => { const d = data(); return d.kind === "mode" ? d.label : preview() && modeLabel(preview()!); })()}>
            {(m) => (
              <span class="picker-tag mode" data-testid="picker-mode">
                {m()}
              </span>
            )}
          </Show>
          <span class="spacer" />
          <span class="picker-when" data-testid="picker-when" title={when().title}>
            {when().text}
          </span>
          <span class="picker-len" data-testid="picker-length" title={preview() ? undefined : "Not recorded"}>
            {preview() ? lengthLabel(preview()!.duration_s) : "—"}
          </span>
        </span>
        <Switch>
          <Match when={preview()}>{(pv) => <Teams preview={pv()} art={p.art} />}</Match>
          <Match when={data().kind === "none"}>
            <span class="picker-none" data-testid="picker-none">
              Not recorded
            </span>
          </Match>
        </Switch>
      </button>
    </li>
  );
}

function Teams(p: { preview: Preview; art: Art | undefined }) {
  return (
    <span class="picker-teams">
      <For each={p.preview.teams}>{(t) => <TeamRow team={t} won={p.preview.winner === t.team} art={p.art} />}</For>
    </span>
  );
}

function TeamRow(p: { team: PreviewTeam; won: boolean; art: Art | undefined }) {
  const souls = () => formatSouls(p.team.souls);
  return (
    <span class={cx("picker-team", p.team.team, p.won && "won")} data-testid="picker-team" data-team={p.team.team}>
      <span class="picker-team-name">{teamName(p.team.team)}</span>
      <span class="picker-heroes">
        <For each={p.team.heroes}>
          {([, hero]) => {
            const h = () => p.art?.heroes.get(hero);
            return (
              <i class="picker-hero" data-testid="picker-hero" data-hero={hero} title={h()?.name}>
                <Show when={h()?.portrait ?? h()?.topbar} fallback={<b>{(h()?.name ?? "?").slice(0, 1)}</b>}>
                  {(src) => <img src={src()} alt={h()?.name ?? ""} draggable={false} />}
                </Show>
              </i>
            );
          }}
        </For>
      </span>
      <span class="picker-kills" data-testid="picker-kills" title="Kills">
        {p.team.kills}
      </span>
      <span class="picker-souls" data-testid="picker-souls" title="Souls">
        {souls().value}
        <Show when={souls().k}>
          <small>k</small>
        </Show>
      </span>
      <span class="picker-won" data-testid={p.won ? "picker-won" : undefined}>
        {p.won ? "Win" : ""}
      </span>
    </span>
  );
}
