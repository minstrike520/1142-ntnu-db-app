import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser smoke tests (issue #543).
 *
 * Deliberately separate from vitest.config.ts. Vitest owns unit / component /
 * behaviour tests in `tests/`; Playwright owns browser-level smoke tests in
 * `tests-browser/`. The two share no config, no directory and no setup file, so
 * neither can quietly take on the other's responsibilities.
 *
 * Phase 1 is frontend-only: every REST call is fulfilled by
 * `tests-browser/support/api-mock.ts`, so this suite needs no PostgreSQL and no
 * Bun backend. Full-stack browser E2E is tracked separately in issue #544.
 */

// 3000 is load-bearing, not a default. `getApiBaseUrl()` in src/lib/api.ts
// branches on `window.location.port`: on 3000 it resolves the API origin to
// `<protocol>//<hostname>:4000`. Serving the app anywhere else changes the URL
// the app actually calls, and the mock's route glob would no longer describe
// the same traffic a developer sees on `next dev`.
const PORT = 3000;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: "./tests-browser",
  // Distinct from Vitest's `tests/**/*.test.ts(x)` so a file can never be
  // collected by both runners.
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  // A committed `test.only` silently shrinks the lane to one case while still
  // reporting green.
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  // Single worker for now: these tests share a real browser and one Next.js
  // server, and a stable signal matters more than wall-clock at this size.
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL: BASE_URL,
    // `retain-on-failure` rather than `on-first-retry`: with retries disabled
    // locally, `on-first-retry` would produce no trace at all for a developer
    // reproducing a CI failure.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // Required because this lane runs a production build. `ServiceWorkerRegistration`
    // gates on `process.env.NODE_ENV !== "production"`, which Next inlines at build
    // time: under `next dev` the worker is unregistered, but under `next start` it
    // registers, claims the page mid-run and serves navigations and `/_next/static`
    // from its own cache. Requests a service worker makes are not visible to
    // `page.route`, so leaving it enabled would make the API mock non-authoritative
    // and the lane's timing dependent on cache state. PWA behaviour is out of scope
    // for issue #543.
    serviceWorkers: "block",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Production build, not `next dev`. next.config.ts sets `reactCompiler:
    // true` and the point of a browser lane is to exercise the same hydration
    // path users get; dev-mode on-demand compilation also turns the first
    // navigation of each route into a multi-second stall that reads as flake.
    //
    // `next start` logs "does not work with output: standalone" because
    // next.config.ts sets `output: "standalone"` for the production image. It is
    // a warning, not an error — the server starts and serves normally, and the
    // standalone bundle is the release path's concern, not this lane's.
    //
    // Keeping the build here rather than in a workflow step is what makes
    // `pnpm test:browser` work from a clean checkout. The cost is diagnostic: a
    // build failure surfaces as a webServer timeout, so check the piped build
    // output above the timeout before assuming Playwright is at fault.
    command: `pnpm exec next build && pnpm exec next start --port ${PORT}`,
    url: BASE_URL,
    // Locally, reuse whatever the developer already has on 3000 instead of
    // rebuilding. In CI there is never a server to reuse, and silently
    // attaching to a stale one would test the wrong commit.
    reuseExistingServer: !isCI,
    // Covers a cold `next build` on a CI runner with no build cache.
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
