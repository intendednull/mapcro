# Deploying mapcro

mapcro runs on the operator's fleet as an `infra` registry app: `runtime = "systemd"` on the `web`
host, at `https://mapcro.dmgdeadlock.com`. This page covers what the flake ships, how the service
is wired, and the operator steps the deploy does not do on its own: DNS, asset packs, and checks.
The fleet's contract and runbook live in the infra repo's `ONBOARDING.md`.

## What the flake ships

| output | what it is |
|---|---|
| `packages.default` (= `server`) | the `mapcro-server` binary (cargo package `mapcro-server`, bin `mapcro-server`) |
| `packages.replay` | the `mapcro-replay` worker binary (cargo package `mapcro-replay`), which parses demos for match import's replay tier; never linked into the server |
| `packages.wasm` | the browser replica: `cargo build -p mapcro-wasm --target wasm32-unknown-unknown`, then `wasm-bindgen --target web` (the build fails if the CLI differs from the crate's `=0.2.121` pin), then `wasm-opt -O2` |
| `packages.web` | the Vite client built over that replica: `index.html`, `assets/`, and the fonts from `web/public/fonts` with their OFL licences. It carries no game art. |
| `packages.oci`, `apps.<system>.oci` | a `streamLayeredImage` script holding the server and client (`nix run .#oci \| docker load`) |
| `nixosModules.default` | `services.mapcro` |
| `checks.<system>.service` | a NixOS VM test of the module |

The web build is hermetic. npm dependencies come from `web/package-lock.json` as a fixed-output
derivation (`npmDepsHash` in `flake.nix`), and the build runs `vite build` alone, the same as
`just e2e`. Type checking stays in CI. **When `web/package-lock.json` changes, update
`npmDepsHash`:** set it to `pkgs.lib.fakeHash`, run `nix build .#web`, and copy the `got:` hash.

The client's closure is self-contained, about 0.8 MB. Panic messages embed toolchain and vendored
source paths in the WASM, and crane's `buildPackage` hooks strip them, so the Rust toolchain does
not ride along to the box.

## The service (`nix/module.nix`)

infra's `mkApp` sets `enable` and `port` from the registry, and adds `MemoryMax` (default 256M).
The host sets `publicOrigin`. The module sets:

| env | value |
|---|---|
| `HOST`, `PORT` | `127.0.0.1`, the registry port |
| `DATA_DIR` | `/var/lib/mapcro` (the SQLite database) |
| `WEB_DIR` | `services.mapcro.webDir`, default `packages.web`; `null` serves the API alone |
| `PACKS_DIR` | `services.mapcro.packsDir`, default `/var/lib/mapcro/packs`; `null` disables packs |
| `PUBLIC_ORIGIN` | `services.mapcro.publicOrigin`, required |
| `MALLOC_ARENA_MAX` | `2`, which the room memory budget is calibrated against |
| `REPLAY_DIR` | `/var/lib/mapcro-replay`, the replay worker's queue, when `services.mapcro.replay.enable` (default true) |
| `REPLAY_WORKERS` | `replay.workers` (2): the worker's parses at once, for the wait estimate |
| `REPLAY_MAX_QUEUE_BYTES`, `REPLAY_MAX_QUEUED` | `replay.queueBytes` (8 GiB), `replay.queuedJobs` (24): the queue's budget |
| `REPLAY_UPLOADS_AT_ONCE`, `REPLAY_DOWNLOADS_AT_ONCE` | `replay.uploadsAtOnce` (4), `replay.downloadsAtOnce` (2) |
| `REPLAY_MAX_WAITING` | `replay.maxWaiting` (64): past this many waiting in line, a new upload or fetch is refused |
| `DEADLOCK_API_KEY_FILE` | `%d/deadlock-api-key`, when `services.mapcro.deadlockApiKeyFile` is set (default null): a deadlock-api key, below |
| `FEEDBACK_GITHUB_TOKEN_FILE` | `%d/feedback-github-token`, when `services.mapcro.feedbackGithubTokenFile` is set (default null): turns the feedback form on, below |
| `FEEDBACK_GITHUB_REPO` | `feedbackGithubRepo`, default `intendednull/mapcro`: where feedback issues go |
| `FEEDBACK_PER_CLIENT_PER_HOUR`, `FEEDBACK_GLOBAL_PER_DAY` | `feedbackPerClientPerHour` (3), `feedbackGlobalPerDay` (30) |
| `METRICS_ADDR` | `services.mapcro.metricsAddr`, default `127.0.0.1:9464`: `/metrics` (Prometheus text) on a loopback listener of its own, which Caddy never proxies; `null` turns it off |

**deadlock-api key (optional).** Without one, deadlock-api's salts endpoint allows 3
Steam-sourced lookups an hour per address, which the replay fetch on open (spec §6a) can meet.
With one it's 300 an hour. Put the key in a root-only file outside the repo and the store, and
set `services.mapcro.deadlockApiKeyFile` to its path: systemd hands it to the unit as a
credential (`LoadCredential`), and the server reads it once at start from the path in
`DEADLOCK_API_KEY_FILE` and sends it as `X-API-KEY`. The value never enters the environment,
the logs or the repo. An unreadable or empty file logs a warning and the server calls
deadlock-api without a key. Restart `mapcro` after changing the file.

**The feedback form (optional, off by default).** With a token, the "Feedback" button opens
public issues on `intendednull/mapcro` (architecture spec §11a). To turn it on:

1. On GitHub, as `intendednull`: Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token. Resource owner `intendednull`; Repository access
   "Only select repositories" → `intendednull/mapcro`; Repository permissions: **Issues: Read
   and write**, nothing else (Metadata: Read-only is added by GitHub and required). Pick an
   expiry and note the date: when it lapses, sends fail with 502 and `github_error` counts rise.
2. In the repository, create the label `feedback` (Issues → Labels → New label). Without it,
   GitHub may refuse the label and the server retries without one, so issues arrive unlabelled.
3. On `web`, put the token in a root-only file outside the repo and the nix store, without
   it passing through shell history: run
   `sudo install -d -m 700 /var/lib/secrets`, then
   `sudo install -m 600 -o root -g root /dev/stdin /var/lib/secrets/mapcro-feedback-github-token`,
   paste the token, press Enter and Ctrl-D. (Any root-only path works; it's only ever named.)
4. In infra's mapcro host config, set
   `services.mapcro.feedbackGithubTokenFile = "/var/lib/secrets/mapcro-feedback-github-token";`
   and deploy. systemd hands the file to the unit as a credential (`LoadCredential`); the
   server reads it once at start. Changing the file needs `systemctl restart mapcro`.
5. Check: `curl -s https://mapcro.dmgdeadlock.com/api/feedback` answers `{"enabled":true}`,
   and the button shows on the landing and boards. Sending one real test issue is the only
   end-to-end check of the token; close it afterwards.

An unreadable or empty token file logs a warning and leaves the form off; it never stops the
server. `mapcro-stats summary` shows "feedback sent" and refusals by reason; a GitHub failure is
also in `mapcro-stats failures` as `github issues <result>`. To turn it off, set the option back
to null (or delete the file) and redeploy; revoke the token on GitHub if it may have leaked.

`StateDirectory = mapcro mapcro/packs` creates both directories at start, owned by `mapcro` with
mode 0700, so the packs directory exists even when empty. The server fails fast if `PACKS_DIR` is
missing. Memory stays at the 256M default: the server budgets open rooms by memory
(`ROOM_MEMORY_BYTES`, 128 MiB), and 32 full rooms measured 155 MB peak (spec §11).

**Metrics and `mapcro-stats`.** Every minute the server writes a snapshot of its metrics to its
own database (docs/specs/observability.md). The module puts `mapcro-stats` on the system path:
a wrapper for `mapcro-server stats --data-dir /var/lib/mapcro`, which only reads. Run it as the
service's user, e.g. `ssh deploy@100.96.92.104 'sudo -u mapcro mapcro-stats summary'`, or from the
dev box `just stats summary` (also `failures`, `funnel`, `limits`, `usage`, `series <metric>`,
each with `--json`). `/metrics` answers only on `metricsAddr`; the public port serves the client
there instead, as the VM test checks. If another service on the host holds 9464, set
`metricsAddr` to a free loopback port: a bind failure only logs, and the snapshots and
`mapcro-stats` keep working.

## The replay worker (`mapcro-replay.service`)

Match import's replay tier (spec §6a) parses demos in a second unit from the same module, never
in the board server. It runs as user `mapcro-replay` with no network, only its queue visible
under `/var/lib`, and the rest of the sandbox listed in spec §11. It parses
`services.mapcro.replay.workers` demos at once (default 2, for the 3-core `web` host), each in
its own child under a 300 s wall clock (`jobTimeoutSec`). Its caps follow the worker count
unless set: `memoryMax` 384M a parse (768M) and `cpuQuota` a core a parse (200%), at a low CPU
weight; `TasksMax` is 8 + 4 a parse. A parse of the largest demos costs a core and ~26 MB of
anonymous memory; the rest is the demo's own pages, which the cap reclaims (journal
2026-11-08-replay-capacity). On a box with more cores, raise `workers` and the caps follow. The queue directory `/var/lib/mapcro-replay` is made by tmpfiles, setgid
`mapcro-replay`; the board server's user joins that group and may write only there besides its
own state. The board server's `/healthz` doesn't look at the worker, so a crashed or stopped
worker can't fail the deploy gate: uploads queue until it's back, and jobs queued for an hour
fail as `timeout`. `systemctl status mapcro-replay` and its journal show each job's outcome and
time.

The queue (spec §6a, The queue) is fair across clients, and when it's full an upload waits in
the browser for its turn ("Waiting for a slot · N ahead") rather than being refused. Its budget:
`replay.queueBytes` (8 GiB) and `replay.queuedJobs` (24) on disk, plus one expanded demo
(≤ 1 GiB) a worker in `work/`: about 10 GiB at the peak, of `web`'s 32 GB free. Timelines are
cached under `/var/lib/mapcro/replays`, capped at 1 GiB. Lower `queueBytes` on a smaller disk;
the line only grows longer. `replay.uploadsAtOnce` (4) and `replay.downloadsAtOnce` (2) bound
the transfers, and `replay.maxWaiting` (64) is the line past which a new one is refused ("Busy.
Try again in a few minutes."); a client may hold 4 uploads and 4 fetches waiting. Two server
settings the module leaves at their defaults: `REPLAY_RESERVE_TTL_S` (90), how long a place in
line is kept without being asked about (past a hidden tab's minute between timers), and
`REPLAY_GRANT_USE_S` (75), how soon a turn given must be used. Each turn given counts against
`REPLAY_PER_CLIENT_PER_HOUR` (6), used or not. A worker restarted mid-parse (a deploy) puts the
job back once rather than failing it.

## Behind Caddy

The infra vhost is `encode zstd gzip` + `reverse_proxy 127.0.0.1:<port>` + HSTS. Checked against
the Caddy in infra's nixpkgs (2.11.3):

- **WebSockets need no `caddyExtra`.** `reverse_proxy` passes upgrades through, and `encode`
  skips any request carrying `Sec-WebSocket-Key`.
- **The Origin check works.** Caddy forwards `Origin` unchanged, so `/ws` sees
  `https://mapcro.dmgdeadlock.com`, which matches `PUBLIC_ORIGIN`.
- **The per-IP limits see the client.** infra sets no `trusted_proxies`, so Caddy *replaces*
  any incoming `X-Forwarded-For` with the TCP peer's address. It appends only for trusted proxies.
  The server trusts the rightmost value, and only from a loopback peer, so a client cannot spoof
  it. This holds only while Caddy is the first hop. **Don't put a CDN proxy in front**, such as an
  orange-cloud Cloudflare record: every client would then show as a CDN address, and the
  board-creation limits would apply per CDN node.
- **Replay uploads need no `caddyExtra`.** They are up to 800 MiB (`REPLAY_MAX_UPLOAD_BYTES`)
  and can take minutes. infra's vhost sets no `request_body` limit, and Caddy's defaults have no
  body size limit, no body read or write timeout, and stream the request to the upstream
  (`request_buffers` off), so nothing at the edge stops them. The server enforces its own caps.
  Checked against infra's `lib/mkApp.nix` and `hosts/web`; confirm once after the first deploy
  with a real 400–500 MB upload.
- **A Caddy reload drops open WebSockets on every vhost.** `stream_close_delay` is 0, so the
  deploy that adds this vhost disconnects live sockets once (paseo-relay and willow-relay clients
  too), and they reconnect. Later mapcro-only deploys don't change the Caddyfile and don't reload
  Caddy.

## First deploy (operator)

From the infra repo, on the branch that adds mapcro:

1. Push mapcro's `main`. infra fetches `github:intendednull/mapcro`, which is public, so no
   token is needed.
2. `nix flake update mapcro`, then the preflight:
   `nix eval .#nixosConfigurations.web.config.systemd.services.mapcro.serviceConfig.ExecStart`
3. DNS: an `A` record `mapcro.dmgdeadlock.com` → the `web` box's **public** IPv4. This is not
   the tailnet address in `registry.nix`, and the record must not be CDN-proxied. Confirm it with
   `dig +short mapcro.dmgdeadlock.com` before the deploy, or ACME fails.
4. `just deploy web`. The healthz gate probes `127.0.0.1:<port>/healthz`.
5. Check:
   `just wait-200 https://mapcro.dmgdeadlock.com/healthz`, then
   `curl -fsS https://mapcro.dmgdeadlock.com/ | grep -q 'id="root"'`, then
   `curl -fsS https://mapcro.dmgdeadlock.com/api/packs` (`[]` until a pack is placed).
6. Commit `flake.lock`.

Without a pack, boards render on the built-in placeholder map.

## Rollbacks and backups

The database is `/var/lib/mapcro/mapcro.sqlite` (WAL mode). A server migrates it forwards on start
when its schema is older, and never backwards (spec §9, §10).

**Rolling back after a schema bump.** `meta` holds two numbers: `schema_version` and
`compat_floor`, the oldest server schema version that can still use the database. An additive
migration (one that only adds tables or columns older servers never read) keeps the floor; any
other raises it to the new version. A server whose own version is older than the database's
opens it if its version is at least the floor, logs a warning ("database schema is newer than
this server"), and leaves it as it is. Otherwise it refuses to start (`database schema N (opens
with servers from F), this server knows M`, exit 2), and systemd's restart limit stops it after
8 tries. A refused rollback needs the backup below.

- v6 (the metrics tables) is additive: its floor is 5, so a v5 server that knows about the floor
  opens a v6 database. Every step before v6 raised the floor.
- **The server deployed before v6 predates the floor and ignores it**: it refuses any newer
  database. So for the deploy that first reaches v6, the rollback is restoring the pre-deploy
  backup, which loses the boards and edits made since. Later rollbacks to a floor-aware server
  can use the floor.

**Before a deploy that bumps the schema** (`SCHEMA_VERSION` in `crates/server/src/store.rs`
changed), copy the database. `.backup` is safe while the server runs:

```sh
ssh deploy@100.96.92.104 'set -e; f=/var/lib/mapcro/mapcro.sqlite; sudo nix shell nixpkgs#sqlite -c sqlite3 $f ".backup $f.pre-vN"; sudo chown mapcro:mapcro $f.pre-vN'
```

Replace `N` with the new version. If `nix shell` isn't usable there, stop the service, copy the
file, and start it again: `sudo systemctl stop mapcro && sudo -u mapcro cp /var/lib/mapcro/mapcro.sqlite /var/lib/mapcro/mapcro.sqlite.pre-vN && sudo systemctl start mapcro`.

**Restoring it** (with the old binary deployed and the service stopped):
`sudo -u mapcro mv /var/lib/mapcro/mapcro.sqlite.pre-vN /var/lib/mapcro/mapcro.sqlite`, delete
`mapcro.sqlite-wal` and `mapcro.sqlite-shm` beside it, then `sudo systemctl reset-failed mapcro`
and start it. There is no off-box backup yet (spec §9, Backups).

## Asset packs

A pack is one `mapcro-extract --out <dir>` directory: `pack.json` and `blobs/`. Extract it on a
machine that has the game (`just extract <citadel dir> <out dir>`). The server indexes
`PACKS_DIR/*/pack.json` **once, at start**. Each pack's id is the SHA-256 of its `pack.json`, and
every blob is hash-checked before it is listed.

**Does a new pack need a restart? Yes.** A pack copied in while the server runs is not listed
until `systemctl restart mapcro`; the VM test asserts this. The restart is brief and touches only
mapcro: boards are durable in SQLite, and open clients reconnect. A pack that fails validation is
skipped with an error in the journal, so a bad copy never half-serves. Keep old packs: boards
record the pack they were made on (spec §12).

**Stat tables** (calculated hero stats, spec §6b): a pack carries the install's own patch's table
always, and older patches' only when extracted with boon-data: `just stat-data <dir outside the
repo>` (about 460 MB, hash-checked; re-runs fetch only new snapshots), then
`just extract <citadel dir> <out dir> --stat-data <dir>`. They're JSON blobs (about 2.3 MB for
28 patches), so like schema 4 they need a server that serves `application/json`. A replay whose
build the newest pack has no table for shows "—".

**Schema 4 packs need the server first.** A pack from schema 4 on carries the items, abilities and
modifiers names table as an `application/json` blob (spec §12). A server from before that change
serves only image types, so it skips the whole pack as invalid ("type \"application/json\" not
served" in the journal). Deploy the server, then place the pack.

`deploy` is in `wheel` with passwordless sudo, and `/var/lib/mapcro` is `mapcro`-owned 0700, so
the copy goes through `sudo`. The commands below run unchanged in bash or fish. Replace
`OUT_DIR` with the extractor's output directory, and `NAME` with a new directory name, such as
the pack's `client_version`. The `mv -T` refuses to overwrite an existing pack.

```sh
# 1. Stream the pack into a staging dir, hand it to mapcro, then move it into place in one step.
tar -C OUT_DIR -cf - . | ssh deploy@100.96.92.104 'set -e; d=/var/lib/mapcro/packs; sudo install -d -o mapcro -g mapcro -m 0700 $d/.incoming-NAME; sudo tar -C $d/.incoming-NAME --no-same-owner -xf -; sudo chown -R mapcro:mapcro $d/.incoming-NAME; sudo mv -T $d/.incoming-NAME $d/NAME'

# 2. Load it, and run the fleet's health gate.
ssh deploy@100.96.92.104 'sudo systemctl restart mapcro && sudo systemctl start --wait healthz-check.service'

# 3. Confirm it is listed, and that nothing was skipped.
curl -fsS https://mapcro.dmgdeadlock.com/api/packs
ssh deploy@100.96.92.104 'sudo journalctl -u mapcro -b --since -5min --no-pager | grep -i pack'
```

If step 1 fails, for example because `NAME` already exists, remove the staging dir before any
restart: `ssh deploy@100.96.92.104 'sudo rm -rf /var/lib/mapcro/packs/.incoming-NAME'`. The
server indexes every subdirectory that holds a `pack.json`, dot-named ones included.

`100.96.92.104` is `web`'s tailnet address (`targetHost` in infra's `registry.nix`); ssh to the
box is tailnet-only. `tar` is on the box (`gnutar` is in the system path).

## Watching production

`tools/prod-watch/watch.py` runs every 15 minutes on the dev box (`just watch-install`, a
transient user timer; re-run it after a reboot). It checks:
- `/healthz`, whose body must start with `ok`, since any unknown path answers 200 with the app
- `just stats summary`, `failures` and `limits` for the last 20 minutes

It alerts the lead agent through Paseo when one of these opens:
- server errors
- failures on our side (users' own replay problems, such as not a replay, an old map or a
  Brawl match, don't count)
- an OOM kill
- deadlock-api backoff over 30 minutes
- any limit at 85% of its cap
- the stats host unreachable

It alerts once when a problem opens, again at most every 6 hours while it stays open, and once
when it clears. A site-down alert also goes to the concierge.

The lead's Paseo agent id is read from `~/.config/mapcro-watch/lead`; update it when a new lead
session takes over. Open alerts are kept in `~/.local/state/mapcro-watch.json`. To check by hand,
run `python3 -I tools/prod-watch/watch.py --dry-run` inside `nix develop`.
