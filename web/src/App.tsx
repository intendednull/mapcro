import { Match, Switch, createMemo, createResource } from "solid-js";
import { parseShareUrl } from "./core/api";
import { href } from "./core/nav";
import { Board } from "./board/Board";
import { Landing } from "./landing/Landing";
import { DeadLink } from "./ui/DeadLink";
import { loadArt } from "./map/pack";
import { OpenLinkKeys, UpdateBanner } from "./ui/OpenLink";

export function App() {
  // The landing can open a board in place, and back and forward follow the address
  // (core/nav.ts): the link follows it. Another board or another token is a new link, and the
  // board mounts afresh for it (sessions.md §4.1); the same one keeps its mount.
  const link = createMemo(() => parseShareUrl(href()), undefined, { equals: (a, b) => a?.board === b?.board && a?.token === b?.token });
  // A board path whose link doesn't parse (cut short, mistyped): say so, don't show the landing.
  const broken = () => !link() && new URL(href()).pathname.startsWith("/b/");
  const [art] = createResource(() => loadArt());
  return (
    <>
    <OpenLinkKeys />
    <UpdateBanner />
    <Switch fallback={<Landing />}>
      <Match when={broken()}>
        <div class="app loading">
          <DeadLink />
        </div>
      </Match>
      <Match when={art() && link()} keyed>
        {(l) => <Board board={l.board} token={l.token} art={art()!} />}
      </Match>
      <Match when={link()}>
        <div class="app loading" />
      </Match>
    </Switch>
    </>
  );
}
