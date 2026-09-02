/**
 * Chat-room working-state preservation (issue #539).
 *
 * Covers the parts of the requirement that are observable without a layout
 * engine: composer draft, reply target and pending attachments surviving both a
 * room switch and a trip off the chat route, per-room isolation, and the states
 * that must deliberately NOT be preserved.
 *
 * Scroll offset is covered only as *plumbing*: jsdom stores `scrollTop`
 * assignments but computes no layout, so `scrollHeight`/`clientHeight` and
 * `getBoundingClientRect()` all read 0 and must be faked per element. That is
 * enough to prove the offset round-trips through the store, and not enough to
 * prove what the user sees — pixel accuracy, drift after attachment images
 * load, and the absence of a visible jump need a real browser (#543 / #544).
 */
import { describe, expect, test } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { mountChatApp } from "./harness";
import { __getApiCallLog, __holdNextAttachmentUpload } from "./mocks/api";

const composer = () => screen.getByPlaceholderText<HTMLTextAreaElement>("Type a message...");

const fileInput = (container: HTMLElement) => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error("attachment input not rendered");
  return input;
};

const attachFile = (container: HTMLElement, filename: string) => {
  fireEvent.change(fileInput(container), {
    target: { files: [new File(["body"], filename, { type: "text/plain" })] },
  });
};

/** The scrollable message list: the parent of the rendered message rows. */
const scrollArea = (container: HTMLElement) => {
  const row = container.querySelector("[data-msg-id]");
  const area = row?.parentElement;
  if (!area) throw new Error("message list not rendered");
  return area as HTMLElement;
};

/** Give jsdom the layout metrics it never computes, so scrolling is meaningful. */
const fakeScrollMetrics = (el: HTMLElement, scrollHeight: number, clientHeight: number) => {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
};

/** Opens the actions menu on one of the current user's own messages. */
const openOwnMessageMenu = () => {
  for (const button of screen.getAllByLabelText("Message actions")) {
    fireEvent.click(button);
    if (screen.queryByText("Edit Message")) return;
    fireEvent.click(document.body);
  }
  throw new Error("no own message with an edit action found");
};

describe("draft preservation across navigation", () => {
  test("returns to the last viewed room from the chats navigation", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    expect(screen.getAllByText("Message 15 in room-2").length).toBeGreaterThan(0);

    await app.navigate("/friends");
    await app.settle();
    fireEvent.click(screen.getAllByRole("button", { name: "Chats" })[0]);
    await app.settle();

    expect(screen.getAllByText("Message 15 in room-2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Message 15 in room-1")).toBeNull();
  });

  test("returns to the last viewed room from the mobile chats navigation", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    await app.navigate("/friends");
    await app.settle();
    const chatsButtons = screen.getAllByRole("button", { name: "Chats" });
    fireEvent.click(chatsButtons[chatsButtons.length - 1]);
    await app.settle();

    expect(screen.getAllByText("Message 15 in room-2").length).toBeGreaterThan(0);
    expect(screen.queryByText("Message 15 in room-1")).toBeNull();
  });

  test("restores the typed draft after leaving and re-entering the chat route", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.change(composer(), { target: { value: "half-written thought" } });
    await app.settle();

    await app.navigate("/friends");
    await app.settle();
    expect(screen.queryByPlaceholderText("Type a message...")).toBeNull();

    await app.navigate("/chat/room-1");
    await app.settle();

    expect(composer().value).toBe("half-written thought");
  });

  test("keeps a separate draft per room", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.change(composer(), { target: { value: "draft for alpha" } });
    await app.settle();

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    // A room with no draft yet starts empty rather than inheriting alpha's.
    expect(composer().value).toBe("");

    fireEvent.change(composer(), { target: { value: "draft for beta" } });
    await app.settle();

    fireEvent.click(screen.getByText("Alpha Group"));
    await app.settle();
    expect(composer().value).toBe("draft for alpha");

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    expect(composer().value).toBe("draft for beta");
  });

  test("does not resurrect a draft that was already sent", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.change(composer(), { target: { value: "Hello there" } });
    fireEvent.click(screen.getByText("Send"));
    await app.settle();

    await app.navigate("/settings");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    expect(composer().value).toBe("");
  });
});

describe("reply target preservation", () => {
  test("keeps the pending reply after leaving and re-entering the chat route", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.click(screen.getAllByText("Reply")[0]);
    await app.settle();
    expect(screen.getByText(/^Reply to /)).toBeTruthy();

    await app.navigate("/emergency");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    expect(screen.getByText(/^Reply to /)).toBeTruthy();
  });
});

describe("pending attachment preservation", () => {
  test("keeps an attachment upload locked across route remounts", async () => {
    const app = await mountChatApp("/chat/room-1");
    const releaseUpload = __holdNextAttachmentUpload();

    attachFile(app.view.container, "quarterly.txt");
    await app.settle();
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("Uploading...")).toBeTruthy());

    await app.navigate("/friends");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    expect(screen.getByText("Uploading...")).toBeTruthy();
    fireEvent.click(screen.getByText("Uploading..."));
    releaseUpload();
    await app.settle();

    expect(__getApiCallLog("uploadAttachment")).toHaveLength(1);
    expect(__getApiCallLog("createMessage")).toHaveLength(1);
  });

  test("does not clear the next room draft when an upload completes", async () => {
    const app = await mountChatApp("/chat/room-1");
    const releaseUpload = __holdNextAttachmentUpload();

    attachFile(app.view.container, "quarterly.txt");
    await app.settle();
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(screen.getByText("Uploading...")).toBeTruthy());

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    fireEvent.change(composer(), { target: { value: "draft for beta" } });
    await app.settle();

    releaseUpload();
    await app.settle();

    expect(composer().value).toBe("draft for beta");
    expect(__getApiCallLog("uploadAttachment")).toHaveLength(1);
    expect(__getApiCallLog("createMessage")).toHaveLength(1);
  });

  test("keeps unsent attachments across navigation", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.change(fileInput(app.view.container), {
      target: { files: [new File(["report"], "quarterly.txt", { type: "text/plain" })] },
    });
    await app.settle();
    expect(screen.getByText("quarterly.txt")).toBeTruthy();

    await app.navigate("/friends");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    expect(screen.getByText("quarterly.txt")).toBeTruthy();
  });

  test("does not carry unsent attachments into another room", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.change(fileInput(app.view.container), {
      target: { files: [new File(["report"], "quarterly.txt", { type: "text/plain" })] },
    });
    await app.settle();

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    expect(screen.queryByText("quarterly.txt")).toBeNull();

    fireEvent.click(screen.getByText("Alpha Group"));
    await app.settle();
    expect(screen.getByText("quarterly.txt")).toBeTruthy();
  });
});

