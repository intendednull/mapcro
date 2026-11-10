// The feedback form's server side (crates/server/src/feedback.rs): whether it's on, and sending.

import { createSignal } from "solid-js";
import type { Timeline } from "../match/timeline";

/** The server's limits, in characters; it checks them itself. */
export const MAX_TITLE = 120;
export const MAX_DESCRIPTION = 5000;

const [enabled, setEnabled] = createSignal(false);
let asked = false;

/** Whether the server has the form on (a token configured). Asked once per page; false until it
 * answers, and on any failure, so the button only shows when sending can work. */
export function feedbackEnabled() {
  if (!asked) {
    asked = true;
    fetch("/api/feedback")
      .then((r) => (r.ok ? (r.json() as Promise<{ enabled?: unknown }>) : { enabled: false }))
      .then((j) => setEnabled(j.enabled === true))
      .catch(() => setEnabled(false));
  }
  return enabled();
}

/** The match the sender had open, attached unless they untick it (spec §11a): the server checks
 * each field and writes the issue's line itself. */
export type FeedbackMatch = { id: string; t_s: number; tier: "replay" | "summary" };

/** The match to offer: the one open in Player, once its timeline is the one shown (none in the
 * sandbox, or while another match loads), at the playback time in whole seconds. */
export function feedbackMatchOf(player: boolean, id: string | undefined, tl: Timeline | undefined, t: number): FeedbackMatch | undefined {
  if (!player || !id || !tl || String(tl.match_id) !== id) return undefined;
  return { id, t_s: Math.max(0, Math.floor(t)), tier: tl.tier === "replay" ? "replay" : "summary" };
}

/** The line the form shows, e.g. "match 134570618 at 9:02 (Full replay)". */
export const matchLine = (m: FeedbackMatch) =>
  `match ${m.id} at ${Math.floor(m.t_s / 60)}:${String(m.t_s % 60).padStart(2, "0")} (${m.tier === "replay" ? "Full replay" : "API summary"})`;

export type Sent = { ok: true; url: string } | { ok: false; message: string };

/** "in about 40 minutes", from a Retry-After in seconds. */
export function waitText(secs: number) {
  if (!Number.isFinite(secs) || secs <= 0) return "later";
  const min = Math.ceil(secs / 60);
  if (min <= 1) return "in a minute";
  if (min < 90) return `in about ${min} minutes`;
  return `in about ${Math.round(min / 60)} hours`;
}

export async function sendFeedback(title: string, description: string, match?: FeedbackMatch): Promise<Sent> {
  let r: Response;
  try {
    r = await fetch("/api/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(match ? { title, description, match } : { title, description }),
    });
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
  const body = (await r.json().catch(() => ({}))) as { url?: unknown; error?: unknown };
  if (r.ok && typeof body.url === "string" && body.url.startsWith("https://")) return { ok: true, url: body.url };
  if (r.status === 429) {
    const wait = waitText(Number(r.headers.get("retry-after")));
    return { ok: false, message: `That's the limit for feedback for now. Try again ${wait}.` };
  }
  if (r.status === 400 && typeof body.error === "string") return { ok: false, message: `Not sent: ${body.error}.` };
  if (r.status === 404) return { ok: false, message: "Feedback is turned off on this server." };
  return { ok: false, message: "GitHub didn't take it this time. Your text is still here; try again in a few minutes." };
}
