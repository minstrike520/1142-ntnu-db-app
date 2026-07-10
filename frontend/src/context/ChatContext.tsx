"use client";

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { resolveAssetUrl } from "@/lib/assets";
import type {
  Attachment as ApiAttachment,
  EmergencyContactResponse,
  Folder as ApiFolder,
  FriendRequestResponse,
  FriendResponse,
  MessageWithSender,
  MyProfile,
  PublicUser,
  Room,
  RoomMember as ApiRoomMember,
  RoomMemberRole,
  RoomSummary,
  UserProfile,
  UserSettings,
} from "@shared/types";
import {
  approveRoomMember,
  attachmentDownloadUrl,
  blockUser as blockUserApi,
  createFolder,
  createGroup,
  createPrivateRoom,
  deleteEmergencyContact,
  deleteFriend,
  deleteFolder as deleteFolderApi,
  renameFolder as renameFolderApi,
  deleteMe as deleteMeApi,
  deleteRoom as deleteRoomApi,
  getBlockedUsers,
  getMe,
  joinRoomByCode,
  getMySettings,
  getUserProfile,
  kickRoomMember,
  leaveRoom as leaveRoomApi,
  listEmergencyContacts,
  listFolders,
  listFriendRequests,
  listFriends,
  listMessages,
  listRoomMembers,
  listRooms,
  logout,
  respondFriendRequest,
  searchUsers,
  sendFriendRequest as sendFriendRequestApi,
  unblockUser as unblockUserApi,
  updateFolderRooms,
  updateMe,
  updateMySettings,
  updateRoom,
  updateRoomMember,
  transferRoomOwner,
  upsertEmergencyContact,
  uploadAttachment,
  uploadAvatar as uploadAvatarApi,
  uploadRoomAvatar as uploadRoomAvatarApi,
  getActiveAccessToken,
  setActiveAccessToken,
  refreshTokens,
} from "@/lib/api";
import {
  createChatSocket,
  joinRoom,
  onEmergencyAlert,
  onFriendRequest,
  onMessageRecalled,
  onMessageUpdated,
  onNewMessage,
  onReadUpdate,
  onSocketError,
  onRoomUpdate,
  onUserStatus,
  onUserTyping,
  recallMessage,
  sendMessage,
  sendReadReceipt,
  sendTyping,
  updateMessage,
  type ChatSocket,
} from "@/lib/socket";

export interface Member {
  userId: string;
  name: string;
  role: RoomMemberRole;
  nickname?: string;
  isMuted?: boolean;
  lastReadId?: string | null;
  avatarUrl?: string;
}

export interface ChatRoom {
  id: string;
  type: "msg" | "group";
  name: string;
  isOnline?: boolean;
  otherMemberId?: string;
  folderId?: string | null;
  inviteCode?: string;
  requireApproval?: boolean;
  viewHistory?: boolean;
  members?: Member[];
  isArchived?: boolean;
  isReadonly?: boolean;
  unreadCount?: number;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  avatarUrl?: string;
  lastReadId?: string | null;
  myRole?: RoomMemberRole;
}

export interface Message {
  id: string;
  roomId: string;
  senderId: string | null;
  senderName: string;
  content: string;
  sentAt: string;
  timestamp: string;
  replyToId?: string;
  isOutgoing?: boolean;
  isRecalled?: boolean;
  replyTo?: {
    senderName: string;
    content: string;
  } | null;
  attachments?: { filename: string; filetype: string; url?: string }[];
  mentions?: string[];
  isRead?: boolean;
}

export interface Folder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface User {
  userId?: string;
  username: string;
  email: string;
  avatar: string;
  bio?: string;
  language?: UiLanguage;
  theme?: "light" | "dark";
  notifyDesktop?: boolean;
  notifySound?: boolean;
  warningEnabled?: boolean;
  warningDays?: number;
  lastActivity?: Date | string;
  roomOrder?: Record<string, string[]>;
}

type StoredUser = User;

export interface Friend {
  id: string;
  name: string;
  email: string;
  status: "online" | "offline";
  isEmergencyContact?: boolean;
  avatarUrl?: string;
}

export interface FriendRequest {
  id: string;
  name: string;
  email: string;
  direction: "incoming" | "outgoing";
  avatarUrl?: string;
}

export interface BlockedUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export interface EmergencyContact {
  id: string;
  contactId: string;
  name: string;
  email: string;
  message: string;
}

export interface EmergencySettings {
  warningEnabled: boolean;
  warningDays: number;
  contacts: EmergencyContact[];
}



export type UiLanguage = "zh-TW" | "en";

export const getAvatarForUser = (
  username: string,
  currentUserAvatar?: string,
  currentUsername?: string,
) => {
  if (currentUsername && username === currentUsername) {
    return currentUserAvatar ? resolveAssetUrl(currentUserAvatar) : "";
  }
  return "";
};

export interface ProfileInput {
  username: string;
  email: string;
  avatar: string;
  avatarFile?: File | null;
  password?: string;
  currentPassword?: string;
  bio?: string;
}

export interface PreferencesInput {
  theme: string;
  language: UiLanguage;
  notifyDesktop: boolean;
  notifySound: boolean;
  warningEnabled?: boolean;
  warningDays?: number;
}

interface GroupSettingsInput {
  name?: string;
  requireApproval?: boolean;
  viewHistory?: boolean;
  isArchived?: boolean;
  avatarFile?: File | null;
}

interface ChatContextType {
  rooms: ChatRoom[];
  folders: Folder[];
  messages: Message[];
  typingUsers: Record<string, string[]>;
  groupReadStates: Record<string, Record<string, string>>;
  user: User;
  activeRoomNicknames: Record<string, string>;
  friends: Friend[];
  friendRequests: FriendRequest[];
  blockedUsers: BlockedUser[];
  emergencySettings: EmergencySettings;
  uiLanguage: UiLanguage;
  isAuthenticated: boolean;
  isMounted: boolean;
  roomsInitialized: boolean;
  selectedFriendForSidebar: Friend | null;
  setSelectedFriendForSidebar: React.Dispatch<React.SetStateAction<Friend | null>>;
  showRightPanel: boolean;
  setShowRightPanel: React.Dispatch<React.SetStateAction<boolean>>;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (val: boolean) => void;

  setRooms: React.Dispatch<React.SetStateAction<ChatRoom[]>>;
  setFolders: React.Dispatch<React.SetStateAction<Folder[]>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setUser: React.Dispatch<React.SetStateAction<User>>;
  setActiveRoomNicknames: React.Dispatch<React.SetStateAction<Record<string, string>>>;

