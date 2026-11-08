// The server calls Player makes (spec §6a, §6b): the board's matches, a match's richest
// timeline, and the replay tier's jobs (upload with progress, fetch, state).

import type { Timeline } from "../match/timeline";

/** The codes of a match refused for its game mode. */
export const MODE_CODES = new Set(["brawl", "unsupported_mode"]);

/** What the server knows of a match's metadata: nothing wrong (`undefined`), or the error code
 * (`not_found`, `brawl`, `upstream_limited`, …; `offline` when the server didn't answer). */
export async function lookup(id: string): Promise<string | undefined> {
  const r = await fetch(`/api/matches/${id}`).catch(() => undefined);
  if (!r) return "offline";
  if (r.ok) return undefined;
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return body.error ?? "failed";
}

/** A replay job's failure as a label. */
export const REASONS: Record<string, string> = {
  old_map: "Old map",
  not_a_replay: "Not a replay",
  too_large: "Too large",
  timeout: "Timed out",
  parse_failed: "Parse failed",
  corrupt: "Corrupt",
  brawl: "Brawl not supported",
  unsupported_mode: "Mode not supported",
  no_replay: "No replay",
  expired: "Replay expired",
  upstream_down: "Upstream down",
  upstream_limited: "Fetch limit reached",
  upstream_shape: "Upstream down",
};

/** Why the replay isn't being fetched, for the tier chip's hint (operator, 2026-11-08). */
export const FETCH_WHY: Record<string, string> = {
  no_replay: "Replay not found yet",
  expired: "Replay expired",
  upstream_limited: "Busy",
};

export interface JobState {
  /** `waiting`: an upload's reservation in line for room (spec §6a, the queue). */
  state: "off" | "none" | "waiting" | "fetching" | "uploading" | "queued" | "parsing" | "done" | "failed";
  reason?: string;
  source?: "upload" | "cdn";
  /** Waiting or queued: how many jobs are ahead of it. */
  ahead?: number;
  /** Queued: the server's estimate of the seconds until it's ready, when it has one. */
  eta_s?: number;
  /** Done, from this board's upload, but parsed by an older worker: uploading the file again
   * gives the newer layers (its demo went with its parse, so it can't be parsed again). */
  stale?: boolean;
}

/** This board's upload, parsed by an older worker (spec §6a, format versions). */
export const staleUpload = (j: JobState | undefined) => j?.state === "done" && j.source === "upload" && !!j.stale;

/** A reservation's answer: send the file now, wait (how many are ahead), or nothing to send (the
 * board has the match's fetched replay already). */
export type Turn = { state: "ready" | "done" } | { state: "waiting"; ahead: number };

export const busy = (j: JobState | undefined) => ["waiting", "fetching", "uploading", "queued", "parsing"].includes(j?.state ?? "");

/** "~2 min": the wait, in whole minutes (never under one). */
export const etaLabel = (s: number) => `~${Math.max(1, Math.round(s / 60))} min`;

/** Where a job stands in the queue, as the tier chip says it: "Queued · 3 ahead · ~1 min",
 * "Waiting for a slot · 2 ahead"; nothing for the other states. */
export function queueLabel(j: JobState | undefined): string | undefined {
  const ahead = j?.ahead ? `${j.ahead} ahead` : undefined;
  if (j?.state === "waiting") return ["Waiting for a slot", ahead].filter(Boolean).join(" · ");
  if (j?.state === "queued") return ["Queued", ahead, j.eta_s !== undefined ? etaLabel(j.eta_s) : undefined].filter(Boolean).join(" · ");
  return undefined;
}

export function jobLabel(j: JobState | undefined, progress: number | undefined): string {
  switch (j?.state) {
    case "uploading":
      return progress === undefined ? "Uploading" : `Uploading ${progress}%`;
    case "waiting":
      return "Waiting";
    case "fetching":
      return "Fetching";
    case "queued":
      return "Queued";
    case "parsing":
      return "Parsing";
    case "failed":
      return REASONS[j.reason ?? ""] ?? "Failed";
    default:
      return "";
  }
}