describe("right panel preservation", () => {
  test("keeps the info panel collapsed after leaving and re-entering the chat route", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.click(screen.getByTitle("Hide Info Panel"));
    await app.settle();
    expect(screen.queryByText("Members (8)")).toBeNull();

    await app.navigate("/friends");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    expect(screen.queryByText("Members (8)")).toBeNull();
  });
});

describe("edit state isolation", () => {
  test("clears an edit when its message is recalled after restoration", async () => {
    const app = await mountChatApp("/chat/room-1");

    openOwnMessageMenu();
    fireEvent.click(screen.getByText("Edit Message"));
    await app.settle();
    await app.navigate("/friends");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();
    expect(screen.getByText("Editing message (Press Esc to cancel)")).toBeTruthy();

    act(() => {
      app.socket().serverEmit("message_recalled", { messageId: "room-1-msg-004" });
    });
    await waitFor(() => {
      expect(screen.queryByText("Editing message (Press Esc to cancel)")).toBeNull();
    });

    expect(composer().value).toBe("");
  });

  test("does not carry an in-progress edit into another room", async () => {
    const app = await mountChatApp("/chat/room-1");

    openOwnMessageMenu();
    fireEvent.click(screen.getByText("Edit Message"));
    await app.settle();
    expect(screen.getByText("Editing message (Press Esc to cancel)")).toBeTruthy();

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();

    // Before #539 this banner stayed put, and handleSend would then send the
    // edit against Beta Group with a message id belonging to Alpha Group.
    expect(screen.queryByText("Editing message (Press Esc to cancel)")).toBeNull();
    expect(composer().value).toBe("");
  });

  test("restores the in-progress edit when returning to its own room", async () => {
    const app = await mountChatApp("/chat/room-1");

    openOwnMessageMenu();
    fireEvent.click(screen.getByText("Edit Message"));
    await app.settle();

    fireEvent.click(screen.getByText("Beta Group"));
    await app.settle();
    fireEvent.click(screen.getByText("Alpha Group"));
    await app.settle();

    expect(screen.getByText("Editing message (Press Esc to cancel)")).toBeTruthy();
  });
});

describe("unsaved attachment guard", () => {
  test("blocks unload while a room holds unsent attachments", async () => {
    const app = await mountChatApp("/chat/room-1");

    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(false);

    attachFile(app.view.container, "quarterly.txt");
    await app.settle();

    const during = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(during);
    expect(during.defaultPrevented).toBe(true);
  });

  test("stops blocking unload once the attachment is removed", async () => {
    const app = await mountChatApp("/chat/room-1");

    attachFile(app.view.container, "quarterly.txt");
    await app.settle();

    fireEvent.click(screen.getByTitle("Cancel"));
    await app.settle();

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  test("still blocks unload from another route", async () => {
    const app = await mountChatApp("/chat/room-1");

    attachFile(app.view.container, "quarterly.txt");
    await app.settle();

    await app.navigate("/friends");
    await app.settle();

    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("scroll offset plumbing", () => {
  test("round-trips a scrolled-away offset through the store", async () => {
    const app = await mountChatApp("/chat/room-1");

    const area = scrollArea(app.view.container);
    fakeScrollMetrics(area, 2000, 400);
    area.scrollTop = 300;
    fireEvent.scroll(area);
    await app.settle();

    await app.navigate("/friends");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    const restored = scrollArea(app.view.container);
    expect(restored.scrollTop).toBe(300);
  });

  test("returns to the newest message when the user left pinned to the bottom", async () => {
    const app = await mountChatApp("/chat/room-1");

    const area = scrollArea(app.view.container);
    // scrollHeight - scrollTop - clientHeight = 0, i.e. pinned to the bottom.
    fakeScrollMetrics(area, 2000, 400);
    area.scrollTop = 1600;
    fireEvent.scroll(area);
    await app.settle();

    await app.navigate("/friends");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    // Falls through to the unread/bottom path rather than pinning the stale
    // offset, so messages that arrived while away still raise the divider.
    expect(scrollArea(app.view.container).scrollTop).not.toBe(1600);
  });
});

describe("state that must not be preserved", () => {
  test("drops the message search query when leaving the chat route", async () => {
    const app = await mountChatApp("/chat/room-1");

    fireEvent.click(screen.getByTitle("Search Messages"));
    await app.settle();
    const search = screen.getByPlaceholderText<HTMLInputElement>("搜尋訊息...");
    fireEvent.change(search, { target: { value: "Message 12" } });
    await app.settle();

    await app.navigate("/friends");
    await app.settle();
    await app.navigate("/chat/room-1");
    await app.settle();

    expect(screen.queryByPlaceholderText("搜尋訊息...")).toBeNull();
  });
});
