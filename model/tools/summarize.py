"""Summarize a Quint ITF trace of sync.qnt as one line per step (python3 -I summarize.py trace.itf.json)."""
import json, sys

def val(v):
    if isinstance(v, dict):
        if "#bigint" in v: return int(v["#bigint"])
        if "#map" in v: return {val(k): val(x) for k, x in v["#map"]}
        if "#set" in v: return {val(x) for x in v["#set"]}
        if "#tup" in v: return tuple(val(x) for x in v["#tup"])
        if "tag" in v and "value" in v:
            inner = val(v["value"])
            return v["tag"] if inner in ({}, None, ()) else f"{v['tag']}({fmt(inner)})"
        return {k: val(x) for k, x in v.items()}
    if isinstance(v, list): return [val(x) for x in v]
    return v

def fmt(x):
    if isinstance(x, dict) and set(x) == {"field", "value"}: return f"{x['field']}={x['value']}"
    if isinstance(x, dict) and set(x) >= {"exists", "fields"}:
        return ("" if x["exists"] else "DEL ") + ",".join(f"{k}={v}" for k, v in sorted(x["fields"].items()))
    if isinstance(x, dict) and set(x) == {"client", "cseq", "op", "undoExpect"}:
        u = f" undo(expect {x['undoExpect']})" if x["undoExpect"] >= 0 else ""
        return f"{x['client']}#{x['cseq']}:{x['op']}{u}"
    if isinstance(x, dict) and set(x) == {"seq", "tx"}: return f"[{x['seq']}]{fmt(x['tx'])}"
    if isinstance(x, list): return "[" + ", ".join(fmt(i) for i in x) + "]"
    if isinstance(x, dict): return "{" + ", ".join(f"{k}: {fmt(v)}" for k, v in x.items()) + "}"
    return str(x)

trace = json.load(open(sys.argv[1]))
for i, st in enumerate(trace["states"]):
    s = {k: val(v) for k, v in st.items()}
    picks = s.get("mbt::nondetPicks", {})
    who = ",".join(f"{k}={fmt(v)}" for k, v in picks.items() if v not in (None, "None") and "None" not in str(v))
    print(f"--- {i}: {s.get('mbt::actionTaken')} {who}")
    print(f"    server log={fmt(s['log'])} board={fmt(s['board'])} clobbered={s['clobbered']}")
    for c, cs in sorted(s["cli"].items()):
        print(f"    {c}: {'up ' if cs['connected'] else 'DOWN'} seq={cs['lastSeq']} confirmed={fmt(cs['confirmed'])} "
              f"pending={fmt(cs['pending'])} undo={len(cs['undoStack'])} | up={fmt(s['up'][c])} down={fmt(s['down'][c])}")
