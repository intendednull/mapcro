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
      src = craneLib.cleanCargoSource ./.;
      commonArgs = { inherit src; strictDeps = true; doCheck = false; };

      server = craneLib.buildPackage (commonArgs // {
        pname = "mapcro-server";
        cargoExtraArgs = "-p mapcro-server";
        meta.mainProgram = "mapcro-server";
      });
    in
    {
      packages.${system} = {
        default = server;
        inherit server;
        oci = pkgs.dockerTools.streamLayeredImage {
          name = "mapcro";
          tag = "latest";
          fromImage = null;
          contents = [ server ];
          config = {
            Cmd = [ (pkgs.lib.getExe server) ];
            Env = [ "HOST=0.0.0.0" "DATA_DIR=/data" ];
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
          machine.systemctl("restart mapcro.service")
          machine.wait_until_succeeds("curl -fsS http://127.0.0.1:8094/healthz")
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
