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
unless set: `memoryMax` 192M a parse (384M) and `cpuQuota` a core a parse (200%), at a low CPU
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
job back once rather than failing it. Timelines parsed on the user's machine (`POST
…/timeline`, spec §6a) take no queue room: `REPLAY_MAX_TIMELINE_BYTES` (4 MiB) caps one as sent
(decoded, 6 MiB, fixed), and `REPLAY_TIMELINES_PER_CLIENT_PER_HOUR` (30) is their own hourly
count; the module leaves both at their defaults. `REPLAY_SALT_PASS_S` (7800, 2 h 10 min) is
how long after a match's end its salts are read only for free, and when a match with no replay
salt yet is tried again on open (spec §6a, Remembered failures); left at its default too.

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
- **The timeline route's validator passes through, and no longer hangs on who compresses.**
  `GET /api/boards/{board}/matches/{id}` answers a cached replay with a validator, which the
  client holds and sends back (sessions.md §4.3).
  - **As deployed, `encode` doesn't touch this route.** The server compresses the timeline
    itself (`main.rs` `compression`, gzip or zstd: 1.50 MiB to 0.50 MiB with zstd on the
    reference replay), and `encode` leaves an answer that is already encoded alone. The `ETag`
    arrives as the server sent it, on the 200 and on the 304, and an `If-None-Match` list reaches
    the server whole (checked 2026-11-13 with 2.11.3 and 2.11.4, and again 2026-11-14 with
    2.11.4 for `Accept-Encoding` zstd, gzip, both, br and none, the debug server behind
    `encode zstd gzip` + `reverse_proxy`).
  - **When `encode` does the compressing, it rewrites the `ETag`.** For an upstream that
    answers plain, it appends the encoding on the 200 (`"…-zstd"`), and of an `If-None-Match`
    list sent back it takes the suffix off the last validator only; the 304 comes back with the
    `ETag` unsuffixed (2.11.3, 2.11.4 and 2.11.7, a stub upstream: the adversarial review's
    run, 2026-11-14). A client comparing `ETag`s then never sees a match and asks again,
    plainly, on every open: four requests and two whole timelines a tab switch. That is one
    change away: dropping the server's compression layer, or `encode` gaining an encoding the
    server lacks.
  - **So the client's cache uses headers of our own**: the validator in `X-Mapcro-Timeline`,
    what the client holds in `X-Mapcro-Held`. A proxy passes them through untouched whoever
    compresses. The server still sends the validator as its `ETag` and still honours
    `If-None-Match`; the client reads neither (it sends `If-None-Match` beside its own header,
    so its request is a conditional one).
  - Tested through a real Caddy (the dev shell's, 2.11.7), both ways:
    `crates/server/tests/replays.rs` `the_validator_passes_a_compressing_proxy_both_ways` (the
    deployed stack, and the proxy compressing: `header_up -Accept-Encoding`), and
    `web/e2e/caddy-timeline.spec.ts` (the real client through the rewriting proxy: sent once,
    then 304s). **Any other proxy put in front must pass `X-Mapcro-Timeline` and
    `X-Mapcro-Held` through.**
- **A Caddy reload drops open WebSockets on every vhost.** `stream_close_delay` is 0, so the
  deploy that adds this vhost disconnects live sockets once (paseo-relay and willow-relay clients
  too), and they reconnect. Later mapcro-only deploys don't change the Caddyfile and don't reload
  Caddy.

### Test proxies left behind

The two tests that go through a real Caddy start one of their own (`caddy run --adapter
caddyfile --config <temp dir>/Caddyfile`, `admin off`, on free loopback ports) and kill it when
they end: `crates/server/tests/replays.rs` and `web/e2e/caddy-timeline.spec.ts`. A run killed
hard (a gate cancelled, a restart mid-test) can leave one running. It holds one or two loopback
ports and nothing else. List them with `pgrep -af 'caddy run --adapter caddyfile'`, check that
the command line names a Caddyfile under a temp directory, and kill those by pid. Their temp
directories (`/tmp/mapcro-e2e-caddy-*`, and the cargo test's own) can go with them. Each writes
what Caddy said to `caddy.log` beside its Caddyfile, and shows it if Caddy never answers.

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

**Rolled back to the previous release, new board files may be refused.** A rollback reads every
stored board, but the older build admits rows by its own statuses: a board file exported by the
newer build, a copy of one of its scenes (Duplicate, New scene), or a pending edit a reloaded tab
resends can carry a row the older build still holds `Ahead`, and is refused whole (`WrongField`).
For v10 → v9 (1dcbd31): kills, deaths, assists and max health. Roll forward to import them.

**Map-state rows: lock them at each deploy.** After a deploy is live, check out the deployed
commit with nothing else in the tree, run `just rows-lock`, and commit `crates/schema/rows.lock`.
It lists the map-state rows the deployed build reads (`docs/specs/map-state.md` §4.3).

- **What the lock holds still.** A row may be written only by a build that follows one that reads
  it. The schema's test refuses a row that is written (`Live`) but not in the lock, a locked row
  that moved, was removed or was narrowed, and `SceneState` written before a lock lists a row of
  the scene's.
- **`just rows-lock` checks before it writes.** It compares this build's rows with the lock
  already there (the last deploy's) and rewrites the file only if every locked row is kept. It
  refuses a tree with uncommitted changes, a build that breaks a locked row, and a missing lock;
  the file is then untouched. Never edit the file by hand to get past it: a refusal means the
  build can't read what the last one may have stored.
- **What a reader release admits.** While a row is `Ahead`, the server reads it from a stored
  board and refuses it from outside: a client's transaction or an imported file that carries the
  row, or a `SceneState`, is rejected (`Admit`, `crates/schema/src/map_state.rs`). So after the
  reader's deploy the database holds nothing the build before it can't load, and a rollback is
  safe. That guarantee ends when a row goes `Live`.
- Schema v8 is the reader (additive: a v7 server still opens the database). v9 is the first
  writer: its step adds no SQL and sets the floor to 8 (`Step::NeedsReader` in `store.rs`), so
  the v8 reader is the rollback target and nothing older starts. v10 is the second writer (the
  rows `kills`, `deaths`, `assists`, `max_health`, and the unfit undo below): the same kind of
  step, floor 9, so **the rollback target from v10 is the v9 build (`1dcbd31`) and nothing
  older**.
- **`has_heroes`** (map-state D2: a scene that holds its own heroes) follows the same two steps.
  - **v12 is its reader**: the row `Ahead`, with an additive store step (v11 → v12, no SQL,
    floor 9). Nothing a v9 to v11 server can't load is stored, so **the rollback targets from
    v12 are still the v11 build (`ce1ec0c`), the v10 build and the v9 build**. One thing is
    stored differently: a save from the metadata tier stores no `health` on a hero's record
    (fewer keys, nothing new). Those builds read the missing key as a hero alive at full
    health; no scene draws a hero's health, but the stat calculator counts a life-threshold
    item (Battle Vest, Hollow Point) as active there (`docs/specs/map-state.md` §4.5). A test in `store.rs` ("the v12
    reader stores nothing new") holds the row `Ahead`, with feedback's three typed fields,
    while v12 is the newest version.
  - **Its writer is the next free store version** (v14 if feedback's writer takes v13; the lead
    assigns it at merge): `ahead("has_heroes", ...)` becomes `row(...)` in
    `crates/schema/src/map_state.rs`, and the store gets a step
    `Step::NeedsReader { reader: 12 }` (the form feedback's release 2 introduces: the floor is
    the reader's version, 12, whatever number the writer takes), then `just ts`, `just
    rows-lock` after the deploy, and `reader` in the justfile set to the deployed v12 commit
    before it merges. From that deploy the rollback target is the v12 build and nothing older
    (a server before v12 can't parse a `more` that names the row).
  - **After the reader's deploy:** `just rows-lock` (16 rows, with `has_heroes`), and before the
    writer merges, `reader` in the justfile set to the deployed v12 commit.
  - **Must fix before the flip** (the D2 reader's review, 2026-11-14):
    - **The "neither" case.** With the row written, `own` is true and Save never pushes the
      roster's sets (`web/src/match/save.ts`, the `!own` guard and the heroes-only fallback;
      asserted in `scene-heroes.test.ts`, "None"). A save with no room for the heroes and the
      flag then stores neither and draws whatever the roster holds, against §4.5 ("sets the
      roster to the match's heroes"). Fall back to the roster's sets when they fit, or refuse
      the save.
    - **Retake's health tier.** Capture asks the open timeline's tier, while
      `CAPTURED.health` asks the scene's `source.tier`: a Retake of a metadata-sourced scene
      with the replay loaded writes health that the reader hides. Make the two ask the same.
  - From the writer's deploy Save leaves the roster alone and a saved scene draws its own
    heroes; `web/e2e/scene-hero.spec.ts` switches from the test of Save setting the roster to
    the test of a scene's own heroes by the row's status, and so does the server's refusal in
    `web/test/scene-hero-pick.test.ts`. Five tests say what this build does and change on
    purpose with the flip: `scene-heroes.test.ts` "is not written by this build", the two Save
    pins in `map-state-pins.test.ts` (with `web/test/pins/save-as-scene.json`), and on the
    server `board_file.rs` "`has_heroes` is the only row still ahead" and `store.rs` "the v12
    reader stores nothing new". The writer was rehearsed three times on the reader's branch
    with the row flipped in the tree only, the third as store v12 on top of v11: everything
    built, `tsc` was clean, the whole vitest suite failed only in those three of its tests,
    `cargo test` only in those two and the rows-lock test (a `Live` row not in the lock: it
    passes once `just rows-lock` has run at the reader's deploy), and the save flows' e2e
    passed with the own-heroes test.
- **`just reader-check`** (in `just test`) loads what this build's server stores on the reader
  release's own code. Its reader is `reader` in the justfile: **set it to the deployed commit
  at each deploy that changes what is stored**, with `just rows-lock`.
- **`just rows-lock` is the only way to write the lock.** The test rewrites it only when the
  recipe names the commit it checked (`MAPCRO_ROWS_LOCK_COMMIT`); the flag alone fails.
- **A looser validation rule is gated like a row.** `UNFIT_UNDO` (`map_state.rs`): the v9 build
  skips an undo whose list no longer fits when it replays a log, and still refuses it from a
  client. v10 makes it `Live` (admitted, logged, skipped), with the store step that sets the
  floor to 9.
  **Deploy note for v10:** every client must be on a build that skips such an entry, or its
  replica would call the board diverged. Clients of the v9 build (`1dcbd31`) do, and this
  deploy closes every older tab as `Outdated` (the build id hashes the schema sources, which
  the flip changes), so they reload. After the deploy, check that the served client's build
  id changed.

- **Typed fields are gated the same way.** Feedback #56, #59 and #60 added three things a log
  may hold that the v10 build can't load (prod is `3423072`; its schema, engine and store are
  `e878c30`'s, the commit `just reader-check` reads): a scene name over 24 characters (up to 48),
  a comment's side (`Callout::side`, `FieldValue::CalloutSide`) and a stroke's colour as a field
  (`FieldValue::StrokeColor`). Each has a status in `map_state.rs` (`LONG_SCENE_NAME`,
  `CALLOUT_SIDE`, `STROKE_COLOR`) that `Admit` asks, as it asks a row's.
  - **v11 is their reader**: all three `Ahead`. Its step adds no SQL and is additive (floor 9):
    it stores nothing new, so **the rollback targets from v11 are still the v10 build
    (prod, `3423072`) and the v9 build**. A test in `store.rs` holds the three `Ahead` while v11 is
    the newest version (from v12, D2's reader, the v12 test holds them).
  - **Their writer is the next store step** (`Step::NeedsReader`, floor 11): it makes the three
    `Live`, and from it the rollback target is the v11 build and nothing older. Before it
    merges, set `reader` in the justfile to the deployed v11 commit, so `just reader-check`
    loads the writer's logs on it.
  - The bytes that writer stores are pinned now (`crates/schema/tests/golden/sides-colours-*`):
    the v11 reader reads exactly those.

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

## Looking up a match from feedback

A feedback issue names the match its sender had open ("Match 134623152 at 28:55 (full replay)"),
not the board. An upload is cached under its board's scope, so the match id alone doesn't find
it through the app. To see what they saw:

1. `just stats timelines 134623152` lists every cached timeline of the match on production:
   source (`cdn` fetched from Valve, `upload`, `client` parsed on the user's machine), scope and
   board id, format, current or stale, and the worker's check. Rows with the same `#n` are one
   file (a clone's carried upload). "open on" says what each board with the match sees: its own
   upload first, else the `cdn` one, else the metadata. Nothing in the output comes from inside a
   timeline. Add `--json` for the data, or `just stats local timelines <id>` for the dev cache.
2. `just pull-timeline 134623152 <cdn | scope | board id>` copies that one (the `cdn` one by
   default) over the deploy SSH, read-only as the mapcro user, to
   `~/.local/share/mapcro-lead/timelines/<id>-<scope>.json` (0600). It's never printed:
   timelines hold in-game names, so don't cat it, paste it or commit it.
3. To see it in Player, add `--dev`: the file also goes to the dev cache as `<id>-cdn.json`
   (`~/.local/share/mapcro/data/replays/`, or `MAPCRO_DATA_DIR`), moving a local one aside to
   `mapcro-lead/timelines/displaced/`, and the local lookup shows it with its check. The dev server
   serves cached timelines only with `REPLAY_DIR` set (no worker is needed to serve one), so start
   it as `REPLAY_DIR=$HOME/.local/share/mapcro/replays/qa just dev`, then open the match on any
   local board (Open match by id). The server reads the file on each open, so no restart is
   needed; it checks nothing on read. A pull from a server on an older format than the local tree
   reads as stale, and an editor's open then tries a re-fetch (only when the match's metadata is
   cached locally); a local board's own upload of the match is served before it.