export class Api {
  constructor(
    readonly board: string,
    readonly token: string,
  ) {}

  private get auth() {
    return { authorization: `Bearer ${this.token}` };
  }

  /** The matches this board has opened, newest first. */
  async matches(): Promise<number[]> {
    const r = await fetch(`/api/boards/${this.board}/matches`, { headers: this.auth });
    if (!r.ok) return [];
    return ((await r.json()) as { matches?: number[] }).matches ?? [];
  }

  async attach(id: string): Promise<boolean> {
    const r = await fetch(`/api/boards/${this.board}/matches/${id}`, { method: "PUT", headers: this.auth });
    return r.ok;
  }

  /** The richest timeline the board has for a match, or its error code. */
  async timeline(id: string): Promise<Timeline | { error: string }> {
    const r = await fetch(`/api/boards/${this.board}/matches/${id}`, { headers: this.auth });
    const body = (await r.json().catch(() => ({}))) as Timeline & { error?: string };
    return r.ok ? body : { error: body.error ?? "failed" };
  }

  async job(id: string): Promise<JobState | undefined> {
    const r = await fetch(`/api/boards/${this.board}/replays/${id}`, { headers: this.auth });
    return r.ok ? ((await r.json()) as JobState) : undefined;
  }

  /** Ask for the replay from Valve (past the server's memory of a failure). An error code, or
   * nothing. */
  async fetchReplay(id: string): Promise<string | undefined> {
    const r = await fetch(`/api/boards/${this.board}/replays/${id}/fetch`, { method: "POST", headers: this.auth }).catch(() => undefined);
    if (!r) return "offline";
    if (r.ok) return undefined;
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return body.error ?? "failed";
  }

  /** Ask for (or keep) this board's turn to upload `bytes` of the match; an error code if
   * refused. Asked again every few seconds while waiting: a turn not asked about lapses. */
  async reserve(id: string, bytes: number): Promise<Turn | { error: string }> {
    const r = await fetch(`/api/boards/${this.board}/replays/${id}/reserve`, {
      method: "POST",
      headers: { ...this.auth, "content-type": "application/json" },
      body: JSON.stringify({ bytes }),
    }).catch(() => undefined);
    if (!r) return { error: "offline" };
    const body = (await r.json().catch(() => ({}))) as { state?: string; ahead?: number; error?: string };
    if (!r.ok) return { error: body.error ?? "failed" };
    return body.state === "waiting" ? { state: "waiting", ahead: body.ahead ?? 0 } : { state: body.state === "done" ? "done" : "ready" };
  }

  /** Give up this board's place in line for the match (Cancel while waiting). */
  async release(id: string): Promise<void> {
    await fetch(`/api/boards/${this.board}/replays/${id}/reserve`, { method: "DELETE", headers: this.auth }).catch(() => undefined);
  }

  /**
   * Upload a `.dem` (XHR: fetch has no upload progress). `progress` gets the bytes sent and the
   * total; `signal` cancels it. Resolves to an error code (`aborted` when cancelled, `offline`
   * when the connection failed), or nothing.
   */
  upload(id: string, f: Blob, progress: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<string | undefined> {
    return new Promise((done) => {
      const x = new XMLHttpRequest();
      x.open("POST", `/api/boards/${this.board}/replays/${id}/upload`);
      x.setRequestHeader("authorization", `Bearer ${this.token}`);
      x.setRequestHeader("content-type", "application/octet-stream");
      x.upload.onprogress = (ev) => progress(ev.loaded, ev.lengthComputable ? ev.total : f.size);
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) return done(undefined);
        let code = "";
        try {
          code = (JSON.parse(x.responseText) as { error?: string }).error ?? "";
        } catch {
          /* not JSON */
        }
        done(code || "failed");
      };
      x.onerror = () => done("offline");
      x.onabort = () => done("aborted");
      if (signal?.aborted) return done("aborted");
      signal?.addEventListener("abort", () => x.abort(), { once: true });
      x.send(f);
    });
  }
}
