import { defineConfig, devices } from "@playwright/test";

// Real browsers against the real server binary serving the built client (see e2e/server.ts).
// Browsers come from nix (flake.nix sets PLAYWRIGHT_BROWSERS_PATH); run through `just e2e`.
//
// WebKit is opt-in (`just e2e-webkit`, which sets MAPCRO_E2E_WEBKIT=1): it stands in for
// WebKitGTK, the Linux app's webview (desktop/README.md, Linux). Same viewport and pixel ratio as
// Chromium, so the specs' geometry holds in both. Specs that use a Chromium-only API skip
// themselves there with the reason (`test.skip(browserName === "webkit", …)`).
const desktop = { viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" as const };
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  outputDir: "test-results",
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], ...desktop } },
    ...(process.env.MAPCRO_E2E_WEBKIT ? [{ name: "webkit", use: { ...devices["Desktop Safari"], ...desktop, deviceScaleFactor: 1 } }] : []),
  ],
});
