# A desktop build for getting replays in (research, 2026-11-10)

Question (operator): should mapcro ship a desktop build of the same web app to make getting
replays easier? The web app stays the main way in, since boards are shared by link. The desktop
build would add four things: a background watch of the local replays folder, one-click upload,
perhaps a local parse with `crates/replay` that uploads only the timeline, and perhaps replay
salts. A browser-only folder watch (File System Access API, branch `replay-watch`) is being
built in parallel, so this judges what desktop adds beyond it.

This is desk research only: nothing was installed, logged in to or run against Steam or the GC.
Sources were read 2026-11-10 unless dated otherwise.

## Recommendation

**Build it, but thin, Windows first, and only after two cheaper steps.** The shell should be
**Tauri 2**, loading the live site (`https://mapcro.dmgdeadlock.com`) in its webview, not a
bundled copy. A small native side, granted IPC for that origin only, finds the replays folder,
watches it, parses with `crates/replay` and uploads the timeline. **Don't get replay salts** in
any form (no-go, below). A desktop user doesn't need one anyway, because the demo is already on
their disk.

The case rests on one finding that cuts against the browser watch. **Chrome's File System
Access blocklist covers the default Steam location on both Windows and Linux** (section 2). So
the browser watch only works for players whose Deadlock sits in a secondary Steam library, and
Firefox and Safari have no folder picker at all. If that holds in a real browser, a native shell
is the only way to get "it just appears" for most players.

## 1. Shell options

| | Tauri 2 | Electron | Installable PWA |
|---|---|---|---|
| Download | ~3–10 MB (hello world 3.2 MB) [1][2] | ~85 MB hello world, 80–200 MB typical [1][2] | none |
| Web view | WebView2 (Chromium) on Windows, WKWebView on macOS, WebKitGTK on Linux | bundled Chromium everywhere | the user's browser |
| Rendering risk for SolidJS + SVG | **Windows: low.** WebView2 is Chromium, which is what our Playwright e2e runs. **Linux: high**, see below. macOS: medium (WebKit) | lowest: one engine, the one we test | none new |
| Rust reuse | links `crates/replay` in-process, or ships `mapcro-replay parse` as a sidecar | N-API addon (napi-rs) built per OS, or the same sidecar | wasm only (backlog "Parse replays in the browser") |
| Auto-update | `tauri-plugin-updater`, minisign-signed artifacts, static JSON feed [4]. A CVE aggregator reports an unsigned-manifest flaw before 2.12.0 (unverified), so pin ≥ 2.12 | `electron-updater` | always current |
| Background / tray | yes | yes | no: needs an open tab |
| Folder access | any path | any path | Chrome's blocklist applies (section 2) |

- **Linux WebKitGTK risk.** Tauri's own docs list blank windows and rendering faults with NVIDIA
  and DMA-BUF. The workarounds are env vars such as `WEBKIT_DISABLE_DMABUF_RENDERER=1` [5].
  WebKitGTK's speed is also widely reported as behind Chromium. SVG-specific reports are thin
  (one WebKit bug about slow SVG pages; "SVG shadows" broken in a blog post) [5]. Our Player
  draws many SVG nodes at 1 s steps, so this needs a real test, not an assumption. Playwright's
  `webkit` project is the cheapest proxy: add it to e2e before any Linux or macOS build.
- **Remote URL plus IPC.** Tauri 2 grants IPC to remote origins only through a capability's
  `remote.urls`. Its docs warn to "consider usage of this feature very carefully", and say that
  on Linux an iframe can't be told apart from the window [6]. Keep the surface tiny and decided
  by the shell: "list replays (match id, size, mtime)", "parse and upload match X to board Y".
  The page must never pass in paths. Our CSP already has `frame-ancestors 'none'`.
- **Code signing.**
  - Windows: Azure Artifact Signing (formerly Trusted Signing) costs ~$9.99/month. Individuals
    must be in the USA or Canada. It gives **no instant SmartScreen trust**: reputation builds up
    per file over time, and EV certificates no longer skip it either [3]. Expect "Windows
    protected your PC" warnings on early releases whatever we pay.
  - macOS: Apple Developer Program, $99/year, plus notarisation. **Not needed**, because Deadlock
    has no macOS client. Mac players run it through CrossOver or Whisky, inside a Windows bottle
    [7]. Drop macOS.
