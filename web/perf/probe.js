// In-page instrumentation, injected with Playwright's addInitScript before the app loads. It
// changes no app code: it wraps the browser APIs the app goes through and timestamps them.
//
// - WebSocket send / onmessage: every frame out (submit, presence) and in (entry, presence),
//   with the handler's duration. The session's handler is synchronous: JSON.parse, the WASM
//   replica, then Solid's store update and the DOM writes it causes, all inside it.
// - The WASM exports (wrapped at instantiation): time per call, by export name.
// - JSON.parse inside a frame handler: its share of the handler.
// - IndexedDB put → transaction complete: the save (or journal entry) before each send, with its size.
// - A MutationObserver on the document: how many attributes and nodes one frame touched.
// - requestAnimationFrame after a frame, then a task after that frame: when it can be painted.
//
// Timestamps are performance.timeOrigin + performance.now(), comparable across pages on one
// machine (the same wall clock, sub-millisecond).
(() => {
  if (window.__perf) return;
  const now = () => performance.timeOrigin + performance.now();
  const P = (window.__perf = {
    recv: [], // frames received
    sent: [], // frames sent
    idb: [], // IndexedDB saves
    input: [], // pointerup / pointerdown on the page
    wasm: {}, // export name -> { n, ms }
    wasmCalls: [], // { name, t, ms } for the replica's hot calls
    longTasks: [],
    me: null, // our peer id, from Ready
    inRecv: null,
  });
  let wasmAcc = 0;
  // "Set:PlayerPos", "Create:Stroke", "Delete": what a transaction's first op does.
  const opName = (op) => {
    if (!op) return "";
    const k = Object.keys(op)[0];
    const v = op[k];
    if (k === "Set" && v && v.value) return "Set:" + Object.keys(v.value)[0];
    if (k === "Create" && v && v.record) return "Create:" + Object.keys(v.record)[0];
    return k;
  };
  let parseAcc = 0;

  // --- WASM exports -------------------------------------------------------------------------
  const HOT = /^boardreplica_(edit|receive|state|connect|undo|redo|view|restore|new)$/;
  const wrapExports = (exports) => {
    const out = {};
    for (const [name, v] of Object.entries(exports)) {
      if (typeof v !== "function") {
        out[name] = v;
        continue;
      }
      const slot = (P.wasm[name] = { n: 0, ms: 0 });
      const hot = HOT.test(name);
      out[name] = function (...args) {
        const t0 = performance.now();
        try {
          return v.apply(this, args);
        } finally {
          const ms = performance.now() - t0;
          slot.n++;
          slot.ms += ms;
          wasmAcc += ms;
          if (hot) P.wasmCalls.push({ name: name.slice(13), t: performance.timeOrigin + t0, ms });
        }
      };
    }
    return out;
  };
  const wrapResult = (r) => (r && r.instance ? { module: r.module, instance: { exports: wrapExports(r.instance.exports) } } : r);
  const inst = WebAssembly.instantiate;
  WebAssembly.instantiate = async function (...a) {
    return wrapResult(await inst.apply(this, a));
  };
  const stream = WebAssembly.instantiateStreaming;
  if (stream)
    WebAssembly.instantiateStreaming = async function (...a) {
      return wrapResult(await stream.apply(this, a));
    };

  // --- JSON.parse inside frame handlers ------------------------------------------------------
  const parse = JSON.parse;
  JSON.parse = function (s, r) {
    if (!P.inRecv) return parse(s, r);
    const t0 = performance.now();
    try {
      return parse(s, r);
    } finally {
      parseAcc += performance.now() - t0;
    }
  };

  // --- Frames out ---------------------------------------------------------------------------
  const WS = window.WebSocket;
  const send = WS.prototype.send;
  WS.prototype.send = function (data) {
    const t = now();
    send.call(this, data);
    if (typeof data !== "string") return;
    try {
      if (data.startsWith('{"t":"presence"')) {
        const s = parse(data).state;
        P.sent.push({ k: "presence", t, bytes: data.length, cursor: s.cursor, drag: s.drag && s.drag.pos, focus: s.focus });
      } else if (data.includes('"Submit"')) {
        const tx = parse(data).msg.Submit;
        P.sent.push({ k: "submit", t, bytes: data.length, client: tx.client, cseq: tx.cseq, ops: tx.ops.length, op: opName(tx.ops[0]) });
      } else if (data.includes('"Hello"')) {
        P.sent.push({ k: "hello", t, client: parse(data).msg.Hello.client });
      }
    } catch {}
  };

  // --- Frames in ----------------------------------------------------------------------------
  const desc = Object.getOwnPropertyDescriptor(WS.prototype, "onmessage");
  const mc = new MessageChannel();
  const afterFrame = [];
  mc.port1.onmessage = () => {
    const t = now();
    for (const r of afterFrame.splice(0)) r.painted = t;
  };
  Object.defineProperty(WS.prototype, "onmessage", {
    configurable: true,
    get() {
      return desc.get.call(this);
    },
    set(fn) {
      if (typeof fn !== "function") return desc.set.call(this, fn);
      desc.set.call(this, function (ev) {
        const data = String(ev.data);
        const rec = { t: now(), bytes: data.length, k: "?", mut: 0, attrs: 0, added: 0, removed: 0 };
        const w0 = wasmAcc;
        parseAcc = 0;
        P.inRecv = rec;
        const t0 = performance.now();
        try {
          return fn.call(this, ev);
        } finally {
          rec.ms = performance.now() - t0;
          rec.wasm = wasmAcc - w0;
          rec.parse = parseAcc;
          queueMicrotask(() => {
            if (P.inRecv === rec) P.inRecv = null;
          });
          try {
            const f = parse(data);
            rec.k = f.t;
            if (f.t === "msg") {
              const m = f.msg;
              if (m && m.Entry) {
                rec.k = "entry";
                rec.seq = m.Entry.seq;
                rec.client = m.Entry.tx.client;
                rec.cseq = m.Entry.tx.cseq;
                rec.ops = m.Entry.tx.ops.length;
                rec.op = opName(m.Entry.tx.ops[0]);
              } else rec.k = typeof m === "object" ? Object.keys(m)[0] : String(m);
            } else if (f.t === "presence") {
              rec.peers = f.peers.map((p) => ({ peer: p.peer, cursor: p.state && p.state.cursor, drag: p.state && p.state.drag && p.state.drag.pos, focus: p.state && p.state.focus }));
            } else if (f.t === "ready") {
              P.me = f.peer;
              rec.base = f.base ? data.length : 0;
            }
          } catch {}
          P.recv.push(rec);
          requestAnimationFrame(() => {
            rec.raf = now();
            afterFrame.push(rec);
            mc.port2.postMessage(0);
          });
        }
      });
    },
  });

  // --- DOM writes per frame -----------------------------------------------------------------
  const count = (n) => (n.nodeType === 1 ? 1 + n.getElementsByTagName("*").length : 1);
  // "g.tok", "path.ink"...: the element and its first class, for naming rebuilt subtrees.
  const label = (n) => (n.nodeType === 1 ? n.tagName.toLowerCase() + (n.classList && n.classList[0] ? "." + n.classList[0] : "") : "#text");
  const mo = new MutationObserver((list) => {
    const r = P.inRecv;
    if (!r) return;
    r.mut += list.length;
    for (const m of list) {
      if (m.type === "attributes") r.attrs++;
      else if (m.type === "characterData") r.attrs++;
      else {
        for (const n of m.addedNodes) {
          const c = count(n);
          r.added += c;
          if (c >= 5) {
            const k = label(n) + " in " + label(m.target);
            r.rebuilt = r.rebuilt || {};
            r.rebuilt[k] = (r.rebuilt[k] || 0) + c;
          }
        }
        for (const n of m.removedNodes) r.removed += count(n);
      }
    }
  });
  const observe = () => mo.observe(document.documentElement, { subtree: true, attributes: true, childList: true, characterData: true });
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe);

  // --- IndexedDB saves ----------------------------------------------------------------------
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    let bytes = -1;
    try {
      bytes = typeof value === "string" ? value.length : JSON.stringify(value).length; // a journal entry is an object
    } catch {}
    const rec = { t: now(), bytes, key: String(key).slice(0, 40) };
    const req = put.call(this, value, key);
    try {
      const tx = this.transaction;
      tx.addEventListener("complete", () => {
        rec.done = now();
        P.idb.push(rec);
      });
    } catch {}
    return req;
  };

  // --- Input and long tasks -----------------------------------------------------------------
  // Capture on window runs before the app's handlers, bubble after them: the gap is the app's
  // synchronous work for that input (for a drop: the local apply and its render).
  for (const type of ["pointerdown", "pointerup", "click"]) {
    let last = null;
    window.addEventListener(type, (e) => P.input.push((last = { k: type, t: performance.timeOrigin + e.timeStamp, seen: now() })), true);
    window.addEventListener(type, () => {
      if (last) last.end = now();
    });
  }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.longTasks.push({ t: performance.timeOrigin + e.startTime, ms: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
})();
