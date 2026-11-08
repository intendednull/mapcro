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
| `DEADLOCK_API_KEY_FILE` | `%d/deadlock-api-key`, when `services.mapcro.deadlockApiKeyFile` is set (default null): a deadlock-api key, below |

**deadlock-api key (optional).** Without one, deadlock-api's salts endpoint allows 3
Steam-sourced lookups an hour per address, which the replay fetch on open (spec §6a) can meet.
With one it's 300 an hour. Put the key in a root-only file outside the repo and the store, and
set `services.mapcro.deadlockApiKeyFile` to its path: systemd hands it to the unit as a
credential (`LoadCredential`), and the server reads it once at start from the path in
`DEADLOCK_API_KEY_FILE` and sends it as `X-API-KEY`. The value never enters the environment,
the logs or the repo. An unreadable or empty file logs a warning and the server calls
deadlock-api without a key. Restart `mapcro` after changing the file.

`StateDirectory = mapcro mapcro/packs` creates both directories at start, owned by `mapcro` with
mode 0700, so the packs directory exists even when empty. The server fails fast if `PACKS_DIR` is
missing. Memory stays at the 256M default: the server budgets open rooms by memory
(`ROOM_MEMORY_BYTES`, 128 MiB), and 32 full rooms measured 155 MB peak (spec §11).

## The replay worker (`mapcro-replay.service`)

Match import's replay tier (spec §6a) parses demos in a second unit from the same module, never
in the board server. It runs as user `mapcro-replay` with no network, only its queue visible
under `/var/lib`, `MemoryMax=1G` (`services.mapcro.replay.memoryMax`), `CPUQuota=100%`
(`cpuQuota`), a 300 s wall clock per job (`jobTimeoutSec`) and the rest of the sandbox listed in
spec §11. The queue directory `/var/lib/mapcro-replay` is made by tmpfiles, setgid
`mapcro-replay`; the board server's user joins that group and may write only there besides its
own state. The board server's `/healthz` doesn't look at the worker, so a crashed or stopped
worker can't fail the deploy gate: uploads queue until it's back, and jobs queued for an hour
fail as `timeout`. `systemctl status mapcro-replay` and its journal show each job's outcome and
time. Disk: at most 3 GiB queued (`REPLAY_MAX_QUEUE_BYTES`) plus one expanded demo (≤ 1 GiB)
in `work/`; timelines are cached under `/var/lib/mapcro/replays`, capped at 1 GiB.

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
