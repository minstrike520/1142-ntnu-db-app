import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  createPrivateRoom,
  makeFriends,
  newIsolatedContext,
  registerUser,
  signInThroughUi,
} from "./support/api";

/**
 * Flow B — two-user private chat over the real stack (issue #544).
 *
 * User A types a message in a real browser; User B, in a separate browser with
 * its own cookie jar and its own `localStorage`, sees it appear without
 * reloading. That single assertion spans the whole system: Chromium → Next.js →
 * Hono/Bun → PostgreSQL → Socket.IO → back to a second Chromium.
 *
 * Scope discipline, per the issue: this asserts only what the receiving browser
 * ends up showing. No Socket.IO event name, no event ordering, no service or
 * repository call is referenced, so the reliability work in #282 / #540 can
 * change the transport freely without touching this spec — as long as the
 * user-visible contract holds.
 */

test.describe("two-user private chat", () => {
  test("delivers a message to the other user's browser without a reload", async ({
    browser,
    request,
  }) => {
    // Prerequisite data through the public REST API. Allowed by the issue as a
    // fixture, and deliberate: driving the friends panel through search →
    // request → accept inside a realtime test would make a friends-UI
    // regression and a realtime regression report identically.
    const alice = await registerUser(request, "alice");
    const bob = await registerUser(request, "bob");
    await makeFriends(request, alice, bob);
    const roomId = await createPrivateRoom(request, alice, bob);

    // Two contexts, not two pages. Pages in one context share cookies and
    // `localStorage`, so Bob would inherit Alice's session and the test would
    // prove nothing about two participants.
    const aliceContext = await newIsolatedContext(browser);
    const bobContext = await newIsolatedContext(browser);

    try {
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await test.step("both users sign in and open the private room", async () => {
        await signInThroughUi(alicePage, alice);
        await signInThroughUi(bobPage, bob);

        await alicePage.goto(`/chat/${roomId}`);
        await bobPage.goto(`/chat/${roomId}`);

        // Gate on the composer existing in both browsers. Without this, Alice
        // could send before Bob's Socket.IO connection has been established,
        // and the message would only ever arrive on a later fetch — the test
        // would then be measuring history loading, not realtime delivery.
        await expect(alicePage.getByPlaceholder("Type a message...")).toBeVisible();
        await expect(bobPage.getByPlaceholder("Type a message...")).toBeVisible();
      });

      // Unique per run, so a match cannot come from a previous run's row or
      // from the other spec's traffic.
      const messageText = `hello from alice ${randomUUID()}`;

      await test.step("alice sends a message from her browser", async () => {
        await alicePage.getByPlaceholder("Type a message...").fill(messageText);
        await alicePage.getByRole("button", { name: "Send" }).click();

        await expect(messageBubble(alicePage, messageText)).toBeVisible();
      });

      await test.step("bob sees it without reloading", async () => {
        // No `reload()` anywhere in this step on purpose: the page has been
        // sitting open since before the message existed, so the only way the
        // text can appear is a live push to Bob's browser.
        await expect(messageBubble(bobPage, messageText)).toBeVisible();
      });

      await test.step("bob replies and alice receives it", async () => {
        // The reverse direction, so a one-way subscription bug cannot pass.
        const replyText = `hello back from bob ${randomUUID()}`;

        await bobPage.getByPlaceholder("Type a message...").fill(replyText);
        await bobPage.getByRole("button", { name: "Send" }).click();

        await expect(messageBubble(alicePage, replyText)).toBeVisible();
      });

      await test.step("the message survives a reload", async () => {
        // Realtime delivery alone could be satisfied by a broadcast that was
        // never committed. Reloading discards all in-memory state and forces
        // Bob's client to refetch the conversation from PostgreSQL, so this is
        // the browser-observable proof that the write is durable — without
        // reaching into the database or naming a repository.
        await bobPage.reload();

        await expect(messageBubble(bobPage, messageText)).toBeVisible();
      });
    } finally {
      // Closed even when an assertion above fails, so a red test does not leak
      // two browser contexts into the rest of the run.
      await aliceContext.close();
      await bobContext.close();
    }
  });
});

/**
 * Locate a message inside the conversation.
 *
 * Scoped to `[data-msg-id]` — the attribute `MessageRow` puts on every rendered
 * message — rather than a bare `getByText`. The sidebar renders the same text
 * again as each room's last-message preview, so an unscoped locator matches two
 * elements and fails Playwright's strict mode. Resolving that with `.first()`
 * would be worse than the strict-mode error: it would keep passing if the
 * conversation stopped rendering the message entirely and only the preview
 * remained.
 */
const messageBubble = (page: import("@playwright/test").Page, text: string) =>
  page.locator("[data-msg-id]").filter({ hasText: text });
