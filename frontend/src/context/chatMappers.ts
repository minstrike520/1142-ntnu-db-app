import { resolveAssetUrl } from "@/lib/assets";
import { attachmentDownloadUrl, getUserProfile, listRoomMembers } from "@/lib/api";
import type {
  Attachment as ApiAttachment,
  EmergencyContactResponse,
  Folder as ApiFolder,
  FriendRequestResponse,
  FriendResponse,
  MessageWithSender,
  MyProfile,
  PublicUser,
  RoomMember as ApiRoomMember,
  RoomSummary,
  UserProfile,
  UserSettings,
} from "@shared/types";
import type {
  ChatRoom,
  EmergencyContact,
  Folder,
  Friend,
  FriendRequest,
  Member,
  Message,
  StoredUser,
  UiLanguage,
} from "./types";

export const getAvatarForUser = (
  username: string,
  currentUserAvatar?: string,
  currentUsername?: string,
): string => {
  if (currentUsername && username === currentUsername) {
    return currentUserAvatar ? (resolveAssetUrl(currentUserAvatar) || "") : "";
  }
  return "";
};

export const normalizeLanguage = (language?: string): UiLanguage =>
  language === "zh-TW" || language === "en" ? language : "en";

export const toStoredUser = (
  profile: MyProfile,
  settings?: Partial<UserSettings>,
): StoredUser => ({
  userId: profile.userId,
  username: profile.name,
  email: profile.email,
  avatar: profile.avatarUrl ?? "",
  bio: profile.bio ?? "",
  language: normalizeLanguage(settings?.language),
  theme: settings?.theme ?? "light",
  notifyDesktop: settings?.notifyDesktop ?? true,
  notifySound: settings?.notifySound ?? true,
  warningEnabled: settings?.warningEnabled ?? false,
  lastActivity: profile.lastActivity,
  roomOrder: settings?.roomOrder ?? {},
});

