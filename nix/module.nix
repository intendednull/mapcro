# NixOS module for the mapcro server (infra ONBOARDING.md §0 contract): binds 127.0.0.1:$PORT,
# serves /healthz, logs to stdout, config via env, fails fast on bad config.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.mapcro;
  pkg = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  options.services.mapcro = {
    enable = lib.mkEnableOption "mapcro collaborative board server";
    port = lib.mkOption {
      type = lib.types.port;
      description = "Loopback port; the infra edge Caddy proxies to it.";
    };
    publicOrigin = lib.mkOption {
      type = lib.types.str;
      example = "https://mapcro.dmgdeadlock.com";
      description = "Origin(s) allowed to open WebSockets, comma-separated. Must be https.";
    };
    webDir = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Built web client to serve (absent until the UI ships).";
    };
    createPerHour = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = "Boards one client IP may create per hour.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.mapcro = { isSystemUser = true; group = "mapcro"; };
    users.groups.mapcro = { };
    systemd.services.mapcro = {
      description = "mapcro board server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      # A crash loop gives up instead of spinning (security review 2026-11-07, C1). With the
      # backoff below, eight starts that each fail at once span about six minutes, inside the
      # fifteen-minute window, so the limit trips only when restarts keep failing; an occasional
      # crash never reaches it. `systemctl reset-failed mapcro` re-arms it.
      startLimitIntervalSec = 900;
      startLimitBurst = 8;
      environment = {
        PORT = toString cfg.port;
        HOST = "127.0.0.1";
        DATA_DIR = "/var/lib/mapcro";
        PUBLIC_ORIGIN = cfg.publicOrigin;
        CREATE_PER_HOUR = toString cfg.createPerHour;
        RUST_LOG = "info";
        # Two malloc arenas: the room memory budget (ROOM_MEMORY_BYTES) is calibrated with this.
        # glibc's default (8 per core) keeps freed load buffers in each thread's arena, which
        # measured ~1.5x the budget resident instead of ~1.3x (journal 2026-11-07-security-fixes).
        MALLOC_ARENA_MAX = "2";
      } // lib.optionalAttrs (cfg.webDir != null) { WEB_DIR = toString cfg.webDir; };
      serviceConfig = {
        ExecStart = lib.getExe pkg;
        User = "mapcro";
        Group = "mapcro";
        StateDirectory = "mapcro";
        StateDirectoryMode = "0700";
        Restart = "on-failure";
        # Exponential backoff: 2 s, doubling over five steps to at most two minutes.
        RestartSec = "2s";
        RestartSteps = 5;
        RestartMaxDelaySec = "2min";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = [ "" ];
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
        SystemCallFilter = [ "@system-service" ];
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        UMask = "0077";
      };
    };
  };
}
