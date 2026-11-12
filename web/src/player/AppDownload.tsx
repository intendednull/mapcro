// The app's two downloads for this system (`desktopAppLinks`): the default one, and the quieter
// one beside it. Both are files (`releases/latest/download/<stable name>`), so they download in
// place: no new tab, never a release page.

import type { DesktopLinks } from "./desktop";

export function AppDownload(p: { links: DesktopLinks; where: string; class?: string; altClass?: string }) {
  return (
    <>
      <a class={p.class} href={p.links.href} download="" data-os={p.links.os} data-testid={`app-get-${p.where}`} title={p.links.title}>
        {p.links.label}
      </a>{" "}
      <a class={p.altClass ?? "muted"} href={p.links.alt.href} download="" data-testid={`app-alt-${p.where}`}>
        {p.links.alt.label}
      </a>
    </>
  );
}
