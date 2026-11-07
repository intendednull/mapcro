// "This link doesn't open a board" (design/v1-board/states.html): a mistyped or cut-short link,
// or one the server no longer accepts. Says what to check and offers a way on.

export function DeadLink() {
  return (
    <div class="scrim" data-testid="dead-link">
      <div class="banner revoked dead-link" role="alert">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1M4 4l16 16" />
        </svg>
        <div class="txt">
          <b>Invalid link</b>
          <div class="acts">
            <a class="btn small" href="/">
              New board
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
