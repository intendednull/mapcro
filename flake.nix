{
  description = "mapcro: real-time collaborative Deadlock macro-coaching board";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; };
      rust = pkgs.rust-bin.fromRustupToolchainFile ./rust-toolchain.toml;
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          rust
          rust-analyzer
          cargo-nextest
          just
          nodejs_24       # Quint CLI (npm) and, later, the web UI
          jdk21_headless  # Apalache, the symbolic model checker Quint downloads on first `quint verify`
          tlaplus         # TLC, for exhaustive checks of `quint compile --target tlaplus` output
        ];
      };
    };
}
