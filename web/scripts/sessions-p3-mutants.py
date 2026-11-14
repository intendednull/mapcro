#!/usr/bin/env python3
# Hand mutation run over the phase 3 client logic: each mutant is one edit; the two test files
# must fail with it. Usage: run.py <worktree>
import subprocess, sys, pathlib
wt = pathlib.Path(sys.argv[1])
M = [
 ("web/src/session/pool.ts", "      if (p.board !== board) continue;\n", "", "take: another board's parked session is touched"),
 ("web/src/session/pool.ts", "if (k === key && this.now() - p.at < this.limits.ageMs) hit", "if (this.now() - p.at < this.limits.ageMs) hit", "take: the credential isn't checked"),
 ("web/src/session/pool.ts", "this.now() - p.at < this.limits.ageMs) hit", "this.now() - p.at <= this.limits.ageMs) hit", "take: given at its time's end"),
 ("web/src/session/pool.ts", "      else p.session.end();\n", "", "take: another credential's session isn't ended"),
 ("web/src/session/pool.ts", "if (this.closed || session.connection.kind === \"closed\") return session.end();", "if (this.closed) return session.end();", "park: a refused link is kept"),
 ("web/src/session/pool.ts", "if (this.closed || session.connection.kind === \"closed\") return session.end();", "if (session.connection.kind === \"closed\") return session.end();", "park: kept after close"),
 ("web/src/session/pool.ts", "if (bytes > this.limits.bytes) return session.end();", "if (bytes >= this.limits.bytes) return session.end();", "park: exactly the budget refused"),
 ("web/src/session/pool.ts", "if (bytes > this.limits.bytes) return session.end();", "", "park: one over the whole budget is kept"),
 ("web/src/session/pool.ts", "this.parked.size <= this.limits.max &&", "this.parked.size < this.limits.max &&", "trim: two kept, not three"),
 ("web/src/session/pool.ts", "this.parked.size <= this.limits.max &&", "", "trim: no count limit"),
 ("web/src/session/pool.ts", "total() <= this.limits.bytes) break;", "total() < this.limits.bytes) break;", "trim: exactly the budget dropped"),
 ("web/src/session/pool.ts", " && total() <= this.limits.bytes) break;", ") break;", "trim: no byte limit"),
 ("web/src/session/pool.ts", "const old = this.now() - p.at >= this.limits.ageMs;", "const old = false;", "trim: no age limit"),
 ("web/src/session/pool.ts", "return via ? `${board}\\u0000${token}\\u0000${via.session}\\u0000${via.grant}` : `${board}\\u0000${token}`;", "return `${board}\\u0000${token}`;", "key: the grant isn't in it"),
 ("web/src/session/pool.ts", "\\u0000${via.session}\\u0000${via.grant}`", "\\u0000${via.grant}`", "key: the session isn't in it"),
 ("web/src/session/pool.ts", "    queueMicrotask(() => {\n      this.settling = false;\n      if (this.closed) return;\n      this.trim();\n      this.arm();\n    });", "    this.settling = false;\n    this.trim();\n    this.arm();", "settle: trimmed before the switch's take"),
 ("web/src/session/pool.ts", "    this.closed = true;\n", "", "close: not remembered"),
 ("web/src/session/pool.ts", "    for (const p of this.parked.values()) p.session.end();\n    this.parked.clear();", "    this.parked.clear();", "close: sessions not ended"),
 ("web/src/session/tabview.ts", "typeof v !== \"object\" || v.board !== board) return undefined;", "typeof v !== \"object\") return undefined;", "parse: another board's view restored"),
 ("web/src/session/tabview.ts", "all.sort((a, b) => a.at - b.at);", "all.sort((a, b) => b.at - a.at);", "save: the newest dropped"),
 ("web/src/session/tabview.ts", "if (all.length <= MAX_TAB_VIEWS) return;", "return;", "save: no cap"),
 ("web/src/session/tabview.ts", "if (view.scene === undefined || live(view.scene)) return view;", "if (view.scene === undefined || !live(view.scene)) return view;", "withScenes: a dead scene kept"),
 ("web/src/session/tabview.ts", "const { scene: _scene, view: _view, viewpoint: _viewpoint, ...rest } = view;\n  return rest;", "const { scene: _scene, ...rest } = view;\n  return rest;", "withScenes: the viewport outlives its scene"),
 ("web/src/session/tabview.ts", "attached.includes(Number(view.match))) return view;", "attached.includes(view.match as never)) return view;", "withMatches: never attached"),
 ("web/src/session/tabview.ts", "const { match: _match, t: _t, playing: _playing, speed: _speed, mode: _mode, ...rest } = view;", "const { match: _match, ...rest } = view;", "withMatches: playback outlives its match"),
 ("web/src/session/tabview.ts", "if (typeof v.scene === \"string\" && /^[0-9a-f]{32}$/.test(v.scene)) out.scene = v.scene;", "if (typeof v.scene === \"string\") out.scene = v.scene;", "parse: any string is a scene"),
 ("web/src/session/tabview.ts", "num(r.x) && num(r.y) && num(r.w) && r.w > 0", "num(r.x) && num(r.w) && r.w > 0", "parse: a view with a bad y"),
 ("web/src/session/tabview.ts", "const { board: _board, at: _at, scene: _scene, view: _view, viewpoint: _viewpoint, side: _side, ...player } = view;", "const { board: _board, at: _at, ...player } = view;", "playerPart: the map part goes to Player"),
 ("web/src/player/timelineCache.ts", "return isFetched(etag) ? `\\u0000${match}` : `${board}\\u0000${match}`;", "return `${board}\\u0000${match}`;", "cache: the fetched replay kept per board"),
 ("web/src/player/timelineCache.ts", "return isFetched(etag) ? `\\u0000${match}` : `${board}\\u0000${match}`;", "return `\\u0000${match}`;", "cache: an upload kept for every board"),
 ("web/src/player/timelineCache.ts", "if (!h || h.etag !== etag) return undefined;", "if (!h) return undefined;", "confirm: another validator accepted"),
 ("web/src/player/timelineCache.ts", "return [own, fetched].filter(", "return [fetched, own].filter(", "candidates: the fetched before the board's own"),
 ("web/src/player/timelineCache.ts", "    if (bytes > this.cap) return tl;\n", "", "put: one over the cap pushes the rest out"),
 ("web/src/player/timelineCache.ts", "      if (this.total <= this.cap) break;\n", "", "put: everything else evicted"),
 ("web/src/player/timelineCache.ts", "    this.held.delete(key);\n    this.held.set(key, h);\n    return h;", "    return h;", "confirm: not marked used"),
 ("web/src/player/timelineCache.ts", "    freezeDeep(tl);\n", "", "put: not frozen"),
 ("web/src/player/timelineCache.ts", "  for (const x of Array.isArray(v) ? v : Object.values(v)) if (x !== null && typeof x === \"object\") freezeDeep(x);\n", "", "freeze: shallow"),
 ("web/src/player/timelineCache.ts", "    this.total -= h.bytes;\n", "", "remove: bytes not given back"),
 ("web/src/core/session.ts", "if (this.ended || this.parked) return false;", "if (this.ended) return false;", "session: a parked session takes an edit"),
 ("web/src/core/session.ts", "if (this.replica && this.status.kind !== \"saved\" && this.status.pending > 0) return;", "", "session: parked with pending edits rests at once"),
 ("web/src/core/session.ts", "if (i === 0 && !this.parked) this.send({ t: \"presence\", state: this.presence });", "if (i === 0) this.send({ t: \"presence\", state: this.presence });", "session: a flushing reconnect shows on the people list"),
 ("web/src/core/session.ts", "    this.o.onRecords?.([...this.records], true);\n    if (this.live) {", "    if (this.live) {", "session: resume doesn't draw"),
 ("web/src/core/session.ts", "    this.resting = true;\n    clearTimeout(this.restTimer);\n    this.stopped = true;", "    this.resting = true;\n    clearTimeout(this.restTimer);", "session: a resting session isn't stopped"),
 ("web/src/core/session.ts", "    void this.starting.then(() => {\n      if (this.parked || this.ended || this.socket) return;", "    void Promise.resolve().then(() => {\n      if (this.parked || this.ended || this.socket) return;", "session: resume opens beside a load under way"),
 ("web/src/core/session.ts", "    this.dropSocket();\n    this.markOffline();\n    this.peers.clear();", "    this.markOffline();\n    this.peers.clear();", "session: a resting session keeps its socket"),
 ("web/src/core/session.ts", "    if (!this.parked || this.ended) throw new Error(\"resume: the session isn't parked\");", "", "session: resume of one not parked"),
]
only = sys.argv[2:] 
killed = missed = 0
for i, (f, a, b, what) in enumerate(M):
    if only and str(i) not in only: continue
    path = wt / f
    src = path.read_text()
    if src.count(a) != 1:
        print(f"BAD   {i:2} {f}: pattern found {src.count(a)} times: {what}"); missed += 1; continue
    path.write_text(src.replace(a, b))
    try:
        r = subprocess.run(["npx", "vitest", "run", "test/sessions-speed.test.ts", "test/sessions-park.test.ts"], cwd=wt / "web", capture_output=True, text=True, timeout=180)
        dead = r.returncode != 0
    except subprocess.TimeoutExpired:
        dead = True
    finally:
        path.write_text(src)
    print(("killed" if dead else "MISSED"), f"{i:2}", f, "-", what, flush=True)
    killed += dead; missed += (not dead)
print(f"{killed} killed, {missed} missed, of {killed + missed}")
