# mapcro for Windows

A thin Tauri 2 shell around the live site (`https://mapcro.dmgdeadlock.com`): one window, the
same web app, plus a tray icon and a watch of Deadlock's replays folder. When a new replay has
downloaded, the app parses it on this machine with `crates/replay` and says "Replay <id> ready:
open board". On the board, **Upload <id> from your replays folder** sends only the parsed
timeline (~0.6 MB gzip instead of a ~500 MB demo). There is no second UI. Research and plan:
`docs/research/desktop-app.md` (this is Phase 2).

- `core/` (`mapcro-desktop-core`, in the root workspace): the native logic, no Tauri. It finds
  the replays folder, lists `<match id>.dem` files, waits for a download to settle, and parses in
  a child process. `cargo test -p mapcro-desktop-core` runs on Linux and Windows.
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
4. `…/steamapps/common/<installdir>/game/citadel/replays/`. The app lists it and watches it
   (that folder only, not recursively). Only `<digits>.dem` names are looked at: their size and
   time, then the 8-byte header, then the file itself when it's parsed or uploaded.

We don't use steamlocate's `find_app`, because it lists each library's `steamapps` folder (every
installed game's manifest).

Nothing is sent or logged except match ids and reason codes. That means no paths, no player
names and no account ids. A timeline does carry the match's hero and player data, the same data
the server's own parse of the demo produces, and the app sends it only when you press Upload.
The app gets no replay salts in any form (research §3). The parse writes a scratch file in the
app's cache folder and deletes it afterwards.

## IPC allow-list

The page reaches the native side only through these three commands. `capabilities/site.json`
grants them to `https://mapcro.dmgdeadlock.com/*` only, in the `main` window. No plugin command
is granted to the page; the tray, notifications and updater are driven from Rust.

| Command | Takes | Gives |
|---|---|---|
| `replays_list` | nothing | `[{id, lastModified, size}]`, newest first |
| `replay_read` | `id` (match id, digits) | the `.dem` bytes (fallback upload, ≤ 1 GiB) |
| `replay_timeline` | `id` | the timeline JSON, gzipped, or a reason code (`old_map`, `brawl`, …) |

The page never passes a path. An id that isn't plain digits is refused (`bad_id`). The window
only navigates within the site's origin; any other link opens in the system browser. On the
web side, `web/src/player/desktop.ts` feature-detects `window.__TAURI_INTERNALS__.invoke`. In a
browser it isn't there and nothing changes.

**A debug build only** takes `MAPCRO_URL` (for example `http://127.0.0.1:5173/`, `just dev`) and
grants the same three commands to that origin at run time (`dev_capability`). A release build
ignores the variable.

## The parse: a child process

`replay_timeline` and the watch run the app's own executable again with
`--mapcro-parse-replay <demo> <out> <id>`. That child calls `mapcro_replay::worker::job`,
the same code as the server's worker. Why a child process and not a thread:

- A panic, abort or stack overflow on a bad demo ends only the child. The tray and the window stay
  up.
- The parent kills it at 5 minutes (`parse::TIMEOUT`). A thread can't be stopped.
- The memory goes back to the system when it exits. On Windows it runs with
  `BELOW_NORMAL_PRIORITY_CLASS` and no console window.
- No per-process memory cap yet (a Windows Job object; backlog).

The parent checks the output with `timeline::validate` and the match id, as the server will, then
gzips it. It keeps the last 8 parses keyed by the file's size and time. The reference replay
(129738985, 504 MB) parsed in 14.5 s here (Linux, release, on a loaded box) to 649 KB gzip.
Brawl and pre-6712 maps are refused by the parser itself (`brawl`, `old_map`).

## The watch

The app looks at the folder at start and whenever it changes (`notify`), and every 30 s
otherwise (every 1 s while a file is settling). A file counts as downloaded when its size and
time haven't changed for 5 s (`settle::QUIET_MS`) and it starts with `PBDEMS2\0`. Then it is
parsed, and on success a notification says "Replay <id> ready: open board". Replays already
there at start aren't announced. If the folder isn't there yet (the game makes it on the first
download), it is looked for again every 30 s. Closing the window hides it to the tray; the
tray's **Quit** ends the app.

Unverified: whether a click on the Windows notification brings the window up. Tauri's desktop
notifications have no click handler. The tray icon and **Open mapcro** do, and the window keeps
the board you had open.

## Uploading

`desktopSource()` in `web/src/player/desktop.ts` implements `ReplaySource`, so Player's folder UI
(`ReplaysFolder.tsx`) is shared. The difference in the app is that there is nothing to link, and
the upload goes through `host.takeLocal`:

1. `replay_timeline(id)` → the gzip, with the chip showing Parsing.
2. `POST /api/boards/{board}/replays/{id}/timeline` with `authorization: Bearer <board token>`
   and `content-encoding: gzip`. The contract is spec §6a "Timelines parsed on the user's
   machine" (branch `client-timeline`).
3. A 404 **without** an `{error}` body means an older server without the route. Then
   `replay_read(id)` and the usual `.dem` upload run. Any other error is shown as its code
   (`outdated_parser` says "Update the mapcro app").

## Building

- Linux check (not a release target yet): `nix develop .#desktop`, then `cd desktop/app &&
  cargo check`. That shell adds WebKitGTK and friends. It also puts `libayatana-appindicator` on
  `LD_LIBRARY_PATH` for the tray, so a debug build can run:
  `MAPCRO_URL=http://127.0.0.1:5173/ cargo run`.
- Windows: `.github/workflows/desktop.yml` on `windows-latest`. It runs `cargo test -p
  mapcro-desktop-core`, then `cargo tauri build --bundles nsis`. The installer is per-user and
  fetches WebView2 if it's missing.
- Icons: `app/icons/` holds a placeholder (a ring and a dot) drawn for this app. Never use game
  art.

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
2. Tag `desktop-v<version>` and push the tag. The workflow builds the NSIS installer, signs the
   update with the key, and makes a **draft** release with the installer, its `.sig` and
   `latest.json`.
3. Check the draft, then publish it. `releases/latest` only points at a published release.
4. After the first release, turn the site's download link on. Set `WINDOWS_APP_RELEASED = true`
   in `web/src/player/desktop.ts` and deploy. "Get the Windows app" then shows on Windows
   browsers only (never inside the app): beside the replays folder link, in "Where's my
   replay?", and in the landing page's footer.

Builds have no Authenticode signature (operator, 2026-11-10: unsigned beta). On first run,
Windows SmartScreen says "Windows protected your PC" (More info → Run anyway).
