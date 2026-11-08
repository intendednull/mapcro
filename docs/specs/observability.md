# Observability: knowing when it breaks, how fast it is, and how close we are to limits

Status: draft for the operator (2026-11-08). Nothing here is built yet.

## Why

Today:
- **Health:** `/healthz` reports whether storage answers and how many rooms are open.
- **Logs:** journald holds plain event lines (room opened, match imported, replay fetched or failed).
- **Resource use:** systemd's per-unit totals reset on every deploy.
- **Browser failures:** nothing is reported. A crash in the browser, a wasm panic or a failed sync never reaches us.

We can't answer "did anything break this week", "how long does a full replay take to arrive", or
"how close are we to deadlock-api's limits or our disk".

This spec lists the questions first and then the data that answers them. It has four parts: a
collector inside the server, a private stats page, alerts, and the privacy rules.

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
- **Stats page:** `/stats`, private to the operator. It is reached with a secret token kept in a
  root-only file (`STATS_TOKEN_FILE`, via `LoadCredential`, as with the deadlock-api key file)
  and is never in the repo. It is one self-contained page with:
  - **Today:** at a glance, with errors first.
  - **Funnels:** time to usable and time to full, by path.
  - **Usage:** over time.
  - **Limits:** each resource as a bar against its cap.
  - **Recent failures:** the log from §2.
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
4. **The `/stats` page.**
5. **Alerts and the daily digest**, once the channel is decided.

Each step comes with tests. Counters and buckets get unit tests. An e2e run checks that a forced
browser error and an opened match produce the right counts. A VM test checks that `/metrics`
can't be reached through Caddy and that `/stats` refuses a request without the token.

## 8. Open questions for the operator

1. **Where alerts go:** email (to which address?), Discord or Slack webhook, ntfy, or through the
   concierge?
2. **Shared monitoring:** should `/metrics` also feed a Prometheus/Grafana on `web` for every app,
   or is mapcro's own `/stats` page enough for now? This is an infra and concierge call.
3. **Retention:** is 400 days of hourly rollups right?
4. **Feature usage counts (§1 C.5):** worth having, or more than we need?
