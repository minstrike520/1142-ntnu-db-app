/**
 * Behaviour regression tests for the chat surface, written against the render
 * measurement harness (issue #383). They pin down the user-visible behaviour
 * of messages, typing, read receipts, unread state, panel toggling and room
 * switching so the render-performance fixes cannot change semantics.
 */
import { describe, expect, test, vi } from "vitest";
import { useEffect } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { mountChatApp } from "./harness";
import { ME_ID, makeMessage, messageId } from "./fixtures";
import {
  __failNextListMessages,
  __failNextRevisionCommand,
  __gateNextSync,
  __getApiCallLog,
} from "./mocks/api";
import { useChat } from "@/context/ChatContext";

describe("opening and switching rooms", () => {
  test("shows the active room's messages and members panel", async () => {
    await mountChatApp("/chat/room-1");

    expect(screen.getAllByText("Message 40 in room-1").length).toBeGreaterThan(0);
    expect(screen.getByText("Members (8)")).toBeTruthy();
    expect(screen.getByText("Group Chat • 8 members")).toBeTruthy();
  });

  test("switching rooms swaps the conversation", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();

    expect(screen.getAllByText("Message 15 in room-2").length).toBeGreaterThan(0);
    // Bodies from room-1 are gone (its final message may stay visible in the
    // sidebar preview, so check a mid-log message that never appears there).
    expect(screen.queryByText("Message 15 in room-1")).toBeNull();
  });

  test("shows the unread marker when entering a room with unread messages", async () => {
    await mountChatApp("/chat/room-2");

    expect(screen.getByText("New Messages")).toBeTruthy();
  });
});

describe("receiving and sending messages", () => {
  test("renders an incoming message and updates the sidebar preview", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverEmit(
        "new_message",
        makeMessage("room-1", 41, "m-2", { content: "Fresh incoming message" }),
      );
    });
    await app.settle();

    // Bubble plus sidebar preview.
    expect(screen.getAllByText("Fresh incoming message").length).toBeGreaterThanOrEqual(2);
  });

  test("increments the unread badge for a background room", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverEmit(
        "new_message",
        makeMessage("room-3", 11, "f-1", { content: "New bg message" }),
      );
    });
    await app.settle();

    // Preview updates and the conversation pane does not show the message.
    const previews = screen.getAllByText("New bg message");
    expect(previews.length).toBe(1);
    expect(screen.getAllByText("1", { exact: true }).length).toBeGreaterThan(0);
  });

  test("sends a durable message over REST and renders the server echo", async () => {
    const app = await mountChatApp("/chat/room-1");
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("Type a message...");

    fireEvent.change(textarea, { target: { value: "Hello there" } });
    fireEvent.click(screen.getByText("Send"));

    const sends = __getApiCallLog("createMessage");
    expect(sends).toHaveLength(1);
    expect(sends[0].args[0]).toBe("room-1");
    expect(sends[0].args[1]).toMatchObject({ content: "Hello there" });
    expect(textarea.value).toBe("");

    act(() => {
      app.socket().serverEmit(
        "new_message",
        makeMessage("room-1", 41, ME_ID, { content: "Hello there" }),
      );
    });
    await app.settle();

    expect(screen.getAllByText("Hello there").length).toBeGreaterThan(0);
  });

  test("marks a message as recalled when the server says so", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverEmit("message_recalled", { messageId: messageId("room-1", 40) });
    });
    await app.settle();

    expect(screen.getByText("Message recalled")).toBeTruthy();
    // The body is gone from the conversation; the sidebar preview may remain.
    expect(screen.queryAllByText("Message 40 in room-1").length).toBeLessThanOrEqual(1);
  });
});

