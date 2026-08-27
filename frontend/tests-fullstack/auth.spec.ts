import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { TEST_PASSWORD } from "./support/api";

/**
 * Flow A — authentication lifecycle against the real stack (issue #544).
 *
 * Register → signed-in app → logout → protected route refuses → login again.
 *
 * Every step here goes through the real `/api/v1/auth/*` routes, a real
 * PostgreSQL row and the real refresh cookie. That is what separates it from
 * the #543 smoke suite, which asserts the same screens with every response
 * fulfilled in-browser: this spec fails if password hashing, the refresh
 * cookie, token rotation or the session bootstrap is broken, and that one
 * cannot.
 */

test.describe("authentication lifecycle", () => {
  test("registers, logs out, is locked out, and logs back in", async ({ page }) => {
    // Unique per run: the acceptance criteria forbid depending on seeded
    // accounts or on a previous run's leftovers.
    const email = `e2e-auth-${randomUUID()}@test.local`;
    const name = "E2E Auth";

    await test.step("register through the real API", async () => {
      await page.goto("/register");

      // Placeholders rather than labels: `Input` renders its `<label>` as a
      // plain sibling with no `htmlFor`, so there is no accessible-name
      // association to query. Same constraint the #543 spec documents.
      await page.getByPlaceholder("Display name").fill(name);
      await page.getByPlaceholder("your email").fill(email);
      await page.getByPlaceholder("your password").fill(TEST_PASSWORD);
      await page.getByPlaceholder("Repeat password").fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Create account" }).click();

      await expect(page).toHaveURL("/");
    });

    await test.step("land in the signed-in application", async () => {
      // The sidebar only renders once `(main)/layout` has finished its
      // bootstrap — profile, settings, rooms and folders all fetched from the
      // backend. Asserting on the email proves the round trip really returned
      // this account rather than a cached or mocked one.
      await expect(page.getByText(email)).toBeVisible();

      // Written by the bootstrap from the real `/users/me` response, not by
      // the register handler's optimistic write.
      const stored = await page.evaluate(() => window.localStorage.getItem("user"));
      expect(stored).not.toBeNull();
      expect(JSON.parse(stored as string)).toMatchObject({ email });
    });

    await test.step("log out", async () => {
      // `aria-label` comes from `t("sidebar.logout")`. The language settles on
      // English because `lang_preference` defaults to 'en' in the initial
      // migration and the bootstrap applies the value it just fetched.
      await page.getByRole("button", { name: "Logout" }).click();

      await expect(page).toHaveURL("/login");
      expect(await page.evaluate(() => window.localStorage.getItem("user"))).toBeNull();
    });

    await test.step("refuse the protected route once logged out", async () => {
      // The real proof that the *server* ended the session, not just the tab:
      // `/` re-runs the bootstrap, which has no access token and falls back to
      // the refresh cookie. That cookie was revoked by `/auth/logout`, so the
      // refresh is rejected and the app is bounced back to /login.
      await page.goto("/");

      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
    });

    await test.step("log back in with the same credentials", async () => {
      await page.getByPlaceholder("your email").fill(email);
      await page.getByPlaceholder("your password").fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      await expect(page).toHaveURL("/");
      await expect(page.getByText(email)).toBeVisible();
    });
  });
});
