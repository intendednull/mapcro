{
  description = "mapcro: real-time collaborative Deadlock macro-coaching board";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    crane.url = "github:ipetkov/crane";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, crane, rust-overlay }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; };
      rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
      craneLib = (crane.mkLib pkgs).overrideToolchain (_: rust);
      # Cargo sources, plus the server's storage dictionaries (`include_bytes!`).
      src = pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type: (craneLib.filterCargoSources path type) || pkgs.lib.hasSuffix ".zdict" path;
      };
      commonArgs = { inherit src; strictDeps = true; doCheck = false; };

      server = craneLib.buildPackage (commonArgs // {
        pname = "mapcro-server";
        cargoExtraArgs = "-p mapcro-server";
        meta.mainProgram = "mapcro-server";
      });

      # The replay worker (spec §6a): its own package and service, never linked into the server.
      replay = craneLib.buildPackage (commonArgs // {
        pname = "mapcro-replay";
        cargoExtraArgs = "-p mapcro-replay";
        meta.mainProgram = "mapcro-replay";
      });

      # The browser replica: the same steps as `just wasm` (wasm32 build, then wasm-bindgen at the
      # version the crate pins), plus wasm-opt. Output: mapcro_wasm.js and mapcro_wasm_bg.wasm.
      wasmArgs = commonArgs // {
        pname = "mapcro-wasm";
        cargoExtraArgs = "-p mapcro-wasm";
        CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
      };
      # buildPackage (not mkCargoDerivation) for its hooks that strip the toolchain and vendored
      # source paths panic messages embed; without them the client's closure carries both.
      wasm = craneLib.buildPackage (wasmArgs // {
        nativeBuildInputs = [ pkgs.wasm-bindgen-cli pkgs.binaryen ];
        buildPhaseCargoCommand = "cargo build --release -p mapcro-wasm --target wasm32-unknown-unknown";
        doInstallCargoArtifacts = false;
        doNotPostBuildInstallCargoBinaries = true;
        installPhaseCommand = ''
          pin=$(sed -n 's/^wasm-bindgen = "=\(.*\)"$/\1/p' crates/wasm/Cargo.toml)
          have=$(wasm-bindgen --version | cut -d' ' -f2)
          [ "$pin" = "$have" ] || { echo "wasm-bindgen-cli $have != crate pin $pin" >&2; exit 1; }
          wasm-bindgen --target web --out-dir "$out" target/wasm32-unknown-unknown/release/mapcro_wasm.wasm
          wasm-opt -O2 "$out/mapcro_wasm_bg.wasm" -o "$out/mapcro_wasm_bg.wasm"
        '';
      });

      # The web client (Vite). Only what `vite build` reads: no tests, no game art (packs are
      # served from PACKS_DIR at runtime, never built in). public/ carries the fonts.
      webSrc = pkgs.lib.fileset.toSource {
        root = ./web;
        fileset = pkgs.lib.fileset.unions [
          ./web/index.html
          ./web/package.json
          ./web/package-lock.json
          ./web/tsconfig.json
          ./web/vite.config.ts
          ./web/public
          (pkgs.lib.fileset.difference ./web/src (pkgs.lib.fileset.maybeMissing ./web/src/wasm))
        ];
      };
      web = pkgs.buildNpmPackage {
        pname = "mapcro-web";
        version = "0.0.0";
        src = webSrc;
        nodejs = pkgs.nodejs_24;
        npmDepsHash = "sha256-mO/yuiIkRpBf6sHOtJH8KqWbDq9GSaLXc3B4+J/otrg=";
        preBuild = ''
          mkdir -p src/wasm
          cp ${wasm}/mapcro_wasm.js ${wasm}/mapcro_wasm_bg.wasm src/wasm/
        '';
        # `vite build` alone, as `just e2e` does: the type check runs in CI, not in the deploy build.
        buildPhase = ''
          runHook preBuild
          npx vite build --logLevel warn
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          test -f dist/index.html
          cp -r dist $out
          runHook postInstall
        '';
      };
    in
    {
      packages.${system} = {
        default = server;
        inherit server replay wasm web;
        oci = pkgs.dockerTools.streamLayeredImage {
          name = "mapcro";
          tag = "latest";
          fromImage = null;
          contents = [ server ];
          config = {
            Cmd = [ (pkgs.lib.getExe server) ];
            Env = [ "HOST=0.0.0.0" "DATA_DIR=/data" "WEB_DIR=${web}" "MALLOC_ARENA_MAX=2" ];
          };
        };
      };

      apps.${system}.oci = { type = "app"; program = "${self.packages.${system}.oci}"; };

      nixosModules.default = import ./nix/module.nix self;

      # A real VM: the module starts the service, /healthz answers, and the API creates a board.
      checks.${system}.service = pkgs.testers.runNixOSTest {
        name = "mapcro-service";
        nodes.machine = {
          imports = [ self.nixosModules.default ];
          services.mapcro = { enable = true; port = 8094; publicOrigin = "https://mapcro.test"; };
        };
        testScript = ''
          machine.wait_for_unit("mapcro.service")
          machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8094/healthz")
          machine.succeed("curl -fsS -X POST -H 'content-type: application/json' -d '{\"title\":\"vm\"}' http://127.0.0.1:8094/api/boards | grep -q owner_token")
          machine.succeed("test -f /var/lib/mapcro/mapcro.sqlite")
          # The client ships in the package: / is the SPA, and a client route falls back to it.
          machine.succeed("curl -fsS http://127.0.0.1:8094/ | grep -q '<div id=\"root\">'")
          machine.succeed("curl -fsS http://127.0.0.1:8094/b/some-board | grep -q '<div id=\"root\">'")
          machine.succeed("curl -fsS -o /dev/null http://127.0.0.1:8094/fonts/federo/Federo-Regular.woff2")
          # The packs directory exists empty, and the server lists no packs.
          machine.succeed("test -d /var/lib/mapcro/packs")
          machine.succeed("test \"$(curl -fsS http://127.0.0.1:8094/api/packs)\" = '[]'")
          # A pack placed as docs/deploy.md does it (root writes, then chown) is indexed at start
          # only: still unlisted while running, listed after the restart.
          machine.succeed("mkdir /var/lib/mapcro/packs/vm && echo '{\"game\":{\"client_version\":1}}' > /var/lib/mapcro/packs/vm/pack.json && chown -R mapcro:mapcro /var/lib/mapcro/packs/vm")
          machine.succeed("test \"$(curl -fsS http://127.0.0.1:8094/api/packs)\" = '[]'")
          machine.systemctl("restart mapcro.service")
          machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8094/healthz")
          machine.succeed("curl -fsS http://127.0.0.1:8094/api/packs | grep -q '\"client_version\":\"1\"'")
          # A crash loop backs off and gives up rather than spinning.
          machine.succeed("systemctl show mapcro.service -p StartLimitBurst | grep -qx StartLimitBurst=8")
          machine.succeed("systemctl show mapcro.service -p RestartSteps | grep -qx RestartSteps=5")
          machine.succeed("systemctl show mapcro.service -p Environment | grep -q MALLOC_ARENA_MAX=2")

          # Observability: /metrics on its own loopback port, never through the public listener
          # (which Caddy proxies), and the minute snapshots readable as the mapcro user.
          machine.succeed("systemctl show mapcro.service -p Environment | grep -q METRICS_ADDR=127.0.0.1:9464")
          machine.succeed("curl -fsS -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:8094/api/boards")
          machine.wait_until_succeeds("curl -fsS http://127.0.0.1:9464/metrics | grep -q '^mapcro_boards_created_total{how=\"new\"} [1-9]'")
          machine.fail("curl -fsS http://127.0.0.1:8094/metrics | grep -q mapcro_")
          machine.succeed("ss -ltnH | grep -q '127.0.0.1:9464 '")
          machine.fail("ss -ltnH | grep ':9464 ' | grep -v '127.0.0.1:9464'")
          machine.wait_until_succeeds("runuser -u mapcro -- mapcro-stats summary --json | grep -q '\"how=new\": [1-9]'", timeout=120)
          machine.succeed("runuser -u mapcro -- mapcro-stats summary | grep -q HEALTH")
          machine.succeed("runuser -u mapcro -- mapcro-stats limits | grep -q database")

          # The replay worker: its own sandboxed unit, sharing only the queue with the server.
          machine.wait_for_unit("mapcro-replay.service")
          # Two parses at once by default: a core and 384M each (journal 2026-11-08-replay-capacity).
          for prop in ["PrivateNetwork=yes", "User=mapcro-replay", "OOMPolicy=continue", "MemoryMax=805306368", "MemorySwapMax=0", "CPUQuotaPerSecUSec=2s", "TasksMax=16", "ProtectSystem=strict"]:
              machine.succeed(f"systemctl show mapcro-replay.service -p {prop.split('=')[0]} | grep -qx {prop}")
          machine.succeed("systemctl show mapcro-replay.service -p Environment | grep -q REPLAY_WORKERS=2")
          # The server knows the worker count (for the wait estimate) and the queue's budgets.
          for env in ["REPLAY_WORKERS=2", "REPLAY_MAX_QUEUE_BYTES=8589934592", "REPLAY_MAX_QUEUED=24", "REPLAY_UPLOADS_AT_ONCE=4", "REPLAY_DOWNLOADS_AT_ONCE=2", "REPLAY_MAX_WAITING=64"]:
              machine.succeed(f"systemctl show mapcro.service -p Environment | grep -q {env}")
          machine.succeed("stat -c '%a %U %G' /var/lib/mapcro-replay/inbox | grep -qx '2750 mapcro mapcro-replay'")
          machine.succeed("stat -c '%a %U %G' /var/lib/mapcro-replay/outbox | grep -qx '2770 mapcro-replay mapcro-replay'")
          # The worker can't write the server's inbox (security review 2026-11-08, M1).
          machine.fail("runuser -u mapcro-replay -- touch /var/lib/mapcro-replay/inbox/x")
          machine.succeed("systemctl show mapcro-replay.service -p TemporaryFileSystem | grep -q /var/lib")
          # A tiny synthetic job round-trips: an editor uploads a demo whose header names a
          # pre-6712 build; the worker refuses it as an old map and its file is gone.
          import json
          board = json.loads(machine.succeed("curl -fsS -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:8094/api/boards"))
          auth = f"-H 'authorization: Bearer {board['owner_token']}'"
          base = f"http://127.0.0.1:8094/api/boards/{board['board']}/replays/100747544"
          machine.succeed("echo UEJERU1TMgAAAAAAAAAAAAEAJAoBeDIfL3Nydi9jaXRhZGVsX3Y2NjgzL2dhbWUvY2l0YWRlbAAAAA== | base64 -d > /tmp/old.dem")
          # Reserved first, as the client does: a free queue is ready at once.
          machine.succeed(f"curl -fsS {auth} -H 'content-type: application/json' -d '{{\"bytes\":64}}' {base}/reserve | grep -q ready")
          machine.succeed(f"curl -fsS {auth} --data-binary @/tmp/old.dem {base}/upload | grep -q queued")
          machine.wait_until_succeeds(f"curl -fsS {auth} {base} | grep -q old_map", timeout=60)
          # Nothing is left but the server's parse order (now empty).
          machine.wait_until_succeeds("test -z \"$(ls -A /var/lib/mapcro-replay/inbox | grep -vx .order)$(ls -A /var/lib/mapcro-replay/work)$(ls -A /var/lib/mapcro-replay/outbox)\"")
          # Bad magic is refused before it is queued.
          machine.succeed(f"test \"$(curl -s -o /dev/null -w '%{{http_code}}' {auth} --data-binary @/etc/hostname {base}/upload)\" = 415")
          # The server's health doesn't depend on the worker's.
          machine.systemctl("stop mapcro-replay.service")
          machine.succeed("curl -fsS http://127.0.0.1:8094/healthz")
          machine.succeed(f"curl -fsS {auth} --data-binary @/tmp/old.dem {base}/upload | grep -q queued")
          machine.succeed("ls /var/lib/mapcro-replay/inbox | grep -q '^100747544-.*\\.dem$'")
          machine.systemctl("start mapcro-replay.service")
          machine.wait_until_succeeds(f"curl -fsS {auth} {base} | grep -q old_map", timeout=60)
        '';
      };

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          rust
          rust-analyzer
          cargo-nextest
          wasm-bindgen-cli  # must match the wasm-bindgen crate pin in crates/wasm
          binaryen          # wasm-opt
          just
          nodejs_24         # Quint CLI (npm) and the web client
          jdk21_headless    # Apalache, the symbolic model checker Quint downloads on first `quint verify`
          tlaplus           # TLC, for exhaustive checks of `quint compile --target tlaplus` output
        ];
        # Browser tests (web/e2e): Playwright's browsers come from nix; the npm
        # @playwright/test version must match playwright-driver's.
        PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
        PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "true";
      };
    };
}
