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
import { act } from "@testing-library/react";
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
