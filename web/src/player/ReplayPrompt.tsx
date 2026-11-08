// The full-replay prompt (spec §6b; operator-approved design and words, 2026-11-08): when the
// replay can't come from Valve, the tab that opened the match is asked, over the map, with the
// API summary already playing underneath: try again, upload the file, or use the summary.

import { Show, onMount } from "solid-js";
import type { PlayerHost } from "./host";
import { PROMPT, canRetry } from "./notice";
import { ReplayHelp } from "./ReplayHelp";

export function ReplayPrompt(p: { host: PlayerHost }) {
  const h = p.host;
  return (
    <Show when={h.prompt.shown() && h.unavailable()}>
      {(why) => <Dialog host={h} why={why()} />}
    </Show>
  );
}

function Dialog(p: { host: PlayerHost; why: NonNullable<ReturnType<PlayerHost["unavailable"]>> }) {
  const h = p.host;
  let box!: HTMLDivElement;
  let file!: HTMLInputElement;
  onMount(() => box.querySelector<HTMLButtonElement>("button")?.focus());
  return (
    <div class="rp-scrim" data-testid="replay-prompt-scrim">
      <div
        ref={box}
        class="dialog rp-dialog"
        role="dialog"
        aria-labelledby="rp-h"
        aria-describedby="rp-why"
        data-testid="replay-prompt"
        data-why={p.why}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            h.prompt.dismiss();
          }
          // The board's and Player's keys (Space plays, arrows seek) aren't for the dialog.
          e.stopPropagation();
        }}
        onKeyUp={(e) => e.stopPropagation()}
      >
        <header>
          <h2 id="rp-h">{PROMPT.title}</h2>
        </header>
        <div class="body">
          <p class="rp-why" id="rp-why" data-testid="replay-prompt-why">
            {PROMPT.reason[p.why]}
          </p>
          <p class="rp-lacks">{PROMPT.lacks}</p>
          <div class="rp-acts">
            <Show when={canRetry(p.why)}>
              <button class="btn" type="button" data-testid="replay-prompt-retry" onClick={() => void h.prompt.retry()}>
                Try again
              </button>
            </Show>
            <button class="btn primary" type="button" data-testid="replay-prompt-upload" onClick={() => file.click()}>
              Upload replay file
            </button>
            <button class="btn ghost" type="button" data-testid="replay-prompt-summary" onClick={() => h.prompt.dismiss()}>
              Use API summary
            </button>
          </div>
          <input
            ref={file}
            type="file"
            accept=".dem"
            hidden
            data-testid="replay-prompt-file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (f) void h.take(f);
            }}
          />
          <ReplayHelp id={h.matchId()} class="inline rp-help" />
        </div>
      </div>
    </div>
  );
}
