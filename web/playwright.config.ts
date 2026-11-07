import { defineConfig, devices } from "@playwright/test";

// Real browsers against the real server binary serving the built client (see e2e/server.ts).
// Browsers come from nix (flake.nix sets PLAYWRIGHT_BROWSERS_PATH); run through `just e2e`.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
});
