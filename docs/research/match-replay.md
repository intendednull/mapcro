# Research: loading a real match and scrubbing it into scenes

**Date:** 2026-11-07 · **Question:** can mapcro load a real Deadlock match, scrub through it on
our minimap (hero positions, objectives, souls, ults, lane waves), and save chosen moments as
scenes, the way Dotabuff-style sites replay Dota 2? If not, what blocks it? · **Used by:** nothing
yet; input for a future spec.

Every link below was accessed on **2026-11-07** unless another date is given. **[inference]**
marks a conclusion I drew rather than read. **[snippet]** marks a claim I saw only in a search
result, because the page itself refused the fetch. This is not legal advice.

## Summary

1. **Feasible now, in part.** Valve's match metadata already carries every hero's x/y and health
   once per second, objective first-damage and destroyed times, mid-boss kills, souls every 3–5
   minutes, and item buys. deadlock-api.com serves it as free, keyless JSON.
2. That is enough for a v1 that turns "12:00" into a scene: all twelve heroes placed, dead
   ones hidden, and the walkers, guardians and shrines that were already down at that moment.
3. **Ults and lane waves aren't in the metadata.** They're in the demo file. deadlock-api will
   query it by SQL for us, or we can parse it with boon (MIT Rust, proven in WASM by deadlock.nyc).
