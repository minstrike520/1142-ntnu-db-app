import { defineConfig, devices } from "@playwright/test";
import { FRONTEND_ORIGIN } from "./tests-fullstack/support/api";

/**
 * Full-stack browser E2E (issue #544).
 *
 * Separate from playwright.config.ts, which is the frontend-only smoke lane
 * (#543): that config's suite installs `tests-browser/support/api-mock.ts`,
 * which fulfils every `/api/v1/**` call in the browser and aborts the Socket.IO
 * handshake outright. Pointing this lane at that config would produce a suite
 * that passes without ever reaching a backend — the exact failure this lane
 * exists to rule out. The two share no testDir and no setup file, so a spec
 * cannot be collected by both.
 *
 * The entry point is always Chromium driving the real frontend, which then
 * talks to a real Bun backend and a real PostgreSQL over real HTTP and a real
 * Socket.IO connection. Fixtures may create prerequisite data through the
 * public REST API (see `tests-fullstack/support/api.ts`), but every acceptance
 * assertion is made against what the browser ends up showing.
 */

// `FRONTEND_ORIGIN` is defined once in tests-fullstack/support/api.ts, which
// documents why its host and port are load-bearing, and is imported here so the
// suite's `baseURL` and its manually-created BrowserContexts cannot drift apart.
const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests-fullstack",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // Phase 1 stays single-worker deliberately. These specs register users and
  // exchange messages against one shared PostgreSQL, and parallel workers would
  // race on realtime delivery long before wall-clock became the constraint.
  workers: 1,
  // Generous relative to the smoke lane: an assertion here can be waiting on a
  // round trip through Next.js, Hono, PostgreSQL and a Socket.IO broadcast.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-fullstack" }]],
  outputDir: "test-results-fullstack",
  use: {
    baseURL: FRONTEND_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Same reason as the smoke lane: this runs a production build, where
    // `ServiceWorkerRegistration` actually registers and would start serving
    // navigations and `/_next/static` from its own cache. PWA behaviour is not
    // what this lane is measuring.
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // No `webServer` block, unlike the smoke lane. This suite needs a backend and
  // a database up *before* the frontend is worth starting, and it needs both
  // processes' logs when something dies. Playwright's webServer can express
  // neither: it would surface a crashed backend as an unrelated test timeout
  // minutes later. Startup, health-gating and log capture are the workflow's
  // job — see the `fullstack-browser-tests` job in
  // .github/workflows/ci-browser.yml, and the local recipe in
  // ../docs/DEVELOPMENT.md#running-full-stack-browser-tests.
});