  toggleFolder: (folderId: string) => void;
  handleLogout: () => void;
  handleSendMessage: (roomId: string, content: string, replyTarget: Message | null) => void;
  handleTyping: (roomId: string, isTyping: boolean) => void;
  handleUploadAttachments: (
    roomId: string,
    files: File[],
    options?: { content?: string; replyTarget?: Message | null },
  ) => Promise<void>;
  handleRecallMessage: (msgId: string) => void;
  handleUpdateMessage: (roomId: string, messageId: string, content: string) => void;
  handleUpdateProfile: (profile: ProfileInput) => Promise<User>;
  handleUpdatePreferences: (preferences: PreferencesInput) => Promise<void>;
  handleCreateRoom: (name: string, type: "msg" | "group", folderId: string) => Promise<string>;
  handleOpenPrivateRoom: (targetUserId: string) => Promise<string>;
  handleCreateFolder: (name: string) => Promise<void>;
  handleDeleteFolder: (folderId: string) => Promise<void>;
  handleRenameFolder: (folderId: string, name: string) => Promise<void>;
  handleCategorizeRoom: (roomId: string, folderId: string | null) => Promise<void>;
  handleModifyNickname: (roomId: string, nickname: string) => Promise<void>;
  handleLeaveOrBlock: (roomId: string) => Promise<{ isDeleted: boolean; newActiveId?: string }>;
  handleDeleteAccount: () => Promise<void>;
  loadGroupMembers: (roomId: string) => Promise<Member[]>;
  saveGroupSettings: (roomId: string, settings: GroupSettingsInput) => Promise<void>;
  approveGroupMember: (roomId: string, userId: string) => Promise<Member[] | undefined>;
  updateGroupMember: (
    roomId: string,
    userId: string,
    data: { role?: "admin" | "member"; nickname?: string; isMuted?: boolean },
  ) => Promise<Member[] | undefined>;
  kickGroupMember: (roomId: string, userId: string) => Promise<Member[] | undefined>;
  transferGroupOwner: (roomId: string, userId: string) => Promise<Member[] | undefined>;
  handleDeleteGroupRoom: (roomId: string) => Promise<string | null>;
  getReadAvatarsForMessage: (room: ChatRoom, msg: Message) => { name: string; displayName?: string; avatarUrl: string }[];

  searchUsersForInvite: (query: string) => Promise<PublicUser[]>;
  handleJoinByInviteCode: (inviteCode: string) => Promise<string>;
  sendFriendRequest: (query: string) => Promise<void>;
  acceptFriendRequest: (requestId: string) => Promise<void>;
  rejectFriendRequest: (requestId: string) => Promise<void>;
  removeFriend: (friendId: string) => Promise<void>;
  blockFriend: (friendId: string) => Promise<void>;
  unblockUser: (blockedId: string) => Promise<void>;
  saveEmergencySettings: (settings: EmergencySettings) => Promise<void>;
  setUiLanguage: (language: UiLanguage) => void;
  activeProfilePopover: { instanceId: string; userId: string } | null;
  setActiveProfilePopover: React.Dispatch<React.SetStateAction<{ instanceId: string; userId: string } | null>>;
  refreshSocialData: () => Promise<void>;
  updateRoomSorting: (nextOrder: Record<string, string[]>) => Promise<void>;
  markRoomAsRead: (roomId: string) => void;
}

const ChatContext = createContext<ChatContextType | undefined>(undefined);

