import { defineConfig, devices } from "@playwright/test";

// Real browsers against the real server binary serving the built client (see e2e/server.ts).
// Browsers come from nix (flake.nix sets PLAYWRIGHT_BROWSERS_PATH); run through `just e2e`.
//
// WebKit is opt-in (`just e2e-webkit`, which sets MAPCRO_E2E_WEBKIT=1): it stands in for
// WebKitGTK, the Linux app's webview (desktop/README.md, Linux). Same viewport and pixel ratio as
// Chromium, so the specs' geometry holds in both. Specs that use a Chromium-only API skip
// themselves there with the reason (`test.skip(browserName === "webkit", …)`).
//
// Firefox is opt-in too (`just e2e-firefox`, MAPCRO_E2E_FIREFOX=1): the phone specs (and
// touch-menu's) only, for Firefox for Android (the operator's browser: about 344 × 615 CSS px
// at a pixel ratio near 4.2).
// Playwright's Firefox has no `isMobile`, so a phone there is a viewport and `hasTouch`
// (e2e/phone-layout.ts, `phoneContext`) plus these prefs: the pointer is coarse, as Android's is,
// so the tablet sizes get the touch layout as well, and every page is drawn at 4.2 device px per
// CSS px (Firefox rounds it to 4.29). The pref, not `deviceScaleFactor`: Playwright's Firefox
// drops that override on a page served with COOP, as ours are. Steps that need CDP touch input
// skip themselves (`hasCdp`).
const FIREFOX_PHONE = { "ui.primaryPointerCapabilities": 1, "ui.allPointerCapabilities": 1, "layout.css.devPixelsPerPx": "4.2" };
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
    ...(process.env.MAPCRO_E2E_FIREFOX ? [{
      name: "firefox", testMatch: /(phone(-player)?|touch-menu)\.spec\.ts$/,
      use: { ...devices["Desktop Firefox"], ...desktop, launchOptions: { firefoxUserPrefs: FIREFOX_PHONE } },
    }] : []),
  ],
});
