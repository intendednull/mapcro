# NixOS module for the mapcro server (infra ONBOARDING.md §0 contract): binds 127.0.0.1:$PORT,
# serves /healthz, logs to stdout, config via env, fails fast on bad config.
self:
{ config, lib, pkgs, ... }:
let
  cfg = config.services.mapcro;
  pkgsSelf = self.packages.${pkgs.stdenv.hostPlatform.system};
  pkg = pkgsSelf.default;
  replayPkg = pkgsSelf.replay;
  # The replay worker's queue (spec §6a), through the mapcro-replay group: neither side can write
  # where the other writes (security review 2026-11-08, M1/M2). inbox/ is the server's (the
  # worker reads it), outbox/ the worker's (the server reads results and removes them), work/
  # the worker's alone. Setgid, so files belong to the group whoever writes them.
  queue = "/var/lib/mapcro-replay";
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
      default = pkgsSelf.web;
      defaultText = lib.literalExpression "mapcro.packages.\${system}.web";
      description = "Built web client to serve; null serves the API alone.";
    };
    packsDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "/var/lib/mapcro/packs";
      description = ''
        Extracted asset packs, one per subdirectory (spec §12). The default sits under the
        StateDirectory and is created empty at start; packs are indexed once at start, so a new
        pack is served after `systemctl restart mapcro` (docs/deploy.md). null disables packs.
      '';
    };
    createPerHour = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = "Boards one client IP may create per hour.";
    };
    replay = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          The replay tier of match import: a separate, sandboxed `mapcro-replay` service parses
          uploaded and fetched demos (spec §6a). The board server never parses one, and its
          health doesn't depend on the worker's.
        '';
      };
      memoryMax = lib.mkOption {
        type = lib.types.str;
        default = "1G";
        description = ''
          The worker's memory cap. Measured on a 478 MB demo: 19 MB anonymous plus the demo's
          own pages (it is memory-mapped, 470 MB, reclaimable) (journal 2026-11-07-replay-tier).
        '';
      };
      cpuQuota = lib.mkOption {
        type = lib.types.str;
        default = "100%";
        description = "The worker's CPU cap: one core. A 478 MB demo parses in ~5 s.";
      };
      jobTimeoutSec = lib.mkOption {
        type = lib.types.ints.positive;
        default = 300;
        description = "Wall clock per job (decompression and parse); past it the job fails.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    users.users.mapcro = { isSystemUser = true; group = "mapcro"; extraGroups = lib.optional cfg.replay.enable "mapcro-replay"; };
    users.groups.mapcro = { };
    users.users.mapcro-replay = lib.mkIf cfg.replay.enable { isSystemUser = true; group = "mapcro-replay"; };
    users.groups.mapcro-replay = lib.mkIf cfg.replay.enable { };
    systemd.tmpfiles.rules = lib.optionals cfg.replay.enable [
      "d ${queue} 0750 root mapcro-replay -"
      "d ${queue}/inbox 2750 mapcro mapcro-replay -"
      "d ${queue}/outbox 2770 mapcro-replay mapcro-replay -"
      "d ${queue}/work 0700 mapcro-replay mapcro-replay -"
    ];
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
      } // lib.optionalAttrs (cfg.webDir != null) { WEB_DIR = toString cfg.webDir; }
        // lib.optionalAttrs (cfg.packsDir != null) { PACKS_DIR = cfg.packsDir; }
        // lib.optionalAttrs cfg.replay.enable { REPLAY_DIR = queue; };
      serviceConfig = {
        ExecStart = lib.getExe pkg;
        User = "mapcro";
        Group = "mapcro";
        # The packs directory exists even when empty (the server fails fast on a missing PACKS_DIR).
        StateDirectory = [ "mapcro" "mapcro/packs" ];
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
      } // lib.optionalAttrs cfg.replay.enable {
        # The queue only; the server sets its files group-readable (replays.rs).
        ReadWritePaths = [ queue ];
        SupplementaryGroups = [ "mapcro-replay" ];
      };
    };

    # The replay worker: parses untrusted demos, so it gets as little as it can work with. No
    # network, no view of the board server's state or processes, a memory and CPU cap, one job
    # at a time, each in a child under a wall clock (crates/replay/src/worker.rs). Not wanted by
    # the board server: if it crashes or is stopped, uploads queue and the server stays healthy.
    systemd.services.mapcro-replay = lib.mkIf cfg.replay.enable {
      description = "mapcro replay worker (parses demos into match timelines)";
      wantedBy = [ "multi-user.target" ];
      after = [ "systemd-tmpfiles-setup.service" ];
      startLimitIntervalSec = 900;
      startLimitBurst = 8;
      environment = {
        REPLAY_JOB_TIMEOUT_S = toString cfg.replay.jobTimeoutSec;
        REPLAY_MAX_DEM_BYTES = toString (1024 * 1024 * 1024);
      };
      serviceConfig = {
        ExecStart = "${lib.getExe replayPkg} work ${queue}";
        User = "mapcro-replay";
        Group = "mapcro-replay";
        Restart = "on-failure";
        RestartSec = "5s";
        RestartSteps = 5;
        RestartMaxDelaySec = "2min";
        # A job's child killed at the memory cap fails that job; the worker carries on.
        OOMPolicy = "continue";
        MemoryMax = cfg.replay.memoryMax;
        MemorySwapMax = 0;
        CPUQuota = cfg.replay.cpuQuota;
        CPUWeight = 20;
        Nice = 10;
        IOSchedulingClass = "idle";
        TasksMax = 16;
        LimitNOFILE = 64;
        # No file it writes (the expanded demo, the timeline) can pass the demo cap.
        LimitFSIZE = 1100 * 1024 * 1024;
        # Nothing but the queue: /var/lib is empty but for it (the inbox read-only), and there
        # is no network at all.
        TemporaryFileSystem = [ "/var/lib" ];
        BindReadOnlyPaths = [ "${queue}/inbox" ];
        BindPaths = [ "${queue}/outbox" "${queue}/work" ];
        PrivateNetwork = true;
        RestrictAddressFamilies = [ "none" ];
        IPAddressDeny = "any";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        PrivateIPC = true;
        ProtectProc = "invisible";
        ProcSubset = "pid";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        NoNewPrivileges = true;
        CapabilityBoundingSet = [ "" ];
        AmbientCapabilities = [ "" ];
        SystemCallFilter = [ "@system-service" "~@privileged" "~@resources" ];
        SystemCallArchitectures = "native";
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        UMask = "0027";
      };
    };
  };
}
