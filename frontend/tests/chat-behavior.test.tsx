/**
 * Behaviour regression tests for the chat surface, written against the render
 * measurement harness (issue #383). They pin down the user-visible behaviour
 * of messages, typing, read receipts, unread state, panel toggling and room
 * switching so the render-performance fixes cannot change semantics.
 */
import { describe, expect, test } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { mountChatApp } from "./harness";
import { ME_ID, makeMessage, messageId } from "./fixtures";

describe("opening and switching rooms", () => {
  test("shows the active room's messages and members panel", async () => {
    await mountChatApp("/chat/room-1");

    expect(screen.getAllByText("Message 40 in room-1").length).toBeGreaterThan(0);
    expect(document.querySelector(".members-panel-root")).toBeTruthy();
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

  test("sends a message over the socket and renders the server echo", async () => {
    const app = await mountChatApp("/chat/room-1");
    const textarea = screen.getByPlaceholderText<HTMLTextAreaElement>("Type a message...");

    fireEvent.change(textarea, { target: { value: "Hello there" } });
    fireEvent.click(screen.getByText("Send"));

    const sends = app.socket().emitted.filter((e) => e.event === "send_message");
    expect(sends).toHaveLength(1);
    expect(sends[0].payload).toMatchObject({ roomId: "room-1", content: "Hello there" });
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

describe("right panel", () => {
  test("toggles the members panel off and on", async () => {
    const app = await mountChatApp("/chat/room-1");

    expect(document.querySelector(".members-panel-root")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Hide Info Panel"));
    await app.settle();
    expect(document.querySelector(".members-panel-root")).toBeNull();

    fireEvent.click(screen.getByTitle("Show Info Panel"));
    await app.settle();
    expect(document.querySelector(".members-panel-root")).toBeTruthy();
  });
});
