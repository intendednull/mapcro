#!/usr/bin/env python3
"""mapcro salt study: when does a fresh Deadlock match's replay_salt appear at deadlock-api?

Standalone, stdlib only; every HTTP request goes through curl (its default User-Agent).
Writes observations as JSONL. It never stores account ids, player fields or salt values:
/active bodies are reduced to (match_id, game_mode, match_mode, start_time) in memory, and a
salts body is reduced to which fields are present plus cluster_id. A Valve CDN URL is built
in memory for a HEAD request and dropped; only the HTTP status and content-length are kept.

Usage: probe.py [DATA_DIR]   (default /tmp/salt-study)
See docs/research/deadlock-api-salts.md in the mapcro repo for the design.
"""

import json
import os
import random
import shutil
import subprocess
import sys
import time

API = "https://api.deadlock-api.com"
DATA = sys.argv[1] if len(sys.argv) > 1 else "/tmp/salt-study"
OBS = os.path.join(DATA, "obs.jsonl")
STATE = os.path.join(DATA, "state.json")
CURL = shutil.which("curl") or "/run/current-system/sw/bin/curl"

RUN_FOR = 38 * 3600          # the probe stops itself; the unit's RuntimeMaxSec is 40 h
TICK = 30                    # main loop period, s
ACTIVE_EVERY = 300           # /v1/matches/active period, s
MAX_TRACKED = 40             # fresh standard matches to follow
ADMIT_PER_POLL = 2           # spread admissions over ~100 min
STANDARD_GAME_MODE = 1       # KECitadelGameModeNormal (6v6); 4 is Street Brawl
MATCH_MODES = (1, 4)         # Unranked, Ranked
# Free (disable_steam=true) reads after a match ended, in seconds.
OFFSETS = [("1m", 60), ("5m", 300), ("15m", 900), ("30m", 1800), ("1h", 3600),
           ("2h", 7200), ("4h", 14400), ("8h", 28800), ("16h", 57600), ("32h", 115200)]
# Steam-capable reads (no disable_steam): target ages and how many matches each.
STEAM_TARGETS = [("10m", 600), ("1h", 3600), ("2h", 7200), ("6h", 21600),
                 ("12h", 43200), ("24h", 86400)]
STEAM_PER_TARGET = 3
STEAM_PER_HOUR = 2           # strict, rolling 3600 s window; leaves 1/h for the dev server
STEAM_MIN_GAP = 25 * 60
# Controls: older matches known (2026-11-08) to have a replay_salt, and older matches seen
# without one (Step 0 of docs/research/browser-side-replays.md, and 133149705).
CONTROLS_WITH = [129738985, 130816395, 132777205]
CONTROLS_WITHOUT = [133942291, 133942783, 133944663, 133149705]
CONTROL_EVERY = 4 * 3600
# Search for a match with no salts row at all.
NOROW_SEARCH_EVERY = 20 * 60
NOROW_MAX_TRIES = 40
MIN_GAP = 2.0                # s between any two deadlock-api requests


def now():
    return time.time()


