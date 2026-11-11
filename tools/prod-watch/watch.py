#!/usr/bin/env python3
"""Watch production mapcro and alert the lead when something breaks (docs/deploy.md, "Watching
production"). Run every 15 minutes by a user timer on the dev box. Reads `mapcro-stats` over the
deploy SSH (`just stats`) plus the public /healthz; keeps open alerts in a state file; sends an
alert when one opens, again at most every 6 h while it stays open, and once when it clears.

Alerts go to the lead agent through Paseo (`paseo send`); a site-down alert also goes to the
concierge. Nothing here stores ids: the stats it reads are counts, and failure rows are already
sanitised by the server.

Usage: watch.py [--dry-run]   (--dry-run prints what it would send and saves no state)
"""

import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SITE = "https://mapcro.dmgdeadlock.com/healthz"
CONF = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "mapcro-watch"
STATE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "mapcro-watch.json"
# The lead to alert: ~/.config/mapcro-watch/lead (a Paseo agent id), else this default.
DEFAULT_LEAD = "b80fcb35-3ec8-462e-bfa1-2fd9408e02f2"
CONCIERGE = "89f02356-e7ef-4821-aeb5-eda251c387a0"
WINDOW = "20m"  # a little over the 15 min cadence, so nothing falls between runs
REPEAT_S = 6 * 3600
LIMIT_FRACTION = 0.85
# A stored quantity past this share of its cap, or on course to reach the cap within PLAN_DAYS at
# its 7-day growth, opens a "plan" alert: the retention policy and cheaper storage come next.
PLAN_FRACTION = 0.6
PLAN_DAYS = 30
BACKOFF_S = 1800
# Replay outcomes a user's file or match causes: expected, never an alert.
USER_CODES = {"not_a_replay", "too_large", "old_map", "brawl", "unsupported_mode", "expired", "no_replay", "not_found", "aborted", "corrupt", "rate_limited", "busy", "queue_full"}


def stats(*args: str):
    """`just stats <args> --json`, parsed; None when the host can't be reached."""
    try:
        out = subprocess.run(["just", "stats", *args, "--json"], cwd=REPO, capture_output=True, text=True, timeout=180)
    except subprocess.TimeoutExpired:
        return None
    if out.returncode != 0:
        return None
    try:
        return json.loads(out.stdout)
    except json.JSONDecodeError:
        return None


def site_up() -> bool:
    try:
        # The body too: any unknown path answers 200 with the app's page.
        with urllib.request.urlopen(SITE, timeout=20) as r:
            return r.status == 200 and r.read(64).startswith(b"ok")
    except Exception:
        return False


def checks() -> dict[str, str]:
    """The problems open right now: key -> one-line description."""
    problems: dict[str, str] = {}
    if not site_up():
        problems["site_down"] = f"{SITE} is not answering \"ok\""
    summary = stats("summary", "--since", WINDOW)
    if summary is None:
        problems["stats_unreachable"] = "`just stats summary` failed (SSH to web or mapcro-stats)"
        return problems
    h = summary.get("health", {})
    if (h.get("http_5xx") or 0) > 0:
        problems["http_5xx"] = f"{h['http_5xx']:.0f} server errors (5xx) in the last {WINDOW}"
    for unit, n in (h.get("unit_oom_kills") or {}).items():
        if (n or 0) > 0:
            problems[f"oom:{unit}"] = f"{unit}: {n:.0f} OOM kill(s) in the last {WINDOW}"
    if (h.get("deadlock_api_backoff_peak_s") or 0) > BACKOFF_S:
        problems["deadlock_api_backoff"] = f"deadlock-api backoff peaked at {h['deadlock_api_backoff_peak_s']:.0f} s"
    failures = stats("failures", "--since", WINDOW) or []
    ours = [f for f in failures if f.get("code") not in USER_CODES]
    if ours:
        lines = "; ".join(f"{f['kind']}/{f['code']} ×{f['count']} ({f['message']})" for f in ours[:6])
        problems["failures"] = f"{sum(f['count'] for f in ours)} failure(s) on our side: {lines}"
    for lim in (stats("limits") or {}).get("limits", []):
        cap, now, ago = lim.get("cap"), lim.get("now"), lim.get("week_ago")
        if not cap or now is None:
            continue
        if now / cap >= LIMIT_FRACTION:
            problems[f"limit:{lim['name']}"] = f"{lim['name']} at {now / cap:.0%} of its cap"
            continue
        # Early warnings, so storage and retention work (docs/specs/architecture-design.md,
        # "Data retention") starts before a cap is near. Memory, cpu and the queue swing, so only
        # stored quantities are projected.
        if lim["name"].startswith(("memory", "cpu", "queue")):
            continue
        growth = (now - ago) / 7 if ago is not None else 0.0
        days = (cap - now) / growth if growth > 0 else None
        if now / cap >= PLAN_FRACTION:
            problems[f"plan:{lim['name']}"] = f"{lim['name']} at {now / cap:.0%} of its cap: time to plan storage or retention"
        elif days is not None and days < PLAN_DAYS:
            problems[f"plan:{lim['name']}"] = f"{lim['name']} at {now / cap:.0%} of its cap, on course to reach it in ~{days:.0f} days (7-day trend)"
    return problems


def send(agent: str, text: str, dry: bool) -> None:
    if dry:
        print(f"--- to {agent}:\n{text}\n")
        return
    subprocess.run(["paseo", "send", "--no-wait", agent, "--prompt", text], capture_output=True, timeout=60)


def main() -> int:
    dry = "--dry-run" in sys.argv
    lead = (CONF / "lead").read_text().strip() if (CONF / "lead").exists() else DEFAULT_LEAD
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    now = time.time()
    problems = checks()
    opened, repeated, cleared = [], [], []
    for key, desc in problems.items():
        seen = state.get(key)
        if seen is None:
            opened.append(desc)
            state[key] = {"since": now, "sent": now}
        elif now - seen["sent"] >= REPEAT_S:
            repeated.append(f"{desc} (open {int((now - seen['since']) / 3600)} h)")
            seen["sent"] = now
    for key in [k for k in state if k not in problems]:
        cleared.append(key)
        del state[key]
    if opened or repeated or cleared:
        parts = ["[mapcro prod-watch] Production needs a look." if opened or repeated else "[mapcro prod-watch] Cleared."]
        parts += [f"NEW: {d}" for d in opened] + [f"STILL: {d}" for d in repeated] + [f"cleared: {k}" for k in cleared]
        parts.append("Check `just stats summary` / `just stats failures` in /storage/projects/mapcro.")
        text = "\n".join(parts)
        send(lead, text, dry)
        if "site_down" in problems and (opened or repeated):
            send(CONCIERGE, "[mapcro prod-watch] mapcro.dmgdeadlock.com/healthz is down; the mapcro lead has been alerted.", dry)
    elif dry:
        print("all clear")
    if not dry:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(state))
    return 0


if __name__ == "__main__":
    sys.exit(main())
