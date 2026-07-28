/**
 * Deterministic fixture data for the render-measurement harness and
 * regression tests. Scale is intentionally realistic-but-bounded:
 *
 *  - 2 group rooms (8 members each): room-1 (40 messages), room-2 (30 messages,
 *    3 unread)
 *  - 6 private rooms room-3..room-8, one per friend f-1..f-6 (10 messages each)
 *  - 2 folders (Work: room-3/room-4, Social: room-5)
 */
import type {
  EmergencyContactResponse,
  Folder,
  FriendRequestResponse,
  FriendResponse,
  MessageWithSender,
  MyProfile,
  PublicUser,
  RoomMember,
  RoomSummary,
  UserProfile,
  UserSettings,
} from "@shared/types";

export const ME_ID = "u-me";
export const ME_NAME = "Me User";
export const TEST_TOKEN = "test-token";

const BASE_TIME = Date.UTC(2026, 0, 1, 12, 0, 0);

export const GROUP_MEMBER_IDS = ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-7"];
const MEMBER_NAMES: Record<string, string> = {
  "m-1": "Member One",
  "m-2": "Member Two",
  "m-3": "Member Three",
  "m-4": "Member Four",
  "m-5": "Member Five",
  "m-6": "Member Six",
  "m-7": "Member Seven",
};

export const FRIEND_IDS = ["f-1", "f-2", "f-3", "f-4", "f-5", "f-6"];
const FRIEND_NAMES: Record<string, string> = {
  "f-1": "Friend One",
  "f-2": "Friend Two",
  "f-3": "Friend Three",
  "f-4": "Friend Four",
  "f-5": "Friend Five",
  "f-6": "Friend Six",
};

export const profiles: Record<string, UserProfile> = {
  [ME_ID]: { userId: ME_ID, name: ME_NAME },
  ...Object.fromEntries(
    [...GROUP_MEMBER_IDS.map((id) => [id, { userId: id, name: MEMBER_NAMES[id] }]),
      ...FRIEND_IDS.map((id) => [id, { userId: id, name: FRIEND_NAMES[id] }])],
  ),
};

export const publicUser = (userId: string): PublicUser => ({
  userId,
  name: profiles[userId]?.name ?? userId,
});

export const messageId = (roomId: string, n: number): string =>
  `${roomId}-msg-${String(n).padStart(3, "0")}`;

const roomTimeOffset: Record<string, number> = {
  "room-1": 0,
  "room-2": 1,
  "room-3": 2,
  "room-4": 3,
  "room-5": 4,
  "room-6": 5,
  "room-7": 6,
  "room-8": 7,
};

export const makeMessage = (
  roomId: string,
  n: number,
  senderId: string,
  overrides: Partial<MessageWithSender> = {},
): MessageWithSender => ({
  messageId: messageId(roomId, n),
  roomId,
  senderId,
  content: `Message ${n} in ${roomId}`,
  isRecalled: false,
  sentAt: new Date(BASE_TIME + (roomTimeOffset[roomId] ?? 9) * 3_600_000 + n * 60_000),
  sender: publicUser(senderId),
  mentions: [],
  ...overrides,
});

const groupSender = (n: number): string =>
  n % 4 === 0 ? ME_ID : GROUP_MEMBER_IDS[n % GROUP_MEMBER_IDS.length];

const buildGroupMessages = (roomId: string, count: number): MessageWithSender[] =>
  Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return makeMessage(roomId, n, groupSender(n), {
      // A few replies so hydrateReplyTargets does real work.
      ...(n % 10 === 0 && n > 10 ? { replyToId: messageId(roomId, n - 5) } : {}),
    });
  });

const buildPrivateMessages = (roomId: string, friendId: string, count: number): MessageWithSender[] =>
  Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return makeMessage(roomId, n, n % 2 === 0 ? ME_ID : friendId);
  });

/** Oldest-first message log per room. */
export const messagesByRoom: Record<string, MessageWithSender[]> = {
  "room-1": buildGroupMessages("room-1", 40),
  "room-2": buildGroupMessages("room-2", 30),
  ...Object.fromEntries(
    FRIEND_IDS.map((friendId, i) => {
      const roomId = `room-${3 + i}`;
      return [roomId, buildPrivateMessages(roomId, friendId, 10)];
    }),
  ),
};

const lastMessageOf = (roomId: string): MessageWithSender => {
  const log = messagesByRoom[roomId];
  return log[log.length - 1];
};

const roomBase = {
  requireApproval: false,
  viewHistory: true,
  isArchived: false,
  isReadonly: false,
  isHidden: false,
  createdAt: new Date(BASE_TIME - 86_400_000),
};

