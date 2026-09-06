import { describe, expect, test } from "vitest";
import {
  compareMessageVersion,
  formatMessageTime,
  getAvatarForUser,
  getPrivateRoomName,
  hydrateReplyTargets,
  isPrivateRoomFallbackName,
  mapAttachment,
  mapFolders,
  mapFriend,
  mapFriendRequest,
  mapMessage,
  mapRoomMember,
  mergeMessages,
  normalizeLanguage,
  sortMessages,
  summarizeMessagePreview,
  toStoredUser,
} from "@/context/chatMappers";
import type { Message } from "@/context/types";
import type {
  Folder as ApiFolder,
  FriendRequestResponse,
  FriendResponse,
  MessageWithSender,
  MyProfile,
  RoomMember as ApiRoomMember,
  UserProfile,
} from "@shared/types";

describe("chatMappers", () => {
  describe("normalizeLanguage", () => {
    test("accepts zh-TW and en, falls back to en", () => {
      expect(normalizeLanguage("zh-TW")).toBe("zh-TW");
      expect(normalizeLanguage("en")).toBe("en");
      expect(normalizeLanguage("fr")).toBe("en");
      expect(normalizeLanguage(undefined)).toBe("en");
    });
  });

  describe("getAvatarForUser", () => {
    test("resolves avatar only if current user matches", () => {
      expect(getAvatarForUser("alice", "/uploads/avatar.png", "alice")).toContain("avatar.png");
      expect(getAvatarForUser("bob", "/uploads/avatar.png", "alice")).toBe("");
      expect(getAvatarForUser("alice", undefined, "alice")).toBe("");
    });
  });

  describe("formatMessageTime", () => {
    test("formats valid dates and returns empty string for invalid dates", () => {
      expect(formatMessageTime("invalid-date")).toBe("");
      const formatted = formatMessageTime("2026-09-01T12:00:00Z");
      expect(formatted).toMatch(/\d{1,2}:\d{2}/);
    });
  });

  describe("summarizeMessagePreview", () => {
    test("handles recalled messages, text content, and attachments", () => {
      expect(summarizeMessagePreview({ content: "Hello", isRecalled: true })).toBe("");
      expect(summarizeMessagePreview({ content: "   Hello World   " })).toBe("Hello World");
      expect(
        summarizeMessagePreview({
          content: "",
          attachments: [{ filename: "doc.pdf" }],
        }),
      ).toBe("doc.pdf");
      expect(summarizeMessagePreview({ content: "" })).toBe("");
    });
  });

  describe("isPrivateRoomFallbackName and getPrivateRoomName", () => {
    test("detects fallback private name", () => {
      expect(isPrivateRoomFallbackName("Private 12345678", "1234567890")).toBe(true);
      expect(isPrivateRoomFallbackName("Secret Chat", "1234567890")).toBe(false);
    });

    test("resolves private room name from other member or room name", () => {
      const room = {
        id: "room-1",
        name: "Private room-12",
        members: [
          { userId: "u-1", name: "Alice", role: "member" as const },
          { userId: "u-2", name: "Bob", role: "member" as const },
        ],
      };
      expect(getPrivateRoomName(room, "u-1")).toBe("Bob");
      expect(getPrivateRoomName({ id: "room-2", name: "Direct with Charlie" }, "u-1")).toBe(
        "Direct with Charlie",
      );
    });
  });

  describe("toStoredUser", () => {
    test("converts profile and settings to stored user", () => {
      const profile: MyProfile = {
        userId: "u-1",
        name: "Alice",
        email: "alice@test.com",
        avatarUrl: "/avatars/alice.png",
        isAdmin: true,
        bio: "Hello",
        lastActivity: new Date(),
      };
      const user = toStoredUser(profile, { language: "zh-TW", theme: "dark" });
      expect(user.userId).toBe("u-1");
      expect(user.username).toBe("Alice");
      expect(user.isAdmin).toBe(true);
      expect(user.language).toBe("zh-TW");
      expect(user.theme).toBe("dark");
    });
  });

  describe("mapAttachment and mapMessage", () => {
    test("maps attachment to client format", () => {
      const att = mapAttachment({
        attachmentId: "att-1",
        messageId: "msg-1",
        uploadedBy: "u-1",
        originalName: "file.png",
        fileType: "image/png",
        fileUrl: "/uploads/file.png",
        uploadedAt: new Date(),
      });
      expect(att.filename).toBe("file.png");
      expect(att.filetype).toBe("image/png");
      expect(att.url).toBeDefined();
    });

    test("maps message with sender and outgoing flag", () => {
      const rawMsg: MessageWithSender = {
        messageId: "msg-1",
        roomId: "room-1",
        senderId: "u-1",
        content: "Hi there",
        sentAt: new Date(),
        messageSequence: 1,
        isRecalled: false,
        sender: { userId: "u-1", name: "Alice", avatarUrl: undefined },
      };
      const msg = mapMessage(rawMsg, "u-1");
      expect(msg.id).toBe("msg-1");
      expect(msg.isOutgoing).toBe(true);
      expect(msg.senderName).toBe("Alice");
      expect(msg.content).toBe("Hi there");
    });
  });

  describe("hydrateReplyTargets", () => {
    test("populates replyTo info based on replyToId within the room", () => {
      const messages: Message[] = [
        {
          id: "m-1",
          roomId: "room-1",
          senderId: "u-1",
          senderName: "Alice",
          content: "Original msg",
          sentAt: new Date().toISOString(),
          timestamp: "12:00",
        },
        {
          id: "m-2",
          roomId: "room-1",
          senderId: "u-2",
          senderName: "Bob",
          content: "Replying to m-1",
          replyToId: "m-1",
          sentAt: new Date().toISOString(),
          timestamp: "12:01",
        },
      ];

      const hydrated = hydrateReplyTargets(messages);
      expect(hydrated[1].replyTo).toEqual({
        senderName: "Alice",
        content: "Original msg",
      });
    });
  });

  describe("sortMessages and compareMessageVersion", () => {
    test("orders messages by messageSequence then sentAt", () => {
      const m1: Message = {
        id: "m-1",
        roomId: "r-1",
        senderId: "u-1",
        senderName: "Alice",
        content: "1",
        sentAt: "2026-09-01T10:00:00Z",
        timestamp: "10:00",
        messageSequence: 1,
      };
      const m2: Message = {
        id: "m-2",
        roomId: "r-1",
        senderId: "u-1",
        senderName: "Alice",
        content: "2",
        sentAt: "2026-09-01T10:01:00Z",
        timestamp: "10:01",
        messageSequence: 2,
      };

      expect(sortMessages([m2, m1])).toEqual([m1, m2]);
      expect(compareMessageVersion(m2, m1)).toBeGreaterThan(0);
    });

    test("merges incoming messages retaining highest revision/changeSequence", () => {
      const current: Message[] = [
        {
          id: "m-1",
          roomId: "r-1",
          senderId: "u-1",
          senderName: "Alice",
          content: "Original",
          sentAt: "2026-09-01T10:00:00Z",
          timestamp: "10:00",
          revision: 1,
        },
      ];
      const incoming: Message[] = [
        {
          id: "m-1",
          roomId: "r-1",
          senderId: "u-1",
          senderName: "Alice",
          content: "Edited",
          sentAt: "2026-09-01T10:00:00Z",
          timestamp: "10:00",
          revision: 2,
        },
      ];

      const merged = mergeMessages(current, incoming);
      expect(merged[0].content).toBe("Edited");
    });
  });

  describe("mapFolders, mapFriend, mapFriendRequest, mapRoomMember", () => {
    test("maps folders preserving collapsed state", () => {
      const apiFolders: ApiFolder[] = [
        { folderId: "f-1", name: "Favorites", roomIds: [], userId: "u-1", createdAt: new Date() },
        { folderId: "f-2", name: "Archived", roomIds: [], userId: "u-1", createdAt: new Date() },
      ];
      const currentFolders = [{ id: "f-1", name: "Fav", collapsed: true }];
      const mapped = mapFolders(apiFolders, currentFolders);
      expect(mapped[0].collapsed).toBe(true);
      expect(mapped[1].collapsed).toBe(false);
    });

    test("maps friend correctly with emergency contact status", () => {
      const friendResp: FriendResponse = {
        friend: { userId: "u-2", name: "Bob", avatarUrl: "/bob.png" },
        friendshipCreatedAt: new Date(),
        status: "online",
      };
      const mapped = mapFriend(friendResp, new Set(["u-2"]));
      expect(mapped.id).toBe("u-2");
      expect(mapped.name).toBe("Bob");
      expect(mapped.status).toBe("online");
      expect(mapped.isEmergencyContact).toBe(true);
    });

    test("maps friend requests with correct direction", () => {
      const reqIncoming: FriendRequestResponse = {
        requesterId: "u-2",
        addresseeId: "u-1",
        status: "pending",
        createdAt: new Date(),
        requester: { userId: "u-2", name: "Bob", avatarUrl: undefined },
      };
      const mapped = mapFriendRequest(reqIncoming, "u-1");
      expect(mapped.direction).toBe("incoming");
      expect(mapped.name).toBe("Bob");

      const reqOutgoing: FriendRequestResponse = {
        requesterId: "u-1",
        addresseeId: "u-3",
        status: "pending",
        createdAt: new Date(),
        addressee: { userId: "u-3", name: "Charlie", avatarUrl: undefined },
      };
      const mappedOut = mapFriendRequest(reqOutgoing, "u-1");
      expect(mappedOut.direction).toBe("outgoing");
      expect(mappedOut.name).toBe("Charlie");
    });

    test("maps room member with profile", () => {
      const apiMember: ApiRoomMember = {
        roomId: "r-1",
        userId: "u-1",
        role: "admin",
        nickname: "Ali",
        isMuted: false,
        joinTime: new Date(),
      };
      const profile: UserProfile = {
        userId: "u-1",
        name: "Alice Real",
        avatarUrl: "/a.png",
      };
      const member = mapRoomMember(apiMember, profile);
      expect(member.name).toBe("Alice Real");
      expect(member.nickname).toBe("Ali");
      expect(member.role).toBe("admin");
    });
  });
});
