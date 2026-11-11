# The mapcro app (Windows, and Linux)

A thin Tauri 2 shell around the live site (`https://mapcro.dmgdeadlock.com`): one window, the
same web app, plus the native side of its replay picker. When you upload (the landing's
**Select replay**, Player's **Upload replay**), the site opens the picker: the replays folder,
looked up then, listed as cards with each match's heroes and score. The replay you pick is parsed
on this machine with `crates/replay`, and only its timeline is sent (~0.6 MB gzip instead of a
~500 MB demo). Nothing runs in the background: no watch and no notifications (operator, 2026-11-10), so no
tray either; closing the window quits. There is no second UI. Research and plan: `docs/research/desktop-app.md` (this is
Phase 2); the picker is spec §6b "The Windows app".

- `core/` (`mapcro-desktop-core`, in the root workspace): the native logic, no Tauri. It finds
  the replays folder (`steam.rs`, `folder.rs`), lists `<match id>.dem` files (`replays.rs`), and
  parses in a child process (`parse.rs`). `cargo test -p mapcro-desktop-core` runs on Linux and
  Windows.
- `app/` (`mapcro-desktop`, its own workspace): the Tauri shell. It needs WebKitGTK to build on
  Linux, so it stays out of the root workspace and `just test`.

## Privacy

The app reads these and nothing else on the machine:

1. The Steam root. On Windows that is the registry value
   `HKLM\SOFTWARE\Wow6432Node\Valve\Steam` `InstallPath` (or `HKLM\SOFTWARE\Valve\Steam`). On
   Linux it is a fixed list of candidate folders, each tested with `is_dir`, never listed
   (`steamlocate::locate_all`).
2. `<Steam>/steamapps/libraryfolders.vdf`, for the library whose `apps` lists Deadlock (1422450).
3. That library's `steamapps/appmanifest_1422450.acf`, for `installdir`. If the vdf is stale, the
   manifest's name is tried in each listed library (a name test, not a listing).
4. `…/steamapps/common/<installdir>/game/citadel/replays/`, when the picker asks (not watched;
   that folder only, not recursively). Only `<digits>.dem` names are looked at: their size and
   time, then the 8-byte header, then, for a card's preview, the demo's signon and last minute
   (a few MB), then the file itself when it's picked.
5. Instead of 4, the folder you chose with **Change folder** (the system's folder chooser), read
   the same way, while it's there. Its path is kept in the app's config folder
   (`replays-folder.txt`) and never sent to the page, logged or uploaded.

We don't use steamlocate's `find_app`, because it lists each library's `steamapps` folder (every
installed game's manifest).

A `mapcro://` board link (below) is read, checked and followed, never logged or kept: its
token stays in the URL's fragment, which the site never sends to the server (spec §11). An
AppImage writes one file to register the scheme (`~/.local/share/applications/
mapcro-desktop-handler.desktop`, Deep links); the installers and packages write nothing at run
time.

Each listed match's preview (heroes, kills, souls, the winner: no names or ids) is read from its
demo by the app and kept in the app's cache folder (`previews.json`, by match id, the file's size
and time); the page asks the server for one only when the app has none. Nothing is sent or logged except match ids and reason codes. That means no paths, no player
names and no account ids. A timeline does carry the match's hero and player data, the same data
the server's own parse of the demo produces, and the app sends it only when you press Upload.
The app gets no replay salts in any form (research §3). The parse writes a scratch file in the
app's cache folder and deletes it afterwards.

## IPC allow-list

The page reaches the native side only through these six commands. `capabilities/site.json`
grants them to `https://mapcro.dmgdeadlock.com/*` only, in the `main` window. No plugin command
is granted to the page; the folder chooser (`tauri-plugin-dialog`) and the updater are driven
from Rust.

| Command | Takes | Gives |
|---|---|---|
| `replays_list` | nothing | `[{id, lastModified, size}]`, newest first |
| `replay_read` | `id` (match id, digits) | the `.dem` bytes (fallback upload, ≤ 1 GiB) |
| `replay_preview` | `id` | the card's preview read from the demo (`{match_id, start_time, duration_s, game_mode, winner, teams, build}`), or a reason code (`corrupt`, `parse_failed`, …) |
| `replay_timeline` | `id` | the timeline JSON, gzipped, or a reason code (`old_map`, `brawl`, …) |
| `replays_choose_folder` | nothing | `chosen` or `cancelled` (the system's folder chooser; the path stays in the app) |
| `app_update` | nothing | the newer version the update feed offers, or `null`. Portable only (it asks the feed once per run); the installed app answers `null` and installs updates itself |

`replays_list` looks the folder up on each call (the picker calls it on open, on focus and every
5 s while open); with none it answers `not_found`.

The page never passes a path. An id that isn't plain digits is refused (`bad_id`). The window
only navigates within the site's origin; any other link opens in the system browser. On the
web side, `web/src/player/desktop.ts` feature-detects `window.__TAURI_INTERNALS__.invoke`. In a
browser it isn't there and nothing changes.

**The site's CSP and the IPC.** Tauri's IPC first tries a request to its own protocol
(`http://ipc.localhost` on Windows, `ipc://localhost` on Linux), and the site's
`connect-src 'self'` blocks that. Tauri then falls back to `postMessage`, which works, but a raw
answer arrives as a JSON number array rather than an `ArrayBuffer` (`desktop.ts` `bytes` takes
both). This was checked under Xvfb with a debug build against a page that sent the live CSP. A
0.65 MB timeline is fine that way, but the ~500 MB `.dem` fallback is not. Adding
`ipc: http://ipc.localhost` to `connect-src` gives `ArrayBuffer`s (checked the same way). That
is a server CSP change and an open decision (spec §6a keeps `connect-src 'self'`).

No `deep-link` plugin command is granted either (`get_current`, `register`, …): the app reads
the link in Rust (`app/src/links.rs`).

**A debug build only** takes `MAPCRO_URL` (for example `http://127.0.0.1:5173/`, `just dev`) and
grants the same six commands to that origin at run time (`dev_capability`). A release build
ignores the variable.

## Installer or portable

Windows releases come two ways, both on the same GitHub release:

- **The installer** (`mapcro_<version>_x64-setup.exe`, also `mapcro_x64-setup.exe`): per-user
  NSIS. It fetches WebView2 if it's missing, adds a Start-menu entry and an uninstaller,
  registers `mapcro://`, and the app updates itself (passively, at start). "Get the Windows app"
  links here.
- **Portable** (`mapcro_<version>_x64-portable.zip`, also `mapcro_x64-portable.zip`): the same
  app built with `--features portable`, the exe and a `README.txt`. Unzip and run it. The flag is
  baked in at build time (`core/src/mode.rs` `Mode`), not a file beside the exe. It differs in:
  - **No auto-update.** It asks the same feed (`app_update`, once per run, when the page asks)
    and, if a newer version is out, the page shows **Update available**, a link to the release
    page. You download the new zip yourself.
  - **No Start-menu entry or uninstaller.** Delete the folder to remove it.
  - **WebView2 must already be there** (it is on current Windows 10 and 11); nothing fetches it.
  - **It registers `mapcro://` itself** for the current user on each start
    (`HKCU\Software\Classes\mapcro` → this exe), so links reach the copy you ran last. Deleting
    the folder leaves that key; the installer, if you install later, overwrites it.
  - **Settings stay in the user's profile,** as for the installer, not beside the exe: the
    chosen replays folder in `%APPDATA%\com.dmgdeadlock.mapcro` (Tauri's config folder, which is
    Roaming), the webview's data and the parse's scratch in `%LOCALAPPDATA%\com.dmgdeadlock.mapcro`.

The site's links use the stable names (`releases/latest/download/mapcro_x64-setup.exe`, `…/mapcro_x64-portable.zip`):
tauri-action names the installer with its version, so the release job also uploads the copies.
"Portable" is the quieter link beside "Get the Windows app", under the same `WINDOWS_APP_RELEASED`.

## Deep links

A shared board opens in the app from a link. The canonical form is

    mapcro://b/<board>#<token>

the site's share link (`https://mapcro.dmgdeadlock.com/b/<board>#<token>`, spec §11) with
`https://mapcro.dmgdeadlock.com` swapped for `mapcro://`. The token stays in the fragment.

- **Registration.** `tauri.conf.json` `plugins.deep-link.desktop.schemes` is `["mapcro"]`
  (`tauri-plugin-deep-link`). The NSIS installer writes it per-user (`HKCU\Software\Classes\mapcro`,
  `"<app>.exe" "%1"`); the .deb's desktop file (and so the nix package's) carries
  `MimeType=x-scheme-handler/mapcro` and `Exec=… %u` (our template, `app/linux/mapcro.desktop`:
  Tauri's own has no `%u`, so a launcher wouldn't pass the link). An AppImage isn't installed, so it
  registers itself on each start (`register_all`: a `…-handler.desktop` in
  `~/.local/share/applications` made the `x-scheme-handler/mapcro` default with `xdg-mime`). CI
  checks the installer's registry key and the .deb's desktop file.
- **Delivery.** The system starts the app with the link as its one argument. A first instance
  opens its window on the board instead of the landing (`links::first_page`). With the app
  running, the second launch hands its argument over (`tauri-plugin-single-instance` with its
  `deep-link` feature: a named pipe on Windows, D-Bus on Linux) and exits; the running app shows
  its window and navigates it to the board (`links::listen`). The same board with another token
  is a fragment change, and the page reloads on `hashchange` (`web/src/core/applink.ts`).
- **Validation** (`core/src/link.rs`, tests there): only `mapcro://b/<22 base64url>#<43
  base64url>` (one `/` after the board id allowed) or the site's own
  `https://mapcro.dmgdeadlock.com/b/<board>#<token>`, at most 256 ASCII bytes; scheme and host
  without case. Anything else (another host, a query, more path, escapes, padding, another
  length) is ignored with `link ignored: not a board link`. The target is always the window's
  own site (`<site>/b/<board>#<token>`; a debug build's `MAPCRO_URL` origin), so a link can't
  point the window anywhere else. `Board`'s `Debug` prints no token; nothing logs the link.
- **In the page** (spec §6b): on a board page in a browser, **Open in app** is the board's
  `mapcro://` link, with a quiet **Get the app** (the installer) beside it for a browser without
  the app (an unknown scheme does nothing visible). It shows where "Get the Windows app" does: a Windows browser, never in the
  app, once `WINDOWS_APP_RELEASED` is on (Linux when its download link ships, backlog). In the
  app, the landing's **Open link** field and **Ctrl+L** anywhere take a pasted link in either
  form (or on the page's own origin, for a dev server), checked by the same rules
  (`parseBoardLink`); anything else says "Not a board link".
- **Smoke test:** a second launch with a board link moves the window to it, the same board's
  other token too, three links that aren't a board's change nothing, and the app started by a
  link opens on its board. On Linux the hand-off needs a D-Bus session: `just desktop-smoke`
  and CI run `dbus-run-session`, so it never reaches an app on your desktop's bus.

## The parse: a child process

`replay_timeline` runs the app's own executable again with
`--mapcro-parse-replay <demo> <out> <id>`. That child calls `mapcro_replay::worker::job`,
the same code as the server's worker. Why a child process and not a thread:

- A panic, abort or stack overflow on a bad demo ends only the child. The window stays up.
- The parent kills it at 5 minutes (`parse::TIMEOUT`). A thread can't be stopped.
- The memory goes back to the system when it exits. On Windows it runs with
  `BELOW_NORMAL_PRIORITY_CLASS` and no console window.
- No per-process memory cap yet (a Windows Job object; backlog).

The parent checks the output with `timeline::validate` and the match id, as the server will, then
gzips it. It keeps the last 8 parses keyed by the file's size and time. The reference replay
(129738985, 504 MB) parsed in 14.5 s here (Linux, release, on a loaded box) to 649 KB gzip.
Brawl and pre-6712 maps are refused by the parser itself (`brawl`, `old_map`).

## The preview: a child process too

`replay_preview` runs the app's executable with `--mapcro-preview-replay <demo> <id>`; the child
calls `mapcro_replay::preview::read` and prints the preview's JSON (or a reason code). It reads
the signon and the last minute of the match, not the whole file (docs/research/demo-preview.md):
129738985 took 0.19 s here, 11 MB of 504 MB. The parent kills it at 30 s, checks the shape and
the match id, and keeps the answer by the file's size and time in `previews.json` (2,000
entries; a timeout isn't kept), so a listing reads no demo twice, across runs too. One preview
at a time.

## The replays folder

Looked up each time the picker lists it (`folder::resolve`): the folder chosen with **Change
folder**, while it's there; else Deadlock's own, through Steam (`steam::locate`). If Steam's isn't
made yet (the game makes it on the first download), the picker says "Replays folder not found".
The page leaves out files younger than 5 s (a download may be in progress), and the app checks
the demo magic (`PBDEMS2\0`) before parsing. Closing the window quits the app.

## Uploading

`desktopSource()` in `web/src/player/desktop.ts` implements `ReplaySource` (plus the parse and
Change folder). The picker (`web/src/player/ReplayPicker.tsx`) reads only through it; the
browser's linked-folder UI (`ReplaysFolder.tsx`) doesn't show in the app. A pick goes through
`host.pick` → `host.takeLocal` (a landing pick through `handoff.ts`, which also attaches):

1. `replay_timeline(id)` → the gzip, with the chip showing Parsing.
2. `POST /api/boards/{board}/replays/{id}/timeline` with `authorization: Bearer <board token>`
   and `content-encoding: gzip`. The contract is spec §6a "Timelines parsed on the user's
   machine" (branch `client-timeline`).
3. A 404 **without** an `{error}` body means an older server without the route. Then
   `replay_read(id)` and the usual `.dem` upload run. Any other error is shown as its code
   (`outdated_parser` says "Update the mapcro app").

## Building

- Windows: `.github/workflows/desktop.yml` on `windows-latest`. The release build is `cargo tauri
  build --bundles nsis`. The installer is per-user and fetches WebView2 if it's missing.
- Linux, for development: `nix develop .#desktop`, then `cd desktop/app && cargo build`. That
  shell adds WebKitGTK and friends (GTK also serves the folder chooser), glib-networking for
  https, and the smoke test's tools. A debug build can run against a dev server:
  `MAPCRO_URL=http://127.0.0.1:5173/ cargo run`.
- Icons: `app/icons/` holds a placeholder (a ring and a dot) drawn for this app. Never use game
  art.

## Linux

The same app on WebKitGTK (Tauri's Linux webview) instead of WebView2. The operator's condition
for shipping it was the e2e suite passing on WebKit: `just e2e-webkit` runs every spec in
Playwright's WebKit (from nix), which stands in for WebKitGTK. It passes, apart from specs on a
Chromium-only API, which skip with the reason (docs/research/README.md, "WebKit").

- **Packages.** `nix build .#mapcro-desktop` (or `nix run .#mapcro-desktop`) builds it with
  nixpkgs' `cargo-tauri.hook` on our toolchain: a release build, the .deb's files unpacked into
  the store path, wrapped for GTK. It has no updater artifacts (`app/tauri.nosign.conf.json`):
  the package manager updates it. CI builds an **AppImage** and a **.deb** on `ubuntu-22.04` (the
  oldest supported Ubuntu, for a low glibc floor) for the release. The updater replaces only an
  AppImage, so `latest.json`'s `linux-x86_64` entry is the AppImage; a .deb user installs the new
  .deb.
- **Steam on Linux** is found at steamlocate's fixed candidates (`$XDG_DATA_HOME/Steam`,
  `~/.steam/steam`, `~/.steam/root`, `~/.steam/debian-installation`, Flatpak, Snap), each tested
  with `is_dir`. Proton keeps Deadlock under `steamapps/common`, so the replays folder is where it
  is on Windows.
- **Blank window on NVIDIA.** WebKitGTK's DMA-BUF renderer can leave the window blank (or fail
  with "AcceleratedSurfaceDMABuf was unable to construct a complete framebuffer") on NVIDIA's
  proprietary driver. The fix Tauri documents is `WEBKIT_DISABLE_DMABUF_RENDERER=1`, at the cost of
  the faster rendering path; `WEBKIT_DISABLE_COMPOSITING_MODE=1` is the last resort (it turns
  accelerated compositing off). Tauri advises against setting it for everyone unless you know
  your app is affected (https://v2.tauri.app/develop/debug/linux-graphics/; WebKit bug 261874).
  The nix package's wrapper sets the first one only when `/proc/driver/nvidia/version` exists
  and you haven't set the variable yourself. The AppImage and the .deb don't set it: setting it in
  the app means `std::env::set_var` in `main()`, which is `unsafe` in edition 2024, and the crate
  forbids `unsafe` (backlog). Until then, an NVIDIA user starts it as
  `WEBKIT_DISABLE_DMABUF_RENDERER=1 mapcro-desktop`.
- **Not checked yet:** a real desktop session (here it ran under Xvfb only), a real Steam install,
  the folder chooser on GNOME/KDE, and speed on real hardware. Headless WebKit drew a scene flip
  at ~10 frames a second here, against ~30 in Chromium (backlog).

## Smoke test

`desktop/smoke/smoke.mjs` drives the real app over WebDriver: `tauri-driver` in front of
WebKitWebDriver (Linux) or msedgedriver (Windows). It serves a page with the site's own CSP (read
from `crates/server/src/main.rs`), points a debug build at it with `MAPCRO_URL`, and checks:

- the page loads, and the IPC bridge (`__TAURI_INTERNALS__.invoke`) is there;
- `replay_read` refuses an id that isn't digits;
- `app_update` answers `null` (the installed build updates itself; only portable reports one);
- no plugin command is the page's: opener, dialog, updater, window, webview, event and deep-link are
  each refused by the ACL;
- with `--fake-steam`, a fake Steam install (its `libraryfolders.vdf`, Deadlock's manifest, and
  three synthetic `<digits>.dem` files: the 8-byte magic and zeros, never a real demo) is found,
  and `replays_list` lists them newest first, as the replay picker asks for them.
- a `mapcro://` board link from a second launch opens the board in the window (and the same
  board's other token), links that aren't a board's change nothing, and the app started by a
  link opens on its board (Deep links). On Linux that needs a D-Bus session (`dbus-run-session`;
  without one those checks are skipped).

It never calls `replays_choose_folder` (that opens the native dialog). Locally:
`nix develop .#desktop -c just desktop-smoke` (Xvfb and a private D-Bus session; the fake Steam
is found through `XDG_DATA_HOME`). On Windows CI the registry value `HKLM\SOFTWARE\Wow6432Node\Valve\Steam`
`InstallPath` points at the fake root (the job also writes `HKCU\Software\Valve\Steam`
`SteamPath`, as Steam does, though the app doesn't read it).

On Windows, two things differ from Linux:

- **DevTools.** msedgedriver asks for WebView2's DevTools through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
  (`--remote-debugging-port=0` and its automation switches), but WebView2 ignores that variable
  when the app passes browser arguments of its own, as wry always does. The session then fails
  after 60 s with `DevToolsActivePort file doesn't exist`. So a **debug** build with tauri-driver's
  `TAURI_WEBVIEW_AUTOMATION=true` set passes the variable's arguments on itself, merged with wry's
  defaults (`automation_browser_args` in `app/src/main.rs`). A release build reads neither.
- **Start by a link.** msedgedriver turns each `args` entry into a lowercased `--` switch, so it
  can't start the app with a link. The test starts the app itself with the link, its DevTools on
  a fixed port, and reads the page's URL from DevTools' `/json/list`.

On a failure, CI uploads `windows-smoke-diag`: msedgedriver's verbose log (the capabilities, the
arguments it set, the launch) and the app's and WebView2's processes with their command lines,
every 3 s.

## CI

`.github/workflows/desktop.yml` runs on every push to main and every PR that touches `desktop/`,
`web/`, `crates/replay`, `crates/stats` or the workflow, and on `desktop-v*` tags:

- `windows` and `linux`: `cargo test -p mapcro-desktop-core`, a **debug** bundle (NSIS; .deb)
  with `tauri.nosign.conf.json` (no signing key needed, so fork PRs run it), installed as a user
  would (`/S`; `apt-get install ./….deb`), then the smoke test against the installed app. Windows
  also starts the installed app on its own for 15 s. A debug build is used because only a debug
  build takes `MAPCRO_URL`.
- On a tag only, after both pass: `release-windows` (NSIS) and then `release-linux` (AppImage and
  .deb) build the signed release bundles into the same draft release. Linux runs after Windows
  because tauri-action adds its platform to `latest.json` by reading and rewriting it.

## Releasing

Updates come from GitHub Releases on the public repo. The updater feed is
`https://github.com/intendednull/mapcro/releases/latest/download/latest.json`
(`app/tauri.conf.json` `plugins.updater.endpoints`). The app checks once at start and installs
passively. Updates are off while the public key is the placeholder.

One-time setup (the operator, on a trusted machine):

1. `cargo tauri signer generate -w <path outside the repo>/mapcro-updater.key`. Keep the private
   key and its password outside the repo, for example in your password manager. Never commit
   either.
2. In the repo's GitHub settings → Secrets and variables → Actions, add `TAURI_SIGNING_PRIVATE_KEY`
   (the key file's contents) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. CI reads them by name.
3. Replace `REPLACE_WITH_THE_MINISIGN_PUBLIC_KEY` in `app/tauri.conf.json` with the contents of
   the `.pub` file. A public key is safe to commit. The workflow refuses to build while the
   placeholder is there.

Each release:

1. Bump `version` in `app/tauri.conf.json` and `app/Cargo.toml`.
2. Tag `desktop-v<version>` and push the tag. The workflow tests both platforms, then builds the
   NSIS installer, the AppImage and the .deb, signs the updates with the key, and makes a
   **draft** release with them, their `.sig`s and `latest.json` (`windows-x86_64` and
   `linux-x86_64`).
3. Check the draft, then publish it. `releases/latest` only points at a published release.
4. After the first release, turn the site's download link on. Set `WINDOWS_APP_RELEASED = true`
   in `web/src/player/desktop.ts` and deploy. "Get the Windows app" then shows on Windows
   browsers only (never inside the app): beside the replays folder link, in "Where's my
   replay?", and in the landing page's footer. Board pages
   get **Open in app** (their `mapcro://` link) the same way.

Builds have no Authenticode signature (operator, 2026-11-10: unsigned beta). On first run,
Windows SmartScreen says "Windows protected your PC" (More info → Run anyway).
