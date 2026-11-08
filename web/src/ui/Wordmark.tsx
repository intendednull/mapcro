/** The mapcro mark; it links home, where you open another match or board. */
export function Wordmark() {
  return (
    <a class="wordmark" href="/" title="Home" data-testid="home">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <polygon points="12,1.5 22.5,12 12,22.5 1.5,12" fill="none" stroke="var(--brass)" stroke-width="1.6" />
        <polygon points="12,7 17,12 12,17 7,12" fill="var(--brass)" />
      </svg>
      <span>mapcro</span>
    </a>
  );
}
