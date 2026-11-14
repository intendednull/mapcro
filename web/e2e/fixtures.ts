// `test` for every spec: Playwright's, plus closing every browser context a test opened.
// Contexts made with `browser.newContext()` (joinNew, most multi-user tests) outlive their test
// otherwise: a worker's browser collected ~70 live boards by the end of a full run, all drawing
// and on the socket, and a page there drew ~7 frames a second (playtest's split-glide test
// saw no frame inside a 100 ms glide).

import { type BrowserContext, test as base } from "@playwright/test";

export * from "@playwright/test";

/**
 * A write to something frozen: Player's timelines are frozen all the way down (sessions.md §4.3,
 * player/timelineCache.ts `freezeDeep`), so a write to one throws in the page. Chromium's,
 * WebKit's and Firefox's words for it.
 */
const FROZEN_WRITE = /read only property|not extensible|Cannot (delete|redefine) property|readonly property|is read-only|is non-writable|can't define property/i;

export const test = base.extend<{ closeContexts: void }>({
  closeContexts: [
    async ({ browser, context }, use) => {
      const before = new Set(browser.contexts());
      // No page of this test may write to a frozen object: the uncaught error fails the test.
      const writes: string[] = [];
      const watch = (c: BrowserContext) => {
        c.on("weberror", (e) => {
          const message = e.error().message;
          if (FROZEN_WRITE.test(message)) writes.push(message);
        });
        return c;
      };
      watch(context);
      const newContext = browser.newContext;
      browser.newContext = async (...args: Parameters<typeof newContext>) => watch(await newContext.apply(browser, args));
      await use();
      browser.newContext = newContext;
      await Promise.all(browser.contexts().filter((c) => !before.has(c)).map((c) => c.close()));
      if (writes.length) throw new Error(`a page wrote to a frozen object (${writes.length}): ${[...new Set(writes)].join("; ")}`);
    },
    { auto: true },
  ],
});
