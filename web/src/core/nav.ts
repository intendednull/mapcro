// In-page navigation: the landing hands a board an upload already chosen (a `File` can't cross a
// page load), so it opens the board without reloading. Back from there reloads (the board isn't
// built to be unmounted by history).

import { createSignal } from "solid-js";

const [href, setHref] = createSignal(location.href);
export { href };

/** Show `url` (same origin) without a page load. */
export function navigate(url: string) {
  history.pushState(null, "", url);
  setHref(location.href);
}

addEventListener("popstate", () => {
  if (location.href !== href()) location.reload();
});