describe("message revision conflicts", () => {
  let recall: ((messageId: string) => void) | null = null;

  function ConflictProbe(): React.ReactElement {
    const { handleRecallMessage } = useChat();
    useEffect(() => {
      recall = handleRecallMessage;
    }, [handleRecallMessage]);
    return <div data-testid="conflict-probe" />;
  }

  test("tells the user and reloads the room when the server rejects a stale revision", async () => {
    const target = messageId("room-1", 40);
    const app = await mountChatApp("/chat/room-1", { probe: <ConflictProbe /> });

    __failNextRevisionCommand(target);
    act(() => {
      recall!(target);
    });
    await app.settle();

    // A 409 used to be logged and swallowed, leaving the user staring at a
    // message the server had already changed.
    expect(screen.getByText(/message changed elsewhere/i)).toBeTruthy();
    expect(__getApiCallLog("recallMessage").length).toBe(1);

    fireEvent.click(screen.getByText("Dismiss"));
    await app.settle();
    expect(screen.queryByText(/message changed elsewhere/i)).toBeNull();
  });

  test("does not claim the message was reloaded when the reload itself fails", async () => {
    const target = messageId("room-1", 40);
    const app = await mountChatApp("/chat/room-1", { probe: <ConflictProbe /> });

    __failNextRevisionCommand(target);
    __failNextListMessages();
    act(() => {
      recall!(target);
    });
    await app.settle();

    // The stale revision is still on screen, so the notice must say so rather
    // than promise a refresh that never landed.
    expect(screen.getByText(/could not be reloaded/i)).toBeTruthy();
  });
});

describe("typing indicator", () => {
  test("appears while a member types and clears afterwards", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverEmit("user_typing", { roomId: "room-1", userId: "m-1", isTyping: true });
    });
    expect(await screen.findByText("Member One is typing...")).toBeTruthy();

    act(() => {
      app.socket().serverEmit("user_typing", { roomId: "room-1", userId: "m-1", isTyping: false });
    });
    await app.settle();
    expect(screen.queryByText(/is typing/)).toBeNull();
  });

  test("typing in another room does not show an indicator here", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverEmit("user_typing", { roomId: "room-2", userId: "m-1", isTyping: true });
    });
    await app.settle();
    expect(screen.queryByText(/is typing/)).toBeNull();
  });

  test("local keystrokes emit typing events over the socket", async () => {
    const app = await mountChatApp("/chat/room-1");
    const textarea = screen.getByPlaceholderText("Type a message...");

    fireEvent.change(textarea, { target: { value: "abc" } });
    const typingEvents = app.socket().emitted.filter((e) => e.event === "typing");
    expect(typingEvents.length).toBeGreaterThan(0);
    expect(typingEvents.at(-1)?.payload).toMatchObject({ roomId: "room-1", isTyping: true });
  });
});

describe("read receipts", () => {
  test("shows a reader avatar once a member reads the latest message", async () => {
    const app = await mountChatApp("/chat/room-1");

    // m-1 has already read message 40 in the fixtures.
    expect(screen.getByTitle("Member One")).toBeTruthy();

    act(() => {
      app.socket().serverEmit("read_update", {
        roomId: "room-1",
        userId: "m-2",
        messageId: messageId("room-1", 40),
      });
    });
    await app.settle();

    expect(screen.getByTitle("Member Two")).toBeTruthy();
  });
});

