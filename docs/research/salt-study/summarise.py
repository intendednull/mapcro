#!/usr/bin/env python3
"""Summarise the salt study's obs.jsonl.

Usage: summarise.py [OBS_JSONL]   (default /tmp/salt-study/obs.jsonl)
"""

import json
import sys
from collections import defaultdict

OBS = sys.argv[1] if len(sys.argv) > 1 else "/tmp/salt-study/obs.jsonl"
LABELS = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "8h", "16h", "32h"]


def pct(a, b):
    return f"{a}/{b} ({100 * a / b:.0f}%)" if b else "0/0"


def main():
    recs = [json.loads(line) for line in open(OBS) if line.strip()]
    kinds = defaultdict(int)
    for r in recs:
        kinds[r["kind"]] += 1
    start = next((r for r in recs if r["kind"] == "start"), None)
    last = recs[-1] if recs else None
    if start and last:
        print(f"span {start['iso']} .. {last['iso']} ({(last['t'] - start['t']) / 3600:.1f} h)")
    print("records:", dict(kinds))
    admitted = {r["match"] for r in recs if r["kind"] == "admit"}
    ended = {r["match"] for r in recs if r["kind"] == "ended"}
    print(f"fresh matches admitted {len(admitted)}, ended {len(ended)}")

    free = [r for r in recs if r["kind"] == "free" and r["cat"] == "fresh"]
    print("\nFree reads (disable_steam=true) of fresh standard matches, by nominal age after end:")
    print(f"{'age':>5} {'reads':>5} {'salts200':>9} {'row has replay_salt':>22} {'meta 200':>14} {'CDN HEAD 200':>13}")
    for lab in LABELS:
        rs = [r for r in free if r["label"] == lab]
        ok = [r for r in rs if r["salts_status"] == 200]
        rep = [r for r in ok if r.get("has_replay_salt")]
        meta = [r for r in rs if r.get("meta_status") == 200]
        head = [r for r in rep if r.get("cdn_head") == 200]
        print(f"{lab:>5} {len(rs):>5} {len(ok):>9} {pct(len(rep), len(ok)):>22} "
              f"{pct(len(meta), len(rs)):>14} {pct(len(head), len(rep)):>13}")
    other = defaultdict(int)
    for r in free:
        if r["salts_status"] != 200:
            other[(r["salts_status"], r.get("reason"))] += 1
    if other:
        print("non-200 salts reads:", dict(other))

    first = {}
    for r in free:
        if r.get("has_replay_salt") and r["match"] not in first:
            first[r["match"]] = r
    if first:
        print("\nFirst free read showing a replay_salt (match: nominal label, actual age, CDN HEAD):")
        for mid, r in sorted(first.items()):
            print(f"  {mid}: {r['label']}, {r['age_s'] / 60:.0f} min, HEAD {r.get('cdn_head')}")

    print("\nSteam-capable reads:")
    for r in recs:
        if r["kind"] == "steam":
            age = f"{r['age_s'] / 60:.0f} min" if r.get("age_s") is not None else "-"
            print(f"  {r['iso']} match {r['match']} ({r['cat']}, target {r['label']}, age {age}): "
                  f"status {r['salts_status']} reason {r.get('reason')} "
                  f"replay_salt {r.get('has_replay_salt')} metadata_salt {r.get('has_metadata_salt')} "
                  f"HEAD {r.get('cdn_head')}")
        elif r["kind"] == "steam_stopped":
            print(f"  {r['iso']} STOPPED: {r['why']}")

    print("\nControls (free reads):")
    by = defaultdict(list)
    for r in recs:
        if r["kind"] == "free" and r["cat"].startswith("control"):
            by[(r["cat"], r["match"])].append(r)
    for (cat, mid), rs in sorted(by.items()):
        seq = " ".join(f"{r['salts_status']}/{'R' if r.get('has_replay_salt') else '-'}"
                       f"{'/H' + str(r['cdn_head']) if r.get('cdn_head') else ''}" for r in rs)
        print(f"  {cat:16} {mid}: {seq}")

    print("\nNo-row search:")
    tries = [r for r in recs if r["kind"] == "norow_try"]
    print(f"  tries {len(tries)}: " + ", ".join(
        f"{r['salts_status']}/{r.get('reason') or ('R' if r.get('has_replay_salt') else '-')}" for r in tries))
    for r in recs:
        if r["kind"] in ("norow_found", "norow_mode") or (r["kind"] == "free" and r["cat"] == "norow"):
            print("  ", {k: v for k, v in r.items() if k not in ("t",)})

    backs = [r for r in recs if r["kind"] == "backoff"]
    if backs:
        print(f"\nbackoffs: {len(backs)}; statuses {sorted({r['status'] for r in backs})}")
    errs = [r for r in recs if r["kind"] == "error"]
    if errs:
        print(f"errors: {len(errs)}")


if __name__ == "__main__":
    main()
