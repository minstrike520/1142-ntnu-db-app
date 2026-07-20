/**
 * Memoization contract tests for ChatContext (issue #383, hotspot #1).
 *
 * These pin down the two properties the stabilized context value must keep:
 *  1. handler identities stay stable across provider state changes (so
 *     downstream memo boundaries are not invalidated), and
 *  2. the stable handlers never capture stale state — a handler reference
 *     taken on the very first render must still observe later state when it
 *     is finally invoked (guards against the classic stale-closure bug that
 *     naive memoization would introduce).
 */
import React from "react";
import { describe, expect, test } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { useChat } from "@/context/ChatContext";
import { mountChatApp } from "./harness";
import { makeMessage, messageId } from "./fixtures";
import { __getApiCallLog } from "./mocks/api";

type ChatContextValue = ReturnType<typeof useChat>;

function makeProbe(sink: ChatContextValue[]): React.ReactElement {
  function ContextProbe(): null {
    const ctx = useChat();
    sink.push(ctx);
    return null;
  }
  return <ContextProbe />;
}

describe("message list memo boundary", () => {
  test("appending one message renders only the affected rows", async () => {
    const app = await mountChatApp("/chat/room-1");

    app.startMeasure();
    act(() => {
      app.socket().serverEmit("new_message", makeMessage("room-1", 41, "m-2"));
    });
    await app.settle();
    const m = app.measure("append one message");

    expect(screen.getAllByText("Message 41 in room-1").length).toBeGreaterThan(0);
    // 40 existing rows must not re-render; only the new row (plus at most a
    // couple of rows whose read receipts moved) may.
    expect(m.chatBubbleRenders).toBeLessThanOrEqual(3);
  });

  test("messages for a background room render no rows in the active room", async () => {
    const app = await mountChatApp("/chat/room-1");

    app.startMeasure();
    act(() => {
      app.socket().serverEmit("new_message", makeMessage("room-3", 11, "f-1"));
    });
    await app.settle();
    const m = app.measure("background message");

    expect(m.chatBubbleRenders).toBe(0);
  });

  test("local keystrokes render no message rows", async () => {
    const app = await mountChatApp("/chat/room-1");
    const textarea = screen.getByPlaceholderText("Type a message...");

    app.startMeasure();
    for (const value of ["a", "ab", "abc"]) {
      fireEvent.change(textarea, { target: { value } });
    }
    await app.settle();
    const m = app.measure("local keystrokes");

    expect(m.chatBubbleRenders).toBe(0);
  });

  test("remote typing events render no message rows", async () => {
    const app = await mountChatApp("/chat/room-1");

    app.startMeasure();
    act(() => {
      app.socket().serverEmit("user_typing", { roomId: "room-1", userId: "m-1", isTyping: true });
    });
    expect(await screen.findByText(/Member One is typing/)).toBeTruthy();
    await app.settle();
    const m = app.measure("remote typing");

    expect(m.chatBubbleRenders).toBe(0);
  });

  test("reply and recall actions still work through the stable row callbacks", async () => {
    const app = await mountChatApp("/chat/room-1");

    // Hover actions render for every non-recalled row; pick the last one.
    fireEvent.click(screen.getAllByText("Reply").at(-1)!);
    // The last row (message 40) is an outgoing message from the fixture user.
    expect(screen.getByText("Reply to Me User")).toBeTruthy();

    fireEvent.click(screen.getAllByText("Recall").at(-1)!);
    const recalls = app.socket().emitted.filter((e) => e.event === "recall_message");
    expect(recalls).toHaveLength(1);
    expect(recalls[0].payload).toMatchObject({ messageId: messageId("room-1", 40) });
  });
});

