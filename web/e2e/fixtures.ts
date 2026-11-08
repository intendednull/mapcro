// `test` for every spec: Playwright's, plus closing every browser context a test opened.
// Contexts made with `browser.newContext()` (joinNew, most multi-user tests) outlive their test
// otherwise: a worker's browser collected ~70 live boards by the end of a full run, all drawing
// and on the socket, and a page there drew ~7 frames a second (playtest's split-glide test
// saw no frame inside a 100 ms glide).

import { test as base } from "@playwright/test";

export * from "@playwright/test";

export const test = base.extend<{ closeContexts: void }>({
  closeContexts: [
    async ({ browser }, use) => {
      const before = new Set(browser.contexts());
      await use();
      await Promise.all(browser.contexts().filter((c) => !before.has(c)).map((c) => c.close()));
    },
    { auto: true },
  ],
});
