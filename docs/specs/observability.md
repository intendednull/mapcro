# Observability: knowing when it breaks, how fast it is, and how close we are to limits

Status: build-order steps 1, 2 and 4 are built (2026-11-08; journal
[2026-11-08-observability](../journal/2026-11-08-observability.md)): the collector, `/metrics`,
the minute snapshots and failures log, the worker's per-job record, and `mapcro-server stats`.
The browser beacons (§3) and alerts (§6) are not. Operator decisions, 2026-11-08: no web view;
7 days of minutes and 400 days of hours; feature counts yes; alerts deferred, channel open.

## Why

Today:
- **Health:** `/healthz` reports whether storage answers and how many rooms are open.
- **Logs:** journald holds plain event lines (room opened, match imported, replay fetched or failed).
- **Resource use:** systemd's per-unit totals reset on every deploy.
- **Browser failures:** nothing is reported. A crash in the browser, a wasm panic or a failed sync never reaches us.

We can't answer "did anything break this week", "how long does a full replay take to arrive", or
"how close are we to deadlock-api's limits or our disk".

This spec lists the questions first and then the data that answers them. It has four parts: a
collector inside the server, a command-line way for the lead to query it, alerts, and the privacy rules.

## 1. The questions

### A. Is it working? (failures and bugs)

1. **Server failures:** Did any request fail on our side (5xx), on which route, and how often?
2. **Browser failures:** Are browsers hitting errors? This covers uncaught exceptions, unhandled
   promise rejections, wasm panics and render errors. Which build, and how often?
3. **Sync health:** How often are ops rejected, connections dropped (by close reason), or clients
   reloaded for an outdated build? How long do reconnects take?
4. **Replay jobs:** How many jobs fail, at which step (fetch, download, decompress, parse, publish)
   and for which reason (`no_replay`, `expired`, `parse_failed`, `timeout`, `not_a_replay`,
   `old_map`, `brawl`…)? A failure rate that jumps after a deploy or a game patch is the signal.
5. **The worker:** Does it crash, time out, or get OOM-killed by its cgroup?
6. **deadlock-api:** How do its calls end, by endpoint and status (200, 404, 429, 5xx, timeout)?
   How long have we spent in backoff?
7. **Silent breakage:** Are there matches that open but show nothing? For example a timeline with
   no players, or a replay timeline missing layers its format should have.

### B. How fast is it? (performance)

1. **Board open:** time from page load to the board drawn and editable. This covers the WebSocket
   connect, then the base frame, then the first render.
2. **Edit latency:** time from an op sent to its ack (durable). On the server, the group-commit
   batch size and fsync time.
