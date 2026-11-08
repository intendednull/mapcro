// What went wrong opening a match or getting its replay, as an outcome and what to do next
// (operator, 2026-11-08: labels and short lines only). Pure, so the landing and Player say the
// same thing for the same code; `notice.test.ts` covers the table.

/** What a notice offers: try the step that failed again, or upload the replay file. */
export type NoticeAction = "retry" | "upload";

export interface Notice {
  /** The outcome and the action, a short line. */
  text: string;
  /** A second, quieter line, when the first needs one. */
  line?: string;
  actions: NoticeAction[];
}

/** The step that failed: the match's metadata, the fetch from Valve, or an upload (or its parse). */
export type Step = "load" | "fetch" | "upload";

const BUSY: Notice = { text: "Busy. Try again in a few minutes.", actions: ["retry", "upload"] };
const DOWN: Notice = { text: "deadlock-api is down. Try again later, or upload the replay file.", actions: ["retry", "upload"] };

/** A notice for an error code from `step`; nothing for codes that need none. */
export function noticeFor(code: string, step: Step): Notice | undefined {
  switch (code) {
    case "not_found":
      return { text: "Match not found yet.", line: "New matches can take a while to reach deadlock-api. Try again later.", actions: ["retry", "upload"] };
    case "no_replay":
      return { text: "Replay not found yet. Try again later, or upload the replay file.", actions: ["retry", "upload"] };
    case "expired":
      return { text: "Replay expired. Upload the replay file.", actions: ["upload"] };
    case "upstream_limited":
    case "rate_limited":
    case "busy":
    case "queue_full":
      // An upload refused for room is tried again by uploading again.
      return step === "upload" ? { text: "Busy. Try again in a few minutes.", actions: ["upload"] } : BUSY;
    case "upstream_down":
    case "upstream_shape":
      return DOWN;
    case "offline":
      return { text: "Offline. Check your connection, then try again.", actions: step === "upload" ? ["upload"] : ["retry"] };
    case "aborted":
      return { text: "Upload cancelled.", actions: ["upload"] };
    // The parse's outcomes (and the upload's own refusals).
    case "not_a_replay":
      return { text: "Not a replay. Pick the match's .dem file.", actions: ["upload"] };
    case "too_large":
      return { text: "Too large. Pick the match's .dem file.", actions: ["upload"] };
    case "corrupt":
      return { text: "Corrupt. Download the replay again in Deadlock, then upload it.", actions: ["upload"] };
    case "timeout":
      return step === "upload"
        ? { text: "Timed out. Upload the replay again.", actions: ["upload"] }
        : { text: "Timed out. Try again.", actions: ["retry"] };
    case "parse_failed":
      return { text: "Parse failed. Upload the replay again, or try another match.", actions: ["upload"] };
    case "old_map":
      return { text: "Old map. Only matches on the current map open.", actions: [] };
    case "brawl":
      return { text: "Brawl not supported. Open a standard match.", actions: [] };
    case "unsupported_mode":
      return { text: "Mode not supported. Open a standard match.", actions: [] };
    case "in_progress":
      return { text: "Already uploading.", actions: [] };
    case "view_only":
      return { text: "View only. An edit link can upload.", actions: [] };
    case "replays_off":
      return { text: "Replays are off on this server.", actions: [] };
    case "bad_id":
      return { text: "Invalid id.", actions: [] };
    default:
      return { text: "Failed. Try again.", actions: [step === "upload" ? "upload" : "retry"] };
  }
}

/** A size in MB, as the file manager shows it (decimal). */
export const mb = (bytes: number) => Math.round(bytes / 1e6);

/** "212 / 504 MB". */
export const sizeLabel = (loaded: number, total: number) => `${mb(loaded)} / ${mb(total)} MB`;

/** The match id a replay's file name gives (the game names it `<match id>.dem`), if it does. */
export const idFromName = (name: string) => /^0*(\d+)/.exec(name)?.[1];

/** Is this a replay file, by its name? */
export const isDem = (name: string) => /\.dem$/i.test(name);

/** Does the file start as a demo does (`PBDEMS2\0`, as the server checks)? Read before an upload,
 * so a file that isn't a replay is refused at once, with no board made for it. */
export async function looksLikeDemo(f: Blob): Promise<boolean> {
  const head = new Uint8Array(await f.slice(0, 8).arrayBuffer());
  return head.length === 8 && new TextDecoder().decode(head) === "PBDEMS2\0";
}
