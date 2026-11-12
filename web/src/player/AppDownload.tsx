// The app's download for this system (`desktopAppLinks`): the self-updating build only (the
// installer, the AppImage). A file (`releases/latest/download/<stable name>`), so it downloads in
// place: no new tab, never a release page.

import type { DesktopLinks } from "./desktop";

export function AppDownload(p: { links: DesktopLinks; where: string; class?: string }) {
  return (
    <a class={p.class} href={p.links.href} download="" data-os={p.links.os} data-testid={`app-get-${p.where}`} title={p.links.title}>
      {p.links.label}
    </a>
  );
}
