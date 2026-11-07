# Deadlock assets and extraction: prior art and recommendation

Researched 2026-11-06. Install facts were measured read-only on a local install at
`~/.local/share/Steam/steamapps/common/Deadlock/game/citadel` ("the install"). This is not
legal advice. **[unverified]** marks claims I could not confirm.

## 1. Existing Deadlock tools

| Tool | What it does | Art sourcing |
|---|---|---|
| DeadStrats ([site](https://deadstrats.gg/), [Overwolf](https://www.overwolf.com/app/deadstrats.gg-deadstrats)) | Drawing tools, area markers, vision cones, hero icons, travel-time measurement between lanes, camps and objectives. Live whiteboarding with teammates or a coach. Exportable strategy links and an in-game overlay. Free with ads. | Not stated **[unverified]** |
| LockBlaze map ([launch post](https://www.lockblaze.com/blogs/interactive-map-launch), [map](https://www.lockblaze.com/map)) | Freehand routes, zones, labels, hero icons and a route planner, launched March 2026. It has free and premium tiers. Both pages returned HTTP 429 to me, so these details come from search snippets. | **[unverified]** |
| Deadlock Academy ([map](https://deadlockacademy.com/map)) | Three-level 2D map with filterable objective, camp, traversal and breakable layers, plus a separate token/drawing board. | Positions "extracted from the game's map files". The background is the official minimap plus the site's own 3D relief, self-hosted at `/img/map/plan/plan-real.webp`. It carries a "not affiliated with Valve" disclaimer. |
| Statlocker ([news](https://thegamehaus.com/gaming/what-is-statlocker-gg-new-community-made-deadlock-stat-tracker/2025/04/14/)), Tracklock ([site](https://tracklock.gg/)) | Stats sites. Valve once throttled tracker match data ([GamesRadar](https://www.gamesradar.com/games/third-person-shooter/valve-cuts-off-deadlock-stat-tracking-and-the-community-understands-why-this-game-is-in-beta-and-they-clearly-arent-ready-for-stats-sites-yet/)). | Tracklock's HTML serves `static.bigbrain.gg/deadlock-img/assets-api-res/images/...`. That is deadlock-api's bucket layout, so it is apparently a self-hosted mirror. Statlocker self-hosts on its own domain. |

**deadlock-api.com.** Its [monorepo](https://github.com/deadlock-api/deadlock-api) is MIT-licensed, and its [OpenAPI spec](https://api.deadlock-api.com/openapi.json) lists `/v1/assets/{heroes,map,images,icons,client-versions,steam-info,…}`. The spec's disclaimer says the project is "not endorsed by Valve". I found no ToS for the assets API. The only terms I found cover the live-events product ([terms](https://live.deadlock-api.com/legal/terms)).

The project **hosts Valve art itself.** Its [`build_version_and_upload.sh`](https://github.com/deadlock-api/deadlock-api/blob/master/scripts/build_version_and_upload.sh) pipeline works like this:

1. It logs in with Steam credentials and downloads `pak01_*.vpk`, `maps/dl_midtown.vpk` and the loose localization files using DepotDownloader.
2. It decompiles them with Source2Viewer-CLI.
3. It uploads the images to R2 at `assets-bucket.deadlock-api.com/assets-api-res`, via `IMAGE_BASE_URL` in `crates/game-assets/src/versions/common.rs`.

Map geometry comes from the entity lump. Patrons are `npc_boss_tier3`, Walkers `npc_boss_tier2`, Guardians `info_super_trooper_spawn` with |y|<5000, base cores the `info_team_spawn` centroid, camps `info_neutral_trooper_camp`, and lanes `citadel_zipline_path` ([`extract_map_geometry.py`](https://github.com/deadlock-api/deadlock-api/blob/master/scripts/extract_map_geometry.py)). Rifts are `info_koth_spawn_location` and base sentries `npc_base_defense_sentry` ([`extract_map_entities.py`](https://github.com/deadlock-api/deadlock-api/blob/master/scripts/extract_map_entities.py)).

**What the boards do well:** layer toggles for streets, tunnels and rat tunnels; filterable objective classes; travel-time measurement; link sharing; an in-game overlay. Every tool I could check that shows art hosts Valve-derived art. None extracts on the client.

## 2. Comparable Valve-game tools and Valve's stance

- [csdb.gg CS2 Tactical Board](https://csdb.gg/tactical-board/) puts 5v5 markers, utility and arrows on hosted radars. It encodes the whole board in the share URL, so nothing is stored server-side. That makes it a good model for serverless sharing.
- [MurkyYT/cs2-map-icons](https://github.com/MurkyYT/cs2-map-icons) scrapes radars "directly from the official game depot" and serves them from GitHub, while stating they are "property of Valve". Hosted mirrors are the norm.
- SimpleRadar's community-drawn CS radars are the non-Valve alternative. Boltobserv uses them ([boltobserv](https://www.github.com/boltgolt/boltobserv)), and so does [CS Demo Manager](https://cs-demo-manager.com/docs/guides/maps).
- I found no comparable Dota 2 map tactic board.
- **Valve stance.** The [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/) has two relevant clauses:
  - §2.D: "You may incorporate content from Valve games into your Fan Art", used "solely on a non-commercial basis".
  - §2.G: forbids users to "copy… reproduce, publish, distribute… reverse engineer… decompile, create derivative works".

  The Valve Developer Community "Mod Content Usage" page reportedly allows non-commercial porting of Valve assets. It is a community wiki, not policy, and returned 403 to me **[unverified]** ([page](https://developer.valvesoftware.com/wiki/Mod_Content_Usage)). Valve did send a DMCA notice over redistributed TF2 assets in January 2024 ([GamesRadar](https://www.gamesradar.com/after-years-of-supporting-mods-and-fan-games-valve-takes-action-against-team-fortress-and-portal-fan-projects)). I found no Deadlock-specific policy on fan tools.

## 3. Extraction feasibility

**(a) ValveResourceFormat (VRF).** It is MIT-licensed ([repo](https://github.com/ValveResourceFormat/ValveResourceFormat)). Release **20.1** (2026-10-15) ships CLI zips for Linux, macOS and Windows, plus `ValveResourceFormat.nupkg` for library use (GitHub releases API). ValvePak is a separate MIT library, at 7.2.0 (2026-10-21). The CLI needs `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1` on NixOS (`/home/intendednull/concierge/notes/2026-11-05-deadlock-coach.md`). The library is .NET, so it suits a desktop helper but not a browser. Running VRF under .NET WebAssembly is untested **[unverified]**.

**(b) Formats actually present in the install** (headers parsed read-only):

- `pak01_dir.vpk` is VPK v2: an 8.4 MB directory tree with 158,667 entries, pointing into 328 chunks that total about 33 GB. `maps/dl_midtown.vpk` is a 1.1 GB single-file VPK v2 with a 108 KB tree.
- Minimap layers (`panorama/images/minimap/base/minimap_midtown_*_psd.vtex_c`) are 1024×1024. Hero minimap portraits (`panorama/images/heroes/*_mm_psd.vtex_c`) are 50×50. Both use format 28, which is **BGRA8888, uncompressed** per VRF's [`VTexFormat.cs`](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/master/ValveResourceFormat/Resource/Enums/VTexFormat.cs). Each entry size equals header + w×h×4.
- A `_dd4bcbf9` variant is DXT5 (format 2). So a BC decoder is needed for some textures, but not for the main layers.
- VRF's [`Texture.cs`](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/master/ValveResourceFormat/Resource/ResourceTypes/Texture.cs) also handles LZ4- or zstd-compressed mips.
- `scripts/heroes.vdata_c` (145 KB) and `default_ents.vents_c` (749 KB) are **binary KV3 v5** (magic `\x05 3VK`). VRF decodes this format with LZ4 or zstd ([`BinaryKV3.cs`](https://github.com/ValveResourceFormat/ValveResourceFormat/blob/master/ValveResourceFormat/Resource/ResourceTypes/BinaryKV3.cs)).

Library landscape:

- VPK reading is easy. In Rust there are [`vpk`](https://github.com/roman901/vpk-rs) and [`sourcepak`](https://github.com/barnabwhy/sourcepak-rs/); on npm there is `vpk-tools` 1.1.0. The prototype's 41-line stdlib reader (`tools/local_vpk.py`) also works.
- Pure-Rust, `no_std`, WASM-friendly decoders exist: [`texture2ddecoder`](https://github.com/UniversalGameExtraction/texture2ddecoder) and [`bcdec_rs`](https://github.com/ScanMountGoat/image_dds) for BC1–BC7, [`lz4_flex`](https://github.com/pseitz/lz4_flex) for LZ4, and [`ruzstd`](https://github.com/KillingSpark/zstd-rs) for zstd.
- The gap is **binary KV3 and the Source 2 resource container.** The KV3 crates I found (`kv3`, `keyvalues3`) parse *text* KV3 ([kv3 README](https://github.com/dxshie/kv3)). I found no Rust or JS crate for `*_c` containers. We would port roughly the relevant parts of VRF (MIT, so attribution is required).

**(c) In-browser extraction is feasible.**

- `showDirectoryPicker` works in Chrome/Edge 86+ only. It is not in Firefox or Safari, and it needs a secure context and a user gesture ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker), [BCD](https://github.com/mdn/browser-compat-data/blob/main/api/Window.json)).
- `<input webkitdirectory>` is Baseline 2025 and works in Chrome, Edge, Firefox and Safari ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory)). It enumerates the whole tree, though. That tree includes per-account files I saw in the install (`account_<id>.stats`, `cache_<id>.soc`), so the code must open only named files.
- `Blob.slice()` reads byte ranges lazily. The read pattern is: read the whole dir tree (8.4 MB), then `slice(offset, length)` per entry inside `pak01_NNN.vpk`.
- The prototype's set (3 layers × 4.2 MB, about 45 portraits × 12 KB, icons, `heroes.vdata_c` and the 749 KB entity lump) comes to roughly **15–20 MB read out of 34 GB**. That is computed from the entry sizes above.
- Whether Chrome's "upload N files" confirmation looks alarming on a 38 GB folder is **[unverified]**.

**(d) Replacing deadlock-api from the install:**

- **Heroes:** `heroes.vdata_c` has `m_HeroID`, `m_eHeroDevelopmentState` (6711+; earlier builds used `m_bPlayerSelectable`), `m_bDisabled` and `m_strMinimapImage` (field names from [`heroes.rs`](https://github.com/deadlock-api/deadlock-api/blob/master/crates/game-assets/src/versions/heroes.rs)). Names come from loose KV1 text such as `resource/localization/citadel_gc_hero_names/citadel_gc_hero_names_english.txt`, read in the install.
- **Objectives, camps, ziplines, rifts:** use the entity classnames from §1. The prototype already gets 12 base guardians, 4 shrines and the Mid Boss at (0,0,−832) from `npc_barrack_boss`, `destroyable_building` and `info_neutral_trooper_spawn` (`tools/extract_local.py`).
- **Transform:** deadlock-api uses `left=(x+R)/2R`, `top=(R−y)/2R` with **`MAP_RADIUS = 10752` hard-coded** ([`map/mod.rs`](https://github.com/deadlock-api/deadlock-api/blob/master/crates/game-assets/src/versions/map/mod.rs)). I found no in-game source for 10752. It is not in the decoded `hud_minimap.css` or `.xml` under the prototype's `assets/local/source/` **[unverified]**.
- **Coordinate traps:** API objective coordinates are CSS top-left corners. `objectives_map.css` has been stale since the 6711 "City Never Sleeps" rework (`map/mod.rs`; notes file). Extracting world positions directly avoids both problems.

## 4. Version tracking

- **`steam.inf`** carries `ClientVersion`, `ServerVersion`, `SourceRevision`, `VersionDate` and `VersionTime`. Today the install reads **6860 / 11211860 / Nov 05 2026**. The prototype was built at 6851 (`assets/references/installed-steam.inf`) and hard-requires 6851 (`README.md`), so **the prototype is already stale**.
- **Steam Web API:** `https://api.steampowered.com/IGCVersion_1422450/GetClientVersion/v1/` returns `active_version` 6860 with no key (fetched today). deadlock-api polls the same endpoint ([`poll_assets_update.sh`](https://github.com/deadlock-api/deadlock-api/blob/master/scripts/poll_assets_update.sh)). Its `/v1/assets/steam-info` endpoint also returns 6860.
- **Depots:** `steamapps/appmanifest_1422450.acf` holds `buildid` 26472578 and depots 1422451, 1422452 and 1422456 with manifest GIDs. The file also has a `LastOwner` account field, so read only these keys. Anonymous PICS ([api.steamcmd.net](https://api.steamcmd.net/v1/info/1422450)) returns `_missing_token` with no depots, and SteamDB returned 403. Manifest IDs are therefore only available locally.
- **Content fingerprints:**
  - Each VPK dir entry stores a CRC32. I verified it equals the payload CRC for `default_ents.vents_c` and for the minimap texture.
  - The mid minimap's compiled SHA-256 (`f19de6f842e9…`) is identical in 6851 and 6860, and `dl_midtown.vpk` was last modified Nov 3, before 6851. **A build bump often changes neither map nor art.**
  - Change detection should therefore be **per needed entry (path + CRC32 + size)**, read from the dir trees alone without touching payloads. Separately, a **geometry hash** over normalized entity records detects actual map changes.

## 5. Recommendation

**Architecture: one Rust extraction core, two shells.**

1. **Primary: browser extractor**, compiled to WASM. It runs fully client-side and uploads nothing. On Chromium it uses `showDirectoryPicker` and keeps the handle in IndexedDB so the next build can be re-checked in one click. Elsewhere it falls back to `webkitdirectory`. It opens only allow-listed paths.
2. **Secondary: `mapcro-extract` CLI**, a native build of the same core. It covers headless users, Linux/Proton paths and debugging. Running it on the install alongside the VRF CLI gives a local golden check. CI cannot do this because it must never contain game files.
3. **Defer the desktop helper** (for example Tauri) unless the Firefox/Safari picker UX proves unacceptable.

**Asset pack.** It lives locally in OPFS/IndexedDB and is never uploaded:

```
pack.json                  # canonical JSON; pack_id = sha256(pack.json)
blobs/<sha256>.{png,webp,svg}
```

`pack.json` has these fields:

- `schema` and `extractor{name,version}`.
- `game{client_version, source_revision, version_datetime, buildid?, depot_manifests?}`.
- `sources[]` of `{vpk, path, crc32, size}`, which is the cheap re-check key.
- `blobs{logical_key → {sha256, w, h, mime}}`.
- `heroes[]` of `{hero_id, class_name, name_token, display_name, minimap_blob, dev_state}`.
- `map{map_id:"dl_midtown", radius, transform, layers[]}`.
- `entities[]` of `{key, kind, team, lane?, world:[x,y,z], src:{classname, hammeruniqueid, targetname}}`.
- `geometry_hash`: SHA-256 over sorted `(key, kind, team, round(world, 1))`.

Content addressing de-duplicates blobs across builds, which matters because most of them do not change.

**Board references.**

- Store positions in **world units**, not minimap fractions or pixels. The transform belongs to the pack.
- Reference heroes by `m_HeroID`.
- Reference objectives by a **semantic key** derived from classname, team, lane and an ordinal along the lane, for example `walker:amber:lane2`. Keep `hammeruniqueid` as evidence, not identity. Whether it stays stable across map reworks is **[unverified]**.
- Each board records the `client_version` and `geometry_hash` it was authored against. On load with a different pack, resolve keys first, then fall back to the nearest neighbour of the same kind within a tolerance. Show anything moved or orphaned to the user instead of silently re-snapping it.
- The server and share links carry only board JSON (keys plus world coordinates), following the csdb.gg URL-state model. A board without a pack renders with neutral placeholder glyphs.

**Before building:**

- Confirm where the 10752 radius comes from, or fit it against extracted objectives over the minimap.
- Port binary KV3 v5 and the resource container from VRF, with tests run against the VRF CLI output.
- Re-baseline the prototype on 6860.

## Risks

- **ToS/legal:** SSA §2.G bars reverse engineering and redistribution. Extracting from the user's own install keeps redistribution off our servers, but the extraction itself still happens. The §2.D fan-art allowance is non-commercial only, so ads or premium tiers would put that reliance at risk. Shared exports must never embed art. The prototype's `index.html` embeds about 1.7 MB of extracted art (`README.md`), and that pattern must not ship. A licensed fallback (original vector map art, like SimpleRadar) removes the dependency.
- **Format drift:** a new KV3 or vtex version breaks the WASM port before VRF's maintainers notice. Pin VRF releases and keep a CLI fallback.
- **Map reworks:** build 6711 replaced the whole map (`map/mod.rs`). Semantic keys survive some changes but not a full rework, so boards need an explicit "authored for map era" state.
- **Privacy:** the picked folder exposes account-ID files and `appmanifest` owner data. Strict allow-lists are required.
