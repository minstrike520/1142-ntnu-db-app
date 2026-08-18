import { expect, test } from "@playwright/test";
import { mockApi, TEST_USER } from "./support/api-mock";

/**
 * Browser smoke tests for the sign-in surface (issue #543).
 *
 * These deliberately assert only what a real browser adds over the jsdom suite:
 * that the route hydrates, that navigation and query-string handling survive a
 * real History API, that `localStorage` is really written, and that a failing
 * `fetch` reaches the error state. Component-level behaviour stays in
 * `tests/` under Vitest.
 */

// `Input` renders its `<label>` as a plain sibling of the `<input>` with no
// `htmlFor` and no wrapping element, so there is no accessible-name association
// and `getByLabel("Email")` resolves to nothing. Placeholders are the only
// stable handle here — please do not "improve" these locators without first
// giving `Input` a real label association.
test.describe("/login", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page);
  });

  test("renders and hydrates the sign-in form", async ({ page }) => {
    await page.goto("/login");

    await expect(page.getByRole("heading", { name: "Near" })).toBeVisible();
    await expect(page.getByPlaceholder("your email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();

    // Proof of hydration rather than of markup: the reveal toggle flips a
    // `useState` inside `Input`, so the type only changes once the client
    // bundle has attached. Server-rendered HTML alone would stay "password".
    const password = page.getByPlaceholder("your password");
    await expect(password).toHaveAttribute("type", "password");
    await password.locator("xpath=following-sibling::button").click();
    await expect(password).toHaveAttribute("type", "text");
  });

  test("blocks an empty submit with native constraint validation", async ({ page }) => {
    await page.goto("/login");

    await page.getByRole("button", { name: "Sign In" }).click();

    // Both fields are `required`, so the browser refuses to submit and the
    // handler's own `!email || !password` guard in src/app/login/page.tsx never
    // runs — that message is unreachable outside jsdom. What a real browser can
    // assert is that the form did not navigate and the field is marked invalid.
    await expect(page).toHaveURL("/login");
    await expect(page.getByPlaceholder("your email")).toHaveJSProperty("validity.valid", false);
  });

  test("rejects a password shorter than the minimum before calling the API", async ({ page }) => {
    await page.goto("/login");

    let loginCalls = 0;
    page.on("request", (request) => {
      if (request.url().includes("/api/v1/auth/login")) loginCalls += 1;
    });

    await page.getByPlaceholder("your email").fill("someone@test.local");
    await page.getByPlaceholder("your password").fill("short");
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page.getByText("Password must be at least 8 characters.")).toBeVisible();
    expect(loginCalls).toBe(0);
  });

  test("navigates to register and back", async ({ page }) => {
    await page.goto("/login");

    await page.getByRole("link", { name: "Create one" }).click();
    await expect(page).toHaveURL("/register");
    await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();

    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL("/login");
    await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
  });

  test("carries the redirect parameter across to register", async ({ page }) => {
    await page.goto("/login?redirect=%2Fsettings");

    // `redirectTo` comes from `useSyncExternalStore`, whose server snapshot is
    // always "/". A real browser is the only place where the post-hydration
    // value can be observed on the rendered href.
    await expect(page.getByRole("link", { name: "Create one" })).toHaveAttribute(
      "href",
      "/register?redirect=%2Fsettings",
    );
  });

  test("stores the session and leaves /login on a successful sign-in", async ({ page }) => {
    await page.goto("/login");

    await page.getByPlaceholder("your email").fill("playwright@test.local");
    await page.getByPlaceholder("your password").fill("password123");
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page).toHaveURL("/");

    const storedUser = await page.evaluate(() => window.localStorage.getItem("user"));
    expect(storedUser).not.toBeNull();
    expect(JSON.parse(storedUser as string)).toMatchObject({
      userId: TEST_USER.userId,
      email: "playwright@test.local",
    });
  });

  test("surfaces the server error message when sign-in fails", async ({ page }) => {
    // Registered after the `beforeEach` mock on purpose: Playwright matches
    // route handlers in reverse registration order, so this one wins.
    await mockApi(page, {
      "POST /auth/login": { status: 401, body: { message: "Invalid email or password." } },
    });

    await page.goto("/login");

    await page.getByPlaceholder("your email").fill("playwright@test.local");
    await page.getByPlaceholder("your password").fill("wrongpassword");
    await page.getByRole("button", { name: "Sign In" }).click();

    await expect(page.getByText("Invalid email or password.")).toBeVisible();
    await expect(page).toHaveURL("/login");
    expect(await page.evaluate(() => window.localStorage.getItem("user"))).toBeNull();
  });
});
