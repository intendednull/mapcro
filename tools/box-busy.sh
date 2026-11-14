#!/usr/bin/env bash
# Is the shared dev box busy? Exit 0 = busy (wait), 1 = free.
# Busy when one of Adora's heavy jobs runs on this machine, or the 1-minute load is 12 or more.
# Operator (2026-11-14): mapcro and Adora take turns; there is no shared lock. Match the command
# itself (argv[0], or a shell running the script), not a Fly delegation (`delegate.sh --where
# sprite ...`) that only names one in its arguments.
ps -eo args= | grep -qE '^(\S*/)?cargo(-xtask)? xtask (verify|android)|^(\S*/)?(ba|z)?sh (\S*/)?land_unit\.sh|^(\S*/)?land_unit\.sh|^(\S*/)?adora-deploy|h2-build-[0-9]+/verify' \
  || [ "$(cut -d' ' -f1 /proc/loadavg | cut -d. -f1)" -ge 12 ]
