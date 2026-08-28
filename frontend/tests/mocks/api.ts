/**
 * Fixture-backed replacement for `@/lib/api` (see vitest.config.ts alias).
 * Read endpoints serve the deterministic fixtures; mutation endpoints resolve
 * with minimal plausible shapes. No network is touched.
 */
import type {
  AuthResponse,
  EmergencyContactResponse,
  Folder,
  FriendRequestResponse,
  FriendResponse,
  MessageWithSender,
  MyProfile,
  PublicUser,
  Room,
  RoomMember,
  RoomSummary,
  SearchUserResult,
  UserProfile,
  UserSettings,
} from "@shared/types";
import {
  TEST_TOKEN,
  emergencyContacts,
  folders,
  friendRequestResponses,
  friendResponses,
  membersByRoom,
  messagesByRoom,
  myProfile,
  mySettings,
  profiles,
  publicUser,
  roomSummaries,
} from "../fixtures";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Message ids whose next edit/recall must fail with a 409 revision conflict. */
const conflictingMessageIds = new Set<string>();

export const __failNextRevisionCommand = (messageId: string): void => {
  conflictingMessageIds.add(messageId);
};

/** When set, the next listMessages call rejects (simulates a failed reload). */
let failNextListMessages = false;

export const __failNextListMessages = (): void => {
  failNextListMessages = true;
};

let activeAccessToken: string | null = TEST_TOKEN;
let settingsState: UserSettings = { ...mySettings };
let attachmentUploadGate: Promise<void> | null = null;
let releaseAttachmentUpload: (() => void) | null = null;

/** Recorded mutation calls, for asserting handler behaviour in tests. */
const apiCallLog: Array<{ fn: string; args: unknown[] }> = [];

export const __getApiCallLog = (fn?: string): Array<{ fn: string; args: unknown[] }> =>
  fn ? apiCallLog.filter((entry) => entry.fn === fn) : [...apiCallLog];

export const __resetApiMock = (): void => {
  activeAccessToken = TEST_TOKEN;
  settingsState = { ...mySettings };
  releaseAttachmentUpload?.();
  attachmentUploadGate = null;
  releaseAttachmentUpload = null;
  apiCallLog.length = 0;
  conflictingMessageIds.clear();
  failNextListMessages = false;
  failMarkRoomRead = false;
  syncGate = null;
};

export const __holdNextAttachmentUpload = (): (() => void) => {
  if (attachmentUploadGate) throw new Error("attachment upload is already held");
  attachmentUploadGate = new Promise<void>((resolve) => {
    releaseAttachmentUpload = resolve;
  });
  return () => {
    releaseAttachmentUpload?.();
    attachmentUploadGate = null;
    releaseAttachmentUpload = null;
  };
};

export const getApiBaseUrl = (): string => "http://mock-api.test";

export const getActiveAccessToken = (): string | null => activeAccessToken;
export const setActiveAccessToken = (token: string | null): void => {
  activeAccessToken = token;
};

export const refreshTokens = async (): Promise<AuthResponse> => ({
  token: TEST_TOKEN,
  user: publicUser(myProfile.userId),
});

export const register = async (): Promise<AuthResponse> => refreshTokens();
export const login = async (): Promise<AuthResponse> => refreshTokens();
export const logout = async (): Promise<void> => undefined;

export const getMe = async (): Promise<MyProfile> => ({ ...myProfile });

export const getUserProfile = async (userId: string): Promise<UserProfile> => {
  const profile = profiles[userId];
  if (!profile) throw new Error(`Unknown user ${userId}`);
  return { ...profile };
};

export const updateMe = async (
  _token: string,
  data: Partial<MyProfile> & { name?: string },
): Promise<MyProfile> => ({ ...myProfile, ...data, name: data.name ?? myProfile.name });

export const uploadAvatar = async (): Promise<MyProfile> => ({ ...myProfile });
export const deleteMe = async (): Promise<void> => undefined;

export const getMySettings = async (): Promise<UserSettings> => ({ ...settingsState });

export const updateMySettings = async (
  _token: string,
  data: Partial<UserSettings>,
): Promise<UserSettings> => {
  settingsState = { ...settingsState, ...data };
  return { ...settingsState };
};

export const searchUsers = async (
  _token: string,
  params: { query: string },
): Promise<SearchUserResult[]> => {
  const q = params.query.trim().toLowerCase();
  return Object.values(profiles)
    .filter((p) => p.name.toLowerCase().includes(q) || p.userId.toLowerCase() === q)
    .map((p) => ({ userId: p.userId, name: p.name }));
};

