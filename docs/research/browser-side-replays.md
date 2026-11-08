# Browser-side deadlock-api calls (research, 2026-11-08)

Goal (operator): move deadlock-api work off our server and onto the user's browser, so per-IP
rate limits fall on each user and our quota and compute go further. In scope now: the three
deadlock-api calls the server makes today. Browser parsing (WebAssembly) and deadlock-api's
`/demo/query` are in the backlog (see "Later (backlog)").

Sources: deadlock-api's `openapi.json` (snapshot read 2026-11-08), CORS preflights against
`https://api.deadlock-api.com`, one metadata GET of match 129738985, and one GET of
`/v1/matches/demo/schema`. No Steam-sourced lookups were spent.

## 1. What the server calls today

| Call | Where | Used for |
|---|---|---|
| `GET /v1/matches/{id}/metadata?disable_steam=true` | `crates/server/src/matches.rs` `fetch` | the match import (positions at 1 s, deaths, objectives, souls) |
| `GET /v1/players/steam?account_ids=a,b,…` | `matches.rs` `names` | players' public names; one batched call for each uncached import |
| `GET /v1/matches/{id}/salts` (no `disable_steam`) | `crates/server/src/replays.rs` `salts` | `cluster_id` and `replay_salt`, from which the server builds the Valve CDN URL |

Valve's CDN (`http://replay{cluster}.valve.net/1422450/{id}_{salt}.dem.bz2`) sends no CORS
headers and is plain http, so the download stays on the server.

## 2. CORS and limits

All three answer the preflight
(`Origin: https://mapcro.dmgdeadlock.com`, method GET/POST, request headers `content-type,x-api-key`)
with `200`, `access-control-allow-origin: *`, `access-control-allow-methods: *`, and
`access-control-allow-headers: content-type,x-api-key`. The real metadata GET also returns
`access-control-expose-headers: *` and `cache-control: public, max-age=604800`. The preflight
also passes for `/v1/matches/demo/schema`, `POST /v1/matches/demo/query`, and `POST /v1/matches/salts`.
Responses carry no rate-limit headers, so a client learns its limit only from a `429` (the
server already reads `Retry-After` on salts).

Documented limits, for each IP without a key (openapi.json):

| Endpoint | Cheap path | Expensive path |
|---|---|---|
| metadata | cache 100/s; S3 100/10 s | **Steam 3/h** (key 300/h, global 1500/h) |
| salts | DB 100/s | **Steam 3/h** (key 300/h, global 1500/h) |
| players/steam | read 100/s | refresh (`refresh=true`) 3/min, 15/h |

Both metadata and salts take `disable_steam=true`, which skips the Steam fallback and returns an
error instead. The server already sends it on metadata, so **the server never spends Steam
lookups on metadata today**: a match deadlock-api hasn't fetched yet simply 404s. Salts are sent
without it, so the server's own IP spends its 3/h there. The operator's deadlock-api key request
was declined (they are at capacity), so the per-IP budget is the one we have.

The win is therefore narrow and specific: the **Steam-sourced** lookups for fresh matches, which
are 3/h per IP. Everything served from deadlock-api's DB, cache, or S3 is already plentiful from
the server.

## 3. Response shapes the browser would see

- **salts** (`MatchSaltsResponse`): `{match_id, cluster_id?, replay_salt?, metadata_salt?, demo_url?, metadata_url?}`,
  with integers marked `int32, minimum 0`. Only `cluster_id` and `replay_salt` matter to us.
  `demo_url` is ignored: the server builds the URL itself.
- **metadata**: `{match_info, hero_build_ids, pregame_hero_ids, banned_hero_ids}`. For
  129738985 it is 1,437,916 bytes raw and 294,100 bytes gzipped. **It contains account ids**:
  `players[].account_id`, plus the maps keyed by `account_id`. A projection down to the fields
  `derive` reads (`match_id, start_time, duration_s, game_mode, winning_team, objectives, mid_boss,
  match_paths, players[{player_slot, team, hero_id, death_details, stats[{time_stamp_s, net_worth}]}]`)
  is 567,098 bytes raw and 168,800 bytes gzipped.
- **players/steam** (`SteamProfile[]`): `account_id, personaname, profileurl, avatar*, countrycode?,
  friends[], last_updated, matches_played_last_30d, …`. That is a lot more personal data than the
  name we keep.

## 4. Recommended flow: the browser primes the cache, the server fetches

The key observation is that the Steam-sourced lookup is the *only* scarce one, and after
deadlock-api performs it, it presumably stores the result (the docs' "from DB" and "from S3"
tiers). So the browser does not need to send us anything forgeable:

