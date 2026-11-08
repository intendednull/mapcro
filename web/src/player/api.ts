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
  state: "off" | "none" | "fetching" | "uploading" | "queued" | "parsing" | "done" | "failed";
  reason?: string;
  source?: "upload" | "cdn";
}

export const busy = (j: JobState | undefined) => ["fetching", "uploading", "queued", "parsing"].includes(j?.state ?? "");

export function jobLabel(j: JobState | undefined, progress: number | undefined): string {
  switch (j?.state) {
    case "uploading":
      return progress === undefined ? "Uploading" : `Uploading ${progress}%`;
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