const toStoredUser = (
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

const formatMessageTime = (value: Date | string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const mapAttachment = (attachment: ApiAttachment) => {
  const filename = attachment.originalName || "attachment";
  return {
    filename,
    filetype: attachment.fileType,
    url: attachmentDownloadUrl(attachment.fileUrl),
  };
};

const summarizeMessagePreview = (message: {
  content: string;
  attachments?: { filename: string }[];
  isRecalled?: boolean;
}) => {
  if (message.isRecalled) return "";
  if (message.content.trim()) return message.content.trim();
  if (message.attachments?.length) return message.attachments[0].filename;
  return "";
};

const isPrivateRoomFallbackName = (roomName: string | undefined, roomId: string) =>
  roomName === `Private ${roomId.slice(0, 8)}`;

const getPrivateRoomName = (
  room: Pick<ChatRoom, "id" | "name" | "members" | "otherMemberId">,
  currentUserId?: string,
) => {
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

const mapMessage = (message: MessageWithSender, currentUserId?: string): Message => ({
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
  replyTo: null,
  attachments: message.attachments?.map(mapAttachment) ?? [],
  mentions: message.mentions ?? [],
});

const hydrateReplyTargets = (items: Message[]): Message[] => {
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
      content: replyTarget.isRecalled ? "" : replyTarget.content,
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

const mapRooms = (
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
            isRecalled: false,
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
      lastMessagePreview: latestMessage
        ? summarizeMessagePreview(latestMessage)
        : currentRoom?.lastMessagePreview,
      lastMessageAt: room.latestMessage
        ? formatMessageTime(room.latestMessage.sentAt)
        : currentRoom?.lastMessageAt,
    };
  });
};

const mapFolders = (apiFolders: ApiFolder[], currentFolders: Folder[]): Folder[] => {
  const collapsedById = new Map(currentFolders.map((folder) => [folder.id, folder.collapsed]));
  return apiFolders.map((folder) => ({
    id: folder.folderId,
    name: folder.name,
    collapsed: collapsedById.get(folder.folderId) ?? false,
  }));
};

const normalizeLanguage = (language?: string): UiLanguage =>
  language === "zh-TW" || language === "en" ? language : "en";

const formatUploadedAttachmentsMessage = (language: UiLanguage, fileNames: string[]) => {
  if (fileNames.length === 1) {
    return language === "zh-TW" ? `已上傳附件：${fileNames[0]}` : `Shared attachment: ${fileNames[0]}`;
  }
  return language === "zh-TW" ? `已上傳了 ${fileNames.length} 個附件` : `Shared ${fileNames.length} attachments`;
};

const mapFriend = (item: FriendResponse, emergencyContactIds: Set<string>): Friend => ({
  id: item.friend.userId,
  name: item.friend.name,
  email: "",
  status: item.status || "offline",
  isEmergencyContact: emergencyContactIds.has(item.friend.userId),
  avatarUrl: item.friend.avatarUrl,
});

const mapFriendRequest = (item: FriendRequestResponse, currentUserId: string): FriendRequest => {
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

const mapEmergencyContact = (item: EmergencyContactResponse): EmergencyContact => ({
  id: item.contactId,
  contactId: item.contactId,
  name: item.contact?.name ?? item.contactId,
  email: item.contact?.email ?? "",
  message: item.message,
});

const mapRoomMember = (member: ApiRoomMember, profile?: UserProfile): Member => ({
  userId: member.userId,
  name: profile?.name || member.userId,
  role: member.role,
  nickname: member.nickname,
  isMuted: member.isMuted,
  lastReadId: member.lastReadId ?? null,
  avatarUrl: profile?.avatarUrl,
});

const fetchRoomMembers = async (authToken: string, roomId: string): Promise<Member[]> => {
  const apiMembers = await listRoomMembers(authToken, roomId);
  const profiles = await Promise.all(
    apiMembers.map((member) =>
      getUserProfile(member.userId, authToken).catch(() => undefined),
    ),
  );

  return apiMembers.map((member, index) => mapRoomMember(member, profiles[index]));
};

const findRequestedUser = (
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

const sortMessages = (items: Message[]) =>
  [...items].sort((a, b) => {
    const sentAtCompare = new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime();
    if (sentAtCompare !== 0) return sentAtCompare;
    return a.id.localeCompare(b.id);
  });

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const socketRef = useRef<ChatSocket | null>(null);
  const roomsRef = useRef<ChatRoom[]>([]);
  const roomMembersRequestRef = useRef<Map<string, Promise<Member[]>>>(new Map());
  const socialDataRefreshTimerRef = useRef<NodeJS.Timeout | null>(null);
  const socialDataRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const socialDataRefreshResolversRef = useRef<Array<() => void>>([]);
  const tokenRef = useRef<string | null>(null);
  const activeRoomIdRef = useRef<string | null>(null);

  const [isMounted, setIsMounted] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [roomsInitialized, setRoomsInitialized] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | undefined>(undefined);
  const [user, setUser] = useState<User>({ username: "", email: "", avatar: "" });
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [groupReadStates, setGroupReadStates] = useState<Record<string, Record<string, string>>>({});
  const [activeRoomNicknames, setActiveRoomNicknames] = useState<Record<string, string>>({});
  const [uiLanguage, setUiLanguageState] = useState<UiLanguage>("zh-TW");
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendRequests, setFriendRequests] = useState<FriendRequest[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [emergencySettings, setEmergencySettings] = useState<EmergencySettings>({
    warningEnabled: false,
    warningDays: 0,
    contacts: [],
  });
  const [selectedFriendForSidebar, setSelectedFriendForSidebar] = useState<Friend | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [showRightPanel, setShowRightPanel] = useState<boolean>(true);
  const [typingUsers, setTypingUsers] = useState<Record<string, string[]>>({});
  const [activeProfilePopover, setActiveProfilePopover] = useState<{ instanceId: string; userId: string } | null>(null);
  const typingTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const activeRoomId = useMemo(() => {
    const match = pathname.match(/^\/chat\/([^/]+)$/);
    return match?.[1] ?? null;
  }, [pathname]);

  useEffect(() => {
    activeRoomIdRef.current = activeRoomId;
  }, [activeRoomId]);


  const loadGroupMembers = async (roomId: string): Promise<Member[]> => {
    if (!token) return [];
    const existingRequest = roomMembersRequestRef.current.get(roomId);
    if (existingRequest) {
      return existingRequest;
    }

    // Deduplicate concurrent member loads for the same room.
    const request = fetchRoomMembers(token, roomId)
      .then((members) => {
        setRooms((current) =>
          current.map((room) =>
            room.id === roomId ? { ...room, members } : room,
          ),
        );

        const myMember = members.find((m) => m.userId === currentUserId || m.name === user.username);
        setActiveRoomNicknames((current) => {
          const next = { ...current };
          if (myMember?.nickname) {
            next[roomId] = myMember.nickname;
          } else {
            delete next[roomId];
          }
          return next;
        });

        const roomReads = members.reduce<Record<string, string>>((reads, member) => {
          if (member.lastReadId) {
            reads[member.userId] = member.lastReadId;
          }
          return reads;
        }, {});

        setGroupReadStates((current) =>
          Object.keys(roomReads).length === 0
            ? current
            : {
                ...current,
                [roomId]: {
                  ...(current[roomId] ?? {}),
                  ...roomReads,
                },
              },
        );

        return members;
      })
      .finally(() => {
        roomMembersRequestRef.current.delete(roomId);
      });

    roomMembersRequestRef.current.set(roomId, request);
    return request;
  };

  const clearSession = () => {
    localStorage.removeItem("user");
    localStorage.removeItem("theme");
    localStorage.removeItem("language");
    localStorage.removeItem("notify-desktop");
    localStorage.removeItem("notify-sound");
    localStorage.removeItem("near:roomOrder");
    localStorage.removeItem("just_registered");
    setActiveAccessToken(null);
    setToken(null);
    setCurrentUserId(undefined);
    setIsAuthenticated(false);
    setRoomsInitialized(false);
    setRooms([]);
    setFolders([]);
    setMessages([]);
    socketRef.current?.disconnect();
    socketRef.current = null;
  };

  const loadMessagesForRooms = useCallback(async (authToken: string, nextRooms: ChatRoom[], userId?: string) => {
    const roomMessages = await Promise.all(
      nextRooms.map(async (room) => {
        try {
          const roomMember = room.members?.find((m) => m.userId === userId || m.name === user.username);
          const role = roomMember?.role ?? room.myRole;
          if (role === "pending") {
            return [];
          }
          const rows = await listMessages(authToken, room.id, { limit: 50 });
          return rows.reverse().map((message) => mapMessage(message, userId));
        } catch (error) {
          console.error(`Failed to load messages for room ${room.id}:`, error);
          return [];
        }
      }),
    );
    setMessages(hydrateReplyTargets(roomMessages.flat()));
  }, [user.username]);

  useEffect(() => {
    if (!token || !activeRoomId) return;

    const activeRoom = roomsRef.current.find((r) => r.id === activeRoomId);
    if (activeRoom) {
      void loadMessagesForRooms(token, [activeRoom], currentUserId);
    }
  }, [activeRoomId, token, currentUserId, loadMessagesForRooms]);

  const refreshRoomsAndFolders = async (authToken: string, userId = currentUserId) => {
    const [apiRooms, apiFolders] = await Promise.all([listRooms(authToken), listFolders(authToken)]);
    const nextRooms = mapRooms(apiRooms, apiFolders, roomsRef.current, userId);

    setFolders((current) => mapFolders(apiFolders, current));
    setRooms(nextRooms);
    const activeRoom = nextRooms.find((r) => r.id === activeRoomIdRef.current);
    void loadMessagesForRooms(authToken, activeRoom ? [activeRoom] : [], userId);
    setRoomsInitialized(true);
  };

  const refreshSocialData = async (authToken: string, settings?: UserSettings, userId = currentUserId) => {
    const effectiveUserId = userId ?? user.userId;
    if (!effectiveUserId) return;

    if (socialDataRefreshTimerRef.current) {
      clearTimeout(socialDataRefreshTimerRef.current);
    }

    // All concurrent callers share one debounced promise; the timeout below
    // resolves it once the batched fetch settles.
    if (!socialDataRefreshPromiseRef.current) {
      let resolveFn: () => void;
      socialDataRefreshPromiseRef.current = new Promise<void>((resolve) => {
        resolveFn = resolve;
      });
      socialDataRefreshResolversRef.current = [resolveFn!];
    }
    const currentPromise = socialDataRefreshPromiseRef.current;

    socialDataRefreshTimerRef.current = setTimeout(async () => {
      socialDataRefreshTimerRef.current = null;
      socialDataRefreshPromiseRef.current = null;
      const resolvers = socialDataRefreshResolversRef.current;
      socialDataRefreshResolversRef.current = [];

      try {
        const [apiFriends, apiRequests, apiEmergencyContacts, apiBlockedUsers] = await Promise.all([
          listFriends(authToken),
          listFriendRequests(authToken),
          listEmergencyContacts(authToken),
          getBlockedUsers(authToken),
        ]);
        const contacts = apiEmergencyContacts.map(mapEmergencyContact);
        const emergencyContactIds = new Set(contacts.map((contact) => contact.contactId));

        setFriends(apiFriends.map((friend) => mapFriend(friend, emergencyContactIds)));
        setFriendRequests(apiRequests.map((req) => mapFriendRequest(req, effectiveUserId)));
        setBlockedUsers(apiBlockedUsers.map(u => ({ id: u.userId, name: u.name, email: u.email, avatarUrl: u.avatarUrl })));
        setEmergencySettings({
          warningEnabled: settings?.warningEnabled ?? user.warningEnabled ?? false,
          warningDays: settings?.warningDays ?? user.warningDays ?? 0,
          contacts,
        });
      } catch (error) {
        console.error("Error refreshing social data:", error);
      } finally {
        resolvers.forEach((resolve) => resolve());
      }
    }, 250);

    return currentPromise;
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- canonical SSR mounted flag; must flip after hydration
    setIsMounted(true);
    console.log(`Near Chat client successfully initialized (v${process.env.NEXT_PUBLIC_APP_VERSION || '1.0.0'})`);
  }, []);

  useEffect(() => {
    const handleExpired = () => {
      clearSession();
    };
    const handleRefreshed = (e: Event) => {
      const customEvent = e as CustomEvent<{ token: string; user: unknown }>;
      setToken(customEvent.detail.token);
    };
    window.addEventListener('auth:token-expired', handleExpired);
    window.addEventListener('auth:token-refreshed', handleRefreshed);
    return () => {
      window.removeEventListener('auth:token-expired', handleExpired);
      window.removeEventListener('auth:token-refreshed', handleRefreshed);
    };
  }, []);

  useEffect(() => {
    tokenRef.current = token;
    if (token && socketRef.current) {
      socketRef.current.auth = { token };
    }
  }, [token]);

  // Session bootstrap: localStorage is only readable after mount, so this
  // hydration must stay in an effect (reading it during render breaks SSR).
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- post-mount localStorage session hydration */
    if (!isMounted) return;

    const savedUser = localStorage.getItem("user");
    const savedTheme = localStorage.getItem("theme");
    const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const initialTheme = savedTheme ?? (systemPrefersDark ? "dark" : "light");

    if (initialTheme === "dark") {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    const savedLanguage = localStorage.getItem("language");
    if (savedLanguage === "zh-TW" || savedLanguage === "en") {
      setUiLanguageState(savedLanguage);
    }

    if (savedUser) {
      try {
        const parsed = JSON.parse(savedUser) as StoredUser;
        setUser(parsed);
        setCurrentUserId(parsed.userId);
      } catch (error) {
        console.error(error);
      }
    }

    let cancelled = false;
    void (async () => {
      try {
        setRoomsInitialized(false);
        let currentToken = getActiveAccessToken();
        if (!currentToken) {
          const refreshResult = await refreshTokens();
          if (cancelled) return;
          currentToken = refreshResult.token;
        }

        const [profile, settings] = await Promise.all([
          getMe(currentToken),
          getMySettings(currentToken),
        ]);
        if (cancelled) return;

        let finalTheme = settings?.theme;
        const isJustRegistered = localStorage.getItem("just_registered") === "true";
        if (isJustRegistered) {
          const systemPrefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
          const systemTheme = systemPrefersDark ? "dark" : "light";
          try {
            await updateMySettings(currentToken, { theme: systemTheme });
            finalTheme = systemTheme;
          } catch (err) {
            console.error("Failed to initialize backend theme on registration:", err);
          }
          localStorage.removeItem("just_registered");
        }

        const stored = toStoredUser(profile, { ...settings, theme: finalTheme || settings?.theme });
        localStorage.setItem("user", JSON.stringify(stored));
        localStorage.setItem("theme", stored.theme ?? "light");
        localStorage.setItem("notify-desktop", String(stored.notifyDesktop ?? true));
        localStorage.setItem("notify-sound", String(stored.notifySound ?? true));
        document.documentElement.classList.toggle("dark", stored.theme === "dark");
        setUser(stored);
        setCurrentUserId(profile.userId);
        setUiLanguageState(stored.language ?? "en");
        setToken(currentToken);
        setActiveAccessToken(currentToken);
        setIsAuthenticated(true);
        await Promise.all([
          refreshRoomsAndFolders(currentToken, profile.userId),
          refreshSocialData(currentToken, settings, profile.userId),
        ]);
      } catch (error) {
        console.error(error);
        if (!cancelled) {
          clearSession();
          window.location.replace("/login");
        }
      }
    })();

    /* eslint-enable react-hooks/set-state-in-effect */
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMounted]);

  useEffect(() => {
    roomsRef.current = rooms;
    if (socketRef.current?.connected) {
      rooms.forEach((room) => joinRoom(socketRef.current!, room.id));
    }
  }, [rooms]);

  useEffect(() => {
    if (!token || !currentUserId) return;

    const socket = createChatSocket(token);
    socketRef.current = socket;

    const joinKnownRooms = () => {
      roomsRef.current.forEach((room) => joinRoom(socket, room.id));
    };

    const cleanupNewMessage = onNewMessage(socket, (payload) => {
      const incoming = mapMessage(payload, currentUserId);
      setMessages((current) => {
        const withoutDuplicate = current.filter((message) => message.id !== incoming.id);
        return hydrateReplyTargets(sortMessages([...withoutDuplicate, incoming]));
      });

      // Update the sender's read receipt (since they sent it, they've read it!)
      const senderId = incoming.senderId;
      if (senderId) {
        setGroupReadStates((current) => ({
          ...current,
          [incoming.roomId]: {
            ...(current[incoming.roomId] ?? {}),
            [senderId]: incoming.id,
          },
        }));
      }

      setRooms((current) =>
        current.map((room) =>
          room.id === incoming.roomId
            ? {
                ...room,
                lastMessagePreview: summarizeMessagePreview(incoming),
                lastMessageAt: incoming.timestamp,
                unreadCount:
                  activeRoomIdRef.current === room.id
                    ? 0
                    : incoming.senderId === currentUserId
                    ? (room.unreadCount ?? 0)
                    : (room.unreadCount ?? 0) + 1,
                lastReadId: incoming.senderId === currentUserId ? incoming.id : room.lastReadId,
                members: room.members?.map((member) =>
                  member.userId === incoming.senderId
                    ? { ...member, lastReadId: incoming.id }
                    : member
                ),
              }
            : room,
        ),
      );
    });
    const cleanupRecall = onMessageRecalled(socket, ({ messageId }) => {
      setMessages((current) =>
        hydrateReplyTargets(
          current.map((message) =>
            message.id === messageId ? { ...message, isRecalled: true, content: "" } : message,
          ),
        ),
      );
    });
    const cleanupUpdate = onMessageUpdated(socket, (updatedMessage) => {
      setMessages((current) =>
        hydrateReplyTargets(
          current.map((message) =>
            message.id === updatedMessage.messageId
              ? mapMessage(updatedMessage, currentUserId)
              : message,
          ),
        ),
      );
    });
    const cleanupRead = onReadUpdate(socket, ({ roomId, userId, messageId }) => {
      setGroupReadStates((current) => ({
        ...current,
        [roomId]: {
          ...(current[roomId] ?? {}),
          [userId]: messageId,
        },
      }));
      setRooms((current) =>
        current.map((room) => {
          if (room.id !== roomId) return room;

          let roomChanged = false;
          const nextRoom = { ...room };

          if (userId === currentUserId && room.lastReadId !== messageId) {
            nextRoom.lastReadId = messageId;
            roomChanged = true;
          }

          if (room.members) {
            const nextMembers = room.members.map((member) => {
              if (member.userId !== userId || member.lastReadId === messageId) {
                return member;
              }
              roomChanged = true;
              return { ...member, lastReadId: messageId };
            });
            nextRoom.members = nextMembers;
          }

          return roomChanged ? nextRoom : room;
        }),
      );
    });
    const cleanupTyping = onUserTyping(socket, ({ roomId, userId, isTyping }) => {
      const typingRoom = roomsRef.current.find(r => r.id === roomId);
      const typingMember = typingRoom?.members?.find(m => m.userId === userId);
      const displayName = typingMember?.nickname ?? typingMember?.name ?? userId;
      const timerKey = `${roomId}:${userId}`;
      if (typingTimersRef.current[timerKey]) {
        clearTimeout(typingTimersRef.current[timerKey]);
      }
      if (isTyping) {
        setTypingUsers(prev => {
          const current = prev[roomId] ?? [];
          if (current.includes(displayName)) return prev;
          return { ...prev, [roomId]: [...current, displayName] };
        });
        typingTimersRef.current[timerKey] = setTimeout(() => {
          setTypingUsers(prev => ({
            ...prev,
            [roomId]: (prev[roomId] ?? []).filter(n => n !== displayName),
          }));
        }, 3000);
      } else {
        setTypingUsers(prev => ({
          ...prev,
          [roomId]: (prev[roomId] ?? []).filter(n => n !== displayName),
        }));
      }
    });
    const cleanupError = onSocketError(socket, (error) => {
      console.error("Socket error", error);
    });
    const cleanupFriendRequest = onFriendRequest(socket, (payload) => {
      const activeTok = tokenRef.current;
      if (activeTok) {
        void refreshSocialData(activeTok, undefined, currentUserId);
        
        const status = payload.status as string;
        if (
          status === "accepted" ||
          status === "deleted" ||
          status === "blocked" ||
          status === "unblocked"
        ) {
          void refreshRoomsAndFolders(activeTok, currentUserId);
        }
      }
    });
    const cleanupEmergencyAlert = onEmergencyAlert(socket, (payload) => {
      window.alert(`[EMERGENCY ALERT]\nFrom User: ${payload.userId}\nMessage: ${payload.message}`);
    });
    const cleanupUserStatus = onUserStatus(socket, ({ userId, status }) => {
      setFriends((prev) =>
        prev.map((friend) =>
          friend.id === userId ? { ...friend, status } : friend,
        ),
      );
    });

    const cleanupRoomUpdate = onRoomUpdate(socket, ({ type, roomId, data }) => {
      const payload = data as {
        userId?: string;
        name?: string;
        avatarUrl?: string;
        requireApproval?: boolean;
        viewHistory?: boolean;
        isArchived?: boolean;
      };
      if (type === 'USER_UPDATED') {
        const { userId, name, avatarUrl } = payload;
        setRooms((current) =>
          current.map((room) => {
            if (!room.members) return room;
            const hasMember = room.members.some((m) => m.userId === userId);
            if (!hasMember) return room;
            return {
              ...room,
              members: room.members.map((m) =>
                m.userId === userId
                  ? { ...m, name: name ?? m.name, avatarUrl: avatarUrl ?? m.avatarUrl }
                  : m
              ),
            };
          })
        );
        setFriends((prev) =>
          prev.map((friend) =>
            friend.id === userId
              ? { ...friend, name: name ?? friend.name, avatarUrl: avatarUrl ?? friend.avatarUrl }
              : friend
          )
        );
        setFriendRequests((prev) =>
          prev.map((req) =>
            req.id === userId
              ? { ...req, name: name ?? req.name, avatarUrl: avatarUrl ?? req.avatarUrl }
              : req
          )
        );
        setBlockedUsers((prev) =>
          prev.map((u) =>
            u.id === userId
              ? { ...u, name: name ?? u.name, avatarUrl: avatarUrl ?? u.avatarUrl }
              : u
          )
        );
        if (userId === currentUserId) {
          setUser((prev) => ({
            ...prev,
            username: name ?? prev.username,
            avatar: avatarUrl ?? prev.avatar,
          }));
        }
      } else if (type === 'ROOM_AVATAR_UPDATED') {
        const { avatarUrl } = payload;
        setRooms((current) =>
          current.map((room) =>
            room.id === roomId ? { ...room, avatarUrl } : room
          )
        );
      } else if (type === 'ROOM_SETTINGS_UPDATED') {
        const updatedRoom = payload;
        setRooms((current) =>
          current.map((room) =>
            room.id === roomId
              ? {
                  ...room,
                  name: updatedRoom.name ?? room.name,
                  avatarUrl: updatedRoom.avatarUrl ?? room.avatarUrl,
                  requireApproval: updatedRoom.requireApproval,
                  viewHistory: updatedRoom.viewHistory,
                  isArchived: updatedRoom.isArchived,
                }
              : room
          )
        );
      } else if (type === 'ROOM_DELETED') {
        setRooms((current) => current.filter((r) => r.id !== roomId));
        if (activeRoomIdRef.current === roomId) {
          router.push("/");
        }
      } else if (type === 'MEMBER_KICKED' || type === 'MEMBER_LEFT') {
        const { userId } = payload;
        if (userId === currentUserId) {
          setRooms((current) => current.filter((r) => r.id !== roomId));
          if (activeRoomIdRef.current === roomId) {
            router.push("/");
          }
        } else {
          void loadGroupMembers(roomId);
        }
      } else if (
        type === 'MEMBER_JOINED' ||
        type === 'MEMBER_APPROVED' ||
        type === 'MEMBER_UPDATED' ||
        type === 'OWNERSHIP_TRANSFERRED'
      ) {
        void loadGroupMembers(roomId);
      } else if (type === 'ROOM_JOINED') {
        // The current user was just approved into a group (or joined directly via
        // invite code). Since they were not yet subscribed to the room's socket
        // channel, the server pushes this event to their personal user channel.
        // Refresh rooms/folders so the new room appears in the sidebar, then
        // join its socket channel so future room events are received.
        const activeTok = tokenRef.current;
        if (activeTok) {
          void refreshRoomsAndFolders(activeTok, currentUserId);
        }
      }
    });

    socket.on("connect", joinKnownRooms);
    socket.connect();

    return () => {
      cleanupNewMessage();
      cleanupRecall();
      cleanupUpdate();
      cleanupRead();
      cleanupTyping();
      cleanupError();
      cleanupFriendRequest();
      cleanupEmergencyAlert();
      cleanupUserStatus();
      cleanupRoomUpdate();
      socket.off("connect", joinKnownRooms);
      socket.disconnect();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId, token]);

  const toggleFolder = (folderId: string) => {
    setFolders((current) =>
      current.map((folder) =>
        folder.id === folderId ? { ...folder, collapsed: !folder.collapsed } : folder,
      ),
    );
  };

  const handleLogout = () => {
    const authToken = token;
    clearSession();
    if (authToken) {
      void logout(authToken).catch(console.error);
    }
    router.push("/login");
  };

  const handleSendMessage = (roomId: string, content: string, replyTarget: Message | null) => {
    if (!content.trim() || !socketRef.current) return;

    sendMessage(socketRef.current, {
      roomId,
      content,
      replyTo: replyTarget?.id,
    });
  };

  const handleTyping = (roomId: string, isTyping: boolean) => {
    if (!socketRef.current) return;
    sendTyping(socketRef.current, { roomId, isTyping });
  };

  const handleUploadAttachments = async (
    roomId: string,
    files: File[],
    options?: { content?: string; replyTarget?: Message | null },
  ) => {
    if (!token || !socketRef.current) return;
    const uploadedResults = await Promise.all(
      files.map((file) => uploadAttachment(token, file))
    );
    const attachmentIds = uploadedResults.map((res) => res.attachmentId);

    const fileNames = files.map((file) => file.name);
    const content = options?.content?.trim()
      ? options.content.trim()
      : formatUploadedAttachmentsMessage(uiLanguage, fileNames);

    sendMessage(socketRef.current, {
      roomId,
      content,
      replyTo: options?.replyTarget?.id,
      attachmentIds,
    });
  };

  const handleRecallMessage = (msgId: string) => {
    if (!socketRef.current) return;
    recallMessage(socketRef.current, msgId);
  };

  const handleUpdateMessage = (roomId: string, messageId: string, content: string) => {
    if (!socketRef.current) return;
    updateMessage(socketRef.current, { roomId, messageId, content });
  };

  const handleUpdateProfile = async (profile: ProfileInput) => {
    let nextUser: StoredUser = {
      ...user,
      username: profile.username,
      email: profile.email,
      avatar: profile.avatar,
      bio: profile.bio ?? user.bio ?? "",
    };

    if (token) {
      const mergeStoredProfile = (updatedProfile: MyProfile) => {
        nextUser = {
          ...nextUser,
          ...toStoredUser(updatedProfile, {
            language: user.language ?? uiLanguage,
            theme: user.theme ?? "light",
            notifyDesktop: user.notifyDesktop ?? true,
            notifySound: user.notifySound ?? true,
            warningEnabled: user.warningEnabled ?? false,
            warningDays: user.warningDays ?? 14,
          }),
        };
      };

      const updatePayload: {
        name?: string;
        email?: string;
        avatarUrl?: string;
        bio?: string;
        password?: string;
        currentPassword?: string;
      } = {};

      if (profile.username !== user.username) {
        updatePayload.name = profile.username;
      }
      if (profile.email !== user.email) {
        updatePayload.email = profile.email;
      }
      if ((profile.bio ?? "") !== (user.bio ?? "")) {
        updatePayload.bio = profile.bio ?? "";
      }
      if (!profile.avatarFile && profile.avatar !== user.avatar) {
        updatePayload.avatarUrl = profile.avatar;
      }
      if (profile.password) {
        updatePayload.password = profile.password;
        updatePayload.currentPassword = profile.currentPassword;
      }

      if (Object.keys(updatePayload).length > 0) {
        const updatedProfile = await updateMe(token, updatePayload);
        mergeStoredProfile(updatedProfile);
      }

      if (profile.avatarFile) {
        const uploadedProfile = await uploadAvatarApi(token, profile.avatarFile);
        mergeStoredProfile(uploadedProfile);
      }
    }

    localStorage.setItem("user", JSON.stringify(nextUser));
    setUser(nextUser);

    if (nextUser.userId) {
      setRooms((current) =>
        current.map((room) => {
          if (!room.members) return room;
          const updatedMembers = room.members.map((m) => {
            if (m.userId === nextUser.userId) {
              return {
                ...m,
                name: nextUser.username,
                avatarUrl: nextUser.avatar,
              };
            }
            return m;
          });
          return {
            ...room,
            members: updatedMembers,
          };
        })
      );
    }

    return nextUser;
  };

  const handleUpdatePreferences = async (preferences: PreferencesInput) => {
    const nextWarningEnabled = preferences.warningEnabled ?? user.warningEnabled ?? false;
    const nextWarningDays = preferences.warningDays ?? user.warningDays ?? 0;
    
    let nextUser: StoredUser = {
      ...user,
      language: preferences.language,
      theme: preferences.theme === "dark" ? "dark" : "light",
      notifyDesktop: preferences.notifyDesktop,
      notifySound: preferences.notifySound,
      warningEnabled: nextWarningEnabled,
      warningDays: nextWarningDays,
    };

    if (token) {
      const updatedSettings = await updateMySettings(token, {
        language: preferences.language,
        theme: preferences.theme === "dark" ? "dark" : "light",
        notifyDesktop: preferences.notifyDesktop,
        notifySound: preferences.notifySound,
        ...(preferences.warningEnabled !== undefined ? { warningEnabled: nextWarningEnabled } : {}),
        ...(preferences.warningDays !== undefined ? { warningDays: nextWarningDays } : {}),
      });
      nextUser = { 
        ...nextUser, 
        language: updatedSettings.language as UiLanguage, 
        theme: updatedSettings.theme as "light" | "dark", 
        notifyDesktop: updatedSettings.notifyDesktop, 
        notifySound: updatedSettings.notifySound, 
        warningEnabled: updatedSettings.warningEnabled, 
        warningDays: updatedSettings.warningDays,
      };
    }

    localStorage.setItem("user", JSON.stringify(nextUser));
    localStorage.setItem("theme", preferences.theme);
    localStorage.setItem("language", preferences.language);
    localStorage.setItem("notify-desktop", String(preferences.notifyDesktop));
    localStorage.setItem("notify-sound", String(preferences.notifySound));
    document.documentElement.classList.toggle("dark", preferences.theme === "dark");
    setUser(nextUser);
    setUiLanguageState(preferences.language);
    setEmergencySettings((current) => ({
      ...current,
      warningEnabled: nextWarningEnabled,
      warningDays: nextWarningDays,
    }));
  };

  const handleCreateRoom = async (name: string, type: "msg" | "group", folderId: string) => {
    if (!token) return "";

    let created: Room;
    if (type === "group") {
      created = await createGroup(token, { name });
    } else {
      const matches = await searchUsers(token, { query: name });
      const target = matches[0];
      if (!target) {
        throw new Error("No matching user found for private room");
      }
      created = await createPrivateRoom(token, { targetUserId: target.userId });
    }

    await refreshRoomsAndFolders(token);
    if (folderId) {
      await handleCategorizeRoom(created.roomId, folderId);
    }
    return created.roomId;
  };

  const handleOpenPrivateRoom = async (targetUserId: string) => {
    if (!token) return "";
    const room = await createPrivateRoom(token, { targetUserId });
    await refreshRoomsAndFolders(token);
    return room.roomId;
  };

  const handleCreateFolder = async (name: string) => {
    if (!token) return;
    const folder = await createFolder(token, name);
    setFolders((current) => [...current, { id: folder.folderId, name: folder.name, collapsed: false }]);
  };

  const handleDeleteFolder = async (folderId: string) => {
    if (!token) return;

    await deleteFolderApi(token, folderId);
    setFolders((current) => current.filter((folder) => folder.id !== folderId));
    setRooms((current) =>
      current.map((room) =>
        room.folderId === folderId ? { ...room, folderId: null } : room,
      ),
    );
  };

  const handleRenameFolder = async (folderId: string, name: string) => {
    if (!token) return;
    const updated = await renameFolderApi(token, folderId, name);
    setFolders((current) =>
      current.map((folder) =>
        folder.id === folderId ? { ...folder, name: updated.name } : folder,
      ),
    );
  };

  const handleCategorizeRoom = async (roomId: string, folderId: string | null) => {
    if (!token) return;

    const nextFolders = folders.map((folder) => {
      const currentRoomIds = rooms
        .filter((room) => room.folderId === folder.id && room.id !== roomId)
        .map((room) => room.id);
      const roomIds = folder.id === folderId ? [...currentRoomIds, roomId] : currentRoomIds;
      return { folder, roomIds };
    });

    await Promise.all(
      nextFolders.map(({ folder, roomIds }) => updateFolderRooms(token, folder.id, roomIds)),
    );

    setRooms((current) =>
      current.map((room) =>
        room.id === roomId ? { ...room, folderId } : room,
      ),
    );
  };

  const handleModifyNickname = async (roomId: string, nickname: string) => {
    if (!token || !user.userId) return;
    const finalNick = nickname.trim();
    await updateRoomMember(token, roomId, user.userId, { nickname: finalNick || user.username });
    await loadGroupMembers(roomId);
  };

  const handleLeaveOrBlock = async (roomId: string) => {
    if (!token) return { isDeleted: false };
    const room = rooms.find((item) => item.id === roomId);
    if (!room) return { isDeleted: false };

    if (room.type === "group") {
      await leaveRoomApi(token, roomId);
      const remaining = rooms.filter((item) => item.id !== roomId);
      setRooms(remaining);
      return { isDeleted: true, newActiveId: remaining[0]?.id };
    }

    const targetUserId =
      room.otherMemberId ?? room.members?.find((member) => member.userId !== currentUserId)?.userId;
    if (!targetUserId) return { isDeleted: false };

    if (room.isReadonly) {
      await unblockUserApi(token, targetUserId).catch(console.error);
    } else {
      await blockUserApi(token, targetUserId).catch(console.error);
    }

    await Promise.all([
      refreshRoomsAndFolders(token, currentUserId).catch(console.error),
      refreshSocialData(token).catch(console.error),
    ]);
    return { isDeleted: false };
  };

  const handleDeleteAccount = async () => {
    if (!token) throw new Error("Not authenticated");
    await deleteMeApi(token);
    handleLogout();
  };

  // Lazy-load members for the active room (placed after loadGroupMembers so the
  // effect references it after declaration).
  // Synchronize/load members for the active room whenever it changes
  useEffect(() => {
    if (!token || !activeRoomId) return;

    void loadGroupMembers(activeRoomId).catch(console.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRoomId, token]);

  const saveGroupSettings = async (roomId: string, settings: GroupSettingsInput) => {
    if (!token) return;

    const payload: Record<string, unknown> = {};
    if (settings.name !== undefined) payload.name = settings.name;
    if (settings.requireApproval !== undefined) payload.requireApproval = settings.requireApproval;
    if (settings.viewHistory !== undefined) payload.viewHistory = settings.viewHistory;
    if (settings.isArchived !== undefined) payload.isArchived = settings.isArchived;

    let updated = await updateRoom(token, roomId, payload);

    if (settings.avatarFile) {
      updated = await uploadRoomAvatarApi(token, roomId, settings.avatarFile);
    }

    setRooms((current) =>
      current.map((room) =>
        room.id === roomId
          ? {
              ...room,
              name: updated.name ?? room.name,
              inviteCode: updated.inviteCode ?? room.inviteCode,
              requireApproval: updated.requireApproval !== undefined ? updated.requireApproval : room.requireApproval,
              viewHistory: updated.viewHistory !== undefined ? updated.viewHistory : room.viewHistory,
              isArchived: updated.isArchived !== undefined ? updated.isArchived : room.isArchived,
              avatarUrl: updated.avatarUrl ?? room.avatarUrl,
            }
          : room,
      ),
    );
  };

  const approveGroupMember = async (roomId: string, userId: string) => {
    if (!token) return;
    await approveRoomMember(token, roomId, userId);
    return loadGroupMembers(roomId);
  };

  const updateGroupMember = async (
    roomId: string,
    userId: string,
    data: { role?: "admin" | "member"; nickname?: string; isMuted?: boolean },
  ) => {
    if (!token) return;
    await updateRoomMember(token, roomId, userId, data);
    return loadGroupMembers(roomId);
  };

  const kickGroupMember = async (roomId: string, userId: string) => {
    if (!token) return;
    await kickRoomMember(token, roomId, userId);
    return loadGroupMembers(roomId);
  };

  const transferGroupOwner = async (roomId: string, userId: string) => {
    if (!token) return;
    await transferRoomOwner(token, roomId, userId);
    return loadGroupMembers(roomId);
  };

  const handleDeleteGroupRoom = async (roomId: string) => {
    if (token) {
      await deleteRoomApi(token, roomId);
    }
    const remaining = rooms.filter((room) => room.id !== roomId);
    setRooms(remaining);
    return remaining[0]?.id ?? null;
  };

  const getReadAvatarsForMessage = (room: ChatRoom, msg: Message): { name: string; displayName?: string; avatarUrl: string }[] => {
    if (room.type !== "group" && room.type !== "msg") return [];

    const roomReads = groupReadStates[room.id];
    if (!roomReads) return [];

    return Object.entries(roomReads)
      .filter(([readerId, lastReadId]) => readerId !== currentUserId && lastReadId === msg.id)
      .map(([readerId]) => {
        const member = room.members?.find((m) => m.userId === readerId);
        return {
          name: member?.name ?? readerId,
          displayName: member?.nickname ?? member?.name ?? readerId,
          avatarUrl: member?.avatarUrl ?? "",
        };
      });
  };

  const searchUsersForInvite = async (query: string): Promise<PublicUser[]> => {
    if (!token) throw new Error("Not authenticated");
    const trimmed = query.trim();
    if (!trimmed) return [];
    return searchUsers(token, { query: trimmed, friendsOnly: true });
  };

  const handleJoinByInviteCode = async (inviteCode: string): Promise<string> => {
    if (!token) throw new Error("Not authenticated");
    const room = await joinRoomByCode(token, inviteCode.trim());
    await refreshRoomsAndFolders(token);
    return room.roomId;
  };

  const sendFriendRequest = async (query: string) => {
    if (!token) throw new Error("Not authenticated");
    const trimmedQuery = query.trim();
    if (!trimmedQuery) throw new Error("Search query is required");

    const matches = await searchUsers(token, { query: trimmedQuery });
    const target = findRequestedUser(matches, trimmedQuery);
    if (!target) {
      throw new Error("No matching user found");
    }

    await sendFriendRequestApi(token, target.userId);
    setFriendRequests((prev) => [
      ...prev,
      {
        id: target.userId,
        name: target.name,
        email: trimmedQuery.includes("@") ? trimmedQuery : "",
        direction: "outgoing",
      },
    ]);
  };

  const acceptFriendRequest = async (requestId: string) => {
    if (!token) return;
    const request = friendRequests.find(
      (item) => item.id === requestId && item.direction === "incoming",
    );

    await respondFriendRequest(token, requestId, "accepted");
    if (request) {
      setFriendRequests((prev) => prev.filter((item) => item.id !== requestId));
      setFriends((prev) => {
        if (prev.some((item) => item.id === request.id)) return prev;
        return [
          ...prev,
          {
            id: request.id,
            name: request.name,
            email: request.email,
            status: "offline",
          },
        ];
      });
    }
    await refreshSocialData(token, undefined, currentUserId);
    await refreshRoomsAndFolders(token, currentUserId);
  };

  const rejectFriendRequest = async (requestId: string) => {
    if (!token) return;
    const request = friendRequests.find((item) => item.id === requestId);
    if (request?.direction === "incoming") {
      await respondFriendRequest(token, requestId, "rejected");
    }
    await refreshSocialData(token);
  };

  const removeFriend = async (friendId: string) => {
    if (!token) return;
    await deleteFriend(token, friendId);
    await Promise.all([
      refreshRoomsAndFolders(token, currentUserId),
      refreshSocialData(token),
    ]);
  };

  const blockFriend = async (friendId: string) => {
    if (!token) return;
    const friend = friends.find((item) => item.id === friendId);
    if (!friend) return;

    await blockUserApi(token, friendId);
    await Promise.all([
      refreshRoomsAndFolders(token, currentUserId),
      refreshSocialData(token),
    ]);
  };

  const unblockUser = async (blockedId: string) => {
    if (token) {
      await unblockUserApi(token, blockedId);
      await Promise.all([
        refreshRoomsAndFolders(token, currentUserId),
        refreshSocialData(token),
      ]);
    }
  };

  const saveEmergencySettings = async (settings: EmergencySettings) => {
    if (!token) return;
    const nextWarningDays = settings.warningEnabled ? Math.max(1, settings.warningDays) : 0;
    await updateMySettings(token, {
      warningEnabled: settings.warningEnabled,
      warningDays: nextWarningDays,
    });

    const nextContactIds = new Set(settings.contacts.map((contact) => contact.contactId));
    const removedContacts = emergencySettings.contacts.filter(
      (contact) => !nextContactIds.has(contact.contactId),
    );

    await Promise.all([
      ...settings.contacts.map((contact) =>
        upsertEmergencyContact(token, {
          contactId: contact.contactId,
          message: contact.message,
        }),
      ),
      ...removedContacts.map((contact) => deleteEmergencyContact(token, contact.contactId)),
    ]);

    const updatedSettings: UserSettings = {
      language: user.language ?? uiLanguage,
      theme: user.theme ?? "light",
      notifyDesktop: user.notifyDesktop ?? true,
      notifySound: user.notifySound ?? true,
      warningEnabled: settings.warningEnabled,
      warningDays: nextWarningDays,
    };
    await refreshSocialData(token, updatedSettings);
    const nextUser = {
      ...user,
      warningEnabled: updatedSettings.warningEnabled,
      warningDays: updatedSettings.warningDays,
    };
    localStorage.setItem("user", JSON.stringify(nextUser));
    setUser(nextUser);
  };

  const setUiLanguage = (language: UiLanguage) => {
    localStorage.setItem("language", language);
    setUiLanguageState(language);
  };

  useEffect(() => {
    if (!currentUserId) return;

    const messagesByRoom = messages.reduce<Record<string, Message[]>>((acc, message) => {
      (acc[message.roomId] ??= []).push(message);
      return acc;
    }, {});

    // TODO: derive unread counts / previews during render (useMemo) instead of
    // writing back into rooms state; needs a wider refactor of rooms consumers.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- guarded write-back (returns `current` when unchanged) prevents render loops
    setRooms((current) => {
      let changed = false;

      const nextRooms = current.map((room) => {
        const roomMessages = sortMessages(messagesByRoom[room.id] ?? []);
        const latestMessage = roomMessages.at(-1);
        const nextUnreadCount =
          activeRoomId === room.id ? 0 : (room.unreadCount ?? 0);
        const nextPreview = latestMessage ? summarizeMessagePreview(latestMessage) : room.lastMessagePreview;
        const nextLastMessageAt = latestMessage ? latestMessage.timestamp : room.lastMessageAt;

        if (
          room.unreadCount === nextUnreadCount &&
          room.lastMessagePreview === nextPreview &&
          room.lastMessageAt === nextLastMessageAt
        ) {
          return room;
        }

        changed = true;
        return {
          ...room,
          unreadCount: nextUnreadCount,
          lastMessagePreview: nextPreview,
          lastMessageAt: nextLastMessageAt,
        };
      });

      return changed ? nextRooms : current;
    });
  }, [activeRoomId, currentUserId, groupReadStates, messages]);

  const prevActiveRoomIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!socketRef.current || !activeRoomId || !currentUserId) return;

    // Skip on room entry — Chatroom calls markRoomAsRead once the user scrolls to the bottom
    if (prevActiveRoomIdRef.current !== activeRoomId) {
      prevActiveRoomIdRef.current = activeRoomId;
      return;
    }

    const activeRoom = roomsRef.current.find((room) => room.id === activeRoomId);
    if (!activeRoom) return;

    const roomMessages = sortMessages(messages.filter((message) => message.roomId === activeRoomId));
    const latestIncoming = roomMessages.at(-1);
    if (!latestIncoming) return;

    const currentLastReadId =
      groupReadStates[activeRoomId]?.[currentUserId] ??
      activeRoom.members?.find((member) => member.userId === currentUserId)?.lastReadId ??
      null;

    if (currentLastReadId === latestIncoming.id) return;

    sendReadReceipt(socketRef.current, {
      roomId: activeRoomId,
      messageId: latestIncoming.id,
    });

    setGroupReadStates((current) => ({
      ...current,
      [activeRoomId]: {
        ...(current[activeRoomId] ?? {}),
        [currentUserId]: latestIncoming.id,
      },
    }));
  }, [activeRoomId, currentUserId, groupReadStates, messages]);

  // Stable function for Chatroom to call when the user has scrolled to the bottom
  const markRoomAsReadRef = useRef<((roomId: string) => void) | null>(null);
  useLayoutEffect(() => {
    markRoomAsReadRef.current = (roomId: string) => {
      if (!socketRef.current || !currentUserId) return;
      const room = roomsRef.current.find((r) => r.id === roomId);
      if (!room) return;
      const roomMessages = sortMessages(messages.filter((m) => m.roomId === roomId));
      const latestIncoming = roomMessages.at(-1);
      if (!latestIncoming) return;
      const currentLastReadId =
        groupReadStates[roomId]?.[currentUserId] ??
        room.members?.find((m) => m.userId === currentUserId)?.lastReadId ??
        null;
      if (currentLastReadId === latestIncoming.id) return;
      sendReadReceipt(socketRef.current, { roomId, messageId: latestIncoming.id });
      setGroupReadStates((current) => ({
        ...current,
        [roomId]: { ...(current[roomId] ?? {}), [currentUserId]: latestIncoming.id },
      }));
    };
  });

  const markRoomAsRead = useCallback((roomId: string) => {
    markRoomAsReadRef.current?.(roomId);
  }, []);

  const derivedRooms = useMemo(() => {
    return rooms.map((room) => {
      let nextName = room.name;
      let nextIsOnline = room.isOnline;

      if (room.type === "msg") {
        const otherMemberId = room.otherMemberId || room.members?.find((m) => m.userId !== currentUserId)?.userId;
        const blockedUser = otherMemberId ? blockedUsers.find((item) => item.id === otherMemberId) : undefined;
        const privateRoomName = getPrivateRoomName(room, currentUserId);
        if (privateRoomName) {
          nextName = privateRoomName;
        }
        if (otherMemberId) {
          const friend = friends.find((f) => f.id === otherMemberId);
          if (friend) {
            nextName = friend.name;
            nextIsOnline = friend.status === "online";
          } else if (blockedUser) {
            nextName = blockedUser.name;
            nextIsOnline = false;
          }
        }
      }
      return {
        ...room,
        name: nextName,
        isOnline: nextIsOnline,
      };
    });
  }, [rooms, friends, blockedUsers, currentUserId]);

  const updateRoomSorting = async (nextOrder: Record<string, string[]>) => {
    if (!token) return;
    try {
      const nextSettings = await updateMySettings(token, { roomOrder: nextOrder });
      setUser((prev) => ({ ...prev, roomOrder: nextSettings.roomOrder }));
    } catch (err) {
      console.error("Failed to sync room order with backend:", err);
    }
  };

  const handleRefreshSocialData = async () => {
    if (token) {
      await refreshSocialData(token);
    }
  };

  return (
    <ChatContext.Provider
      value={{
        rooms: derivedRooms,
        folders,
        messages,
        groupReadStates,
        user,
        activeRoomNicknames,
        friends,
        friendRequests,
        blockedUsers,
        emergencySettings,
        uiLanguage,
        isAuthenticated,
        isMounted,
        roomsInitialized,
        selectedFriendForSidebar,
        setSelectedFriendForSidebar,
        showRightPanel,
        setShowRightPanel,
        setRooms,
        setFolders,
        setMessages,
        setUser,
        setActiveRoomNicknames,
        toggleFolder,
        handleLogout,
        handleSendMessage,
        handleTyping,
        handleUploadAttachments,
        handleRecallMessage,
        handleUpdateMessage,
        handleUpdateProfile,
        handleUpdatePreferences,
        handleCreateRoom,
        handleOpenPrivateRoom,
        handleCreateFolder,
        handleDeleteFolder,
        handleRenameFolder,
        handleCategorizeRoom,
        handleModifyNickname,
        handleLeaveOrBlock,
        handleDeleteAccount,
        loadGroupMembers,
        saveGroupSettings,
        approveGroupMember,
        updateGroupMember,
        kickGroupMember,
        transferGroupOwner,
        handleDeleteGroupRoom,
        getReadAvatarsForMessage,
        searchUsersForInvite,
        handleJoinByInviteCode,
        sendFriendRequest,
        acceptFriendRequest,
        rejectFriendRequest,
        removeFriend,
        blockFriend,
        unblockUser,
        saveEmergencySettings,
        setUiLanguage,
        typingUsers,
        activeProfilePopover,
        setActiveProfilePopover,
        hasUnsavedChanges,
        setHasUnsavedChanges,
        refreshSocialData: handleRefreshSocialData,
        updateRoomSorting,
        markRoomAsRead,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (context === undefined) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
}