1. The board opens match `id`. The server tries as it does today, with `disable_steam=true` on
   **both** metadata and salts (new for salts). Its own IP never spends Steam lookups.
2. If the server answers "not at deadlock-api yet" (a 404 with `disable_steam`), the browser calls
   `GET /v1/matches/{id}/salts` and/or `/metadata` **without** `disable_steam`. That spends *the
   user's* 3/h Steam budget and makes deadlock-api fetch from Steam and store the result.
3. On a 200, the browser tells the server "try again" (no body beyond the match id). The server
   re-fetches with `disable_steam=true` and now gets the stored copy from deadlock-api's
   DB/S3 tier, which is authoritative and goes into the shared cache as today.

That keeps the trust model unchanged: everything in the shared cache still comes from the
server's own fetch. **Unverified:** that one Steam-sourced fetch by any IP makes the next
`disable_steam=true` call succeed, and how soon. Test it on one fresh match: browser call, then
server call. If it doesn't hold, use the forwarding variant below.

### Forwarding variant (if priming doesn't hold, or for salts anyway)

**Salts: `POST /api/replays/{id}/salts {cluster_id, replay_salt}`.** The server validates:
- the body is a small JSON with exactly those two non-negative integers (`cluster_id` a u32 below
  a sane cap, e.g. 10,000; `replay_salt` a u32, since openapi says int32 ≥ 0, though the server
  stores u64 today);
- the match id in the path is `valid_id`;
- the usual per-client fetch limits apply.

The server then builds `http://replay{cluster}.valve.net/1422450/{id}_{salt}.dem.bz2` itself. A
wrong salt can only 404 on Valve. A right salt fetches Valve's real replay *for that id*, so the
resulting timeline is as trustworthy as one from a server-fetched salt and may enter the shared
cache.

Rules the server must adopt for browser-supplied salts:
- **A download that fails with browser salts never touches `negative`**, which is match-wide and
  set in `replays.rs` when a fetch fails for any reason other than `upstream_limited`, `queue_full`
  or `internal`. Record it as that job's failure (`failed`), or answer the POST with `no_replay`
  and record nothing. Otherwise one forged salt blocks the match for every board for
  `NEGATIVE_FOR`.
- A browser's 429 from deadlock-api must never trigger the server's global `back_off`.
- Browser salts are never cached as the match's salts. Keep them for the job only, and don't log
  them beyond what's logged today.
- Bound the cluster value, because it chooses a DNS name under `valve.net`.
- `max_redirects(0)` and the size cap stay as they are.

**Metadata: `POST /api/matches/{id}/metadata` with the projection above (~170 KB gzipped).**
It is forgeable: nothing signs it. Rules:
- Strip account ids in the browser before posting (send the projection only), and strip them
  again on the server (`Upstream` ignores unknown fields, but `accounts()` reads `account_id`,
  so a browser-posted body must take a path that never calls `names()` with ids from it).
- Run the same `derive` and the same mode refusal (`mode_refusal`; standard 6v6 only), and the
  same size cap.
- Store the result **scoped to the board that sent it**, never in `DATA_DIR/matches/<id>.json`
  and never in `refused_path`. The next server fetch with `disable_steam=true` that succeeds
  replaces it with the authoritative copy.
- Label it as browser-supplied in the timeline's `source`, so it's never mistaken for ours.
- Client code must never persist account ids (no localStorage or IndexedDB, and nothing in the
  board doc). The browser holds the raw response in memory only long enough to project it.

**Names (`players/steam`): leave on the server.** Its read path is 100/s per IP and needs no
Steam lookup, so moving it saves nothing. It would also put friend lists, avatars and country
codes in the browser, and browser-sent names are forgeable. If it ever moves, the browser must
take ids from the metadata in memory only, and names posted to the server are board-scoped.

## 5. Fallbacks

