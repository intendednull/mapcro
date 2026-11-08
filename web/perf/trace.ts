// Reads a Chrome trace (browser.startTracing) of one page: the renderer main thread's time by
// kind (scripting, rendering, painting, GC), its long tasks, and frames drawn.

import { readFileSync } from "node:fs";

interface Ev {
  name: string;
  cat: string;
  ph: string;
  ts: number;
  dur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: Record<string, unknown> };
}

const SCRIPT = new Set(["FunctionCall", "EvaluateScript", "v8.compile", "v8.callFunction", "TimerFire", "EventDispatch", "FireAnimationFrame", "RunMicrotasks", "v8.run", "V8.Execute", "v8.evaluateModule", "CompileScript", "CompileCode", "v8.produceCache"]);
const RENDER = new Set(["UpdateLayoutTree", "Layout", "RecalculateStyles", "PrePaint", "UpdateLayer", "UpdateLayerTree", "HitTest", "Layerize", "IntersectionObserverController::computeIntersections", "ScheduleStyleRecalculation", "LocalFrameView::RunPostLifecycleSteps", "LocalFrameView::UpdateLifecyclePhases", "ProxyMain::BeginMainFrame::commit"]);
const PAINT = new Set(["Paint", "PaintImage", "CompositeLayers", "Commit", "Decode Image", "Draw LazyPixelRef", "PaintNonDefaultBackgroundColor"]);
const GC = /GC|gc|Scavenge|MarkCompact|MinorMS|V8.GC/;

export interface TraceSummary {
  file: string;
  windowMs: number;
  mainBusyMs: number;
  byKind: Record<string, number>;
  topSelf: Array<[string, number]>;
  longTasks: number;
  longTaskMs: number;
  longestTaskMs: number;
  framesDrawn: number;
}

export function readTrace(file: string): TraceSummary {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { traceEvents: Ev[] } | Ev[];
  const evs = Array.isArray(raw) ? raw : raw.traceEvents;
  const threadNames = new Map<string, string>();
  for (const e of evs) if (e.ph === "M" && e.name === "thread_name") threadNames.set(`${e.pid}:${e.tid}`, e.args?.name ?? "");
  // The renderer's main thread with the most work (one page per browser in this harness).
  const busy = new Map<string, number>();
  for (const e of evs) {
    const k = `${e.pid}:${e.tid}`;
    if (threadNames.get(k) === "CrRendererMain" && e.ph === "X" && e.dur) busy.set(k, (busy.get(k) ?? 0) + e.dur);
  }
  const main = [...busy].sort((a, b) => b[1] - a[1])[0]?.[0];
  const mine = evs.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === "X" && e.dur !== undefined).sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  // Self time: each event's duration minus its children's.
  const self = new Map<string, number>();
  const stack: Array<{ e: Ev; end: number; child: number }> = [];
  const pop = () => {
    const top = stack.pop()!;
    self.set(top.e.name, (self.get(top.e.name) ?? 0) + Math.max(0, (top.e.dur ?? 0) - top.child));
    if (stack.length) stack[stack.length - 1]!.child += top.e.dur ?? 0;
  };
  let tasks: Ev[] = [];
  for (const e of mine) {
    while (stack.length && stack[stack.length - 1]!.end <= e.ts) pop();
    if (!stack.length && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask")) tasks.push(e);
    stack.push({ e, end: e.ts + (e.dur ?? 0), child: 0 });
  }
  while (stack.length) pop();
  const byKind: Record<string, number> = { scripting: 0, rendering: 0, painting: 0, gc: 0, other: 0 };
  for (const [name, us] of self) {
    const k = GC.test(name) ? "gc" : SCRIPT.has(name) ? "scripting" : RENDER.has(name) ? "rendering" : PAINT.has(name) ? "painting" : "other";
    byKind[k]! += us / 1000;
  }
  tasks = tasks.filter((t) => t.dur);
  const long = tasks.filter((t) => t.dur! > 50_000);
  const ts = mine.map((e) => e.ts);
  const windowMs = ts.length ? (Math.max(...mine.map((e) => e.ts + (e.dur ?? 0))) - Math.min(...ts)) / 1000 : 0;
  const framesDrawn = evs.filter((e) => e.name === "DrawFrame" && e.ph !== "M").length;
  return {
    file,
    windowMs,
    mainBusyMs: tasks.reduce((a, t) => a + t.dur!, 0) / 1000,
    byKind,
    topSelf: [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([n, us]) => [n, us / 1000]),
    longTasks: long.length,
    longTaskMs: long.reduce((a, t) => a + t.dur!, 0) / 1000,
    longestTaskMs: tasks.reduce((a, t) => Math.max(a, t.dur!), 0) / 1000,
    framesDrawn,
  };
}
