import { Match, Switch, createResource } from "solid-js";
import { parseShareUrl } from "./core/api";
import { Board } from "./board/Board";
import { Landing } from "./landing/Landing";
import { DeadLink } from "./ui/DeadLink";
import { loadArt } from "./map/pack";

export function App() {
  const link = parseShareUrl(location.href);
  // A board path whose link doesn't parse (cut short, mistyped): say so, don't show the landing.
  const broken = !link && location.pathname.startsWith("/b/");
  const [art] = createResource(() => loadArt());
  return (
    <Switch fallback={<Landing />}>
      <Match when={broken}>
        <div class="app loading">
          <DeadLink />
        </div>
      </Match>
      <Match when={link && art()}>
        <Board board={link!.board} token={link!.token} art={art()!} />
      </Match>
      <Match when={link}>
        <div class="app loading" />
      </Match>
    </Switch>
  );
}