The browser path is an accelerator, never a requirement. Every failure falls back to today's
server-side behaviour:
- **CSP:** the server sends `connect-src 'self'` (`crates/server/src/main.rs`; also stated in
  `matches.rs`'s module docs). The browser call needs `connect-src 'self' https://api.deadlock-api.com`.
  Without that change, every browser call fails as blocked.
- **Blocked** (ad blocker, privacy extension, corporate proxy, CSP, offline). Detect this as a
  network error or opaque failure, then fall back to the server's own lookup. For salts that is
  the server's current Steam-capable call from its IP, under its 3/h and the existing backoff.
  For metadata it is the 404 "not available yet" the user sees today. Whether
  `api.deadlock-api.com` is on common filter lists is **unverified**.
- **User's own 429** (3/h Steam). Show the existing "rate limited, try later" state using the
  `Retry-After` it got. Optionally fall back to the server's lookup if the server's budget allows.
  That is a policy choice: the operator's aim is to save the server's budget, so the default
  should be to wait.
- **404** (deadlock-api has no salts or demo). The same `no_replay` as today. It may negative-cache
  only if the *server's* own lookup says so.
- **deadlock-api down**: the same as the server's `upstream_down`.

## 6. Privacy

When the browser calls deadlock-api directly, **deadlock-api sees the user's IP address**, the
`Origin`/`Referer` (that they use mapcro), the match ids they open, and their user agent. Today
only our server's IP reaches them (`matches.rs` module docs: "users' addresses stay private").
This changes that promise and must be recorded here and in `matches.rs`'s module docs when it
ships. The operator wants it in the repo, not in the UI. The browser also receives the raw
metadata, account ids included, straight from deadlock-api. That is public data deadlock-api
serves to anyone, but our code must not keep it. Names stay server-side, so friend lists never
reach the browser.

## 7. Staged plan (rough sizes)

1. **(a) Salts via the browser.** Add `disable_steam=true` to the server's salts call. Add the
   browser lookup, plus a `POST {cluster_id, replay_salt}` *or* a "primed, try again" signal.
   Change the negative-cache and backoff rules above, and the CSP. About 150 to 250 lines of
   server and web code with tests. This is the biggest win: replay fetches of fresh matches are
   the main Steam consumer.
2. **(b) Metadata priming.** The browser calls metadata without `disable_steam` on the server's
   404, then asks the server to retry. Small (about 80 lines) *if* priming holds. If not, the
   board-scoped forwarding variant is about 300 lines (new endpoint, board-scoped store, source
   label, replacement by the authoritative copy).
3. **Names:** no change.

Recommended order: (a) first; verify priming on one fresh match; then (b) as priming, falling
back to the forwarding variant only if priming fails.

## Later (backlog)

**Parsing in the browser (WebAssembly): not built, not measured.** Learned so far:
- boon-deadlock 0.19.0 has `Parser::from_bytes(Vec<u8>)` (its docs mention WASM). `from_file`
  memory-maps the file.
- boon's unconditional dependencies include `memmap2`, `reqwest` (blocking, rustls), `tempfile`,
  `snap` and `sha2`. The parse path doesn't need reqwest or tempfile, but they are compiled in.
  Whether they build for `wasm32-unknown-unknown` is untested.
- No rayon or threads were found in boon's parser.
- `crates/replay/src/parse.rs` takes a `&Path` and opens the parser twice (`header`, then
  `observe`). A from-bytes entry point means refactoring both to share one buffer.
- bzip2 and zstd are only in `worker.rs` (decompressing downloads). A user's own `.dem` from the
  game folder is already uncompressed, so a browser parse needs neither.
- boon reads the demo as one `&[u8]`, so a 504 MB demo means a 504 MB+ buffer in wasm memory. It
  can't stream from `File.slice` without changes upstream. That is likely out of reach for
  phones, and plausible on desktops (wasm32 memory limit 4 GB).
- Not measured: build success, parse time (native is ~5.3 s), peak memory, timeline size.

**deadlock-api `/v1/matches/demo/query`: not tried.** It is asynchronous (returns a job id;
poll `/demo/query/{job_id}`; the result is a public Parquet or NDJSON.zst URL), takes ~13 s and
up to a minute, and is limited to 200/h per IP (400 with a key, 1200/h global). Identical queries
are deduplicated. Its schema (`/demo/schema`, 5.3 MB, 931 entity and 67 event tables) does carry
the inputs we derive from:
- `CCitadelPlayerPawn` (`CBodyComponent__m_cell*/m_vec*`, `m_iHealth`, `m_lifeState`, `m_nHeroID`)
- `CNPC_Trooper` (`m_iLane`)
- `CCitadelZipLineNode` (`m_iTeamNum`, `m_iPrimaryLane`)
- `CCitadelGameRulesProxy` (paused ticks, game start, mode, neutral camp timers, KotH fields)
- the objective classes
- `CCitadel_PickupItemSpawner`
- `ImportantAbilityUsedEvent`

It would probably take one query for each table (about 10 to 14 for each match), and it is
unknown whether each one costs them a full parse. With 1200/h global and deadlock-api at
capacity, leaning on their compute is likely unwelcome. Not measured: the row volume at
1 s resolution, result sizes, and the real latency.

**Salt ingest (`POST /v1/matches/salts`):** a browser holding salts from the user's own client
could contribute them back (100/s per IP). Not a priority.
