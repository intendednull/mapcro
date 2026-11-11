// In-page navigation: the landing hands a board an upload already chosen (a `File` can't cross a
// page load), so it opens the board without reloading. Back and forward follow the address in
// place too (sessions.md §10 phase 0): App shows what the address names, and a board that is
// left unmounts cleanly (its socket closed, its timers stopped, module state reset), so the next
// one starts as it would on a fresh page. A change of fragment only (the same board, another
// token: a link opened in the app, an edited address) is followed the same way: the board mounts
// again with the new token.

import { createSignal } from "solid-js";

const [href, setHref] = createSignal(location.href);
export { href };

/** Show `url` (same origin) without a page load. */
export function navigate(url: string) {
  history.pushState(null, "", url);
  setHref(location.href);
}

/** Show the address as it is now (back, forward, an edited fragment). */
const follow = () => {
  if (location.href !== href()) setHref(location.href);
};
addEventListener("popstate", follow);
addEventListener("hashchange", follow);
