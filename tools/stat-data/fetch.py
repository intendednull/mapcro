"""Fetch boon-data snapshots for the pack's per-patch stat tables (docs/research/stat-calc-spike.md,
"Production plan"; boon-data: github.com/pnxenopoulos/boon-data, scripts MIT, data Valve's).

    python3 -I tools/stat-data/fetch.py <dir outside the repo>

Writes <dir>/versions.json (boon-data's manifest) and, per distinct snapshot,
<dir>/<snapshot>/{heroes,abilities,misc}.json, each checked against the manifest's SHA-256. Files
already present with the right hash are kept, so a re-run fetches only new snapshots. The
extractor reads the directory (`just extract <citadel> <out> --stat-data <dir>`) and checks the
hashes again. Valve's data never enters the repo: the directory must be outside it."""
import hashlib, json, os, sys, urllib.request

MANIFEST = "https://raw.githubusercontent.com/pnxenopoulos/boon-data/data-index/versions.json"
FILES = ("heroes.json", "abilities.json", "misc.json")
REPO = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mapcro-stat-data"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = os.path.realpath(sys.argv[1])
    if out == REPO or out.startswith(REPO + os.sep):
        sys.exit("refusing to write inside the repository: Valve's data never enters it")
    os.makedirs(out, exist_ok=True)
    manifest = get(MANIFEST)
    versions = json.loads(manifest)["versions"]
    snapshots = sorted({v["snapshot"] for v in versions.values()}, key=int)
    fetched = kept = 0
    for snap in snapshots:
        artifacts = versions[snap]["artifacts"]
        os.makedirs(os.path.join(out, snap), exist_ok=True)
        for name in FILES:
            want = artifacts[name]["sha256"]
            path = os.path.join(out, snap, name)
            if os.path.exists(path):
                with open(path, "rb") as f:
                    if sha(f.read()) == want:
                        kept += 1
                        continue
            data = get(artifacts[name]["url"])
            if sha(data) != want:
                sys.exit(f"{snap}/{name}: hash mismatch, nothing written for it")
            with open(path + ".part", "wb") as f:
                f.write(data)
            os.replace(path + ".part", path)
            fetched += 1
    # Written last: the extractor trusts only a manifest whose snapshots are all on disk.
    with open(os.path.join(out, "versions.json"), "wb") as f:
        f.write(manifest)
    print(f"{len(versions)} builds, {len(snapshots)} snapshots ({snapshots[0]}..{snapshots[-1]}): {fetched} fetched, {kept} kept")


if __name__ == "__main__":
    main()
