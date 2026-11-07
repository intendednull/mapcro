import { Match, Switch, createResource } from "solid-js";
import { parseShareUrl } from "./core/api";
import { Board } from "./board/Board";
import { Landing } from "./landing/Landing";
import { loadArt } from "./map/pack";

export function App() {
  const link = parseShareUrl(location.href);
  const [art] = createResource(() => loadArt());
  return (
    <Switch fallback={<Landing />}>
      <Match when={link && art()}>
        <Board board={link!.board} token={link!.token} art={art()!} />
      </Match>
      <Match when={link}>
        <div class="app loading" />
      </Match>
    </Switch>
  );
}
