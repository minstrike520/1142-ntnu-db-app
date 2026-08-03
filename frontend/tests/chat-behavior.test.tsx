/**
 * Behaviour regression tests for the chat surface, written against the render
 * measurement harness (issue #383). They pin down the user-visible behaviour
 * of messages, typing, read receipts, unread state, panel toggling and room
 * switching so the render-performance fixes cannot change semantics.
 */
import React from "react";
import { describe, expect, test } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { mountChatApp } from "./harness";
import { ME_ID, makeMessage, messageId } from "./fixtures";
import { mergeMessageSnapshot, useChat, type Message } from "@/context/ChatContext";

type ChatContextValue = ReturnType<typeof useChat>;

function makeProbe(sink: ChatContextValue[]): React.ReactElement {
  function ContextProbe(): null {
    sink.push(useChat());
    return null;
  }
  return <ContextProbe />;
}

describe("reconnect snapshot convergence", () => {
  test("a delayed REST snapshot cannot wipe pending commands or newer live revisions", () => {
    const base: Message = {
      id: "message-live",
      revision: "2",
      deliveryState: "sent",
      roomId: "room-1",
      senderId: ME_ID,
      senderName: "Me",
      content: "new live value",
      sentAt: "2026-08-03T00:00:02.000Z",
      timestamp: "00:00",
    };
    const pending: Message = {
      ...base,
      id: "command-pending",
      revision: undefined,
      commandId: "command-pending",
      deliveryState: "pending",
      content: "pending value",
    };

    const merged = mergeMessageSnapshot([base, pending], [{
      ...base,
      revision: "1",
      content: "stale snapshot value",
    }]);

    expect(merged.find((message) => message.id === base.id)?.content).toBe("new live value");
    expect(merged).toContainEqual(pending);
  });
});

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
      app.socket().serverMessageCreated(
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
      app.socket().serverMessageCreated(
        makeMessage("room-3", 11, "f-1", { content: "New bg message" }),
      );
    });
    await app.settle();

    // Preview updates and the conversation pane does not show the message.
    const previews = screen.getAllByText("New bg message");
    expect(previews.length).toBe(1);
    expect(screen.getAllByText("1", { exact: true }).length).toBeGreaterThan(0);
  });

  test("converges an optimistic send onto the canonical ACK without duplicating it", async () => {
    const seen: ChatContextValue[] = [];
    const app = await mountChatApp("/chat/room-1", { probe: makeProbe(seen) });
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("Type a message...");

    fireEvent.change(textarea, { target: { value: "Hello there" } });
    fireEvent.click(screen.getByText("Send"));

    const sends = app.socket().emitted.filter((e) => e.event === "message.send");
    expect(sends).toHaveLength(1);
    expect(sends[0].payload).toMatchObject({ roomId: "room-1", content: "Hello there" });
    expect(textarea.value).toBe("");

    await app.settle();

    // The server excludes the originating connection from the room broadcast, so
    // the ACK is the sole delivery and must replace the optimistic placeholder
    // rather than sit alongside it.
    const sent = seen.at(-1)!.messages.filter((m: Message) => m.content === "Hello there");
    expect(sent).toHaveLength(1);
    expect(sent[0].id).not.toBe(sends[0].id);
    expect(sent[0].deliveryState).toBe("sent");
    expect(screen.getAllByText("Hello there")).toHaveLength(2);
  });

  test("marks a message as recalled when the server says so", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverMessageRecalled(messageId("room-1", 40));
    });
    await app.settle();

    expect(screen.getByText("Message recalled")).toBeTruthy();
    // The body is gone from the conversation; the sidebar preview may remain.
    expect(screen.queryAllByText("Message 40 in room-1").length).toBeLessThanOrEqual(1);
  });
});

describe("typing indicator", () => {
  test("appears while a member types and clears afterwards", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverTypingChanged({ roomId: "room-1", userId: "m-1", isTyping: true });
    });
    expect(await screen.findByText("Member One is typing...")).toBeTruthy();

    act(() => {
      app.socket().serverTypingChanged({ roomId: "room-1", userId: "m-1", isTyping: false });
    });
    await app.settle();
    expect(screen.queryByText(/is typing/)).toBeNull();
  });

  test("typing in another room does not show an indicator here", async () => {
    const app = await mountChatApp("/chat/room-1");

    act(() => {
      app.socket().serverTypingChanged({ roomId: "room-2", userId: "m-1", isTyping: true });
    });
    await app.settle();
    expect(screen.queryByText(/is typing/)).toBeNull();
  });

  test("local keystrokes emit typing events over the socket", async () => {
    const app = await mountChatApp("/chat/room-1");
    const textarea = screen.getByPlaceholderText("Type a message...");

    fireEvent.change(textarea, { target: { value: "abc" } });
    const typingEvents = app.socket().emitted.filter((e) => e.event === "typing.set");
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
      app.socket().serverReadAdvanced({
        roomId: "room-1",
        userId: "m-2",
        messageId: messageId("room-1", 40),
      });
    });
    await app.settle();

    expect(screen.getByTitle("Member Two")).toBeTruthy();
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
