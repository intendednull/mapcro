#!/usr/bin/env bash
# Is the shared dev box busy? Exit 0 = busy (wait), 1 = free.
# Busy when `box-state` (the machine's tracker; it knows Adora's heavy jobs, load, memory and
# heat) says busy, or one of Adora's heavy jobs runs here, or the 1-minute load is 12 or more.
# Operator (2026-11-14): mapcro and Adora take turns; there is no shared lock. Match the command
# itself (argv[0], or a shell running the script), not a Fly delegation (`delegate.sh --where
# sprite ...`) that only names one in its arguments. box-state exits 0 busy, 1 free, 2 error;
# an error falls through to the checks below.
if command -v box-state >/dev/null 2>&1; then
  box-state >/dev/null 2>&1
  [ $? -eq 0 ] && exit 0
fi
ps -eo args= | grep -qE '^(\S*/)?cargo(-xtask)? xtask (verify|android)|^(\S*/)?(ba|z)?sh (\S*/)?land_unit\.sh|^(\S*/)?land_unit\.sh|^(\S*/)?adora-deploy|h2-build-[0-9]+/verify' \
  || [ "$(cut -d' ' -f1 /proc/loadavg | cut -d. -f1)" -ge 12 ]