describe("ChatContext value stability", () => {
  test("handler identities survive provider state changes", async () => {
    const seen: ChatContextValue[] = [];
    const app = await mountChatApp("/chat/room-1", { probe: makeProbe(seen) });

    const before = seen.at(-1)!;
    act(() => {
      app.socket().serverEmit("new_message", makeMessage("room-1", 41, "m-2"));
    });
    await app.settle();
    const after = seen.at(-1)!;

    // Data changed, so the value object itself must change...
    expect(after).not.toBe(before);
    expect(after.messages).not.toBe(before.messages);
    // ...but every handler keeps its identity.
    expect(after.handleSendMessage).toBe(before.handleSendMessage);
    expect(after.handleTyping).toBe(before.handleTyping);
    expect(after.handleCategorizeRoom).toBe(before.handleCategorizeRoom);
    expect(after.loadGroupMembers).toBe(before.loadGroupMembers);
    expect(after.markRoomAsRead).toBe(before.markRoomAsRead);
    expect(after.setMessages).toBe(before.setMessages);
  });

  test("a captured handler observes later state (no stale closure)", async () => {
    const seen: ChatContextValue[] = [];
    const app = await mountChatApp("/chat/room-1", { probe: makeProbe(seen) });

    // Capture the handler reference *before* the folder list changes.
    const captured = seen.at(-1)!.handleCategorizeRoom;
    expect(seen.at(-1)!.folders.map((f) => f.name)).toEqual(["Work", "Social"]);

    await act(async () => {
      await seen.at(-1)!.handleCreateFolder("Later");
    });
    await app.settle();
    expect(seen.at(-1)!.folders).toHaveLength(3);

    // The old reference must see all three folders; a stale closure would
    // only recompute room lists for the original two.
    await act(async () => {
      await captured("room-1", "folder-1");
    });

    const calls = __getApiCallLog("updateFolderRooms");
    const byFolder = new Map(calls.map((c) => [c.args[0], c.args[1]]));
    expect(byFolder.size).toBe(3);
    expect(byFolder.get("folder-1")).toEqual(
      expect.arrayContaining(["room-3", "room-4", "room-1"]),
    );
    expect(byFolder.get("folder-2")).toEqual(["room-5"]);
    expect(byFolder.has("folder-Later")).toBe(true);
  });

  test("remote typing events do not invalidate the main context value", async () => {
    const seen: ChatContextValue[] = [];
    const app = await mountChatApp("/chat/room-1", { probe: makeProbe(seen) });

    const before = seen.at(-1)!;
    act(() => {
      app.socket().serverEmit("user_typing", { roomId: "room-1", userId: "m-1", isTyping: true });
    });
    expect(await screen.findByText(/Member One is typing/)).toBeTruthy();

    // The indicator rendered, but the main context value kept its identity —
    // useChat() consumers were not invalidated by the typing event.
    expect(seen.at(-1)!).toBe(before);

    act(() => {
      app.socket().serverEmit("user_typing", { roomId: "room-1", userId: "m-1", isTyping: false });
    });
    await app.settle();
    expect(seen.at(-1)!).toBe(before);
  });

  test("toggling the right panel does not invalidate the main context value", async () => {
    const seen: ChatContextValue[] = [];
    const app = await mountChatApp("/chat/room-1", { probe: makeProbe(seen) });

    const before = seen.at(-1)!;
    fireEvent.click(screen.getByTitle("Hide Info Panel"));
    await app.settle();

    expect(screen.queryByText("Members (8)")).toBeNull();
    expect(seen.at(-1)!).toBe(before);

    fireEvent.click(screen.getByTitle("Show Info Panel"));
    await app.settle();
    expect(screen.getByText("Members (8)")).toBeTruthy();
  });

  test("switching the UI language still reaches translation consumers", async () => {
    const seen: ChatContextValue[] = [];
    const app = await mountChatApp("/chat/room-1", { probe: makeProbe(seen) });

    expect(screen.getByText("Send")).toBeTruthy();

    await act(async () => {
      await seen.at(-1)!.handleUpdatePreferences({
        theme: "light",
        language: "zh-TW",
        notifyDesktop: true,
        notifySound: true,
      });
    });
    await app.settle();

    expect(screen.getByText("發送")).toBeTruthy();
    expect(screen.getByText("成員列表 (8)")).toBeTruthy();
  });

  test("getReadAvatarsForMessage tracks the latest read state", async () => {
    const seen: ChatContextValue[] = [];
    const app = await mountChatApp("/chat/room-1", { probe: makeProbe(seen) });

    const readersOf = (ctx: ChatContextValue) => {
      const room = ctx.rooms.find((r) => r.id === "room-1")!;
      const msg = ctx.messages.find((m) => m.id === messageId("room-1", 40))!;
      return ctx.getReadAvatarsForMessage(room, msg).map((r) => r.name);
    };

    expect(readersOf(seen.at(-1)!)).toEqual(["Member One"]);

    act(() => {
      app.socket().serverEmit("read_update", {
        roomId: "room-1",
        userId: "m-2",
        messageId: messageId("room-1", 40),
      });
    });
    await app.settle();

    expect(readersOf(seen.at(-1)!)).toEqual(
      expect.arrayContaining(["Member One", "Member Two"]),
    );
  });
});