3. **Opening a match by id, end to end** (the operator's question). Two times are measured:
   - **To usable:** from Open match (or Load) to the API summary playing.
   - **To full:** from Open match to "Full replay" shown. It is split by path:
     - Already cached: should be about a second.
     - Auto-fetched from Valve: the salt lookup, then the queue wait, the download, decompress,
       parse and publish, then the client noticing.
     - Uploaded by the user: picking the file, the upload, then the queue wait, parse and publish.
4. **Per parse:** queue wait, download time and throughput, decompress time, parse time, peak
   memory and demo size. Do they trend up as matches or game patches change?
5. **The queue:** how long it is, how long people wait, and how often the "~N min" estimate is
   off by more than 2×.

### C. How much is it used?

1. **People:** distinct users per day, week and month. These are counts only (see §5).
2. **Peaks:** the most people connected at once, and the most boards open at once.
3. **Boards:** boards created, opened and edited per day; boards active in the last 7 or 30 days.
4. **Matches:** matches opened by tier (API summary vs full replay) and by path (cached, fetched,
   uploaded), and scenes saved from Player.
5. **Features:** which features get used: Player, follow, laser, comments, the Names toggle, the
   events list and its filters.
6. **The replay prompt:** what people choose there: Try again, Upload, or Use API summary.

### D. How close are we to limits?

1. **deadlock-api:** calls per hour by endpoint and tier, and time spent rate-limited. The tiers
   are stored data (100 per second) and Steam lookups (3 per hour per IP).
2. **The queue:** refusals (`busy`, `queue_full`, `rate_limited`), waiting places against
   `maxWaiting`, and queue bytes against the 8 GiB budget.
3. **Memory:** the server against its 256M and the worker against its 768M. OOM events.
4. **Disk and storage:** free disk, database size against `max_storage_bytes`, and boards against
   `max_boards`. Also the replay cache size and how fast it grows.
5. **CPU:** CPU use by each service.

### E. Where do people struggle? (UX signals)

- **Uploads:** uploads cancelled; the file refused for not being a replay; "Where's my replay?"
  opened.
- **The replay prompt:** how often it is shown, and for which reason.
- **Opening a match:** "Match not found yet" seen, and the user trying again later (whether it
  worked the second time).

## 2. What we record

**Counters** (totals since start, labelled by a small fixed set of values):
- `http_requests{route, status_class}`
- `ws_closes{reason}`
- `ops_rejected{reason}`
- `outdated_reloads`
- `boards_created`
- `matches_opened{tier, path}`
- `replay_jobs{source, outcome}`, where outcome is `done` or one of the reason codes
- `deadlock_api_calls{endpoint, result}`
- `queue_refusals{reason}`
- `client_errors{kind, build}`
- `prompt_choice{choice, reason}`
- `feature_used{feature}`, counted once per session per feature

**Gauges** (current value, sampled):
- `rooms_open`, `connections_open`
- `queue_waiting`, `queue_bytes`, `parses_running`
- `db_bytes`, `cache_bytes`, `disk_free_bytes`
- `server_memory_bytes`, `worker_memory_bytes` (read from the units' cgroups,
  `/sys/fs/cgroup/system.slice/<unit>/memory.current` and `memory.peak`)
- `deadlock_api_backoff_s`

**Durations** (histograms with fixed buckets; each one also keeps its count, sum and p50/p90/p99
per window):
- `op_ack_ms`, `commit_batch_ms`
- `board_open_ms` (from the client)
- `match_to_usable_ms{path}`, `match_to_full_ms{path}` (from the client, see §3)
- `queue_wait_s`
- `download_s`, `decompress_s`, `parse_s`
- `upload_s`, `upload_mb_per_s`

**Per-job record:** the worker already writes a result file per job. It also writes the job's
phase times, peak RSS (`getrusage`), demo size and timeline size. The server reads these when it
collects the result. No match-level data is kept beyond the aggregate.

**Recent failures log:** the last 1,000 failures, or 30 days, whichever is smaller. Each row is
time, kind, code, build and a short message with no ids, for example
`replay parse_failed after 4.1 s`. This answers "what broke" without opening the journal.

## 3. What the browser sends

The browser is where most failures and the "time to full replay" happen, so it reports two kinds
of beacon to our own server only:

- **Errors:** `POST /api/telemetry/error` with `{build, kind, message, frames}`.
  - `kind` is one of `exception`, `rejection`, `wasm_panic`, `render` or `sync`.
  - `message` is truncated to 300 characters.
  - `frames` holds the top 5 stack frames, with file paths reduced to bundle file names.
  - Before sending, the browser strips anything that looks like an id, token or URL fragment.
  - A tab sends at most a few a minute. The same error from one tab is sent once, with a count.
- **Timings and choices:** `POST /api/telemetry/event` with `{name, ms?, path?, choice?}`.
  - `name` comes from a fixed list: `board_open`, `match_to_usable`, `match_to_full`,
    `prompt_choice` and `feature_used`.
  - The server drops names it doesn't know.

Neither beacon carries a board id, match id, link token, name or IP. The server counts them by
client key only for rate limiting, in memory, as it already does for the queue.

`match_to_full` starts when Open match or Load is pressed and ends when the tier chip first reads
"Full replay". If the user leaves or closes the tab first, it is reported as `abandoned` with the
step reached (waiting for slot, uploading, queued or parsing).

## 4. Where it lives and who sees it

- **Collector:** in-process, using the `metrics` crate with a Prometheus exporter, or a small
  hand-rolled registry if that's leaner. Every 60 s the server writes a snapshot to its SQLite
  database:
  - minute rows are kept for 7 days
  - hourly rollups are kept for 400 days
  - the size stays at a few MB a year
- **`/metrics`:** Prometheus text format, served only on a separate loopback port that Caddy never
  proxies. Shared monitoring on `web` can use it later (an infra decision, via the concierge).
- **No web page for now (operator, 2026-11-08).** The lead agent is the main reader and uses the
  data to steer development, so access is built for an agent first. A human view can come later
  on top of the same queries.
- **`mapcro-server stats`:** a read-only subcommand that queries the metrics tables in the
  server's database. It is run on `web` over the existing deploy SSH as
  `sudo -u mapcro mapcro-server stats …`, or locally against a dev database. Each query prints
  a short text summary by default and full data with `--json`:
  - `stats summary [--since 24h]`: health first (errors and failures by kind, worker incidents,
    deadlock-api trouble), then usage and the slowest funnels, each compared with the previous
    period.
  - `stats failures [--since 7d] [--kind …]`: the recent-failures log, grouped, with counts and
    the first and last time seen.
  - `stats funnel [--path cached|fetched|uploaded]`: time to usable and time to full, as
    p50/p90/p99 per day, with abandons by step.
  - `stats limits`: each resource against its cap now, plus its peak and trend (the queue, disk,
    database, memory, deadlock-api).
  - `stats usage [--by day|week]`: people, boards, matches by tier and path, and feature use.
  - `stats series <metric> [--since …]`: the raw series of one metric.
- **A `just stats …` recipe** wraps the SSH call, so it is one command from the dev box.
- **The lead's routine:** check `stats summary` after every deploy and at the start of a session.
  Read `stats failures` before triaging bugs. Use the numbers when choosing work: what's breaking
  most, what's slowest, and what's nearest a limit.
- **The worker** stays sandboxed (PrivateNetwork). It reports only through its result files.

## 5. Privacy

- **Counts and durations only.** No IP addresses, board ids, match ids, link tokens, names, Steam
  or account ids are stored in metrics or the failures log. Labels come from fixed lists, so no
  free text becomes a label.
- **Distinct users** are counted with a daily salted hash of the client key. Both are held in
  memory and only the day's count is written; the salt is thrown away at midnight. So we know
  "41 people today" but can never link days or people.
- **What gets recorded is written up in the repo.** The browser beacons go only to our own
  server, never to a third party.

## 6. Alerts: knowing without looking

A dashboard only helps when someone looks. The server checks a few rules every minute and sends
a message when one trips:
- `/healthz` failing, or the worker down
- 5xx or client errors above a baseline, for example 5× the 7-day rate for 10 minutes
- replay job failures above 30% over the last 20 jobs
- the worker OOM-killed or timing out repeatedly
- deadlock-api backoff lasting more than 30 minutes
- disk under 15% free, the database over 80% of its cap, or memory at 90% of a unit's max

Each rule sends one alert when it trips and one when it recovers, at most hourly. There is also a
daily digest with usage, the slowest funnels and new failure kinds. The delivery channel is an
open question (§8). Its webhook or token lives in a root-only file and moves by path.

## 7. Build order

1. **Server collector, `/metrics`, minute snapshots and the recent-failures log**, with the
   counters, gauges and durations already reachable in the server: HTTP, WebSocket, ops, the
   queue, jobs, deadlock-api and cgroup memory.
2. **The worker's per-job record** (phase times and peak RSS).
3. **Browser beacons:** errors first, then the match funnel timings and the prompt choices.
4. **`mapcro-server stats` and `just stats`.** Build them alongside step 1, so each step's data
   can be read as soon as it lands.
5. **Alerts and the daily digest**, once the channel is decided.

Each step comes with tests. Counters and buckets get unit tests. An e2e run checks that a forced
browser error and an opened match produce the right counts. A VM test checks that `/metrics`
can't be reached through Caddy.

## 7a. As built

- **Code.** `crates/server/src/metrics/`: `mod.rs` (the registry's types, Prometheus text,
  quantiles), `catalog.rs` (every metric and label), `snapshot.rs` (minute rows),
  `db.rs` (tables, rollup, retention), `failures.rs`, `users.rs`, `sample.rs` (sampled gauges).
  `crates/server/src/stats.rs` is the subcommand.
- **Collector.** Hand-rolled, not the `metrics` crate: every label is a Rust enum, the snapshot
  reads every value back each minute, and it adds no dependencies (journal).
- **Tables** (schema v6): `metric_rows (res, t, name, labels, kind, value, sum, n, max, buckets)`
  with one row per metric cell per window. A counter's row holds the window's delta. A gauge's
  holds its mean, its peak and the sample count. A histogram's holds its count, its sum and its
  non-empty buckets as `[lower, upper|null, n]`, so rollups merge exactly and quantiles come
  from the buckets. `failures (t, kind, code, build, message)`. `daily_users (day, users)`.
- **Windows.** A snapshot is written a second after each UTC minute ends, and once more at
  shutdown. A restart within a minute merges into that minute's row. Rows older than 7 days roll
  into hours whole. Hours older than 400 days are dropped, and so are failures past 30 days or
  the newest 1,000.
- **What's recorded now:**
  - HTTP: `http_requests{route, status_class}`, using axum's matched template mapped to the
    `Route` enum (an unknown template is `other`; the fallback is `page`).
  - Sync: `ws_opens`, `ws_closes{reason}` (the close reason, or `gone`), `outdated_reloads`,
    `ops_rejected{reason}`, `connections_open`, `rooms_open`, `commit_batch_size`,
    `commit_ms` and `op_ack_ms`. `op_ack_ms` runs from a room taking an edit to its ack, so the
    room's own queue isn't in it.
  - Usage: `boards_created{how}`, `matches_opened{tier, path}`, and `users_today`, the daily
    distinct count.
  - deadlock-api: `deadlock_api_calls{endpoint, result}` for `metadata`, `steam_profiles` and
    `salts`, and `deadlock_api_backoff_s`.
  - The replay queue: `queue_waiting`, `queue_bytes` and their caps, `parses_running`,
    `queue_refusals{reason}`, `replay_jobs{source, outcome}`, `replay_job_s{source}` (from the
    demo queued to its result collected), and `download_s`.
  - From the worker's record: `queue_wait_s`, `decompress_s`, `parse_s`, `publish_s`,
    `parse_peak_rss_bytes`, `demo_bytes` and `timeline_bytes`.
  - Storage and host: `db_bytes`, `boards_stored` and their caps, `cache_bytes{cache}`,
    `disk_free_bytes`, `disk_total_bytes`, and per unit `unit_memory_bytes`,
    `unit_memory_peak_bytes`, `unit_memory_max_bytes`, `unit_cpu_cores` and `unit_oom_kills`.
    They come from `/sys/fs/cgroup/system.slice/<unit>.service`. In development the server's
    own process stands in, and the worker reads as absent.
  - Failures: 5xx answers, room storage failures, compaction failures, deadlock-api trouble
    (not 404s), and replay jobs that end without a timeline.
- **The worker's record.** The child writes `work/<job>.stats` with its decompress and parse
  times, the demo and timeline sizes, and its `VmHWM`. `VmHWM` is the same number as
  `getrusage`'s `ru_maxrss`, read without unsafe code. The parent adds the queue wait and the
  publish time. It writes `outbox/<job>.stats` before the result, and the result is still
  published by copy. The server reads the record when it collects the result, accepts only
  sane numbers, and deletes it.
- **`/metrics`** is on `METRICS_ADDR` (the module's default is `127.0.0.1:9464`). The server
  refuses an address that isn't loopback or is the public port. A bind failure only logs.
- **On the host:** `sudo -u mapcro mapcro-stats summary` (the module's wrapper), or
  `just stats summary` from the dev box. `just stats local summary` reads the dev database.
- **Users** are counted when a WebSocket opens. A restart starts the day's set again, so the
  stored count is the higher of before and after, which can undercount. A week's people is its
  busiest day's, because days can't be linked.
- **`funnel`** shows the server's job times by source and outcomes per day until the beacons
  land. It already reads `match_to_usable_ms{path}` and `match_to_full_ms{path}` when they do.

## Adding a metric

For whoever instruments the next call site:

1. **Pick the kind.**
   - A counter counts events (`inc`, `add`).
   - A gauge is a value now (`set`, `add`). Its peak within each minute is kept.
   - A histogram is a duration or a size (`observe`, `observe_ms`), in one of the bucket sets in
     `catalog.rs` (`MS`, `SECS`, `BATCH`, `RSS`, `FILE`).
2. **Labels come from an enum**, never from a string the code was handed. If none of
   `catalog.rs`'s fits, declare one with `label!`. Its values are short snake_case words, and
   the `label_enums_are_plain_and_distinct` test must list it. Never make a label from a board
   id, match id, token, name, address, path or free text. Keep the label set small: each value
   combination is a row a minute.
3. **Add one line to `registry!`** in `catalog.rs`: the field, its type and its constructor.
   For example:
   `prompt_choices: Counter<(Choice, PromptReason)> = Counter::new("prompt_choices", "…"),`.
   The macro adds it to `/metrics` and to the snapshot, so it can't be forgotten in either.
4. **Record it at the call site:** `crate::metrics::get().prompt_choices.inc((choice, reason));`.
   A metric with one label takes a 1-tuple: `.inc((reason,))`. A metric with none takes `()`.
5. **A failure worth reading later** also goes in the log:
   `crate::metrics::failures::record(FailureKind::…, code.as_str(), &format!("…"))`. The code
   is an enum's `as_str`. The message is built from fixed words and numbers; it is sanitised
   anyway.
6. **Don't change a histogram's buckets or a metric's meaning under its name.** Rows already
   written keep the old ones. Give it a new name instead.
7. **Test it.** Have a test check the call site bumps the right cell: scrape `/metrics`, or run
   `stats … --json` (see `crates/server/tests/observability.rs`).
8. **Show it.** If the lead should see it without asking, add it to `stats summary` or `usage`
   in `stats.rs`. `stats series <name>` shows any metric with no change.

## 8. Open questions for the operator

1. **Where alerts go:** email (to which address?), Discord or Slack webhook, ntfy, or through the
   concierge?
2. **Shared monitoring:** should `/metrics` also feed a Prometheus/Grafana on `web` for every app?
   This is an infra and concierge call; until then, `mapcro-server stats` is the way in. A human
   view is deferred (operator, 2026-11-08).
3. **Retention:** is 400 days of hourly rollups right?
4. **Feature usage counts (§1 C.5):** worth having, or more than we need?
