import { defineConfig, devices } from "@playwright/test";

// `just perf-player` (see the justfile): one Chromium, no Playwright tracing (its DOM
// snapshots after each action would be measured too), nothing kept in the repo.
export default defineConfig({
  testDir: ".",
  testMatch: "player.spec.ts",
  timeout: 1_800_000,
  workers: 1,
  reporter: [["list"]],
  outputDir: "/tmp/mapcro-perf/test-results",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, trace: "off" } }],
});