export const formatMessageTime = (value: Date | string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

export const mapAttachment = (attachment: ApiAttachment) => {
  const filename = attachment.originalName || "attachment";
  return {
    filename,
    filetype: attachment.fileType,
    url: attachmentDownloadUrl(attachment.fileUrl),
  };
};

export const summarizeMessagePreview = (message: {
  content: string;
  attachments?: { filename: string }[];
  isRecalled?: boolean;
}): string => {
  if (message.isRecalled) return "";
  if (message.content.trim()) return message.content.trim();
  if (message.attachments?.length) return message.attachments[0].filename;
  return "";
};

export const isPrivateRoomFallbackName = (roomName: string | undefined, roomId: string): boolean =>
  roomName === `Private ${roomId.slice(0, 8)}`;

export const getPrivateRoomName = (
  room: Pick<ChatRoom, "id" | "name" | "members" | "otherMemberId">,
  currentUserId?: string,
): string => {
  const otherMember =
    room.members?.find((member) =>
      currentUserId
        ? member.userId !== currentUserId
        : room.otherMemberId
          ? member.userId === room.otherMemberId
          : true,
    ) ?? null;

  if (otherMember?.name) {
    return otherMember.name;
  }

  if (room.name && !isPrivateRoomFallbackName(room.name, room.id)) {
    return room.name;
  }

  return "";
};

export const mapMessage = (message: MessageWithSender, currentUserId?: string): Message => ({
  id: message.messageId,
  roomId: message.roomId,
  senderId: message.senderId,
  senderName: message.sender?.name ?? "Deleted User",
  content: message.content,
  sentAt: new Date(message.sentAt).toISOString(),
  timestamp: formatMessageTime(message.sentAt),
  replyToId: message.replyToId,
  isOutgoing: Boolean(currentUserId && message.senderId === currentUserId),
  isRecalled: message.isRecalled,
  messageSequence: message.messageSequence,
  changeSequence: message.changeSequence,
  revision: message.revision,
  replyTo: null,
  attachments: message.attachments?.map(mapAttachment) ?? [],
  mentions: message.mentions ?? [],
});

export const hydrateReplyTargets = (items: Message[]): Message[] => {
  const messageByRoom = new Map<string, Map<string, Message>>();

  for (const item of items) {
    let roomMessages = messageByRoom.get(item.roomId);
    if (!roomMessages) {
      roomMessages = new Map<string, Message>();
      messageByRoom.set(item.roomId, roomMessages);
    }
    roomMessages.set(item.id, item);
  }

  return items.map((item) => {
    if (!item.replyToId) {
      return item.replyTo ? { ...item, replyTo: null } : item;
    }

    const replyTarget = messageByRoom.get(item.roomId)?.get(item.replyToId);
    if (!replyTarget) {
      return item;
    }

    const nextReplyTo = {
      senderName: replyTarget.senderName,
      content: replyTarget.isRecalled
        ? ""
        : replyTarget.content || replyTarget.attachments?.[0]?.filename || "",
    };

    if (
      item.replyTo?.senderName === nextReplyTo.senderName &&
      item.replyTo?.content === nextReplyTo.content
    ) {
      return item;
    }

    return {
      ...item,
      replyTo: nextReplyTo,
    };
  });
};

// How often a connected session re-runs `/sync` purely to move its cursor
// forward. Long enough that an idle-but-chatty session is not making steady
// background requests, short enough that the catch-up after a reconnect stays
// bounded by minutes of activity rather than by the whole connection.
export const CURSOR_CHECKPOINT_INTERVAL_MS = 5 * 60_000;

export const mapRooms = (
  apiRooms: RoomSummary[],
  apiFolders: ApiFolder[],
  currentRooms: ChatRoom[],
  currentUserId?: string,
): ChatRoom[] => {
  const currentRoomById = new Map(currentRooms.map((room) => [room.id, room]));
  const folderByRoom = new Map<string, string>();
  for (const folder of apiFolders) {
    for (const roomId of folder.roomIds) {
      folderByRoom.set(roomId, folder.folderId);
    }
  }

  return apiRooms.map((room) => {
    const currentRoom = currentRoomById.get(room.roomId);
    const latestMessage =
      room.latestMessage
        ? {
            content: room.latestMessage.content,
            attachments: [],
            isRecalled: room.latestMessage.isRecalled,
          }
        : null;

    return {
      id: room.roomId,
      type: room.type === "group" ? "group" : "msg",
      avatarUrl: room.avatarUrl,
      name:
        room.name ||
        (room.type === "group"
          ? (currentRoom?.name && !isPrivateRoomFallbackName(currentRoom.name, room.roomId)
              ? currentRoom.name
              : `Group ${room.roomId.slice(0, 8)}`)
          : getPrivateRoomName(
              {
                id: room.roomId,
                name: currentRoom?.name ?? "",
                members: currentRoom?.members,
                otherMemberId: room.otherMemberId ?? currentRoom?.otherMemberId,
              },
              currentUserId,
            )),
      folderId: folderByRoom.get(room.roomId) ?? currentRoom?.folderId ?? null,
      inviteCode: room.inviteCode,
      requireApproval: room.requireApproval,
      viewHistory: room.viewHistory,
      isArchived: room.isArchived,
      isReadonly: room.isReadonly,
      isOnline: room.isOnline ?? currentRoom?.isOnline,
      otherMemberId: room.otherMemberId ?? currentRoom?.otherMemberId,
      members: currentRoom?.members ?? (room.type === "group" ? [] : undefined),
      unreadCount: room.unreadCount ?? currentRoom?.unreadCount ?? 0,
      lastReadId: room.lastReadId ?? currentRoom?.lastReadId ?? null,
      myRole: room.role ?? currentRoom?.myRole,
      lastMessagePreview: latestMessage ? summarizeMessagePreview(latestMessage) : undefined,
      lastMessageAt: room.latestMessage
        ? formatMessageTime(room.latestMessage.sentAt)
        : undefined,
      lastMessageId: room.latestMessage?.messageId,
      lastMessageSequence: room.latestMessage?.messageSequence,
      lastMessageChangeSequence: room.latestMessage?.changeSequence,
    };
  });
};

export const mapFolders = (apiFolders: ApiFolder[], currentFolders: Folder[]): Folder[] => {
  const collapsedById = new Map(currentFolders.map((folder) => [folder.id, folder.collapsed]));
  return apiFolders.map((folder) => ({
    id: folder.folderId,
    name: folder.name,
    collapsed: collapsedById.get(folder.folderId) ?? false,
  }));
};

export const mapFriend = (item: FriendResponse, emergencyContactIds: Set<string>): Friend => ({
  id: item.friend.userId,
  name: item.friend.name,
  email: "",
  status: item.status || "offline",
  isEmergencyContact: emergencyContactIds.has(item.friend.userId),
  avatarUrl: item.friend.avatarUrl,
});

export const mapFriendRequest = (item: FriendRequestResponse, currentUserId: string): FriendRequest => {
  if (item.requesterId === currentUserId) {
    return {
      id: item.addresseeId,
      name: item.addressee?.name ?? item.addresseeId,
      email: "",
      direction: "outgoing",
      avatarUrl: item.addressee?.avatarUrl,
    };
  }
  return {
    id: item.requesterId,
    name: item.requester?.name ?? item.requesterId,
    email: "",
    direction: "incoming",
    avatarUrl: item.requester?.avatarUrl,
  };
};

export const mapEmergencyContact = (item: EmergencyContactResponse): EmergencyContact => ({
  id: item.contactId,
  contactId: item.contactId,
  name: item.contact?.name ?? item.contactId,
  email: item.contact?.email ?? "",
  message: item.message,
});

export const mapRoomMember = (member: ApiRoomMember, profile?: UserProfile): Member => ({
  userId: member.userId,
  name: profile?.name || member.userId,
  role: member.role,
  nickname: member.nickname,
  isMuted: member.isMuted,
  lastReadId: member.lastReadId ?? null,
  readPosition: member.readPosition,
  avatarUrl: profile?.avatarUrl,
});

export const fetchRoomMembers = async (authToken: string, roomId: string): Promise<Member[]> => {
  const apiMembers = await listRoomMembers(authToken, roomId);
  const profiles = await Promise.all(
    apiMembers.map((member) =>
      getUserProfile(member.userId, authToken).catch(() => undefined),
    ),
  );

  return apiMembers.map((member, index) => mapRoomMember(member, profiles[index]));
};

export const findRequestedUser = (
  candidates: PublicUser[],
  query: string,
): PublicUser | undefined => {
  const normalizedQuery = query.trim().toLowerCase();

  return (
    candidates.find((candidate) => candidate.userId.toLowerCase() === normalizedQuery) ??
    candidates.find((candidate) => candidate.name.toLowerCase() === normalizedQuery) ??
    candidates.find((candidate) => candidate.name.toLowerCase().includes(normalizedQuery)) ??
    candidates[0]
  );
};

export const sortMessages = (items: Message[]): Message[] =>
  [...items].sort((a, b) => {
    if (a.messageSequence !== undefined && b.messageSequence !== undefined) {
      const sequenceCompare = a.messageSequence - b.messageSequence;
      if (sequenceCompare !== 0) return sequenceCompare;
    }
    const sentAtCompare = new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
    if (sentAtCompare !== 0) return sentAtCompare;
    return a.id.localeCompare(b.id);
  });

export const compareMessageVersion = (left: Message, right: Message): number => {
  if (left.changeSequence !== undefined && right.changeSequence !== undefined) {
    return left.changeSequence - right.changeSequence;
  }
  if (left.revision !== undefined && right.revision !== undefined) {
    return left.revision - right.revision;
  }
  if (left.messageSequence !== undefined && right.messageSequence !== undefined) {
    return left.messageSequence - right.messageSequence;
  }
  return new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime();
};

export const mergeMessages = (current: Message[], incoming: Message[]): Message[] => {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (!existing || compareMessageVersion(message, existing) >= 0) {
      byId.set(message.id, message);
    }
  }
  return hydrateReplyTargets(sortMessages(Array.from(byId.values())));
};
