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
    metricsAddr = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = "127.0.0.1:9464";
      description = ''
        Where the server serves `/metrics` (Prometheus text, docs/specs/observability.md):
        a loopback address and port of its own, never the public `port`, so Caddy can't proxy
        it (the server refuses a non-loopback one). If the port is taken the server logs it and
        runs without `/metrics`; its minute snapshots and `mapcro-stats` don't depend on it.
        null: off.
      '';
    };
    createPerHour = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = "Boards one client IP may create per hour.";
    };
    deadlockApiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/deadlock-api-key";
      description = ''
        A file holding a deadlock-api key, passed to the server as a systemd credential (never
        in the environment or the store). With it, deadlock-api allows 300 Steam-sourced salts
        lookups an hour instead of 3 per address. null: no key.
      '';
    };
    feedbackGithubTokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/mapcro-feedback-github-token";
      description = ''
        A file holding a fine-grained GitHub token (this repository only, Issues: read and
        write), passed to the server as a systemd credential (never in the environment or the
        store). With it, the feedback form opens issues on `feedbackGithubRepo`
        (docs/deploy.md). null: the form is off and its button hidden.
      '';
    };
    feedbackGithubRepo = lib.mkOption {
      type = lib.types.str;
      default = "intendednull/mapcro";
      description = "The `owner/repo` feedback issues are opened on.";
    };
    feedbackPerClientPerHour = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 100;
      description = "Feedback issues one client (an IPv4 address or an IPv6 /64) may open per hour.";
    };
    feedbackGlobalPerDay = lib.mkOption {
      type = lib.types.ints.unsigned;
      default = 500;
      description = "Feedback issues the server opens per day, from everyone together.";
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
      workers = lib.mkOption {
        type = lib.types.ints.positive;
        default = 2;
        description = ''
          Demos parsed at once, each in its own child under its own wall clock. A parse is CPU
          bound on one core (a 504 MB demo: ~5 s), so on the 3-core `web` host 2 leaves a core
          for everything else (journal 2026-11-08-replay-capacity).
        '';
      };
      memoryMax = lib.mkOption {
        type = lib.types.str;
        default = "${toString (cfg.replay.workers * 192)}M";
        defaultText = lib.literalExpression ''"''${toString (workers * 192)}M"'';
        description = ''
          The worker's memory cap, 192M a parse by default (was 384M until 2026-11-11; prod's peak since the streamed parse: 33 MB anonymous a parse, 221 MB cgroup with reclaimable page cache). Measured on the real 504 MB demo
          (format 9, 2026-11-11, streamed parse): 33 MB anonymous from a .dem, 36 MB from zstd
          (a 2 MiB window), 37 MB from bzip2, and VmHWM 37-40 MB: the demo is read, not mapped,
          so there are no file pages to reclaim. One parses under a 34M cap. The headroom covers
          a zstd window (at most 128 MiB; the job record's `zstd_window_bytes` says what
          downloads use).
        '';
      };
      cpuQuota = lib.mkOption {
        type = lib.types.str;
        default = "${toString (cfg.replay.workers * 100)}%";
        defaultText = lib.literalExpression ''"''${toString (workers * 100)}%"'';
        description = "The worker's CPU cap: one core a parse, at a low CPU weight.";
      };
      queueBytes = lib.mkOption {
        type = lib.types.ints.positive;
        default = 8 * 1024 * 1024 * 1024;
        defaultText = lib.literalExpression "8 GiB";
        description = ''
          Bytes the queue may hold: queued demos (fetched ones compressed, ~330 MB; uploads raw,
          ~500 MB) and transfers under way at their size. A compressed demo decompresses into
          the parse, so nothing expanded is written beside them (since 2026-11-11).
        '';
      };
      queuedJobs = lib.mkOption {
        type = lib.types.ints.positive;
        default = 24;
        description = "Jobs on disk or on their way there at once; more wait in line.";
      };
      uploadsAtOnce = lib.mkOption {
        type = lib.types.ints.positive;
        default = 4;
        description = "Uploads streaming at once (one per client); more wait in line.";
      };
      downloadsAtOnce = lib.mkOption {
        type = lib.types.ints.positive;
        default = 2;
        description = "Downloads from Valve's CDN at once; more wait in line.";
      };
      maxWaiting = lib.mkOption {
        type = lib.types.ints.positive;
        default = 64;
        description = ''
          Transfers waiting in line past which a new one is refused ("Busy. Try again in a few
          minutes."): the last resort for a backlog that won't clear soon.
        '';
      };
      jobTimeoutSec = lib.mkOption {
        type = lib.types.ints.positive;
        default = 300;
        description = "Wall clock per job (decompression and parse); past it the job fails.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # `sudo -u mapcro mapcro-stats summary`: the read-only metrics queries against the live
    # database (`mapcro-server stats`, docs/specs/observability.md §4; `just stats` runs it).
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "mapcro-stats" ''
        exec ${lib.getExe pkg} stats --data-dir /var/lib/mapcro "$@"
      '')
    ];
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
        // lib.optionalAttrs (cfg.metricsAddr != null) { METRICS_ADDR = cfg.metricsAddr; }
        // lib.optionalAttrs (cfg.packsDir != null) { PACKS_DIR = cfg.packsDir; }
        // lib.optionalAttrs cfg.replay.enable {
          REPLAY_DIR = queue;
          REPLAY_WORKERS = toString cfg.replay.workers;
          REPLAY_MAX_QUEUE_BYTES = toString cfg.replay.queueBytes;
          REPLAY_MAX_QUEUED = toString cfg.replay.queuedJobs;
          REPLAY_UPLOADS_AT_ONCE = toString cfg.replay.uploadsAtOnce;
          REPLAY_DOWNLOADS_AT_ONCE = toString cfg.replay.downloadsAtOnce;
          REPLAY_MAX_WAITING = toString cfg.replay.maxWaiting;
        }
        # The key's path, not its value: systemd hands the file to this unit as a credential.
        // lib.optionalAttrs (cfg.deadlockApiKeyFile != null) { DEADLOCK_API_KEY_FILE = "%d/deadlock-api-key"; }
        // {
          FEEDBACK_GITHUB_REPO = cfg.feedbackGithubRepo;
          FEEDBACK_PER_CLIENT_PER_HOUR = toString cfg.feedbackPerClientPerHour;
          FEEDBACK_GLOBAL_PER_DAY = toString cfg.feedbackGlobalPerDay;
        }
        // lib.optionalAttrs (cfg.feedbackGithubTokenFile != null) { FEEDBACK_GITHUB_TOKEN_FILE = "%d/feedback-github-token"; };
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
      } // lib.optionalAttrs (cfg.deadlockApiKeyFile != null || cfg.feedbackGithubTokenFile != null) {
        LoadCredential =
          lib.optional (cfg.deadlockApiKeyFile != null) "deadlock-api-key:${cfg.deadlockApiKeyFile}"
          ++ lib.optional (cfg.feedbackGithubTokenFile != null) "feedback-github-token:${cfg.feedbackGithubTokenFile}";
      };
    };

    # The replay worker: parses untrusted demos, so it gets as little as it can work with. No
    # network, no view of the board server's state or processes, a memory and CPU cap, `workers`
    # jobs at a time, each in a child under its own wall clock (crates/replay/src/worker.rs). Not wanted by
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
        REPLAY_WORKERS = toString cfg.replay.workers;
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
        TasksMax = 8 + 4 * cfg.replay.workers;
        LimitNOFILE = 64;
        # It writes only timelines and job records (the parse is streamed): a timeline is
        # ~1.5 MB (129738985), so 64 MiB is ample.
        LimitFSIZE = 64 * 1024 * 1024;
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
