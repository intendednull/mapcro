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
        inherit server wasm web;
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