describe("realtime sync recovery", () => {
  let readStates: Record<string, Record<string, string>> = {};
  let observedRooms: Array<{ id: string; unreadCount?: number }> = [];

  function ReadStateProbe(): React.ReactElement {
    const { groupReadStates, rooms } = useChat();
    useEffect(() => {
      readStates = groupReadStates;
    }, [groupReadStates]);
    useEffect(() => {
      observedRooms = rooms;
    }, [rooms]);
    return <div data-testid="read-state-probe" />;
  }

  test("keeps a read receipt that arrived while a failing sync was in flight", async () => {
    const app = await mountChatApp("/chat/room-1", { probe: <ReadStateProbe /> });
    const target = messageId("room-1", 40);
    expect(readStates["room-1"]?.["m-2"]).not.toBe(target);

    // Reconnect with the sync held open, so the read receipt lands in the
    // buffer rather than being applied directly.
    const failing = __gateNextSync();
    act(() => {
      app.socket().disconnect();
      app.socket().connect();
    });
    act(() => {
      app.socket().serverEmit("read_update", {
        roomId: "room-1",
        userId: "m-2",
        messageId: target,
      });
    });

    // Precondition: the receipt is buffered, not applied live.
    expect(readStates["room-1"]?.["m-2"]).not.toBe(target);

    // The sync fails. New-message events are dropped because the retry
    // re-delivers them; a read receipt never is, so it has to survive.
    await act(async () => {
      failing.fail();
      await Promise.resolve();
    });
    await app.settle();

    act(() => {
      app.socket().connect();
    });
    await app.settle();

    expect(readStates["room-1"]?.["m-2"]).toBe(target);
  });

  test("replays a buffered new message for its side effects without double-counting unread", async () => {
    const app = await mountChatApp("/chat/room-1", { probe: <ReadStateProbe /> });
    const incoming = makeMessage("room-2", 99, "m-3", { content: "Buffered while syncing" });

    const failing = __gateNextSync();
    act(() => {
      app.socket().disconnect();
      app.socket().connect();
    });
    act(() => {
      app.socket().serverEmit("new_message", incoming);
    });

    await act(async () => {
      failing.fail();
      await Promise.resolve();
    });
    await app.settle();

    act(() => {
      app.socket().connect();
    });
    await app.settle();

    // The sender's read receipt rides on new_message and is never re-delivered
    // by sync, so the task has to be replayed rather than dropped.
    expect(readStates["room-2"]?.["m-3"]).toBe(incoming.messageId);
    expect(screen.getAllByText("Buffered while syncing").length).toBeGreaterThan(0);
    // The retry's canonical room projection already counted this message, so
    // the replay must not add to it. room-2 is unread 3 in the fixtures.
    expect(observedRooms.find((room) => room.id === "room-2")?.unreadCount).toBe(3);
  });

  test("reloads the active room's members after a recovery sync", async () => {
    const app = await mountChatApp("/chat/room-1", { probe: <ReadStateProbe /> });
    const before = __getApiCallLog("listRoomMembers").length;

    act(() => {
      app.socket().disconnect();
      app.socket().connect();
    });
    await app.settle();

    // Room summaries carry no members and the cached list survives the refresh,
    // so without an explicit reload the roles, avatars and read markers changed
    // during the outage would stay stale until the user switched rooms.
    const reloads = __getApiCallLog("listRoomMembers")
      .slice(before)
      .filter((entry) => entry.args[0] === "room-1");
    expect(reloads.length).toBeGreaterThan(0);
  });

  test("never advances the sync cursor from a live event's sequence", async () => {
    const app = await mountChatApp("/chat/room-1", { probe: <ReadStateProbe /> });
    const incoming = makeMessage("room-1", 41, "m-2", {
      content: "Live only",
      changeSequence: 4_242,
    });

    act(() => {
      app.socket().serverEmit("new_message", incoming);
    });
    await app.settle();

    act(() => {
      app.socket().disconnect();
      app.socket().connect();
    });
    await app.settle();

    // Services publish after their transaction commits and after a follow-up
    // snapshot query, so concurrent commands can reach the client out of
    // sequence order. Trusting the larger sequence as a watermark would push a
    // smaller, not-yet-received change permanently behind `/sync`'s
    // `change_sequence > cursor` filter. Only `/sync` may move the cursor.
    const cursors = __getApiCallLog("syncChanges").map((entry) => entry.args[0]);
    expect(cursors).not.toContain(4_242);
    expect(cursors.at(-1)).toBe(0);
  });

  test("checkpoints the cursor through /sync while the session stays connected", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const app = await mountChatApp("/chat/room-1", { probe: <ReadStateProbe /> });

      // No durable event yet, so a tick has nothing to checkpoint.
      const idleBefore = __getApiCallLog("syncChanges").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000);
      });
      expect(__getApiCallLog("syncChanges").length).toBe(idleBefore);

      act(() => {
        app.socket().serverEmit(
          "new_message",
          makeMessage("room-1", 42, "m-2", { content: "Checkpoint me", changeSequence: 4_243 }),
        );
      });
      await app.settle();

      // Now the cursor is behind, so the tick pulls it forward through the one
      // path that cannot straddle a sequence gap — without a reconnect.
      const before = __getApiCallLog("syncChanges").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6 * 60_000);
      });
      expect(__getApiCallLog("syncChanges").length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("right panel", () => {
  test("toggles the members panel off and on", async () => {
    const app = await mountChatApp("/chat/room-1");

    expect(screen.getByText("Members (8)")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Hide Info Panel"));
    await app.settle();
    expect(screen.queryByText("Members (8)")).toBeNull();

    fireEvent.click(screen.getByTitle("Show Info Panel"));
    await app.settle();
    expect(screen.getByText("Members (8)")).toBeTruthy();
  });
});