4. **What blocks it:** demos are valid for three weeks; salts need a Steam login (in practice,
   deadlock-api's); the metadata path samples drift from the game clock for some players;
   the metadata doesn't name the game build; and everything rests on one community-run, sponsor-funded API.
5. Positions are in the same world space as our entity lump, so they drop straight onto our map.

## 1. Official data (Valve)

Valve publishes no web API for Deadlock matches. Match data comes from the Game Coordinator (GC),
which a Steam client logs in to. The protobufs below come from SteamDB's tracking repo, which
mirrors the shipped game's definitions at build 6860.

### 1.1 Metadata: `CMsgMatchMetaData` and how it's fetched

- A client sends `CMsgClientToGCGetMatchMetaData { match_id }`. The response carries
  `replay_salt`, `metadata_salt`, `replay_group_id` (the cluster), and also
  `replay_valid_through` and `replay_processing_through`. Error results include `RateLimited`,
  `TooBusy`, `InvalidPermission` and `MatchInFlight`
  ([citadel_gcmessages_client.proto L1153–1178](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/fd21313e755aaac0a1625e0851b8d5c3f03ff46d/Protobufs/citadel_gcmessages_client.proto#L1153-L1178)).
- With the salts, both files are plain HTTP downloads:
  `http://replay{cluster}.valve.net/1422450/{match_id}_{salt}.meta.bz2` and `….dem.bz2`
  ([deadlock-api `valve_replay.rs`](https://github.com/deadlock-api/deadlock-api/blob/52938c10dd6082be3ee68a56936034bbec587a26/api/src/utils/valve_replay.rs)).
  deadlock-api's salts endpoint returns those exact URLs; I saw `replay404.valve.net` for one match.
- Despite the `.bz2` name, Valve "switched the actual compression to zstd for matches from
  2026-07-20 19:00 UTC onward", so the format has to be sniffed from the magic bytes (same source).
- **Retention.** Replays do expire: the game has `Citadel_Replay_Expired` "Replay Expired"
  ([citadel_main_english.txt L2131](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/01cd7477fc56cf05164e622a1ce63d1861797065/game/citadel/resource/localization/citadel_main/citadel_main_english.txt#L2131)),
  and the GC reports `replay_valid_through`, which deadlock-api's code says is the match start
  plus three weeks (§3.4). Valve publishes no retention period, for the demo or the metadata.
  deadlock-api keeps its own copy of the metadata (its "From S3" tier, below), so old metadata
  outlives Valve's copy there **[inference]**.
- **Getting salts yourself needs a logged-in Steam account talking to the GC.** That is how
  deadlock-api does it (its rate limits name a "From Steam" tier). We would rather not hold a
  Steam credential (spec §12 already declines one for asset extraction).

### 1.2 What the metadata contains

`CMsgMatchMetaData { version, match_details: bytes, match_id }` wraps a serialised
`CMsgMatchMetaDataContents`, whose `MatchInfo` holds the match
([citadel_gcmessages_common.proto L548–823](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/fed007c2f240713754bb4fe6c6f2e9b8fe56e93a/Protobufs/citadel_gcmessages_common.proto#L548-L823)).
I checked the field list against two real responses from deadlock-api (§2.2): a 35-minute normal
match, 130816395, and a short match, 132777205.

| Want | In the metadata? | Field and granularity |
|---|---|---|
| **Hero positions over time** | **Yes** | `match_paths: CMsgMatchPlayerPathsData` ([L460–498](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/fed007c2f240713754bb4fe6c6f2e9b8fe56e93a/Protobufs/citadel_gcmessages_common.proto#L460-L498)). It has `interval_s`, `x_resolution`, `y_resolution`, and one `Path` per `player_slot` with a float bounding box (`x_min..x_max`, `y_min..y_max`) and packed `x_pos[]`, `y_pos[]` (quantised 0..resolution), `health[]` (percent), `combat_type[]` (out of combat, player, enemy NPC, neutral) and `move_type[]` (normal, ability, dash, slide, rope, zipline, air…). Observed: `interval_s = 1.0`, resolution 16383, version 1. No z. |
| **Objectives up or down** | **Yes, as events** | `objectives[]`: `team_objective_id` (`Tier1_Lane1..4` = guardians, `Tier2_Lane1..4` = walkers, `BarrackBoss_Lane1..4` = base guardians, `TitanShieldGenerator_1/2` = shrines, `Titan` = patron, `Core`; [enum L106–123](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/fed007c2f240713754bb4fe6c6f2e9b8fe56e93a/Protobufs/citadel_gcmessages_common.proto#L106-L123)), owning `team`, `first_damage_time_s`, `destroyed_time_s`, plus damage totals. Observed: an objective that survived has `destroyed_time_s = 0`; the match above lists 21 rows. `mid_boss[]` has `team_killed`, `team_claimed`, `destroyed_time_s`. No health over time. |
| **Souls over time** | **Coarse** | `players[].stats[]` (`PlayerStats`): `time_stamp_s`, `net_worth`, gold by source, kills, deaths, level, damage and more. Observed at 180, 360, 540, 720, 900, 1200, 1500, 1800 s and match end: every 3 minutes, then every 5. |
| **Items** | **Yes** | `players[].items[]`: `game_time_s`, `item_id`, `upgrade_id`, `sold_time_s`, `imbued_ability_id`. Ability upgrades appear here too. |
| **Deaths** | **Yes** | `death_details[]`: `game_time_s`, `death_pos` and `killer_pos` (world x/y/z), killer slot, `time_to_kill_s`, `death_duration_s`. |
| **Ult / ability use** | **No** | Only `ability_stats[]` (`ability_id`, `ability_value`) totals, empty in both samples, and the damage matrix by source. No cast times. |
| **Lanes / troopers** | **No** | Only `assigned_lane` per player (observed 1, 4, 6, matching our zipline paths `Lane1`, `Lane4`, `Lane6`) and per-objective `creep_damage`. No trooper positions. |
| Pauses | Yes | `match_pauses[]`: `game_time_s`, `pause_duration_s`. |
| Game build | **No** | `start_time` (unix), `game_mode`, `match_mode`, `game_mode_version`. No client version or map build. See §5. |

**The path index is not quite the game clock.** I compared the runs where `health[] == 0` with
each player's `death_details[].game_time_s` in match 130816395:

- For 6 of 12 players, every death run starts 0–1 samples after the death time.
- For the other six the offset grows during the match, to 3, 3, 5, 7, 53 and 59 samples. The
  worst-drifting path has 2,156 samples for a 2,096 s match; the rest have 2–54 extra.
- One of those six has one more zero-health run than deaths. The match also had a 29 s pause at
  538 s.

The cause is unknown. A guess is that the server skips or repeats samples per player
**[inference]**. A scrubber can re-anchor each path to its known death and respawn times, which
fixes the clock between deaths **[inference]**. This needs checking on more matches before we
trust a "12:00" scene to the second.

Decoding is `x = x_min + x_pos / x_resolution × (x_max − x_min)`, and likewise for y. That is
inferred from the field names, and §4 confirms it: decoded spawn positions land on our spawns.
While a hero is dead, its sample is `(0, 0)`, which decodes to the box corner and must be hidden.

### 1.3 Demo files (`.dem`)

The `.dem` is a Source 2 demo: the networked entity state of the whole match, tick by tick. Its
`CDemoFileHeader` carries `build_num`, `patch_version`, `map_name` and `server_start_tick`
([demo.proto L26–42](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/f3ac323d5184ddb4b4ceae2abb3ed68d3a17f7f6/Protobufs/demo.proto#L26-L42)).
What a demo exposes is in §3.

## 2. Community APIs and sites

### 2.1 Sources table

| Source | Positions | Objectives | Souls | Ults | Troopers | Granularity | Access | Terms | Link |
|---|---|---|---|---|---|---|---|---|---|
| **Valve GC metadata** | Heroes, x/y + health | Destroy and first-damage times | Every 3–5 min | No | No | 1 s paths; events to the second | Steam login to the GC for salts, then anonymous HTTP | Steam Subscriber Agreement; no Deadlock data terms found | [proto](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/fed007c2f240713754bb4fe6c6f2e9b8fe56e93a/Protobufs/citadel_gcmessages_common.proto) |
| **Valve demo (`.dem`)** | Every entity, x/y/z | Health and state per tick | Per tick | Cooldown start/end per tick | Every trooper, with lane | Per tick | As above; valid 3 weeks after the match starts | As above | [demo.proto](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/f3ac323d5184ddb4b4ceae2abb3ed68d3a17f7f6/Protobufs/demo.proto) |
| **deadlock-api `/v1/matches/{id}/metadata`** | As Valve metadata | As Valve | As Valve | No | No | As Valve | Anonymous; IP limit 100 req/s cached, 100 req/10 s from S3, 3 req/h from Steam | Code MIT; no API ToS found; "not endorsed by Valve" | [OpenAPI](https://api.deadlock-api.com/openapi.json) |
| **deadlock-api `/v1/matches/{id}/salts`** | — | — | — | — | — | — | Anonymous; returns both Valve URLs; 3 req/h per IP if it must ask Steam | As above | [OpenAPI](https://api.deadlock-api.com/openapi.json) |
| **deadlock-api demo SQL** (`POST /v1/matches/demo/query`, `GET /demo/schema`) | Every entity table in the demo | Yes | Yes | Yes | Yes | Per tick; we choose by SQL | Anonymous; 200 req/h per IP; async, about 10 s to a minute; result is Parquet or NDJSON at a public URL | As above | [OpenAPI](https://api.deadlock-api.com/openapi.json) |
| **deadlock-api live** (`/demo/live/query`, `/{id}/live/url`) | Same, streamed while the match is live | Yes | Yes | Yes | Yes | Per tick | 20 queries/min per IP; spectating a match 6 req/h per IP without a key | As above | [OpenAPI](https://api.deadlock-api.com/openapi.json) |
| **deadlock.nyc** (boon in WASM) | Heroes with facing, surface and tunnel layers | With live health | Yes | Cooldowns and charges | Lane troopers | Per tick | Free web app; the user drops in a `.dem`; no API | Code MIT | [repo](https://github.com/pnxenopoulos/deadlock-nyc) |
| **deadlocklabs.gg** | Its 2D replay shows paths, kills, fights, scrubbable scoreboard | Yes | Yes | Not mentioned | Not mentioned | Unknown | Web only; no API found; fetches 403 | Privacy policy only | [replays](https://deadlocklabs.gg/matches/replays/) **[snippet]** |
| statlocker.gg | No replay or timeline found | — | — | — | — | — | Links a "Public API" page whose content didn't render | None found | [site](https://statlocker.gg/), [api](https://statlocker.gg/api) |
| tracklock.gg | No replay or timeline; match history, damage meters | — | — | — | — | — | No API | Privacy policy only; "powered by" U.GG | [site](https://tracklock.gg/) |
| deadlocktracker.gg | No; final net worth and ratings only | — | — | — | — | — | No API | None found | [match page](https://deadlocktracker.gg/matches/133149705) |
| mobalytics, deadlock.coach, metabot.gg | Guides, profiles; metabot records local scrubbable replays on Windows | — | — | — | — | — | Desktop apps, no API | Not found | [deadlock.coach](https://deadlock.coach/), [metabot](https://metabot.gg/) **[snippet]** |

### 2.2 deadlock-api.com

**What it is.** An MIT-licensed monorepo
([repo](https://github.com/deadlock-api/deadlock-api), pushed 2026-11-07), funded by Patreon
and GitHub Sponsors, with no company or SLA named. That it is run by volunteers is
**[inference]**. The OpenAPI description says it is "not endorsed by Valve"
([OpenAPI](https://api.deadlock-api.com/openapi.json)).

**Match endpoints** (all from the OpenAPI spec):

- **`GET /v1/matches/{match_id}/metadata`** returns `CMsgMatchMetaDataContents` as JSON, plus
  `hero_build_ids`, `pregame_hero_ids` and `banned_hero_ids` from its own demo analysis.
  `/metadata/raw` returns the protobuf. `?disable_steam=true` serves only what it already holds.
  - Observed: 1.18 MB of JSON for a 35-minute match, `cache-control: public, max-age=604800`.
  - Limits per IP: from cache 100 req/s, from S3 100 req/10 s, from Steam 3 req/h. An API key
    raises "from Steam" to 300 req/h.
- **`GET /v1/matches/{match_id}/salts`** returns `cluster_id`, both salts, `metadata_url` and
  `demo_url`. It notes "we currently fetch many matches without salts", so not every match has a
  demo URL.
- **`POST /v1/matches/demo/query`** runs SQL over a match's demo:
  - It is asynchronous: "download + decompress + parse + query takes ~10s on average and up to
    about a minute". You poll `/demo/query/{job_id}` for a public `result_url` (Parquet, or
    zstd-compressed NDJSON).
  - Identical queries are de-duplicated. 404 means "No demo / salts available"; 502 means
    "Valve's replay server failed to serve the demo". 200 req/h per IP, 400 with a key.
  - It is built on its `demofusion` crate, which runs Apache DataFusion over haste
    ([Cargo.toml](https://github.com/deadlock-api/deadlock-api/blob/52938c10dd6082be3ee68a56936034bbec587a26/crates/demofusion/Cargo.toml)).
- **`GET /v1/matches/demo/schema`** lists the tables. I fetched it once (5.3 MB, 998 tables for
  match 132777205). The tables we'd need:
  - `CCitadelPlayerPawn`: `CBodyComponent__m_cellX/Y/Z`, `m_vecX/Y/Z`, `m_iHealth`, `m_lifeState`,
    `m_iTeamNum`.
  - `CCitadelPlayerController`: `m_PlayerDataGlobal__m_nHeroID`, `m_iGoldNetWorth`, `m_iLevel`,
    `m_bUltimateTrained`, `m_flUltimateCooldownStart`, `m_flUltimateCooldownEnd`,
    `m_flRespawnTime`, `m_nAssignedLane`.
  - `CNPC_Trooper` (position, health, `m_iLane`, team) and `CCitadelTrooperMinimap`
    (`m_vecFOWEntities__m_nPosX/Y`, the minimap's own trooper dots).
  - `CNPC_TrooperBoss`, `CNPC_Boss_Tier2`, `CNPC_Boss_Tier3`, `CNPC_BarrackBoss`, `CNPC_MidBoss`
    (health, life state, lane).
  - `CCitadelGameRules`: `m_flGameStartTime`, `m_bGamePaused`, `m_nTotalPausedTicks`,
    `m_tNextMidBossSpawnTime`, neutral camp respawn times.
  - Events: `BossKilledEvent` (`gametime`, `entity_position`), `ImportantAbilityUsedEvent`,
    `ObjectiveMaskEvent`, `HeroKilledEvent`, `GoldHistoryEvent`.
- The query docs warn that "while a hero is dead, `CCitadelPlayerController.m_hPawn` points at a
  `CCitadelObserverPawn`", so pawns should be joined by hero id.

**Terms and attribution.**

- I found **no terms of use for the main API.** The only terms are for the separate paid
  "Live Events" product: keep keys confidential, and don't "resell or sublicense access to the
  raw API without our written consent" ([terms](https://live.deadlock-api.com/legal/terms),
  last reviewed 2026-05-03).
- Free, keyless use is the documented default, and a free, open-source, non-commercial client
  fits the project's stated aim ("open, free and future-proof for everyone") **[inference]**.
- No attribution rule is published. We'd credit it anyway: "Match data from deadlock-api.com
  (not endorsed by Valve)" **[inference: courtesy, not a requirement]**.
- The code is MIT, so we may also run any of it ourselves with the licence notice.

**Its own viewers.** Its website shows kill and death heatmaps and per-match timeline charts, but
no positional replay (repo paths `website/src/components/features/heatmap/`,
`…/tracker/matches/MatchTimeline.tsx`). The heatmap code is also the best evidence on map versions
(§5).

### 2.3 Existing replay viewers

- **deadlocklabs.gg** has the closest thing to what we want **[snippet]**
  ([replays](https://deadlocklabs.gg/matches/replays/), [about](https://deadlocklabs.gg/about/)).
  - It shows a 2D minimap with player movement paths, kill markers, auto-detected fights, a
    scoreboard (items, souls, K/D) that updates as you scrub, a timeline with engagement
    markers, and drawing tools.
  - It is "powered by match data from the Deadlock API". Nothing mentions troopers or ults, so
    it likely runs on metadata paths alone **[inference]**.
  - It shows a v1 like ours is buildable on metadata **[inference]**.
- **deadlock.nyc** ([repo](https://github.com/pnxenopoulos/deadlock-nyc), MIT) is a client-side
  `.dem` viewer, built on boon in WASM. It shows heroes, troopers and objective health on a
  scrubbable minimap: the full version of what we want, minus scenes and collaboration. See §3.1.

## 3. Demo parsing

### 3.1 Parsers

| Parser | Language | Licence | State on 2026-11-07 | Current builds? | Browser |
|---|---|---|---|---|---|
| [boon](https://github.com/pnxenopoulos/boon) (crate `boon-deadlock`) | Rust core, Python bindings, CLI | MIT ([LICENSE](https://github.com/pnxenopoulos/boon/blob/main/LICENSE)) | v0.19.0, released 2026-10-21 | Yes; 0.11+ handles the "City Never Sleeps" map (README) | **Yes, proven:** deadlock.nyc compiles `boon-deadlock = "=0.19.0"` to WASM with wasm-bindgen ([wasm/Cargo.toml](https://github.com/pnxenopoulos/deadlock-nyc/blob/main/wasm/Cargo.toml)) |
| [haste](https://github.com/blukai/haste) (blukai) | Rust | BSD-3-Clause ([license.txt](https://github.com/blukai/haste/blob/main/license.txt)) | Pushed 2026-10-22; no releases; the readme calls the API "very unstable" | Parses current builds after a fix on 2026-10-22 ([#14](https://github.com/blukai/haste/pull/14)), but its position helper still assumes the old `MAX_COORD_INTEGER = 16384` ([entities.rs L102](https://github.com/blukai/haste/blob/d2cdbf2cc13cadf12ec6c6b765f689a5894a6b36/crates/haste_core/src/entities.rs#L102)) | A WASM build runs at [haste-inspector](https://blukai.github.io/haste-inspector/), whose repo has no licence |
| deadlock-api's haste fork ([crates/haste](https://github.com/deadlock-api/deadlock-api/tree/master/crates/haste)) | Rust | Keeps haste's BSD-3 licence inside the MIT repo | Commits to 2026-11-02 | Yes; fixed the build-6712 coordinate change on 2026-09-29 | Not stated |
| [deadem](https://github.com/Igor-Losev/deadem) (`@deademx/deadlock`) | JavaScript | MIT ([npm](https://www.npmjs.com/package/deadem)) | Pushed 2026-11-07 | README lists builds up to 6766 ([README](https://github.com/Igor-Losev/deadem/blob/main/packages/deadlock/README.md)) | Runs in browsers natively, with a seekable player |
| [demofile-net](https://github.com/saul/demofile-net) | C# | MIT | Last release 0.44.1, 2026-05-09 | Probably not: "Deadlock parser not working" open since 2026-02-17 ([#167](https://github.com/saul/demofile-net/issues/167)) | No |

**An existing viewer does what we want.** [deadlock.nyc](https://deadlock.nyc)
([repo](https://github.com/pnxenopoulos/deadlock-nyc), MIT, pushed 2026-10-30) is "a fast,
fully client-side demo (replay) viewer". It lets you "Drop in a `.dem` file and scrub through
the match on a live minimap", with no upload. Its README lists:

- heroes with facing;
- lane troopers, neutral camps and breakables;
- guardians, walkers, shrines, patron and mid boss, "with live health rings";
- surface and tunnel layers, a timeline scrubber, and feeds of kills, ability use and objectives;
- per-player cooldowns and charges.

It "selects a bundled catalog matching the demo header (6746 or 6759)", so the header build is
the game's build number. It leaves fetching the demo to the user ([README](https://github.com/pnxenopoulos/deadlock-nyc/blob/main/README.md)).

### 3.2 What a demo exposes

Field names are from deadlock-api's demo schema (§2.2) and the parser docs.

- **Heroes:** `CCitadelPlayerPawn` position (`CBodyComponent` cell plus offset, with z), health
  and `m_lifeState`; souls in `m_nCurrencies`
  ([boon entity-classes.md](https://github.com/pnxenopoulos/boon/blob/main/crates/boon-python/docs/reference/entity-classes.md)).
  Example code is in haste's [`deadlock-position.rs`](https://github.com/blukai/haste/blob/main/examples/deadlock-position.rs).
- **Ults:** `CCitadelPlayerController.m_PlayerDataGlobal.m_flUltimateCooldownStart/End` and
  `m_bUltimateTrained`. Every ability entity also has `m_flCooldownStart/End` and
  `m_iRemainingCharges`, plus `ImportantAbilityUsedEvent`.
- **Troopers, which give real lane equilibrium:** every `CNPC_Trooper` with position, health,
  team and `m_iLane`. boon has a ready-made `troopers` dataset (per tick, opt-in).
- **Objectives:** `CNPC_TrooperBoss` (guardian), `CNPC_Boss_Tier2` (walker), `CNPC_Boss_Tier3`
  (patron), `CNPC_BarrackBoss`, `CNPC_MidBoss` and `CCitadel_Destroyable_Building` (shrine), with
  `m_iHealth`, `m_iMaxHealth` and `m_iLane`. `BossKilledEvent` adds the game time and position.
  - deadlock-api's live parser calls the base guardian `CNPC_TrooperBarrackBoss`, but its
    current schema and boon say `CNPC_BarrackBoss` (it was renamed at some point **[inference]**).
- **Clock:** `CCitadelGameRules` `m_flGameStartTime`, `m_bGamePaused` and `m_nTotalPausedTicks`.
  Game time = (tick − paused ticks) × tick interval − start time
  ([haste `deadlock-gametime.rs`](https://github.com/blukai/haste/blob/main/examples/deadlock-gametime.rs)).

### 3.3 Costs

- **Size:** uncompressed `.dem` files are 229–557 MB, and mostly 350–500 MB on 2025–26 builds,
  per deadem's fixture list ([DemoFile.js](https://github.com/Igor-Losev/deadem/blob/main/packages/examples-common/data/DemoFile.js)).
  I found no figure for the compressed download and didn't download one.
- **Tick rate:** 64 ticks per second ([deadem engine README](https://github.com/Igor-Losev/deadem/blob/main/packages/engine/README.md)).
  An older issue says 60 ([demofile-net #96](https://github.com/saul/demofile-net/issues/96)),
  so read `tick_interval` from the demo rather than hard-coding it.
- **Seeking:** a full snapshot about every 60 s keeps seeking cheap.
- **Parse time:**
  - haste: a 31-minute match in about 660 ms with a 17.5 MB peak, measured in 2024 on older
    builds ([readme](https://github.com/blukai/haste)).
  - deadem in Node: a 30-minute match in about 6.6 s and 232 MB RSS for everything.
- **Where parsing would run:**
  - **Our server:** boon or the deadlock-api haste fork, in Rust. The cost is downloading and
    decompressing about 0.4 GB per match, plus seconds of CPU. Cache the derived timeline, not
    the demo **[inference]**.
  - **The browser:** boon in WASM is proven by deadlock.nyc. But the browser still needs the
    demo bytes, and Valve's replay servers are plain `http://`. A page served over https can't
    fetch them directly, as mixed content, and CORS headers are unverified **[inference]**. In
    practice that means the user downloads the file, or our server relays it.
  - **Neither:** deadlock-api's demo SQL runs the parse on their side (§2.2).

### 3.4 Retention and access

- **Three weeks.** deadlock-api's ingest tool states that the GC's `replay_valid_through` "is the
  match's start plus three weeks". It relies on this to match replies to matches, with a test
  vector from a live client ([game_memory/mod.rs L79–82](https://github.com/deadlock-api/deadlock-api-ingest/blob/main/src/game_memory/mod.rs)).
  That is Valve's stated validity, not a measured deletion **[inference]**.
- **Salts need a Steam login.** deadlock-api gets them through bot accounts, which the salts code
  says are limited to about 50 per bot per day
  ([salts.rs](https://github.com/deadlock-api/deadlock-api/blob/master/api/src/routes/v1/matches/salts.rs)).
  Players can also contribute salts from their Steam cache
  ([FAQ](https://github.com/deadlock-api/deadlock-api/blob/master/website/src/components/features/ingest-cache/faq.ts)).

### 3.5 Demo coordinates

- World = cell × 512 − max_coord + offset in cell
  ([haste entities.rs](https://github.com/blukai/haste/blob/d2cdbf2cc13cadf12ec6c6b765f689a5894a6b36/crates/haste_core/src/entities.rs)).
- **Build 6712 (2026-09-29) doubled max_coord, from 16384 to 32768.** Servers now announce it in
  `CSVCMsg_GameSessionConfiguration.max_coord`. deadlock-api's fork reads it
  ([fork entities.rs](https://github.com/deadlock-api/deadlock-api/blob/master/crates/haste/crates/haste_core/src/entities.rs)),
  and boon hard-codes 32768 ([position.rs](https://github.com/pnxenopoulos/boon/blob/main/crates/boon/src/position.rs)).
- Upstream haste's helper would return positions shifted by 16384 on current demos **[inference]**.
- Results are in world units ([boon DESIGN.md](https://github.com/pnxenopoulos/boon/blob/main/DESIGN.md)).

## 4. Coordinates

**Same world space; positions drop straight onto our map.**

- Our map entities are entity-lump `origin` values in world units
  (`crates/extract/src/entities.rs`). The board maps them with `mx = (x + 10752) / 21504`,
  `my = (10752 − y) / 21504` (`design/parity/README.md`, "Coordinates").
- **Check on a real match.** I decoded the first path sample of all 12 players in match
  130816395 (played 2026-11-04 on the current map) and compared each with our extracted team
  spawn points (`design/shared/minimap-data.js` `spawn`, converted back to world units).
  - Lobby team 0 starts within 55–299 units of the Amber spawn at about (−1280, −10016).
  - Team 1 starts within 36–283 units of the Sapphire spawn at about (1280, 10208).
  - Six heroes spread around a spawn would fit that **[inference]**, as would team 0 being
    Amber, which matches our parity orientation.
- Across all paths, x stays within −9,566…9,115 and y within −10,146…10,282. That is inside the
  ±10752 square.
- deadlock-api plots kill and death positions with the same ±10752 bounds
  ([map-era.ts](https://github.com/deadlock-api/deadlock-api/blob/52938c10dd6082be3ee68a56936034bbec587a26/website/src/components/features/heatmap/map-era.ts)).
- `death_pos` and `killer_pos` are world x/y/z floats and need no decoding.
- Metadata paths have no z, so the layer a hero is on (street, tunnel, rat tunnel) can't be
  known from them. Demos carry z.
- **Stale bounds to ignore.** haste has a comment, from before the map rework, saying the game
  rules report `m_vMinimapMins/Maxs` as ±8960
  ([entities.rs L104–106](https://github.com/blukai/haste/blob/d2cdbf2cc13cadf12ec6c6b765f689a5894a6b36/crates/haste_core/src/entities.rs#L104-L106)).
  Current paths reach y = 10,282, beyond that. Reading those two fields from a current demo would
  confirm our R = 10752 from the game itself, not from deadlock-api's constant **[inference]**.
- Demo positions are world units too (§3.5), but only after applying the post-6712 `max_coord`.
  A parser still on 16384 would put everything off by 16384 per axis.

## 5. What's per-match and what's per-patch

- **Match data carries no game build.**
  - The metadata has `start_time` but no client version (§1.2).
  - The demo header has `build_num` and `patch_version` (§1.3). deadlock.nyc picks its data
    catalog by the header's build, naming builds 6746 and 6759, so `build_num` uses the same
    numbering as the `ClientVersion` our packs record (§3.1). That they are always equal is
    **[inference]**.
- **deadlock-api picks the map by date.** Its heatmap code says the "City Never Sleeps" update
  (build 6711/6712) "rebuilt the whole map: same ±10752 world bounds, new streets, so positions
  from one layout land in the other's buildings". It switches layouts at `2026-09-29T20:50:00Z`
  and asks its assets API for build 6701 for older matches
  ([map-era.ts](https://github.com/deadlock-api/deadlock-api/blob/52938c10dd6082be3ee68a56936034bbec587a26/website/src/components/features/heatmap/map-era.ts)).
- **We can do the same, at finer grain.** Map `start_time` to the build live at that moment, using
  build timestamps, then pick the newest pack at or before that build.
  - SteamDB's tracking repo commits each build with its number and time, for example
    "6860 | 15 files" at 2026-11-06T00:52Z
    ([commits](https://github.com/SteamDatabase/GameTracking-Deadlock/commits/master)).
  - deadlock-api's `/v2/patches` (patch notes with `pub_date`) and `/v1/assets/client-versions`
    also help ([OpenAPI](https://api.deadlock-api.com/openapi.json)).
  - Most builds don't move the map (spec §12: 6851 → 6860 left the minimap byte-identical), so
    an approximate date is safe except near a rework **[inference]**.
  - Where a demo exists, its `build_num` settles it.

## 6. Recommended path

### 6.1 v1: metadata scrubber, one API, no demo

**Goal:** paste a match id or link, scrub a timeline, press "Save as scene".

1. **Fetch.** The server proxies `GET api.deadlock-api.com/v1/matches/{id}/metadata` and caches
   the result immutably, since matches don't change. It sends a plain user agent and no key.
   Proxying keeps users' IPs off a third party and lets one cached copy serve a whole room
   **[inference]**. Treat 404 and 429 as "not available yet, try later".
2. **Pick the pack** from `start_time` (§5). Refuse, or warn, if the match predates the oldest
   pack we hold for that map layout.
3. **Build a timeline** in the client, in game seconds:
   - Hero positions: decode the paths, hide samples with `health == 0`, and re-anchor each
     path to its deaths (§1.2).
   - Objectives: each `team_objective_id` is up until `destroyed_time_s`. Map it to our semantic
     keys (`walker:amber:lane2`…) by team, tier and lane number.
   - Mid boss: from `mid_boss[]`.
   - Souls: `stats[]` gives net worth, interpolated between samples and labelled approximate.
   - Items owned at t: from `items[]`.
4. **Scrub → scene.** A slider over `0..duration_s`. "Save as scene" writes an ordinary scene:
   hero tokens at their positions, objectives toggled, and a caption such as
   "Match 130816395 @ 12:00". It is then a normal, editable scene, with no live link to the match.
   That keeps the document model unchanged **[inference]**.

**v1 can't show** ult readiness, lane wave positions, z or layer, objective health, or souls
more often than every 3–5 minutes.

**Cost:** about 1.2 MB of JSON per match. Decoding 12 × ~2,100 samples is trivial in the browser
**[inference]**.

### 6.2 v2: ults and lane waves from the demo, via deadlock-api's demo SQL

Add a few SQL queries per match, each downsampled to about one row per second, for example
`WHERE tick % 64 = 0` **[inference: assumes 64 ticks/s; see §3]**:

- **Ults:** `CCitadelPlayerController` → hero id, `m_bUltimateTrained`,
  `m_flUltimateCooldownEnd` against the game clock gives "ult ready" per hero.
- **Lane waves:** `CNPC_Trooper` positions with `m_iLane` and team, or the cheaper
  `CCitadelTrooperMinimap` dots. Where the two teams' fronts meet on each lane is the wave
  equilibrium **[inference]**.
- **Objective health:** `CNPC_Boss_Tier2`, `CNPC_TrooperBoss` and similar, by `m_iHealth`.
- **Exact clock:** `CCitadelGameRules` start time and pauses, which also fixes the path drift.

This costs us no parser, and the queries run on deadlock-api's machines. Results are Parquet; the
browser would need a Parquet reader, or the server converts them to JSON **[inference]**. The
limits: 200 queries/h per IP, and it only works within the demo's three weeks. Because of that,
we should store the derived timeline the first time a match is imported **[inference]**.

### 6.3 v3: our own parser (fuller, independent)

Parse the `.dem` ourselves with boon and emit the same timeline (§3). boon is MIT and also
builds to WASM, as deadlock.nyc shows. It can run in the Rust server, or in the browser on a file
the user drops in. deadlock.nyc is the reference for the entity handling, and its MIT licence lets
us borrow code with the notice.

This removes the dependency on deadlock-api's query service. It doesn't remove the need for
someone to hold salts, or for the demo to be under three weeks old, unless the user supplies the
file. A replay the user saved in game is a local `.dem` **[inference]**.

## 7. Blockers to watch

All checked 2026-11-07.

| # | What's missing | Who controls it | How we'd know it changed |
|---|---|---|---|
| B1 | **Ult and ability timing and trooper positions are absent from the metadata.** They're only in demos. | Valve (the `CMsgMatchMetaDataContents` schema) | Watch [`Protobufs/citadel_gcmessages_common.proto`](https://github.com/SteamDatabase/GameTracking-Deadlock/commits/master/Protobufs/citadel_gcmessages_common.proto) for new `MatchInfo` or `Players` fields, or a new `CMsgMatchPlayerPathsData` version |
| B2 | **Demos are valid for three weeks** after the match starts (the GC's `replay_valid_through`), and Valve publishes no policy. Older matches lose ults and troopers for good, unless someone kept the demo or we cache our derived timeline. | Valve | `REPLAY_VALID_FOR` in [deadlock-api-ingest `game_memory/mod.rs`](https://github.com/deadlock-api/deadlock-api-ingest/blob/main/src/game_memory/mod.rs) failing to match; deadlock-api's demo query returning 404 or 502 for matches under three weeks old |
| B3 | **Salts need a Steam GC login,** and not every match has salts stored ("we currently fetch many matches without salts"). | Valve (GC access); deadlock-api (coverage) | `/v1/matches/{id}/salts` returning `demo_url` for the matches we try; the salts endpoint's description in the [OpenAPI spec](https://api.deadlock-api.com/openapi.json) |
| B4 | **Path samples drift from the game clock** for some players, by up to about 60 s in one match. | Valve (how paths are recorded) | `match_paths.version` changing from 1; re-run the death-alignment check from §1.2 on a few new matches |
| B5 | **No game build in the match metadata.** We pick the pack by `start_time`. | Valve | A new build or version field in `MatchInfo` (same proto file as B1) |
| B6 | **One community-run API, with no published terms or SLA** for the main API. Valve has throttled trackers before ([GamesRadar](https://www.gamesradar.com/games/third-person-shooter/valve-cuts-off-deadlock-stat-tracking-and-the-community-understands-why-this-game-is-in-beta-and-they-clearly-arent-ready-for-stats-sites-yet/)). | deadlock-api maintainers; Valve (GC rate limits) | Rate-limit tables and disclaimers in the [OpenAPI spec](https://api.deadlock-api.com/openapi.json); the [repo](https://github.com/deadlock-api/deadlock-api) commits; a ToS appearing at deadlock-api.com |
| B7 | **No z in the metadata paths,** so tunnel and rat-tunnel heroes draw on the street layer. | Valve | `CMsgMatchPlayerPathsData.Path` gaining a z field (B1's proto file) |
| B8 | **Souls only every 3–5 minutes** in the metadata. | Valve | `PlayerStats` cadence in a fresh match; the demo has it per tick |
| B9 | **Demo coordinate encoding changes at map reworks.** Build 6712 doubled `max_coord`, and upstream haste still assumes the old value. | Valve; parser maintainers | `CSVCMsg_GameSessionConfiguration.max_coord` in a new demo; [boon releases](https://github.com/pnxenopoulos/boon/releases); [haste commits](https://github.com/blukai/haste/commits/main) |
| B11 | **Powerup state isn't in the match metadata.** The two powerup spawners (`citadel_item_powerup_spawner`) have no timeline: players only carry permanent pickup counts (`power_up_buffs`), with no time or site. Imported scenes leave powerups at their default state. | Valve | `CMsgMatchMetaDataContents` gaining powerup pickup events with time and position (same proto as B1); checked 2026-11-08 |
| B10 | **Rift state isn't in the match metadata.** `ECitadelObjective` has no rift (KOTH) entries (guardians, walkers, base guardians, shrines, patron, core only), and a full `/v1/matches/130816395/metadata` response has no rift, KOTH or similar field; the only "urn" hits are a hero ability. Rifts would need the demo (the entities at our two `info_koth_spawn_location` sites), so they stay manual in v1. | Valve | `ECitadelObjective` or `CMsgMatchMetaDataContents` gaining rift entries in [citadel_gcmessages_common.proto](https://github.com/SteamDatabase/GameTracking-Deadlock/blob/master/Protobufs/citadel_gcmessages_common.proto); checked 2026-11-08 |

## 8. Open questions for the operator

1. **Which data source:** is relying on deadlock-api.com for v1 acceptable? The alternative is
   holding a Steam account to talk to the GC ourselves. Spec §12 already declined a credential for
   assets.
2. **Should our server proxy and cache** match JSON, or should browsers call deadlock-api
   directly? Proxying is kinder to their limits and keeps users' IPs private, but our server then
   stores third-party data.
3. **Imported scenes:** frozen copies (the v1 proposal), or should a scene remember its match and
   time so it can be re-imported later?
4. **Is v1 worth shipping without ults and lane waves?** Or is lane equilibrium the point, which
   makes v2 (demo SQL) the first useful release?
5. **Old matches:** what should happen when a match predates our oldest pack for its map layout:
   refuse, or draw on the nearest pack with a warning?
6. **Credit line:** is "Match data from deadlock-api.com" in the import dialog enough, given
   that none is required?
7. **deadlock.nyc already scrubs demos in the browser.** Should mapcro build its own v3, or link
   out to it and import its moments? Contacting its author would be a separate decision; I made no
   contact.