const summaryLatest = (roomId: string) => {
  const last = lastMessageOf(roomId);
  return {
    messageId: last.messageId,
    senderId: last.senderId,
    content: last.content,
    sentAt: last.sentAt,
  };
};

export const roomSummaries: RoomSummary[] = [
  {
    ...roomBase,
    roomId: "room-1",
    type: "group",
    name: "Alpha Group",
    inviteCode: "ALPHA123",
    latestMessage: summaryLatest("room-1"),
    unreadCount: 0,
    lastReadId: messageId("room-1", 40),
    role: "owner",
  },
  {
    ...roomBase,
    roomId: "room-2",
    type: "group",
    name: "Beta Group",
    inviteCode: "BETA1234",
    latestMessage: summaryLatest("room-2"),
    unreadCount: 3,
    lastReadId: messageId("room-2", 27),
    role: "member",
  },
  ...FRIEND_IDS.map((friendId, i): RoomSummary => {
    const roomId = `room-${3 + i}`;
    return {
      ...roomBase,
      roomId,
      type: "private",
      latestMessage: summaryLatest(roomId),
      unreadCount: 0,
      isOnline: i < 3,
      otherMemberId: friendId,
      lastReadId: messageId(roomId, 10),
      role: "member",
    };
  }),
];

const groupMembers = (roomId: string, myRole: RoomMember["role"]): RoomMember[] => [
  {
    roomId,
    userId: ME_ID,
    role: myRole,
    isMuted: false,
    isHidden: false,
    lastReadId: roomId === "room-2" ? messageId(roomId, 27) : messageId(roomId, 40),
    joinTime: new Date(BASE_TIME - 86_400_000),
  },
  ...GROUP_MEMBER_IDS.map(
    (userId, i): RoomMember => ({
      roomId,
      userId,
      role: i === 0 && myRole !== "owner" ? "owner" : "member",
      isMuted: false,
      isHidden: false,
      // m-1 has read everything: exercises the read-receipt avatar path.
      lastReadId: userId === "m-1" ? lastMessageOf(roomId).messageId : messageId(roomId, 5),
      joinTime: new Date(BASE_TIME - 86_400_000),
    }),
  ),
];

export const membersByRoom: Record<string, RoomMember[]> = {
  "room-1": groupMembers("room-1", "owner"),
  "room-2": groupMembers("room-2", "member"),
  ...Object.fromEntries(
    FRIEND_IDS.map((friendId, i) => {
      const roomId = `room-${3 + i}`;
      const members: RoomMember[] = [
        {
          roomId,
          userId: ME_ID,
          role: "member",
          isMuted: false,
          isHidden: false,
          lastReadId: messageId(roomId, 10),
          joinTime: new Date(BASE_TIME - 86_400_000),
        },
        {
          roomId,
          userId: friendId,
          role: "member",
          isMuted: false,
          isHidden: false,
          lastReadId: messageId(roomId, 10),
          joinTime: new Date(BASE_TIME - 86_400_000),
        },
      ];
      return [roomId, members];
    }),
  ),
};

export const folders: Folder[] = [
  {
    folderId: "folder-1",
    userId: ME_ID,
    name: "Work",
    createdAt: new Date(BASE_TIME - 86_400_000),
    roomIds: ["room-3", "room-4"],
  },
  {
    folderId: "folder-2",
    userId: ME_ID,
    name: "Social",
    createdAt: new Date(BASE_TIME - 86_400_000),
    roomIds: ["room-5"],
  },
];

export const myProfile: MyProfile = {
  userId: ME_ID,
  name: ME_NAME,
  email: "me@example.com",
  bio: "",
  lastActivity: new Date(BASE_TIME),
};

export const mySettings: UserSettings = {
  warningEnabled: false,
  warningDays: 0,
  language: "en",
  theme: "light",
  notifyDesktop: true,
  notifySound: true,
  roomOrder: {},
};

export const friendResponses: FriendResponse[] = FRIEND_IDS.map((friendId, i) => ({
  friend: publicUser(friendId),
  friendshipCreatedAt: new Date(BASE_TIME - 86_400_000),
  status: i < 3 ? "online" : "offline",
}));

export const friendRequestResponses: FriendRequestResponse[] = [
  {
    requesterId: "u-stranger",
    addresseeId: ME_ID,
    status: "pending",
    createdAt: new Date(BASE_TIME),
    requester: { userId: "u-stranger", name: "Stranger" },
  },
];

export const emergencyContacts: EmergencyContactResponse[] = [];
