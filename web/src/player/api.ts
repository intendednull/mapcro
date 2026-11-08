// The server calls Player makes (spec §6a, §6b): the board's matches, a match's richest
// timeline, and the replay tier's jobs (upload with progress, fetch, state).

import type { Timeline } from "../match/timeline";

export const ERRORS: Record<string, string> = {
  bad_id: "Invalid id",
  not_found: "Not found",
  rate_limited: "Rate limited",
  busy: "Busy",
  upstream_limited: "Rate limited",
  upstream_down: "Upstream down",
  upstream_shape: "Upstream down",
  too_large: "Too large",
  brawl: "Brawl not supported",
  unsupported_mode: "Mode not supported",
  queue_full: "Busy",
  in_progress: "In progress",
  not_a_replay: "Not a replay",
  view_only: "View only",
  replays_off: "Replays off",
};

/** The labels of a match refused for its game mode (only the standard 6v6 is understood). */
export const MODE_REFUSED = new Set([ERRORS.brawl!, ERRORS.unsupported_mode!]);

/** Why the match's metadata refuses it for its mode, as a label; nothing when it doesn't (or
 * can't say: not found, upstream down). */
export async function modeRefusal(id: string): Promise<string | undefined> {
  const r = await fetch(`/api/matches/${id}`).catch(() => undefined);
  if (r?.status !== 422) return undefined;
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  return body.error === "brawl" || body.error === "unsupported_mode" ? ERRORS[body.error] : undefined;
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
  upstream_down: "Upstream down",
  upstream_limited: "Rate limited",
  upstream_shape: "Upstream down",
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

  /** The richest timeline the board has for a match, or an error label. */
  async timeline(id: string): Promise<Timeline | { error: string }> {
    const r = await fetch(`/api/boards/${this.board}/matches/${id}`, { headers: this.auth });
    const body = (await r.json().catch(() => ({}))) as Timeline & { error?: string };
    return r.ok ? body : { error: ERRORS[body.error ?? ""] ?? "Failed" };
  }

  async job(id: string): Promise<JobState | undefined> {
    const r = await fetch(`/api/boards/${this.board}/replays/${id}`, { headers: this.auth });
    return r.ok ? ((await r.json()) as JobState) : undefined;
  }

  async fetchReplay(id: string): Promise<string | undefined> {
    const r = await fetch(`/api/boards/${this.board}/replays/${id}/fetch`, { method: "POST", headers: this.auth });
    if (r.ok) return undefined;
    const body = (await r.json().catch(() => ({}))) as { error?: string };
    return ERRORS[body.error ?? ""] ?? "Failed";
  }

  /** Upload a `.dem` (XHR: fetch has no upload progress). Resolves to an error label, or nothing. */
  upload(id: string, f: Blob, progress: (pct: number) => void): Promise<string | undefined> {
    return new Promise((done) => {
      const x = new XMLHttpRequest();
      x.open("POST", `/api/boards/${this.board}/replays/${id}/upload`);
      x.setRequestHeader("authorization", `Bearer ${this.token}`);
      x.setRequestHeader("content-type", "application/octet-stream");
      x.upload.onprogress = (ev) => ev.lengthComputable && progress(Math.floor((ev.loaded / ev.total) * 100));
      x.onload = () => {
        if (x.status >= 200 && x.status < 300) return done(undefined);
        let code = "";
        try {
          code = (JSON.parse(x.responseText) as { error?: string }).error ?? "";
        } catch {
          /* not JSON */
        }
        done(ERRORS[code] ?? "Failed");
      };
      x.onerror = () => done("Offline");
      x.send(f);
    });
  }
}
