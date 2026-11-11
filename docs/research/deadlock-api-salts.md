# How and when deadlock-api gets a match's replay salt (research, 2026-11-09)

Question (operator): how, precisely, and when does a Deadlock match's `replay_salt` become
available at deadlock-api? mapcro builds Valve's replay URL from it
(`http://replay{cluster}.valve.net/1422450/{id}_{replay_salt}.dem.bz2`). Follows
[browser-side-replays.md](browser-side-replays.md) "Step 0 result": fresh standard matches get a
salts row with `cluster_id` and `metadata_salt` within seconds of ending, but no `replay_salt`,
and neither free nor Steam-capable reads filled it in over 1.5 h.

Part 1 is from deadlock-api's own sources. Part 2 is a 36 h probe now running; its results go in
"Results" at the end.

## Sources

Read 2026-11-09. Paths below are relative to these checkouts:

- **API server and workers:** [deadlock-api/deadlock-api](https://github.com/deadlock-api/deadlock-api)
  at `387266427bd2` (2026-11-08). Links below use `DA/` for
  `https://github.com/deadlock-api/deadlock-api/blob/387266427bd206798affc31884586f374af9345f/`.
- **Ingest tool:** [deadlock-api/deadlock-api-ingest](https://github.com/deadlock-api/deadlock-api-ingest)
  at `d0b3a416ba26` (2026-11-06). `DI/` below.
- **Older CLI ingester:** [deadlock-api/public-ingest](https://github.com/deadlock-api/public-ingest)
  at `1c2268c08cbf`.
- **OpenAPI:** `https://api.deadlock-api.com/openapi.json`, snapshot cached at `/tmp/dlapi-openapi.json`.
  It is generated from the route doc comments in `DA/api/src/routes/`, so it says the same things.
- **Probe:** a few header and field-presence reads of known matches (no Steam-capable reads by hand).

## Part 1: findings

### Where a salts row comes from

Everything is in one ClickHouse table, `match_salts` (`DA/db/clickhouse/default/match_salts.sql`):

```sql
match_id UInt64, cluster_id Nullable(UInt32), metadata_salt Nullable(UInt32),
replay_salt Nullable(UInt32), created_at DateTime DEFAULT now(), username Nullable(String),
verified_at Nullable(DateTime), failed_at Nullable(DateTime)
ENGINE = CoalescingMergeTree ORDER BY (match_id, cluster_id, metadata_salt)
```

A row has four possible writers. `username` tells them apart.

| Writer | `username` | What it writes | Source |
|---|---|---|---|
| `GET /v1/matches/{id}/salts` Steam fallback | `api-fetch:<bot>` | the GC's `GetMatchMetaData` reply: `replay_group_id` becomes `cluster_id`, plus `metadata_salt` and `replay_salt` | `DA/api/src/routes/v1/matches/salts.rs` `fetch_match_salts` |
| salt-scraper worker | `salt-scraper:<bot>` | the same GC reply, for matches of "prioritized" accounts only | `DA/workers/salt-scraper/src/main.rs` |
| `POST /v1/matches/salts` (community ingest) | uploader-chosen, or the User-Agent; the ingest tool sends `ingest-tool:<steam id3>` | whatever the uploader has: often only `cluster_id` + `metadata_salt` | `DA/api/src/routes/v1/matches/ingest_salts.rs` |
| matchdata-downloader | (re-inserts the key) | the verdict stamps `verified_at` / `failed_at`, after it downloads the `.meta.bz2` with those salts | `DA/workers/matchdata-downloader/src/main.rs` |

Every field of a Steam-sourced row comes from Valve's game coordinator (GC) reply
`CMsgClientToGcGetMatchMetaDataResponse`: `result`, `metadata_salt`, `replay_salt`,
`replay_group_id`, `replay_valid_through`, `replay_processing_through`. A community row carries
whatever the uploader found.

**Where the fresh rows without `replay_salt` most likely come from** (inference, consistent with
everything below): players running deadlock-api's ingest tool. When a match ends, each player's
client fetches that match's `.meta.bz2` from Valve, and the tool sees the URL in Steam's HTTP
cache and uploads `cluster_id` and `metadata_salt`. A `.dem.bz2` URL, carrying the replay salt,
is only in the cache after someone downloads the replay in game. `DI/src/utils.rs`
`Salts::from_url`:

```rust
if name.ends_with(".meta.bz2") { ... metadata_salt: salt_str.parse().ok(), replay_salt: None, ... }
else if name.ends_with(".dem.bz2") { ... replay_salt: salt_str.parse().ok(), metadata_salt: None, ... }
```

The salt-scraper comment gives the rate: "community uploads (~35% of prio matches within 15
minutes)" (`DA/workers/salt-scraper/src/main.rs`, `MIN_MINUTES_SINCE_END`). That matches "a row
within seconds" for top-200 matches, which are the busiest and most watched.

### When the backend asks the GC, and whether a row stops it

**A stored row always wins: the Steam path is never reached for a match with a row.** In
`fetch_match_salts`, the very first step returns whatever ClickHouse has, `replay_salt` or not:

```rust
// Try fetch from Clickhouse via batcher
if let Ok(salts) = state.batchers.match_salts_read.load(match_id).await {
    debug!("Match salts found in Clickhouse");
    return Ok(salts.into());
}
```

So a Steam-capable read of a match with a metadata-only row is the same as a free read and should
cost nothing. That matches Step 0. Then, only for matches with no row:

1. `disable_steam=true`, or the `STEAM_SALTS_FALLBACK` feature flag off: 404 "Match salts not
   found in Clickhouse and Steam fallback is disabled". **Side effect:** if the match has no
   `match_player` rows, `queue_requested_match` puts it on the `/v1/matches/to-fetch` queue that
   ingest-tool users' GC passes work through.
2. The match has `match_player` rows (metadata already ingested): **400** "Match salts for match
   {id} won't be fetched, as it has metadata already". This check runs before the rate limiter,
   so it spends nothing. The HLTV scraper fills `match_player` for spectated matches
   (`matchdata-downloader` comment: "the HLTV scraper fills it too"), and metadata is served from
   `.meta_hltv.bz2` (`metadata.rs` `fetch_salt_or_hltv`). Top-200 `/active` matches are probably
   in that set.
3. Otherwise the rate limit (3/h per IP, 300/h per key, 1500/h global), then one GC
   `GetMatchMetaData` through a bot, with a 2 s timeout and a 24 h / 50 cooldown per bot.
   `KEResultInvalidMatch` gives 404 and marks the match invalid. Success with `cluster_id` and a
   non-zero `metadata_salt` is written as `api-fetch:` and returned.

The read is cached in-process for 60 s per match id (`#[cached(ttl_secs = 60, convert = "{ match_id }")]`),
whatever the `disable_steam` flag. Cloudflare sits in front: salts that aren't "settled" (proven,
with all three fields) get `cache-control: public, max-age=120, stale-while-revalidate=120`, and
settled ones `max-age=604800`. Our reads saw `cf-cache-status` HIT, EXPIRED and UPDATING, so a read
can be up to about 4 minutes stale.

**The read query merges by `(match_id, cluster_id, metadata_salt)` and drops rows without
`metadata_salt > 0 AND cluster_id > 0`**, taking `max(replay_salt)` within a group
(`MatchSaltsReadQuery`). Inference, unverified: a `.dem.bz2`-only upload (replay salt, null
`metadata_salt`) is a different group and is filtered out. A replay salt then only shows when an
upload carries it with the same `cluster_id` and `metadata_salt`, as GC replies and the ingest
tool's memory reader do.

**The salt-scraper skips covered matches too.** Its candidate query anti-joins on matches whose
`match_salts` has any `(cluster_id, metadata_salt)` not yet written off, or any `salt-scraper:` /
`api-fetch:` row:

```sql
HAVING uniqExact((cluster_id, metadata_salt))
     > uniqExactIf((cluster_id, metadata_salt), failed_at IS NOT NULL)
    OR countIf(username LIKE 'salt-scraper:%' OR username LIKE 'api-fetch:%') > 0
```

It also skips matches with `match_player` rows, and only covers prioritized accounts. Also,
`pending_matches_from_salts_mv` marks any salts insert `done`, which takes the match off the
to-fetch queue. **Net effect: once a community upload with only a metadata salt lands, none of
deadlock-api's GC paths will ask for that match's replay salt.** Only a later upload that carries
it can fill it.

### Is the replay salt only available once a replay exists or is requested?

From the sources, **no: the GC gives it out right after the match**, and replays look recorded
for every match, not made on demand:

- `DA/workers/salt-scraper/src/main.rs`: "The GC hands out replay salts within a minute of the
  end; the wait only gives community uploads ... the chance to spare a bot call."
- `DI/src/game_memory/mod.rs`: "A reply's `replay_valid_through` is the match's start plus three
  weeks, and its `replay_processing_through` the match's end plus twenty minutes." So the GC
  reply itself says the replay is processed for up to 20 minutes after the end and kept 3 weeks.
  That fits Valve's ~3-week retention.
- `DI/src/game_memory/scan.rs` only accepts replies with all six fields set (has-bits `0x3f`).
  `Salts::from_metadata_reply` drops a salt of 0, which suggests a 0 can occur. When it does is
  not documented.
- The salts endpoint says: "We currently fetch many matches without salts, so for these matches we
  do not have salts stored."

None of the sources says whether the CDN serves the `.dem.bz2` before `replay_processing_through`.
The probe's HEAD checks answer that only once a salt shows up. Nothing in the sources says replays
are generated on demand.

### How the ingest tool gets salts from players' machines

`DI/README.md` and the code describe three sources. Each sends `{match_id, cluster_id,
metadata_salt, replay_salt, username: "ingest-tool:<account id3>"}` to `POST /v1/matches/salts`:

1. **Steam's HTTP cache** (`Steam/appcache/httpcache/`): "scans ... for Deadlock replay URLs
   (`.meta.bz2` and `.dem.bz2` files)" (`DI/src/scan_cache.rs`, `utils.rs` `from_url`). A
   `.meta.bz2` URL gives `cluster_id` + `metadata_salt`, and a `.dem.bz2` URL gives `cluster_id` +
   `replay_salt`.
2. **The game's memory, read-only, while Deadlock runs** (`DI/src/game_memory/`): finds
   `GetMatchMetaData` replies left on the heap. They name no match, so it uses the reply's
   `replay_valid_through` (start + 3 weeks) to find the matching history record. It also finds
   replay URLs. These replies carry both salts.
3. **Its own GC requests while Deadlock is closed** (`DI/src/gc/`), every 30 minutes, with the
   saved Steam session of each "remember me" account on the PC: friends' new matches first, then
   matches from `GET /v1/matches/to-fetch`. "Each account makes at most 40 metadata requests and
   20 friend match-history requests a day." This is the same GC call as `api-fetch:`, so it gets
   the replay salt.

The deadlock-api website also has a browser "cache upload" (`DA/website/src/lib/ingest-cache-scanner.ts`)
that scans an uploaded Steam cache for the same URLs. The older `public-ingest` CLI logs into Steam
with a username and password and posts GC replies for given match ids.

`POST /v1/matches/salts` accepts an upload only if it adds something: a metadata salt when none is
verified, or a replay salt when none is stored ("not failed"). Usernames `api-fetch:` and
`salt-scraper:` are reserved. "Replay salts are never exercised by the downloader" (`salts.rs`
`MatchSaltsExistsQuery`): **nobody checks that an uploaded replay salt is right.** That is why the
probe HEADs the CDN.

### Other endpoints that trigger or reveal a fetch

- `GET /v1/matches/{id}/metadata` without `disable_steam` goes through the same `fetch_match_salts`
  (same 3/h budget and rules) when S3 has neither `{id}.meta.bz2` nor `{id}.meta_hltv.bz2`.
- `GET /v1/matches/demo/schema?match_id=` and `POST /v1/matches/demo/query`: "if we don't already
  have its salts, they are fetched from Steam (rate limited, see `/{match_id}/salts`)". A demo
  query needs the replay, so it can only work when a `replay_salt` is stored.
- `GET /v1/matches/to-fetch` (not in the public OpenAPI; `DA/api/src/routes/v1/matches/to_fetch.rs`):
  the queue the ingest tool's GC passes take match ids from. A `disable_steam` 404 on a match
  without metadata adds to it.
- `GET /v1/matches/recently-fetched`: matches fetched in the last 10 minutes, with account ids. We
  don't use it.
- `GET /v1/matches/{id}/live/url` and `/demo/live/query`: live broadcast (HLTV), not the replay.

### What this means for mapcro (preliminary)

- For a fresh top-200 match, deadlock-api's own Steam path is closed twice over: by the
  community metadata-only row, and probably by HLTV `match_player` rows. Spending our 3/h on it
  buys nothing. The probe's Steam-capable reads test this.
- A replay salt appears only if some player's client produced it: by downloading the replay
  (cache URL), or through a `GetMatchMetaData` reply the ingest tool read from memory or asked for
  itself. That happens late or never for most matches.
- A companion that makes one GC `GetMatchMetaData` call per match (as `public-ingest` and the
  ingest tool's GC pass do) would get the replay salt within about a minute of the end. Doing
  that needs a logged-in Steam session, which raises account and terms questions that are out of
  scope here.

## Part 2: the probe

Script: [salt-study/probe.py](salt-study/probe.py), with [salt-study/summarise.py](salt-study/summarise.py).
Running copy and data: `/tmp/salt-study/` (`obs.jsonl`, `state.json` for restarts, `probe.log`
for stderr). Python stdlib only; every request goes through curl with its default User-Agent.

Launched 2026-11-09 00:22 UTC as a transient user unit:

```sh
systemd-run --user --unit mapcro-salt-study --property=RuntimeMaxSec=40h \
  --property=Restart=on-failure --property=RestartSec=60 --nice=19 \
  --setenv=PATH=/run/current-system/sw/bin \
  --property=StandardError=append:/tmp/salt-study/probe.log \
  /run/current-system/sw/bin/python3 -I /tmp/salt-study/probe.py /tmp/salt-study
```

The script stops itself after 38 h. Check it with `systemctl --user status mapcro-salt-study`,
stop it with `systemctl --user stop mapcro-salt-study`.

### Design

- **Sampling:** `GET /v1/matches/active` every 5 min. Each match is cut down in memory to
  `(match_id, game_mode, match_mode, start_time)`, so players and every other field are dropped
  before anything is written. Up to 40 matches with `game_mode == 1` (Normal, 6v6) and
  `match_mode` Unranked or Ranked are admitted, newest first, at most 2 per poll. Street Brawl
  (`game_mode == 4`) is skipped. A tracked match missing from a poll is "ended" at its last-seen
  time (5 min resolution, plus Cloudflare's 2 to 4 min staleness). If it comes back, that is
  logged and the end is cleared.
- **Free reads**, at +1 m, 5 m, 15 m, 30 m, 1 h, 2 h, 4 h, 8 h, 16 h and 32 h after the end:
  `salts?disable_steam=true` and `metadata?disable_steam=true`. Each logs the HTTP status, a reason
  code for errors, whether `cluster_id`, `metadata_salt` and `replay_salt` are present (never the
  values), `cluster_id`, and `cf-cache-status`/`age`. For metadata it logs only the status and
  byte size.
- **Steam-capable reads** (no flag): at most 2 in any rolling hour and at least 25 min apart. Each
  goes on a different tracked match without a replay salt, at a target age of 10 m, 1 h, 2 h, 6 h,
  12 h or 24 h (3 matches per age), and never within 90 s of that match's last read (the API's
  60 s cache). They stop for good after any 429. Expected from the code: identical to the free
  read (the stored row wins).
- **Replay salt seen:** a HEAD request to the Valve CDN URL, built in memory and then dropped.
  It logs the status and `content-length` only. It runs on every read where the salt is present.
- **Controls:**
  - `control_with`: 129738985, 130816395 and 132777205, which had a replay salt on 2026-11-08.
  - `control_without`: the Step 0 matches 133942291, 133942783 and 133944663, plus 133149705.
  - Both groups are read every 4 h, with a HEAD when a salt is present.
- **No-row control:** every 20 min, up to 40 tries, a random id 30k–400k below the newest
  `/active` id is read with `disable_steam=true`, until one gives 404 `not_in_db`. That match gets
  one Steam-capable read, then the free-read schedule from that moment. After 30 min its metadata
  is read once and only `match_info.game_mode` is kept, to tell whether it was a standard match.
  The first try found one (133736539). Its mode is unknown until that read.
- **Politeness:** at least 2 s between deadlock-api requests. Any 429, 5xx or network failure
  pauses all calls for max(`Retry-After`, a back-off doubling from 60 s to 30 min). Expected total
  is about 1,300 deadlock-api calls over 36 h: about 430 `/active`, 800 free, a few dozen controls
  and searches, and at most about 20 Steam-capable. HEADs go to Valve, not deadlock-api.

### Record kinds in `obs.jsonl`

Every line has `t` (unix), `iso` and `kind`.

- `start` / `stop`
- `active` (`n`, `standard`, `admitted`, `tracked`)
- `admit` (`match`, `game_mode`, `match_mode`, `started_ago_s`)
- `ended` (`live_s`)
- `reappeared`
- `free`, or `steam` for Steam-capable reads (`match`, `cat` = fresh / control_with /
  control_without / norow, `label`, `age_s`, `salts_status`, `reason`, `has_cluster`,
  `has_metadata_salt`, `has_replay_salt`, `cluster_id`, `cf`, `cf_age`, `meta_status`,
  `meta_size`, `cdn_head`, `cdn_length`)
- `steam_stopped`
- `norow_try` / `norow_found` / `norow_mode`
- `backoff` (`status`, `retry_after`, `pause_s`)
- `error`

### Reading the output

```sh
python3 -I /tmp/salt-study/summarise.py            # or pass another obs.jsonl
```

It prints:

- per nominal age, the reads, the share of salts 200s with a `replay_salt`, the metadata 200 share,
  and the CDN HEAD 200 share among the reads with a salt;
- the first age at which each match showed a replay salt;
- every Steam-capable read;
- each control's read sequence (`status/R` means a replay salt was present, `/H200` the HEAD
  status);
- the no-row search, and the back-offs and errors.

Interpretation:

- **Replay share stays near 0 across all ages:** the replay salt only comes from player uploads,
  and most fresh matches never get one.
- **It rises with age:** players downloading replays (or ingest-tool GC passes) fill it, and the
  curve gives the delay.
- **A HEAD 404 on a present salt:** an uploaded salt was wrong.
- **The no-row Steam read returns a replay salt:** the GC hands it out when asked, and only the
  covering community row prevents it for fresh matches.

## Results

Run: 2026-11-09 08:41 to 2026-11-10 22:41 UTC (38.0 h, 1,432 deadlock-api calls; data in
`~/.local/share/mapcro/salt-study/`, summary from `summarise.py`). 40 fresh standard matches were
admitted and all 40 ended. No 429s and no back-offs.

**Early result (2026-11-09 00:23 UTC):** the no-row control 133736539 (404 `not_in_db` on a free
read) got one Steam-capable read, which returned 200 with `cluster_id`, `metadata_salt` *and*
`replay_salt`. The CDN HEAD for that salt was 200 (35.5 MB). So when deadlock-api has no row, its
GC path does create one with a working replay salt, for a match some days old (judging by its id). Its
game mode isn't known yet (the `norow_mode` read comes 30 min later).

- **Replay-salt share by age** (free reads, fresh standard matches, 40 per age):

  | age | salts 200 | has `replay_salt` | metadata 200 |
  | --- | --- | --- | --- |
  | 1 m | 23 | 2 (5% of 40) | 23 |
  | 5 m | 23 | 2 | 23 |
  | 15 m | 25 | 2 | 25 |
  | 30 m | 26 | 4 | 26 |
  | 1 h | 29 | 4 (10%) | 29 |
  | 2 h | 40 | 17 (42%) | 40 |
  | 4 h / 8 h / 16 h | 40 | 18 (45%) | 40 |
  | 32 h | 40 | 19 (48%) | 40 |

  Every non-200 was 404 `not_in_db` (74 reads, all in the first hour). By 2 h every match had a
  row, with `metadata_salt`, but more than half never got a `replay_salt` within 32 h.
- **First-appearance ages** (19 matches): 2 at 5–6 min, 2 at 30 min, 13 at exactly 120–121 min,
  1 at 4 h, 1 at 32 h. The sharp 2 h cluster points to a scheduled deadlock-api/ingest pass
  around two hours after the end, not to players' downloads arriving at random.
- **Steam-capable outcomes** (18 reads, 10 min to 24 h after the end): every one returned the
  stored row. 17 had `metadata_salt` but no `replay_salt`; the only one with a replay salt
  (134235210 at 24 h) already had it from the free reads. The read on the no-row match failed
  (404 `steam_failed`). So paying our 3/h Steam-capable budget on a fresh match never produced a
  replay salt that the free read lacked, as Part 1 predicted.
- **CDN HEAD outcomes:** 200 on every read with a replay salt (fresh, controls, no-row). No
  uploaded salt was wrong.
- **Controls:** the three `control_with` matches had a replay salt and HEAD 200 on all 10 reads;
  the four `control_without` matches stayed 200 with no replay salt on all 10. Rows don't gain or
  lose a replay salt after the first days.
- **No-row control:** the first try found 134157415 (404 `not_in_db`). Its Steam-capable read
  at 1 min failed with `steam_failed`. Free reads stayed 404 to 15 min; at 30 min a row appeared
  with a working replay salt (CDN HEAD 200, 35.5 MB) and stayed. Its mode read gave `game_mode 4`
  (Street Brawl), so it is evidence about the API only, not match data. With the early result
  (133736539: a Steam read created a full row), the GC path can create a replay salt when there
  is no row, but doesn't reliably do so.
- **Conclusions:**
  1. For a fresh standard match, a free read (`disable_steam=true`) is as good as a
     Steam-capable one: spend none of the 3/h budget on fresh matches.
  2. About 10% of matches are fetchable within an hour, about 42% at 2 h, and the share
     plateaus near 45–48%. Retry the free read around +2 h (and once more later) rather than
     polling; after a day, a match without a replay salt very likely never gets one.
  3. For the other half, upload is the only path, which keeps the upload UX the main route for
     fresh matches (deadlock-api declined us an API key on 2026-11-08).
  4. Uploaded salts have been correct every time (no HEAD failures), so a present salt can be
     trusted without a pre-check.
