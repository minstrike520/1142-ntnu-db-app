import type React from "react";
import type {
  PublicUser,
  RoomMemberRole,
} from "@shared/types";

export interface Member {
  userId: string;
  name: string;
  role: RoomMemberRole;
  nickname?: string;
  isMuted?: boolean;
  lastReadId?: string | null;
  readPosition?: number;
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
  lastMessageId?: string;
  lastMessageSequence?: number;
  lastMessageChangeSequence?: number;
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
  messageSequence?: number;
  changeSequence?: number;
  revision?: number;
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

export type StoredUser = User;

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

export interface GroupSettingsInput {
  name?: string;
  requireApproval?: boolean;
  viewHistory?: boolean;
  isArchived?: boolean;
  avatarFile?: File | null;
}

export interface ChatContextType {
  rooms: ChatRoom[];
  folders: Folder[];
  messages: Message[];
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
  refreshSocialData: () => Promise<void>;
  updateRoomSorting: (nextOrder: Record<string, string[]>) => Promise<void>;
  markRoomAsRead: (roomId: string) => void;
}

export interface ProfilePopoverContextType {
  activeProfilePopover: { instanceId: string; userId: string } | null;
  setActiveProfilePopover: React.Dispatch<
    React.SetStateAction<{ instanceId: string; userId: string } | null>
  >;
}

export interface RightPanelContextType {
  showRightPanel: boolean;
  setShowRightPanel: React.Dispatch<React.SetStateAction<boolean>>;
}

export const HANDLER_KEYS = [
  "toggleFolder",
  "handleLogout",
  "handleSendMessage",
  "handleTyping",
  "handleUploadAttachments",
  "handleRecallMessage",
  "handleUpdateMessage",
  "handleUpdateProfile",
  "handleUpdatePreferences",
  "handleCreateRoom",
  "handleOpenPrivateRoom",
  "handleCreateFolder",
  "handleDeleteFolder",
  "handleRenameFolder",
  "handleCategorizeRoom",
  "handleModifyNickname",
  "handleLeaveOrBlock",
  "handleDeleteAccount",
  "loadGroupMembers",
  "saveGroupSettings",
  "approveGroupMember",
  "updateGroupMember",
  "kickGroupMember",
  "transferGroupOwner",
  "handleDeleteGroupRoom",
  "searchUsersForInvite",
  "handleJoinByInviteCode",
  "sendFriendRequest",
  "acceptFriendRequest",
  "rejectFriendRequest",
  "removeFriend",
  "blockFriend",
  "unblockUser",
  "saveEmergencySettings",
  "setUiLanguage",
  "refreshSocialData",
  "updateRoomSorting",
] as const;

export type HandlerKey = (typeof HANDLER_KEYS)[number];