- **Builds and CI.**
  - Linux builds fit Nix: nixpkgs has `cargo-tauri` and `webkitgtk_4_1`.
  - Windows can't build under Nix. Tauri can cross-compile an NSIS installer from Linux with
    `cargo-xwin`, but calls it "a last resort", and signing then needs an external tool [8].
  - Use a `windows-latest` GitHub Actions job instead (our CI is GitHub Actions on
    `ubuntu-latest` today).
- **`crates/replay` on Windows** (from `Cargo.lock`, not yet built there):
  - The C or asm dependencies are `ring` 0.17 (through boon's `reqwest`/rustls) and `zstd-sys`.
    Both build with MSVC. bzip2 0.6 is pure Rust (`libbz2-rs-sys`), and `memmap2` is
    cross-platform.
  - `libc` and the `cfg(unix)` code sit in `worker.rs` only. A desktop parse needs just
    `parse::header`/`observe` plus derive, with no decompression, because a local `.dem` is raw.
  - The first Windows build is the first real check.
- **Others, one line each:** Wails, Neutralino and Flutter can't reuse the Rust parser cleanly.
  A tray-only Rust helper with no UI is the smallest build, but it is the "companion UI" the
  operator ruled out, and it would need its own board-picking UI.

## 2. The replays folder

- **Where:** `<Steam library>/steamapps/common/Deadlock/game/citadel/replays/<match id>.dem`.
  - It is the same on Windows and under Proton on Linux, because Proton keeps the game folder
    in `steamapps/common`.
  - The folder can be missing. The in-game download then fails with
    `CITADEL_REPLAY_MANAGER_ERROR_CREATION_FAILURE`, and creating it by hand fixes it (forum,
    2026-03-07 and 2026-08-04) [9].
  - The game writes the file when the player presses Download in Match History (spec §6b,
    "Where's my replay?").
  - Whether watching in the client writes it without a download is **unverified**. So is
    whether the file is written in place or renamed in once complete. Treat the file as complete
    when its size has been stable for a few seconds and it starts with `PBDEMS2\0`.
  - Size is ~11 MB per match minute: 504 MB for 44 min (129738985).
- **Finding it without listing Steam directories.** `steamlocate` 2.1.1 (MIT, 2026-10-16)
  `find_app(1422450)` reads exactly what we need. I checked its source:
  - The Steam root comes from the registry on Windows (`HKLM\SOFTWARE\Wow6432Node\Valve\Steam`
    `InstallPath`). On Linux it is a fixed set of candidates: XDG `Steam`, `~/.steam/steam`,
    `~/.steam/root`, `debian-installation`, Flatpak and Snap. Each is tested with
    `steamapps/` `is_dir`, not listed.
  - Then it reads `steamapps/libraryfolders.vdf`, whose `apps` map names the library that holds
    the app, and one `appmanifest_1422450.acf` for `installdir`.
  - It does no `read_dir` on that path (`library.rs` lists `steamapps` only in its "all apps"
    iterator). After that, the watcher opens only the replays folder.
  - We could also parse those two files ourselves in about 60 lines.
- **Why the browser watch mostly can't reach it** (Chromium `main`,
  `chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc`,
  `kBlockPaths`):
  - On Windows, `DIR_PROGRAM_FILES`, `DIR_PROGRAM_FILESX86` and `DIR_PROGRAM_FILES6432` are
    `kBlockAllChildren`. Steam's default root is under `Program Files (x86)`.
  - On Linux, `~/.local/share` is `kBlockAllChildren` (crbug.com/561996724), and that is Steam's
    default root. Paths are normalised first, so the `~/.steam/steam` symlink doesn't get round
    it.
  - Not blocked: secondary libraries (for example `D:\SteamLibrary`), plain `<input type=file>`
    and drag-and-drop.
  - `FileSystemObserver` shipped in Chrome 133, desktop only (chromestatus), and persistent "Allow
    on every visit" grants came in Chrome 120–122 [10]. Both still need an open tab.
  - **Not yet tried in a real browser.** It is the first thing to check (Phase 0). The
    `replaywatch` agent has been told.