export const listFriends = async (): Promise<FriendResponse[]> => friendResponses;
export const deleteFriend = async (): Promise<void> => undefined;
export const listFriendRequests = async (): Promise<FriendRequestResponse[]> =>
  friendRequestResponses;
export const sendFriendRequest = async (): Promise<{ status: string }> => ({
  status: "pending",
});
export const respondFriendRequest = async (): Promise<{ status: string }> => ({
  status: "accepted",
});
export const getBlockedUsers = async (): Promise<
  { userId: string; name: string; email: string; avatarUrl?: string }[]
> => [];
export const blockUser = async (): Promise<{ status: "blocked" }> => ({ status: "blocked" });
export const unblockUser = async (): Promise<void> => undefined;

export const listRooms = async (): Promise<RoomSummary[]> => roomSummaries;

const roomFromSummary = (summary: RoomSummary): Room => ({
  roomId: summary.roomId,
  type: summary.type,
  name: summary.name,
  avatarUrl: summary.avatarUrl,
  inviteCode: summary.inviteCode,
  requireApproval: summary.requireApproval,
  viewHistory: summary.viewHistory,
  isArchived: summary.isArchived,
  isReadonly: summary.isReadonly,
  createdAt: summary.createdAt,
});

export const createGroup = async (
  _token: string,
  data: { name: string },
): Promise<Room> => ({
  ...roomFromSummary(roomSummaries[0]),
  roomId: "room-new",
  name: data.name,
});

export const createPrivateRoom = async (): Promise<Room> =>
  roomFromSummary(roomSummaries[2]);

export const joinRoomByCode = async (): Promise<Room> => roomFromSummary(roomSummaries[1]);

export const updateRoom = async (
  _token: string,
  roomId: string,
  data: Record<string, unknown>,
): Promise<Room> => ({
  ...roomFromSummary(roomSummaries.find((r) => r.roomId === roomId) ?? roomSummaries[0]),
  ...data,
});

export const uploadRoomAvatar = async (
  _token: string,
  roomId: string,
): Promise<Room> =>
  roomFromSummary(roomSummaries.find((r) => r.roomId === roomId) ?? roomSummaries[0]);

export const deleteRoom = async (): Promise<void> => undefined;
export const leaveRoom = async (): Promise<void> => undefined;

export const listRoomMembers = async (
  _token: string,
  roomId: string,
): Promise<RoomMember[]> => {
  apiCallLog.push({ fn: "listRoomMembers", args: [roomId] });
  return membersByRoom[roomId] ?? [];
};

export const approveRoomMember = async (): Promise<void> => undefined;
export const updateRoomMember = async (): Promise<void> => undefined;
export const kickRoomMember = async (): Promise<void> => undefined;
export const transferRoomOwner = async (): Promise<void> => undefined;

export const listMessages = async (
  _token: string,
  roomId: string,
  options?: { limit?: number },
): Promise<MessageWithSender[]> => {
  if (failNextListMessages) {
    failNextListMessages = false;
    throw new ApiError("Service unavailable", 503);
  }
  const log = messagesByRoom[roomId] ?? [];
  const limit = options?.limit ?? 50;
  // The real API returns newest-first; ChatContext reverses it back.
  return [...log].slice(-limit).reverse();
};

export const createMessage = async (
  _token: string,
  roomId: string,
  data: { content: string; replyToId?: string; attachmentIds?: string[] },
): Promise<MessageWithSender> => {
  apiCallLog.push({ fn: "createMessage", args: [roomId, data] });
  return {
    ...(messagesByRoom[roomId]?.at(-1) ?? messagesByRoom["room-1"]?.at(-1)),
    messageId: "message-created",
    roomId,
    senderId: myProfile.userId,
    content: data.content,
    isRecalled: false,
    sentAt: new Date(),
    sender: { userId: myProfile.userId, name: myProfile.name },
  } as MessageWithSender;
};

export const editMessage = async (
  _token: string,
  roomId: string,
  messageId: string,
  content: string,
  revision: number,
): Promise<MessageWithSender> => {
  apiCallLog.push({ fn: "editMessage", args: [roomId, messageId, content, revision] });
  if (conflictingMessageIds.delete(messageId)) {
    throw new ApiError("Message revision is stale", 409);
  }
  const existing = (messagesByRoom[roomId] ?? []).find((message) => message.messageId === messageId);
  return { ...(existing ?? messagesByRoom["room-1"]![0]), content, revision: revision + 1 };
};

