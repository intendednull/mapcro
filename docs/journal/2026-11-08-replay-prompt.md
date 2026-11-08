# 2026-11-08: The full-replay prompt

When Valve's replay can't come, the tab that opened the match now gets a dialog over the map
(operator-approved design and words): "Full replay unavailable", one reason line, what the API
summary lacks, and **Try again** / **Upload replay file** / **Use API summary**, with Where's my
replay?. It replaces the one-line fetch-failure notices under the transport; upload and parse
failures keep theirs. Spec §6b, "The full-replay prompt", and §6a's job-state line.

## What changed

- **Server:** the job status now says why no fetch is coming even when nothing is remembered.
  `expired` comes from the cached metadata's start time on every status call, not only from the
  negative cache that an open fills and that forgets after 6 h (or a restart). An open whose
  auto-fetch our per-client cap skipped used to be silent; it now reads `busy` for 10 min, keyed
  by the board's own job name, so another board never hears it. Test:
  `the_status_says_when_a_fetch_cant_come_expired_or_skipped_for_caps`.
- **Who sees it:** a tab-local mark (sessionStorage, board + match) set by the landing's Open
  match and Player's Load. A reload of that tab asks again unless this browser chose the summary
  (localStorage, per match). Followers, viewers and other editors see the chip only.
- **When:** the host arms the prompt on open and after Try again; it opens once the fetch's
  failure (or the expired status) arrives. Try again shows "Fetching replay…" at once, and a
  refusal on the spot (a backoff's 429) re-reads the server's state so the prompt comes back.
- **The chip** reopens it for the tab that opened the match; for everyone else it still toggles
  the hint.

## Surprises

- The first e2e run failed on a second landing open: the dialog mounted under the join card
  and its focus-on-open took the focus from the name field, so Enter pressed Try again. The
  prompt now waits for the join card.
- In the fixture match the heroes spend most of the game in the lanes' middle band, which a
  centred dialog covers; the screenshots seek to 15:00, where a few are outside it.

## Validation

`web/e2e/replay-prompt.spec.ts` (7 tests: each reason and its buttons, Try again re-fetching
and the prompt's return, Upload from the prompt, Use API summary across a reload, the chip
reopening it, Esc, a second person never seeing it, the phone layout). Each assertion was
checked by reverting its piece (opener gating, the remembered choice, re-arming after Try
again, Esc, no Try again when expired, the notice suppression); every one failed. Screenshots in
`/tmp/replay-prompt-shots/`.
