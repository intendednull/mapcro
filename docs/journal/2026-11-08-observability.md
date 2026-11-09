# 2026-11-08: Observability, the server's half

The operator wanted to know "did anything break this week", how long a full replay takes to
arrive, and how close we are to deadlock-api's limits and the disk. Spec
[observability](../specs/observability.md) lists the questions. This entry covers build-order
steps 1, 2 and 4: the collector, the worker's per-job record, and `mapcro-server stats`. The
browser beacons and alerts are later steps.

## Decisions

- **A hand-rolled registry, not the `metrics` crate.** The crate and `metrics-exporter-prometheus`
  would work with our tokio and axum. But:
  - Their labels are strings, and spec §5 wants every label from a fixed list. Here each label
    is a Rust enum (`label!`), so free text can't become a label by construction.
  - Reading every value back each minute for the SQLite snapshot would need a custom recorder
    or `metrics-util`'s snapshotter.
  - The exporter brings hyper and more.

  The registry is about 400 lines: counters, gauges with a per-minute peak, and fixed-bucket
  histograms. It has no new dependencies except rustix, for `statvfs` without unsafe code.
- **One line per metric.** `registry!` in `catalog.rs` generates the struct, its constructor and
  the list the exporter and the snapshot walk. A metric can't be recorded without also being
  exported and stored. The spec's "Adding a metric" section is written for the agents who
  instrument the rest.
- **Rows are windows, not totals.** A counter's row is its delta for the minute, so a restart
  loses at most the minute in progress, and a sum over rows is a total. Histogram rows keep
  their non-empty buckets with both edges (`[lower, upper|null, n]`), so an hourly rollup merges
  them exactly and the quantiles come out right after the rollup. Quantiles are interpolated
  within the bucket, as Prometheus does.
- **Peak RSS from `VmHWM`, not `getrusage`.** The workspace forbids unsafe code, and rustix has
  no `getrusage`. The child reads its own `/proc/self/status` `VmHWM`, which is the number
  `ru_maxrss` reports, and the worker's sandbox leaves `/proc/self` visible.
- **The record crosses as its own file.** The worker writes `outbox/<job>.stats` before the
  job's `.json` or `.failed`, so the server finds both when it collects. The timeline is still
  published by copy (work/ and outbox/ are separate mounts). It is staged in the outbox and
  renamed there after the record, so `publish_s` covers the copy. A record whose job is gone is
  dropped like any stray output. The worker is untrusted, so the server keeps only finite
  numbers under a day or 64 GiB.
- **The stats command needs only the database.** `mapcro-server stats` runs before any config is
  read, opens the database read-only, and works against a dev `DATA_DIR` or on the host as the
  mapcro user, through the module's `mapcro-stats` wrapper. The snapshot writes the caps too
  (`db_max_bytes`, `boards_max`, the queue's, each unit's `memory.max`), so `limits` needs no
  configuration of its own.
- **`/metrics` refuses to be public.** A non-loopback `METRICS_ADDR`, or one on the public port,
  is a configuration error. A port another service holds only logs, so it can't fail a deploy.

## Surprises

- **An empty float sum is `-0.0`.** The first `stats summary` read "prev -0". `num` now
  normalises it.
- **The fallback has no matched path.** axum's `MatchedPath` is absent for the SPA fallback and
  for 404s, so both count as `page`. A nested service's template starts with its prefix, so
  `/assets/*` is matched by prefix.
- **The worker's child takes the output path as its third argument, not its second.** The
  first draft of the record test wrote its stand-in's record to the wrong file. The existing
  cross-filesystem test showed the convention.

## Checks

- Every test was run against its own reverted piece, and each one failed:
  - raw URIs instead of templates;
  - the worker's record not ingested;
  - the job name in a failure message with the sanitiser off (with it on, the name became
    `<id>` and the test still passed, as it should);
  - the salt never reset;
  - rollup after 9 days;
  - no failures cap;
  - quantiles without interpolation.
- The VM test checks that `/metrics` answers on 9464 only, and that the public port's
  `/metrics` is the client. It also checks that the listener binds loopback only, and that
  `mapcro-stats` run as `mapcro` shows the board the test created.

## Left for later

- The browser beacons (§3), and `feature_used` and `prompt_choice` with them. `funnel` reads
  `match_to_usable_ms` and `match_to_full_ms` once they exist.
- Instrumenting the remaining call sites, such as the reconnect time and the "~N min" estimate
  error, following "Adding a metric".
- Alerts (§6), once the channel is decided.