export const recallMessage = async (
  _token: string,
  roomId: string,
  messageId: string,
  revision: number,
): Promise<MessageWithSender> => {
  apiCallLog.push({ fn: "recallMessage", args: [roomId, messageId, revision] });
  if (conflictingMessageIds.delete(messageId)) {
    throw new ApiError("Message revision is stale", 409);
  }
  const existing = (messagesByRoom[roomId] ?? []).find((message) => message.messageId === messageId);
  return { ...(existing ?? messagesByRoom["room-1"]![0]), isRecalled: true, revision: revision + 1 };
};

/** Makes every markRoomRead call reject, the way an offline client sees it. */
let failMarkRoomRead = false;

export const __failMarkRoomRead = (fail: boolean): void => {
  failMarkRoomRead = fail;
};

export const markRoomRead = async (
  _token: string,
  roomId: string,
  messageId: string,
): Promise<RoomMember> => {
  apiCallLog.push({ fn: "markRoomRead", args: [roomId, messageId] });
  if (failMarkRoomRead) throw new ApiError("Read position write failed", 503);
  return { ...membersByRoom[roomId]![0], lastReadId: messageId };
};

/**
 * Test control over the next syncChanges call: the returned promise stays
 * pending until the test releases it, which is the only way to emit realtime
 * events while ChatContext still considers a sync in flight.
 */
let syncGate: Promise<{ failed: boolean }> | null = null;

export const __gateNextSync = (): { fail: () => void; succeed: () => void } => {
  let release!: (outcome: { failed: boolean }) => void;
  syncGate = new Promise<{ failed: boolean }>((resolve) => { release = resolve; });
  return {
    fail: () => release({ failed: true }),
    succeed: () => release({ failed: false }),
  };
};

export const syncChanges = async (
  _token: string,
  cursor: number,
): Promise<{ changes: []; nextCursor: number; hasMore: false }> => {
  apiCallLog.push({ fn: "syncChanges", args: [cursor] });
  const gate = syncGate;
  if (gate) {
    syncGate = null;
    const outcome = await gate;
    if (outcome.failed) throw new ApiError("Sync failed", 503);
  }
  return { changes: [], nextCursor: cursor, hasMore: false };
};

export const listFolders = async (): Promise<Folder[]> => folders;

export const createFolder = async (_token: string, name: string): Promise<Folder> => ({
  folderId: `folder-${name}`,
  userId: myProfile.userId,
  name,
  createdAt: new Date(),
  roomIds: [],
});

export const deleteFolder = async (): Promise<void> => undefined;

export const renameFolder = async (
  _token: string,
  folderId: string,
  name: string,
): Promise<Folder> => ({
  folderId,
  userId: myProfile.userId,
  name,
  createdAt: new Date(),
  roomIds: [],
});

export const updateFolderRooms = async (
  _token: string,
  folderId: string,
  roomIds: string[],
): Promise<void> => {
  apiCallLog.push({ fn: "updateFolderRooms", args: [folderId, roomIds] });
};

export const uploadAttachment = async (
  _token: string,
  file: File,
): Promise<{ attachmentId: string }> => {
  apiCallLog.push({ fn: "uploadAttachment", args: [file.name] });
  if (attachmentUploadGate) await attachmentUploadGate;
  return { attachmentId: "att-1" };
};

export const attachmentDownloadUrl = (fileUrl: string): string =>
  `http://mock-api.test${fileUrl}`;

export const fetchAttachmentBlob = async (): Promise<Blob> => {
  throw new Error("attachments are not fetched in tests");
};

export const fetchAttachmentBlobUrl = async (): Promise<string> => {
  throw new Error("attachments are not fetched in tests");
};

export const listEmergencyContacts = async (): Promise<EmergencyContactResponse[]> =>
  emergencyContacts;
export const upsertEmergencyContact = async (): Promise<{ success: boolean }> => ({
  success: true,
});
export const deleteEmergencyContact = async (): Promise<{ success: boolean }> => ({
  success: true,
});
export const checkEmergencyInactivity = async (): Promise<{ triggered: boolean }> => ({
  triggered: false,
});

// Re-exported so tests can build PublicUser payloads without importing fixtures.
export type { PublicUser };
