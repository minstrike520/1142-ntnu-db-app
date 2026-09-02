import { expect, test, type BrowserContext, type TestInfo } from "@playwright/test";
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
  }, testInfo) => {
    // Prerequisite data through the public REST API. Allowed by the issue as a
    // fixture, and deliberate: driving the friends panel through search →
    // request → accept inside a realtime test would make a friends-UI
    // regression and a realtime regression report identically.
    const [alice, bob] = await Promise.all([
      registerUser(request, "alice"),
      registerUser(request, "bob"),
    ]);
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

        // No waiter has to be armed before navigating any more: readiness is a
        // state the page publishes and holds, not an event that can be missed
        // by observing too late.
        await waitForRoomRealtimeReady(alicePage, roomId);
        await waitForRoomRealtimeReady(bobPage, roomId);

        // The readiness gates above prove both realtime sessions are live for
        // this room; these assertions additionally prove both pages are usable.
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
    } catch (error) {
      // These contexts come from `browser.newContext()`, which Playwright's
      // worker-scoped `browser` fixture does not photograph on failure the way
      // it does the `page` fixture. Capture here, where the failure is known,
      // rather than in `finally` behind a flag.
      await attachScreenshots(aliceContext, "alice", testInfo);
      await attachScreenshots(bobContext, "bob", testInfo);
      throw error;
    } finally {
      // Closed even when an assertion above fails, so a red test does not leak
      // two browser contexts into the rest of the run.
      await aliceContext.close();
      await bobContext.close();
    }
  });

  /**
   * The navigation case, as its own test rather than another step of the one
   * above (issue #620).
   *
   * Every navigation in the first test is `page.goto`, a document load that
   * tears down and rebuilds `ChatProvider` and its socket. This one enters the
   * room the way a user actually does — clicking it in the sidebar, an in-app
   * `router.push` — where the provider does *not* remount: the socket effect is
   * keyed on `[currentUserId, token]`, so no reconnect happens, no
   * `realtime_ready` is re-emitted and no second `/sync` is issued. That is
   * precisely the shape the deleted `/sync` waiter could not express, and it is
   * the shape the readiness attribute exists to cover.
   *
   * Separate rather than appended because the suite budgets 60s per test and
   * the first one already spans roughly eight round trips; sharing that budget
   * would surface a slow runner as a flake in the assertions above.
   */
  test("stays realtime-ready when the room is entered by in-app navigation", async ({
    browser,
    request,
  }, testInfo) => {
    const [alice, bob] = await Promise.all([
      registerUser(request, "alice"),
      registerUser(request, "bob"),
    ]);
    await makeFriends(request, alice, bob);
    const roomId = await createPrivateRoom(request, alice, bob);

    const aliceContext = await newIsolatedContext(browser);
    const bobContext = await newIsolatedContext(browser);

    try {
      const alicePage = await aliceContext.newPage();
      const bobPage = await bobContext.newPage();

      await test.step("bob opens the room directly and alice stops at the room list", async () => {
        await signInThroughUi(bobPage, bob);
        await bobPage.goto(`/chat/${roomId}`);
        await waitForRoomRealtimeReady(bobPage, roomId);

        // Login lands on `/`, so Alice's socket connects and completes its
        // bootstrap here, before the room is ever opened. Whatever readiness
        // the room page reports below is therefore inherited across a
        // navigation rather than produced by one.
        await signInThroughUi(alicePage, alice);
      });

      await test.step("alice enters the room by clicking it in the sidebar", async () => {
        // The sidebar entry's own button, which owns the `router.push`.
        await alicePage.locator(`[data-room-id="${roomId}"]`).click();

        await expect(alicePage).toHaveURL(`/chat/${roomId}`);
        await waitForRoomRealtimeReady(alicePage, roomId);
        await expect(alicePage.getByPlaceholder("Type a message...")).toBeVisible();
      });

      const fromAlice = `soft-nav hello from alice ${randomUUID()}`;

      await test.step("she can send from the room she navigated into", async () => {
        // Sending, not just receiving, is the assertion that matters here.
        // Alice's `new_message` listener is registered once on the provider's
        // socket, so she would receive Bob's messages whether or not the
        // navigation worked; the composer, by contrast, is bound to the room id
        // derived from the pathname, so this is what proves the in-app route
        // change actually rebound the room.
        await alicePage.getByPlaceholder("Type a message...").fill(fromAlice);
        await alicePage.getByRole("button", { name: "Send" }).click();

        await expect(messageBubble(bobPage, fromAlice)).toBeVisible();
      });

      await test.step("and still receives on the same connection", async () => {
        const fromBob = `soft-nav reply from bob ${randomUUID()}`;

        await bobPage.getByPlaceholder("Type a message...").fill(fromBob);
        await bobPage.getByRole("button", { name: "Send" }).click();

        await expect(messageBubble(alicePage, fromBob)).toBeVisible();
      });
    } catch (error) {
      await attachScreenshots(aliceContext, "alice", testInfo);
      await attachScreenshots(bobContext, "bob", testInfo);
      throw error;
    } finally {
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

/**
 * Wait until the browser itself reports that this room is ready for realtime.
 *
 * `Chatroom` publishes `data-room-ready="<roomId>"` once the socket is
 * connected, every room subscription has been restored server-side, the
 * durable `/sync` behind `realtime_ready` has completed and its buffered
 * events have flushed — and once this particular room is one the socket
 * actually joined. See `useRealtimeReady` in ChatContext for the full contract.
 *
 * This replaces waiting on a `GET /api/v1/sync` response (issue #620). That
 * waiter read an internal endpoint's request ordering to infer readiness,
 * which contradicted this file's own scope discipline above, and it only
 * worked because every navigation here is a document load: an in-app
 * `router.push` re-renders the room without reconnecting the socket, so no
 * second `/sync` is issued and such a waiter would hang until the timeout.
 * The attribute holds for both, which is what makes it a stable contract.
 */
const waitForRoomRealtimeReady = async (
  page: import("@playwright/test").Page,
  roomId: string,
): Promise<void> => {
  // `toBeAttached`, not `toBeVisible`: this asserts a contract, not pixels.
  // The message keeps a backend failure legible — the deleted waiter reported
  // a bad `/sync` status by name, and without it a broken bootstrap would
  // present only as an anonymous locator timeout.
  await expect(
    page.locator(`[data-room-ready="${roomId}"]`),
    `room ${roomId} never reported realtime readiness`,
  ).toBeAttached();
};

/** Attach every still-open page before raw contexts bypass fixture teardown. */
const attachScreenshots = async (
  context: BrowserContext,
  participant: string,
  testInfo: TestInfo,
): Promise<void> => {
  for (const [index, page] of context.pages().entries()) {
    try {
      await testInfo.attach(`${participant}-page-${index + 1}`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    } catch (error) {
      // Diagnostics must never replace the original assertion failure, but a
      // capture failure must remain visible rather than disappearing silently.
      testInfo.annotations.push({
        type: "diagnostic-error",
        description: `${participant} screenshot failed: ${String(error)}`,
      });
    }
  }
};
