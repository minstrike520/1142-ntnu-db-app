import { expect, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";

/**
 * Real-API fixtures for the full-stack browser lane (issue #544).
 *
 * The opposite of `tests-browser/support/api-mock.ts`: nothing here is faked.
 * These helpers speak to the same Bun backend and PostgreSQL the browser is
 * about to speak to, over the same REST contract, and exist only to put
 * prerequisite rows in place. Every acceptance assertion belongs in the spec,
 * against what the browser renders.
 *
 * What may live here: registering a user, making two users friends, opening a
 * private room. What may not: anything the spec is meant to prove. Driving the
 * friend-request UI through four tab switches inside a test whose subject is
 * realtime delivery would make a realtime failure and a friends-panel failure
 * indistinguishable.
 */

/**
 * Where the backend listens.
 *
 * Must agree with the frontend origin's host spelling: the refresh cookie is
 * `SameSite=Strict` (backend src/utils/cookies.ts), and `127.0.0.1` and
 * `localhost` are different hosts to Chromium, so mixing them across the
 * 3000/4000 boundary silently drops the cookie and the session bootstrap
 * bounces to /login.
 */
export const API_ORIGIN = process.env.E2E_API_ORIGIN ?? "http://127.0.0.1:4000";

/**
 * Where Chromium reaches the real Next.js frontend, and the suite's `baseURL`
 * (playwright.fullstack.config.ts imports this rather than restating it).
 *
 * Port 3000 is load-bearing, not a default, and must stay in sync with the
 * backend's CORS_ORIGINS and PORT. `getApiBaseUrl()` in src/lib/api.ts branches
 * on `window.location.port`: served on 3000 it resolves the API origin to
 * `<protocol>//<hostname>:4000`. Serving the app anywhere else silently
 * repoints every REST call and the Socket.IO handshake. The `127.0.0.1`
 * spelling is required for the same SameSite=Strict reason as API_ORIGIN above.
 */
export const FRONTEND_ORIGIN = process.env.E2E_FRONTEND_ORIGIN ?? "http://127.0.0.1:3000";

const apiUrl = (path: string): string => `${API_ORIGIN}/api/v1${path}`;

/** Long enough to satisfy the backend's 8-character minimum (userSchemas.ts). */
export const TEST_PASSWORD = "password123";

export interface TestUser {
  userId: string;
  name: string;
  email: string;
  password: string;
  /** Access token from the registration response, for further fixture calls. */
  token: string;
}

/**
 * A fresh identity per call.
 *
 * Random rather than sequential or timestamped: the acceptance criteria require
 * specs to be independent of execution order and of any previous run's data,
 * and a UUID keeps that true even if this suite is ever run twice against one
 * database.
 */
const uniqueEmail = (label: string): string => `e2e-${label}-${randomUUID()}@test.local`;

/**
 * Assert a fixture call succeeded, loudly.
 *
 * Without this a failed prerequisite surfaces much later as an empty room list
 * or a missing message, and the spec reports a realtime failure that never
 * happened. `response.text()` is included because the backend's error handler
 * returns a JSON body explaining the refusal.
 */
const expectOk = async (
  response: Awaited<ReturnType<APIRequestContext["post"]>>,
  what: string,
): Promise<void> => {
  if (!response.ok()) {
    throw new Error(
      `Fixture setup failed: ${what} returned ${response.status()} ${response.statusText()}\n${await response.text()}`,
    );
  }
};

/** Register a brand-new user through the real auth route. */
export const registerUser = async (
  request: APIRequestContext,
  label: string,
): Promise<TestUser> => {
  const email = uniqueEmail(label);
  const name = `E2E ${label}`;

  const response = await request.post(apiUrl("/auth/register"), {
    data: { email, name, password: TEST_PASSWORD },
  });
  await expectOk(response, `register ${email}`);

  const body = (await response.json()) as { token: string; user: { userId: string } };

  return { userId: body.user.userId, name, email, password: TEST_PASSWORD, token: body.token };
};

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Make two users friends.
 *
 * Two calls because that is genuinely the contract: the addressee decides. The
 * PATCH is keyed by the *requester's* user id, not by a separate request id —
 * see `makeFriendRequestRoutes` in backend/src/routes/friendRoutes.ts, which
 * reads `:id` as the counterpart user.
 */
export const makeFriends = async (
  request: APIRequestContext,
  requester: TestUser,
  addressee: TestUser,
): Promise<void> => {
  const sent = await request.post(apiUrl("/friend-requests"), {
    headers: authHeaders(requester.token),
    data: { targetUserId: addressee.userId },
  });
  await expectOk(sent, `friend request ${requester.email} -> ${addressee.email}`);

  const accepted = await request.patch(apiUrl(`/friend-requests/${requester.userId}`), {
    headers: authHeaders(addressee.token),
    data: { status: "accepted" },
  });
  await expectOk(accepted, `accept friend request from ${requester.email}`);
};

/**
 * Open the private room between two users and return its id.
 *
 * `roomService.createPrivate` refuses with 403 unless the two are already
 * friends, so `makeFriends` has to have run first. The route answers 201 for a
 * newly created room and 200 when one already existed; both are success.
 */
export const createPrivateRoom = async (
  request: APIRequestContext,
  creator: TestUser,
  target: TestUser,
): Promise<string> => {
  const response = await request.post(apiUrl("/rooms"), {
    headers: authHeaders(creator.token),
    data: { type: "private", targetUserId: target.userId },
  });
  await expectOk(response, `create private room ${creator.email} <-> ${target.email}`);

  const room = (await response.json()) as { roomId: string };
  expect(room.roomId, "private room response carries a roomId").toBeTruthy();
  return room.roomId;
};

/**
 * A browser context with its own cookie jar and its own `localStorage`.
 *
 * The two-user spec needs this rather than two pages: pages in one context
 * share both, so User B would inherit User A's refresh cookie and stored
 * session and the test would prove nothing about two real participants.
 */
export const newIsolatedContext = async (browser: Browser): Promise<BrowserContext> =>
  // Raw contexts do not inherit Playwright Test's `use` options. Keep PWA
  // caching out of this realtime lane just as the config does for fixtures.
  browser.newContext({ baseURL: FRONTEND_ORIGIN, serviceWorkers: "block" });

/**
 * Sign in through the real login form and wait until the app is usable.
 *
 * Deliberately the UI and not an injected token: the acceptance criteria put
 * the entry point in the browser, and this path is what exercises the refresh
 * cookie and the `ChatContext` session bootstrap that everything else depends
 * on. Waiting on the sidebar rather than on the URL matters — `(main)/layout`
 * renders a loading state until the bootstrap has fetched profile, settings and
 * rooms, and a spec that starts typing before that has finished races it.
 */
export const signInThroughUi = async (
  page: import("@playwright/test").Page,
  user: TestUser,
): Promise<void> => {
  await page.goto("/login");

  // Placeholders, not labels: `Input` renders its `<label>` as a plain sibling
  // with no `htmlFor`, so there is no accessible-name association to query.
  // Same constraint the #543 smoke spec documents.
  await page.getByPlaceholder("your email").fill(user.email);
  await page.getByPlaceholder("your password").fill(user.password);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).toHaveURL("/");
  await expect(page.getByText(user.email)).toBeVisible();
};