## 3. Replay salts: no-go

A desktop user with the file on disk needs no salt. A salt would only let *our server* fetch
Valve's copy instead: a shared, trusted `cdn` timeline, and a contribution to deadlock-api. The
ways a desktop app could get one, as `deadlock-api-ingest` does
([deadlock-api-salts](deadlock-api-salts.md) "How the ingest tool gets salts"):

| Route | Verdict |
|---|---|
| Steamworks in-process | **No.** The Steamworks SDK runs as *our* AppID, and has no documented call to another game's GC. Posing as 1422450 is tampering (SSA §4.B, below) |
| GC calls with the user's saved Steam session (the ingest tool's `gc/`) | **No.** It uses the user's credentials/session for non-human GC traffic: SSA §1.C "You may not reveal, share or otherwise allow others to use your password or Account", and §4.C "You may not use any form of scripts, bots, macros, or other non-human-controlled systems … to interact with Content and Services on Steam in any manner" |
| Reading the running game's memory (the ingest tool's `game_memory/`) | **No.** SSA §4.B: "You agree that you will not tamper with the execution of Steam or Content and Services". Deadlock's anti-cheat is client-side and its policy is undocumented. One unverified report blames a June 2026 ban on a stats overlay [11]. The risk falls on our users' accounts |
| Reading Steam's HTTP cache for the `.dem.bz2` URL | Technically read-only, but the URL is only there **after** the user downloaded the replay, when we have the file anyway. It also means reading inside Steam's `appcache`, which our privacy rule forbids. Not worth it |

Steam Subscriber Agreement, last updated 2026-09-10, quoted from
`store.steampowered.com/subscriber_agreement/`. §4.D says Valve "may restrict or terminate your
Account(s) … for any conduct or activity that … constitutes a Cheat or Automation", without
notice. **Recommendation: no-go on salts in any build.** If the operator ever wants the shared
`cdn` copy for desktop uploads, the "forwarding variant" in
[browser-side-replays](browser-side-replays.md) §4 is the design. The salt would still have to
come from somewhere legitimate, and nothing above qualifies.

## 4. Local parsing and server trust

- **Cost** (spec §6a "The replay worker", 129738985, 504 MB, release build): 5.3 s on one core,
  26 MB anonymous memory plus the mapped demo's clean, reclaimable pages. Capped at 64M it still
  takes only 6.2 s. Any gaming PC handles this. Run it at low priority, once the file is stable.
- **Upload size:** 504 MB demo, against a timeline of 1.53 MB raw / 578 KB gzip at format 7
  (status-effects.md). Format 8 runs about 41 KB per match minute, so ~1.8 MB raw for 44 min.
  That is about 300× less raw and 800× less gzipped. It takes uploads out of our bandwidth, the
  queue and the worker entirely.
- **What the server checks today** (`crates/server/src/replays.rs` `collect`):
  - The worker's output passes `read_capped(MAX_BYTES = 6 MiB)`, then
    `mapcro_replay::timeline::validate` (shape, lengths, ranges, key plausibility, name
    characters), then `match_id ==` the job's.
  - Uploads are already **board-scoped**, because "a demo carries no match id, so an upload's
    claim can't be checked". A client-parsed timeline therefore doesn't widen what a forger can
    reach: their own board, which they can draw on anyway.
- **What has to change to accept client timelines:**
  1. A new editor-only `POST /api/boards/{board}/replays/{id}/timeline`. It reads a capped body
     (gzip or zstd allowed, capped *after* decompression), runs the same `validate` and
     `match_id` check, and writes to the board's scope (`<id>-<board hash>`). Never `cdn`.
  2. The server sets `source` to `client` itself, and Player can label it.
  3. Mode: the timeline has no `game_mode`, so the server can't verify standard mode. Keep the
     metadata refusal (`<id>.refused`) as the gate, and have the client parser refuse Brawl and
     `old_map` as the worker does.
  4. **Format skew:** a timeline whose `format` is below `FORMAT` is refused with an "update the
     app" reason. That is why the updater matters.
  5. A per-client hourly cap like `REPLAY_PER_CLIENT_PER_HOUR`, without a queue slot.
  - The same endpoint serves a future wasm parse in the browser, so it is not desktop-only work.

