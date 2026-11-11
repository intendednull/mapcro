import { Match, Switch, createMemo, createResource } from "solid-js";
import { parseShareUrl } from "./core/api";
import { href } from "./core/nav";
import { Board } from "./board/Board";
import { Landing } from "./landing/Landing";
import { DeadLink } from "./ui/DeadLink";
import { loadArt } from "./map/pack";
import { OpenLinkKeys } from "./ui/OpenLink";
import { followHashChanges } from "./core/applink";

// Another token for the same board (a link opened in the app, an edited address) loads it.
followHashChanges();

export function App() {
  // The landing can open a board in place (core/nav.ts): the link follows the address.
  const link = createMemo(() => parseShareUrl(href()));
  // A board path whose link doesn't parse (cut short, mistyped): say so, don't show the landing.
  const broken = () => !link() && new URL(href()).pathname.startsWith("/b/");
  const [art] = createResource(() => loadArt());
  return (
    <>
    <OpenLinkKeys />
    <Switch fallback={<Landing />}>
      <Match when={broken()}>
        <div class="app loading">
          <DeadLink />
        </div>
      </Match>
      <Match when={link() && art()}>
        <Board board={link()!.board} token={link()!.token} art={art()!} />
      </Match>
      <Match when={link()}>
        <div class="app loading" />
      </Match>
    </Switch>
    </>
  );
}
