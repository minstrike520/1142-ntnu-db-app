import type { Page, Request } from "@playwright/test";
import type { AuthResponse, UserSettings } from "@shared/types";

/**
 * REST mocking for the frontend-only browser lane (issue #543).
 *
 * Phase 1 must not depend on PostgreSQL or a running Bun backend, so every
 * `/api/v1` call is fulfilled in the browser instead. The point is still to
 * exercise the real client: real `fetch`, real CORS, real hydration, real
 * navigation — only the origin server is replaced.
 */

/**
 * `src/lib/api.ts` builds every URL as `getApiBaseUrl() + '/api/v1' + path`.
 * With the app served on port 3000 that base resolves to
 * `http://127.0.0.1:4000`, but the glob is host-agnostic on purpose: it keeps
 * matching if the resolution rules change, and it never swallows the app's own
 * document, chunk or image requests.
 */
export const API_ROUTE_GLOB = "**/api/v1/**";

/** Where the app is served. Needed verbatim for credentialed CORS replies. */
const PAGE_ORIGIN = "http://127.0.0.1:3000";

export const TEST_USER: AuthResponse["user"] = {
  userId: "11111111-1111-4111-8111-111111111111",
  name: "Playwright Tester",
  avatarUrl: "",
};

export const TEST_AUTH: AuthResponse = {
  token: "test-access-token",
  user: TEST_USER,
};

export const TEST_SETTINGS: UserSettings = {
  warningEnabled: false,
  warningDays: 0,
  language: "en",
  theme: "light",
  notifyDesktop: true,
  notifySound: true,
};

// Not typed as `MyProfile`: that interface declares `lastActivity: Date`, which
// is what the app holds after parsing, not what crosses the wire as JSON.
const TEST_PROFILE = {
  userId: TEST_USER.userId,
  name: TEST_USER.name,
  email: "playwright@test.local",
  bio: "",
  avatarUrl: "",
  lastActivity: "2026-01-01T00:00:00.000Z",
};

export type MockResponse = {
  status?: number;
  /** Serialized as JSON. Omit to fall back to the shape-based default. */
  body?: unknown;
};

/** Keyed by `"<METHOD> <path after /api/v1>"`, e.g. `"POST /auth/login"`. */
export type MockRoutes = Record<string, MockResponse>;

/**
 * Enough of the session bootstrap for a signed-in page to mount.
 *
 * `ChatContext`'s bootstrap effect treats any failure in `getMe` /
 * `getMySettings` / `listRooms` / `listFolders` as an expired session: it
 * clears `localStorage.user` and calls `window.location.replace("/login")`.
 * A test that mocked only `/auth/login` would therefore be bounced back to the
 * login page mid-assertion. The collection-shaped calls are covered by the
 * empty-array default below rather than being listed one by one, so adding a
 * bootstrap request to the app does not silently break this lane.
 */
const DEFAULT_ROUTES: MockRoutes = {
  "POST /auth/login": { body: TEST_AUTH },
  "POST /auth/register": { body: TEST_AUTH },
  "POST /auth/refresh": { body: TEST_AUTH },
  "GET /users/me": { body: TEST_PROFILE },
  "GET /users/me/settings": { body: TEST_SETTINGS },
};

/**
 * `route.fulfill` short-circuits the network but not the browser's same-origin
 * policy: the page runs on :3000 and calls :4000, so a reply without these
 * headers is rejected by Chromium and surfaces as "Failed to fetch". The app
 * sends `credentials: 'include'`, which additionally forbids the `*` wildcard
 * and requires the explicit origin. Playwright lower-cases request headers, so
 * `["origin"]` is the correct key.
 *
 * The matching CORS *preflight* is not handled here and must not be: Playwright
 * fulfils intercepted `OPTIONS` preflights itself and never dispatches them to
 * a route handler (`crNetworkManager`'s `isInterceptedOptionsPreflight`). That
 * only happens while at least one route is registered — a test that navigates
 * without calling `mockApi` would send a real preflight to a dead port 4000 and
 * see every request fail.
 */
const corsHeaders = (request: Request): Record<string, string> => ({
  "Access-Control-Allow-Origin": request.headers()["origin"] ?? PAGE_ORIGIN,
  "Access-Control-Allow-Credentials": "true",
  "Access-Control-Allow-Headers": "authorization,content-type",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
});

/**
 * Install the REST mock on `page`.
 *
 * Unlisted routes answer 200 with `[]` for GET and `{}` otherwise. That covers
 * the collection endpoints the session bootstrap fans out to without pinning
 * this helper to the current list of them.
 */
export const mockApi = async (page: Page, overrides: MockRoutes = {}): Promise<void> => {
  const routes: MockRoutes = { ...DEFAULT_ROUTES, ...overrides };

  await page.route(API_ROUTE_GLOB, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api\/v1/, "");
    const match = routes[`${request.method()} ${path}`];
    const body = match?.body ?? (request.method() === "GET" ? [] : {});

    await route.fulfill({
      status: match?.status ?? 200,
      headers: { ...corsHeaders(request), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  });

  // Socket.IO's handshake is `/socket.io/?EIO=4&...`, which is outside
  // API_ROUTE_GLOB and would otherwise hit a dead port 4000 the moment
  // ChatContext authenticates, then retry on a backoff for the rest of the
  // test. Aborting keeps the console clean and stops the page from ever being
  // network-idle. Realtime behaviour belongs to the full-stack lane (#544).
  await page.route("**/socket.io/**", (route) => route.abort());
};