## 5. Plan

- **Phase 0 (an hour, no code):** in Chrome on Windows and on Linux, try `showDirectoryPicker`
  on the default `…\Program Files (x86)\Steam\…\citadel\replays` and `~/.local/share/Steam/…`.
  - If they are blocked (as the source says), the browser watch is a secondary-library feature,
    and desktop has a real reason to exist.
  - If they open, desktop's extra value shrinks to background watching and the local parse, and
    a wasm parse may be the better spend.
- **Phase 1 (server, ~200 lines with tests):** the client-timeline endpoint above. It is needed
  by both desktop and wasm.
- **Phase 2 (Windows Tauri shell):**
  - Remote URL; tray; `steamlocate`; `notify` watch on the replays folder only.
  - `mapcro-replay parse` as a sidecar, so a bad demo can't take down the shell.
  - A toast, "Replay 13xxxxxxx is ready: Open board": it creates a board, uploads the timeline
    and opens it.
  - The web app feature-detects the IPC and otherwise behaves exactly as in a browser.
  - Updater on minisign. Built and signed on a `windows-latest` CI job.
- **Phase 3 (maybe):** a Linux AppImage or Nix package, only after Playwright `webkit` passes
  Player's specs. Never macOS.

## Decisions for the operator

1. Go ahead with Phase 0 and Phase 1 now, and decide on Phase 2 after Phase 0?
2. Signing: Azure Artifact Signing (~$10/month; individuals must be in the USA or Canada), an OV
   certificate, or unsigned beta builds that show SmartScreen warnings at first?
3. Confirm no salts in any form (section 3).
4. Linux desktop: skip it, or ship after a WebKit e2e pass? Players on Linux can still drop the
   file.
5. Updates: where the update feed lives (our server or GitHub Releases), and whether old parsers
   are refused (recommended) or marked stale.
6. Privacy note for the README/spec: the app reads the registry key, `libraryfolders.vdf`, one
   app manifest and the replays folder, and nothing else in Steam.

## Sources

1. tech-insider.org, "Tauri vs Electron 2026" (test dated July 2026): https://tech-insider.org/tauri-vs-electron-2026/
2. pkgpulse, "Electron vs Tauri 2026": https://www.pkgpulse.com/guides/electron-vs-tauri-2026
3. Microsoft Learn, "Code signing options" (Artifact Signing price, eligibility, SmartScreen): https://learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options
4. Tauri updater plugin: https://v2.tauri.app/plugin/updater/; CVE-2026-95625 summary (aggregator, unverified): https://app.opencve.io/cve/CVE-2026-95625
5. Tauri, "Linux graphics issues": https://v2.tauri.app/develop/debug/linux-graphics/; WebKit bug 250829: https://bugs.webkit.org/show_bug.cgi?id=250829; "hate webkit": https://gethopp.app/blog/hate-webkit
6. Tauri, "Capabilities" (remote URLs): https://v2.tauri.app/security/capabilities/
7. Deadlock on Mac: https://applegamingwiki.com/wiki/Deadlock; https://forums.playdeadlock.com/threads/mac-os-compatibility.7973/
8. Tauri, "Windows installer" (cross-compiling, WebView2 modes): https://v2.tauri.app/distribute/windows-installer/
9. Deadlock forums, replays folder error: https://forums.playdeadlock.com/threads/keep-getting-error-error-citadel_replay_manager_error_creation_failure-when-trying-to-save-a-replay.114942
10. Chromium blocklist: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/file_system_access/chrome_file_system_access_permission_context.cc; FileSystemObserver: https://chromestatus.com/feature/4622243656630272; persistent permissions: https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api
11. gamingdeputy.com, Deadlock mods and bans (2026-11-03): https://www.gamingdeputy.com/france/deadlock-mods-bannissement/
12. Steam Subscriber Agreement (updated 2026-09-10): https://store.steampowered.com/subscriber_agreement/
13. steamlocate 2.1.1: https://docs.rs/steamlocate/2.1.1/ (source read from the crates.io tarball)
