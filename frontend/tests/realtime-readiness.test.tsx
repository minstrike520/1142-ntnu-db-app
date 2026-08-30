/**
 * Realtime readiness contract tests (issue #620).
 *
 * `Chatroom` publishes `data-room-ready="<roomId>"` as the browser-observable
 * signal the full-stack lane waits on, in place of watching for a `GET
 * /api/v1/sync` response. These tests pin the state transitions behind it at
 * the level the full-stack lane cannot reach: it needs Docker, a real backend
 * and a real database, so a socket that drops midway through a sync is not
 * something it can stage. Here the mock socket makes each transition directly
 * reachable.
 *
 * The contract, stated once in the `useRealtimeReady` JSDoc: ready means the
 * socket is connected, the server has restored every room subscription, the
 * durable sync that follows `realtime_ready` has completed, and its buffered
 * events have been flushed.
 */
import { describe, expect, test } from "vitest";
import { act } from "@testing-library/react";
import { mountChatApp } from "./harness";
import { __gateNextSync } from "./mocks/api";

/** The attribute as a test would query it: named for one room, or absent. */
const roomReady = (container: HTMLElement, roomId: string): boolean =>
  container.querySelector(`[data-room-ready="${roomId}"]`) !== null;

describe("room realtime readiness", () => {
  test("publishes the active room's id once the initial sync completes", async () => {
    const app = await mountChatApp("/chat/room-1");

    expect(roomReady(app.view.container, "room-1")).toBe(true);
    // Named for the room it means, so a waiter cannot be satisfied by a
    // different room that happens to be ready.
    expect(roomReady(app.view.container, "room-2")).toBe(false);
  });

  test("withdraws readiness while a reconnect's sync is still in flight", async () => {
    const app = await mountChatApp("/chat/room-1");
    expect(roomReady(app.view.container, "room-1")).toBe(true);

    // Reconnect with the sync held open: the socket is connected again but has
    // not caught up, which is exactly the window a `/sync`-response waiter
    // would have treated as ready.
    const gate = __gateNextSync();
    act(() => {
      app.socket().disconnect();
      app.socket().connect();
    });
    await app.settle();

    expect(roomReady(app.view.container, "room-1")).toBe(false);

    await act(async () => {
      gate.succeed();
      await Promise.resolve();
    });
    await app.settle();

    expect(roomReady(app.view.container, "room-1")).toBe(true);
  });

  test("does not report ready when the sync fails", async () => {
    const app = await mountChatApp("/chat/room-1");

    const failing = __gateNextSync();
    act(() => {
      app.socket().disconnect();
      app.socket().connect();
    });
    await act(async () => {
      failing.fail();
      await Promise.resolve();
    });
    await app.settle();

    // The failure path disconnects and schedules a retry; nothing about that
    // is ready.
    expect(roomReady(app.view.container, "room-1")).toBe(false);
  });

  test("does not report ready when the socket drops mid-sync", async () => {
    // Regression guard for the subtlest false-ready this contract can produce.
    // A sync awaits `/sync` paging, a rooms refresh, a debounced social refresh
    // and a member load. If the socket drops anywhere in that window, the sync
    // still resolves *successfully* afterwards — and readiness must not come
    // back with it, because the connection it describes is gone.
    const app = await mountChatApp("/chat/room-1");

    const gate = __gateNextSync();
    act(() => {
      app.socket().disconnect();
      app.socket().connect();
    });
    await app.settle();
    expect(roomReady(app.view.container, "room-1")).toBe(false);

    act(() => {
      app.socket().disconnect();
    });
    await act(async () => {
      gate.succeed();
      await Promise.resolve();
    });
    await app.settle();

    expect(roomReady(app.view.container, "room-1")).toBe(false);
  });
});
