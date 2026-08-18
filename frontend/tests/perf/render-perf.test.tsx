/**
 * Fixed render-measurement scenarios for issue #383.
 *
 * These tests drive the three interaction scenarios and print commit counts /
 * render durations / bubble-subtree render counts. They assert behaviour only
 * (the UI ends up in the right state) — the numbers are output for humans to
 * compare, not thresholds, because durations are machine-dependent.
 *
 * The render-count guarantees these scenarios were built to protect are
 * asserted for real in tests/chat-memoization.test.tsx: appending one message
 * re-renders at most 3 rows, and a background room, local typing or remote
 * typing re-renders none. Those are the regression guard; this file is the
 * measurement harness.
 *
 * Run with: cd frontend && pnpm test -- tests/perf/render-perf.test.tsx
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { formatMeasurement, mountChatApp, type Measurement } from "../harness";
import { ME_ID, makeMessage } from "../fixtures";

const results: Measurement[] = [];

afterAll(() => {
  const lines = [
    `run at ${new Date().toISOString()}`,
    ...results.map(formatMeasurement),
    "",
  ];
  // Some reporters swallow console output from hooks, so persist to a file
  // (gitignored) as well. Path override: PERF_RESULTS_FILE.
  const outFile =
    process.env.PERF_RESULTS_FILE ?? path.join(__dirname, ".last-results.txt");
  fs.writeFileSync(outFile, lines.join("\n"));
  console.log(lines.join("\n"));
});

describe("scenario 1: open and switch chatroom", () => {
  test("switch from room-1 to room-2 via the sidebar", async () => {
    const app = await mountChatApp("/chat/room-1");
    expect(screen.getAllByText("Message 40 in room-1").length).toBeGreaterThan(0);

    app.startMeasure();
    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    results.push(app.measure("S1  switch room (room-1 → room-2)"));

    expect(screen.getAllByText("Message 30 in room-2").length).toBeGreaterThan(0);
  });
});

describe("scenario 2: receive and send messages", () => {
  test("receive 5 messages in the active room", async () => {
    const app = await mountChatApp("/chat/room-1");
    const socket = app.socket();

    app.startMeasure();
    for (let i = 1; i <= 5; i += 1) {
      act(() => {
        socket.serverEmit("new_message", makeMessage("room-1", 40 + i, "m-2"));
      });
    }
    await app.settle();
    results.push(app.measure("S2a receive 5 msgs (active room)"));

    expect(screen.getAllByText("Message 45 in room-1").length).toBeGreaterThan(0);
  });

  test("receive 3 messages in a background room", async () => {
    const app = await mountChatApp("/chat/room-1");
    const socket = app.socket();

    app.startMeasure();
    for (let i = 1; i <= 3; i += 1) {
      act(() => {
        socket.serverEmit("new_message", makeMessage("room-3", 10 + i, "f-1"));
      });
    }
    await app.settle();
    results.push(app.measure("S2b receive 3 msgs (background room)"));

    // Unread badge for the background room appears in the sidebar.
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
    // The active conversation must not show the background room's messages.
    expect(screen.queryByText("Message 11 in room-3")).toBeNull();
  });

  test("send one message and receive the server echo", async () => {
    const app = await mountChatApp("/chat/room-1");
    const socket = app.socket();
    const textarea = screen.getByPlaceholderText("Type a message...");

    app.startMeasure();
    fireEvent.change(textarea, { target: { value: "Hello from me" } });
    fireEvent.click(screen.getByText("Send"));
    act(() => {
      socket.serverEmit(
        "new_message",
        makeMessage("room-1", 41, ME_ID, { content: "Hello from me" }),
      );
    });
    await app.settle();
    results.push(app.measure("S2c send 1 msg + server echo"));

    expect(socket.countEmitted("send_message")).toBe(1);
    expect(screen.getAllByText("Hello from me").length).toBeGreaterThan(0);
  });
});

describe("scenario 3: typing, typing indicator, right panel", () => {
  test("remote typing indicator on and off", async () => {
    const app = await mountChatApp("/chat/room-1");
    const socket = app.socket();

    app.startMeasure();
    act(() => {
      socket.serverEmit("user_typing", { roomId: "room-1", userId: "m-1", isTyping: true });
    });
    expect(await screen.findByText(/Member One is typing/)).toBeTruthy();
    act(() => {
      socket.serverEmit("user_typing", { roomId: "room-1", userId: "m-1", isTyping: false });
    });
    await app.settle();
    results.push(app.measure("S3a remote typing on+off"));

    expect(screen.queryByText(/is typing/)).toBeNull();
  });

  test("local input: 5 keystrokes in the message box", async () => {
    const app = await mountChatApp("/chat/room-1");
    const textarea = screen.getByPlaceholderText("Type a message...");

    app.startMeasure();
    for (const value of ["H", "He", "Hel", "Hell", "Hello"]) {
      fireEvent.change(textarea, { target: { value } });
    }
    await app.settle();
    results.push(app.measure("S3b local input x5 keystrokes"));

    expect(app.socket().countEmitted("typing")).toBeGreaterThan(0);
  });

  test("toggle the right panel off and on", async () => {
    const app = await mountChatApp("/chat/room-1");

    app.startMeasure();
    fireEvent.click(screen.getByTitle("Hide Info Panel"));
    await app.settle();
    fireEvent.click(screen.getByTitle("Show Info Panel"));
    await app.settle();
    results.push(app.measure("S3c toggle right panel x2"));

    expect(screen.getByTitle("Hide Info Panel")).toBeTruthy();
  });
});