def log(kind, **fields):
    rec = {"t": round(now(), 1), "iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "kind": kind}
    rec.update(fields)
    with open(OBS, "a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


def err(msg):
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- HTTP via curl

class Api:
    """deadlock-api calls with spacing and a shared back-off on 429 / 5xx / network errors."""

    def __init__(self, st):
        self.st = st
        self.last = 0.0

    def paused(self):
        return now() < self.st["pause_until"]

    def _curl(self, args, body):
        wait = self.last + MIN_GAP - now()
        if wait > 0:
            time.sleep(wait)
        self.last = now()
        w = "\n%{http_code}\t%{size_download}\t%header{cf-cache-status}\t%header{age}\t%header{retry-after}"
        cmd = [CURL, "-s", "--connect-timeout", "10", "--max-time", "90", "-w", w]
        if not body:
            cmd += ["-o", "/dev/null"]
        cmd += args
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=120).stdout
        except subprocess.TimeoutExpired:
            out = b"\n000\t0\t\t\t"
        payload, _, tail = out.rpartition(b"\n")
        parts = (tail.decode("ascii", "replace").split("\t") + [""] * 5)[:5]
        code = int(parts[0]) if parts[0].isdigit() else 0
        meta = {"status": code, "size": int(parts[1]) if parts[1].isdigit() else 0,
                "cf": parts[2] or None, "age": parts[3] or None}
        self._account(code, parts[4])
        return meta, payload

    def _account(self, code, retry_after):
        st = self.st
        self.st["calls"] += 1
        if code == 429 or code >= 500 or code == 0:
            ra = int(retry_after) if retry_after.isdigit() else 0
            st["backoff"] = min(max(st["backoff"] * 2, 60), 1800)
            st["pause_until"] = now() + max(ra, st["backoff"])
            log("backoff", status=code, retry_after=ra or None, pause_s=round(st["pause_until"] - now()))
        else:
            st["backoff"] = 0

    def get_json(self, path):
        meta, payload = self._curl([API + path], body=True)
        data = None
        if payload:
            try:
                data = json.loads(payload)
            except ValueError:
                data = None
        return meta, data

    def get_size(self, path):
        meta, _ = self._curl([API + path], body=False)
        return meta


def cdn_head(cluster, match_id, salt):
    """HEAD the replay on Valve's CDN; keeps status and content-length only."""
    url = f"http://replay{cluster}.valve.net/1422450/{match_id}_{salt}.dem.bz2"
    cmd = [CURL, "-s", "-I", "-o", "/dev/null", "--connect-timeout", "10", "--max-time", "30",
           "-w", "%{http_code}\t%header{content-length}", url]
    del url
    try:
        out = subprocess.run(cmd, capture_output=True, timeout=45).stdout.decode("ascii", "replace")
    except subprocess.TimeoutExpired:
        out = "000\t"
    code, _, length = out.partition("\t")
    return int(code) if code.isdigit() else 0, int(length) if length.isdigit() else None


# ---------------------------------------------------------------- reads

def reason(data):
    """Error bodies reduced to a fixed reason code (the raw text is not stored)."""
    if isinstance(data, dict):
        text = json.dumps(data)
    else:
        text = str(data or "")
    for needle, code in [("has metadata already", "has_metadata"),
                         ("Steam fallback is disabled", "not_in_db"),
                         ("Failed to fetch", "steam_failed"), ("not found", "not_found"),
                         ("ate limit", "rate_limited")]:
        if needle in text:
            return code
    return None


def read_salts(api, match_id, steam):
    path = f"/v1/matches/{match_id}/salts" + ("" if steam else "?disable_steam=true")
    meta, data = api.get_json(path)
    obs = {"salts_status": meta["status"], "cf": meta["cf"], "cf_age": meta["age"]}
    salt = None
    if meta["status"] == 200 and isinstance(data, dict):
        obs["has_cluster"] = data.get("cluster_id") is not None
        obs["has_metadata_salt"] = data.get("metadata_salt") is not None
        obs["has_replay_salt"] = data.get("replay_salt") not in (None, 0)
        obs["cluster_id"] = data.get("cluster_id")
        if obs["has_replay_salt"] and obs["has_cluster"]:
            salt = (data["cluster_id"], data["replay_salt"])
    else:
        obs["reason"] = reason(data)
    data = None
    return obs, salt


def free_read(api, st, m, label, steam=False, with_meta=True):
    m["last_read"] = now()
    obs, salt = read_salts(api, m["id"], steam)
    if with_meta and not steam:
        mm = api.get_size(f"/v1/matches/{m['id']}/metadata?disable_steam=true")
        obs["meta_status"], obs["meta_size"] = mm["status"], mm["size"]
    if salt:
        code, length = cdn_head(salt[0], m["id"], salt[1])
        obs["cdn_head"], obs["cdn_length"] = code, length
        if not m.get("replay_seen"):
            m["replay_seen"] = now()
    salt = None
    ended = m.get("ended")
    log("steam" if steam else "free", match=m["id"], cat=m["cat"], label=label,
        age_s=round(now() - ended) if ended else None, **obs)
    m["last_has_replay"] = obs.get("has_replay_salt")
    return obs


# ---------------------------------------------------------------- state

def load_state():
    if os.path.exists(STATE):
        with open(STATE) as f:
            return json.load(f)
    st = {"started": now(), "calls": 0, "pause_until": 0, "backoff": 0, "last_active": 0,
          "matches": {}, "steam_times": [], "steam_disabled": False, "steam_done": {},
          "norow_tries": 0, "norow_last": 0, "norow_found": None, "control_last": 0,
          "max_seen_id": 0}
    for mid in CONTROLS_WITH:
        st["matches"][str(mid)] = {"id": mid, "cat": "control_with", "done": []}
    for mid in CONTROLS_WITHOUT:
        st["matches"][str(mid)] = {"id": mid, "cat": "control_without", "done": []}
    return st


def save_state(st):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
    os.replace(tmp, STATE)


# ---------------------------------------------------------------- loop steps

def poll_active(api, st):
    meta, data = api.get_json("/v1/matches/active")
    st["last_active"] = now()
    if meta["status"] != 200 or not isinstance(data, list):
        log("active", status=meta["status"])
        return
    # Reduce to the four fields we keep; players and every other field are dropped here.
    live = {}
    for x in data:
        if isinstance(x, dict) and isinstance(x.get("match_id"), int):
            live[x["match_id"]] = (x.get("game_mode"), x.get("match_mode"), x.get("start_time"))
    data = None
    t = now()
    if live:
        st["max_seen_id"] = max(st["max_seen_id"], max(live))
    tracked = [m for m in st["matches"].values() if m["cat"] == "fresh"]
    for m in tracked:
        if m["id"] in live:
            if m.get("ended"):
                log("reappeared", match=m["id"], gone_s=round(t - m["ended"]))
                m["ended"] = None
            m["last_seen"] = t
        elif not m.get("ended"):
            m["ended"] = m["last_seen"]
            m["ended_detected"] = t
            log("ended", match=m["id"], live_s=round(m["last_seen"] - m["first_seen"]),
                started_ago_s=round(t - m["start_time"]) if m.get("start_time") else None)
    admitted = 0
    standard = [mid for mid, (gm, mm, _) in live.items()
                if gm == STANDARD_GAME_MODE and mm in MATCH_MODES]
    # Newest first, so admitted matches have most of their game still to play.
    for mid in sorted(standard, reverse=True):
        if len(tracked) + admitted >= MAX_TRACKED or admitted >= ADMIT_PER_POLL:
            break
        if str(mid) in st["matches"]:
            continue
        gm, mm, start = live[mid]
        st["matches"][str(mid)] = {"id": mid, "cat": "fresh", "game_mode": gm, "match_mode": mm,
                                   "start_time": start, "first_seen": t, "last_seen": t,
                                   "ended": None, "done": []}
        log("admit", match=mid, game_mode=gm, match_mode=mm,
            started_ago_s=round(t - start) if start else None)
        admitted += 1
    log("active", status=200, n=len(live), standard=len(standard), admitted=admitted,
        tracked=len(tracked) + admitted)


def due_free_reads(st):
    t = now()
    out = []
    for m in st["matches"].values():
        if m["cat"] not in ("fresh", "norow") or not m.get("ended"):
            continue
        for label, off in OFFSETS:
            if label not in m["done"] and t >= m["ended"] + off:
                out.append((m["ended"] + off, m, label))
                break  # one at a time per match; the next comes on a later tick
    out.sort(key=lambda x: x[0])
    return out


def steam_allowed(st):
    if st["steam_disabled"]:
        return False
    t = now()
    st["steam_times"] = [x for x in st["steam_times"] if t - x < 3600]
    if len(st["steam_times"]) >= STEAM_PER_HOUR:
        return False
    return not st["steam_times"] or t - max(st["steam_times"]) >= STEAM_MIN_GAP


def spend_steam(api, st, m, label):
    st["steam_times"].append(now())
    obs = free_read(api, st, m, label, steam=True)
    m.setdefault("steam", []).append(label)
    if obs["salts_status"] == 429:
        st["steam_disabled"] = True
        log("steam_stopped", why="429")
    return obs


def maybe_steam(api, st):
    if not steam_allowed(st):
        return
    t = now()
    nr = st["norow_found"]
    if nr and not nr.get("steam_done"):
        m = st["matches"][str(nr["id"])]
        obs = spend_steam(api, st, m, "norow")
        nr["steam_done"] = True
        m["ended"] = now()  # anchor its free reads on the Steam read
        return
    order = sorted(STEAM_TARGETS, key=lambda x: (st["steam_done"].get(x[0], 0), x[1]))
    for label, age in order:
        if st["steam_done"].get(label, 0) >= STEAM_PER_TARGET:
            continue
        for m in st["matches"].values():
            if m["cat"] != "fresh" or not m.get("ended") or m.get("steam"):
                continue
            a = t - m["ended"]
            if not (age <= a <= age * 1.5 + 300):
                continue
            if m.get("last_has_replay"):
                continue  # a replay_salt is already there; nothing to learn from Steam
            if t - m.get("last_read", 0) < 90:
                continue  # the API caches salts per match for 60 s, whatever the flag
            spend_steam(api, st, m, label)
            st["steam_done"][label] = st["steam_done"].get(label, 0) + 1
            return


def maybe_norow(api, st):
    if st["norow_found"] or st["norow_tries"] >= NOROW_MAX_TRIES or not st["max_seen_id"]:
        return
    if now() - st["norow_last"] < NOROW_SEARCH_EVERY:
        return
    st["norow_last"] = now()
    st["norow_tries"] += 1
    mid = st["max_seen_id"] - random.randint(30_000, 400_000)
    obs, _ = read_salts(api, mid, steam=False)
    log("norow_try", match=mid, **obs)
    if obs["salts_status"] == 404 and obs.get("reason") == "not_in_db":
        st["norow_found"] = {"id": mid, "found": now()}
        st["matches"][str(mid)] = {"id": mid, "cat": "norow", "ended": None, "done": []}
        log("norow_found", match=mid)


def maybe_controls(api, st):
    if now() - st["control_last"] < CONTROL_EVERY:
        return
    st["control_last"] = now()
    for m in st["matches"].values():
        if m["cat"].startswith("control"):
            free_read(api, st, m, "control")


def norow_mode(api, st):
    """Once the no-row control's metadata is readable, keep only its game_mode."""
    nr = st["norow_found"]
    if not nr or not nr.get("steam_done") or "game_mode" in nr:
        return
    if now() - st["matches"][str(nr["id"])]["ended"] < 1800:
        return
    meta, data = api.get_json(f"/v1/matches/{nr['id']}/metadata?disable_steam=true")
    gm = None
    if isinstance(data, dict):
        gm = (data.get("match_info") or {}).get("game_mode")
    data = None
    nr["game_mode"] = gm
    log("norow_mode", match=nr["id"], meta_status=meta["status"], game_mode=gm)


def main():
    os.makedirs(DATA, exist_ok=True)
    st = load_state()
    api = Api(st)
    log("start", resumed=st["calls"] > 0, calls=st["calls"])
    while now() - st["started"] < RUN_FOR:
        try:
            if not api.paused():
                if now() - st["last_active"] >= ACTIVE_EVERY:
                    poll_active(api, st)
                for _, m, label in due_free_reads(st)[:12]:
                    if api.paused():
                        break
                    free_read(api, st, m, label)
                    m["done"].append(label)
                if not api.paused():
                    maybe_steam(api, st)
                if not api.paused():
                    maybe_controls(api, st)
                if not api.paused():
                    maybe_norow(api, st)
                if not api.paused():
                    norow_mode(api, st)
        except Exception as e:  # keep going; the error text holds no ids or salts
            err(f"tick error: {type(e).__name__}: {e}")
            log("error", what=type(e).__name__)
        save_state(st)
        time.sleep(TICK)
    log("stop", calls=st["calls"])


if __name__ == "__main__":
    main()
