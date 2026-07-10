/**
 * Shared API contract — matches api-documentation.md and relation-schema.md.
 *
 * Column-naming convention:
 *   - Database:   snake_case  (user_id, room_id, sent_at, join_time)
 *   - TypeScript: camelCase  (userId, roomId, sentAt, joinTime)
 *   - Repositories own the snake_case → camelCase mapping; nothing above the
 *     repo layer sees snake_case.
 *
 * v1 implementation scope: users, rooms, messages, room_members, folders,
 *   attachments, friendships, blocks, emergency_contacts, message_mentions
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Full internal user record — never sent to the client. */
export interface User {
  userId: string;
  name: string;
  email: string;
  /** bcrypt hash; never included in API responses. */
  passwordHash: string;
  bio?: string;
  avatarUrl?: string;
  language: string;
  theme: 'light' | 'dark';
  notifyDesktop: boolean;
  notifySound: boolean;
  warningEnabled: boolean;
  warningDays: number;
  lastActivity: Date;
  createdAt: Date;
  deletedAt?: Date | null;
  roomOrder?: Record<string, string[]>;
}

/** Safe public projection of a user — no credentials. */
export interface PublicUser {
  userId: string;
  name: string;
  avatarUrl?: string;
}

/** Extended projection returned by the user-search endpoint.
 * email is omitted when mode=name to prevent email enumeration via fuzzy search. */
export interface SearchUserResult extends PublicUser {
  email?: string;
}

export interface UserProfile {
  userId: string;
  name: string;
  bio?: string;
  avatarUrl?: string;
}

export interface MyProfile extends UserProfile {
  email: string;
  lastActivity: Date;
}

export interface UserSettings {
  warningEnabled: boolean;
  warningDays: number;
  language: string;
  theme: 'light' | 'dark';
  notifyDesktop: boolean;
  notifySound: boolean;
  roomOrder?: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export type RoomType = 'private' | 'group';

export interface Room {
  roomId: string;
  type: RoomType;
  /** Required when type === 'group'. */
  name?: string;
  avatarUrl?: string;
  inviteCode?: string;
  requireApproval: boolean;
  viewHistory: boolean;
  isArchived: boolean;
  isReadonly: boolean;
  createdAt: Date;
}

export interface RoomSummary extends Room {
  latestMessage?: Pick<Message, 'messageId' | 'senderId' | 'content' | 'sentAt'>;
  unreadCount: number;
  isOnline?: boolean;
  otherMemberId?: string;
  lastReadId?: string;
  role?: RoomMemberRole;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface Message {
  messageId: string;
  roomId: string;
  /** null when the sender's account has been deleted (SET NULL on FK). */
  senderId: string | null;
  content: string;
  replyToId?: string;
  isRecalled: boolean;
  sentAt: Date;
  attachments?: Attachment[];
}

/** Message enriched with the sender's public profile (via JOIN). */
export interface MessageWithSender extends Message {
  sender: PublicUser | null;
  mentions?: string[]; // Array of mentioned user IDs
}

// ---------------------------------------------------------------------------
// Room membership
// ---------------------------------------------------------------------------

export type RoomMemberRole = 'owner' | 'admin' | 'member' | 'pending';

export interface RoomMember {
  roomId: string;
  userId: string;
  role: RoomMemberRole;
  nickname?: string;
  isMuted: boolean;
  lastReadId?: string;
  joinTime: Date;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  email: string;
  name: string;
  password: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface JwtPayload {
  userId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// API error shape (used by REST responses and Socket.IO error events)
// ---------------------------------------------------------------------------

export interface ApiError {
  statusCode: number;
  message: string;
  /** Optional machine-readable error code, e.g. "NOT_FOUND", "CONFLICT". */
  code?: string;
}

// ---------------------------------------------------------------------------
// Socket.IO event maps — matches api-documentation.md Section 2
// ---------------------------------------------------------------------------

export interface ClientToServerEvents {
  join_room:      (payload: { roomId: string }) => void;
  leave_room:     (payload: { roomId: string }) => void;
  send_message:   (payload: { roomId: string; content: string; replyTo?: string; attachmentIds?: string[] }) => void;
  recall_message: (payload: { messageId: string }) => void;
  update_message: (payload: { roomId: string; messageId: string; content: string }) => void;
  typing:         (payload: { roomId: string; isTyping: boolean }) => void;
  read_receipt:   (payload: { roomId: string; messageId: string }) => void;
}

export interface ServerToClientEvents {
  new_message:      (payload: MessageWithSender) => void;
  message_recalled: (payload: { messageId: string }) => void;
  message_updated:  (payload: MessageWithSender) => void;
  user_typing:      (payload: { roomId: string; userId: string; isTyping: boolean }) => void;
  read_update:      (payload: { roomId: string; userId: string; messageId: string }) => void;
  room_update:      (payload: { type: string; roomId: string; data: any }) => void;
  friend_request:   (payload: FriendRequest) => void;
  emergency_alert:  (payload: { userId: string; message: string }) => void;
  error:            (payload: ApiError) => void;
  user_status:      (payload: { userId: string; status: 'online' | 'offline' }) => void;
}

// ---------------------------------------------------------------------------
// Additional Entities
// ---------------------------------------------------------------------------

export type FriendshipStatus = 'pending' | 'accepted';

export interface FriendRequestResponse {
  requesterId: string;
  addresseeId: string;
  status: FriendshipStatus;
  createdAt: Date;
  requester?: PublicUser;
  addressee?: PublicUser;
}

export interface FriendResponse {
  friend: PublicUser;
  friendshipCreatedAt: Date;
  status?: 'online' | 'offline';
}

/** Payload for the `friend_request` Socket.IO server event. */
export interface FriendRequest {
  requesterId: string;
  addresseeId: string;
  status: FriendshipStatus;
  createdAt: Date;
}

export interface Folder {
  folderId: string;
  userId: string;
  name: string;
  createdAt: Date;
  roomIds: string[];
}

export interface EmergencyContactResponse {
  userId: string;
  contactId: string;
  message: string;
  createdAt: Date;
  contact?: Pick<PublicUser, 'name' | 'avatarUrl'> & {
    email?: string;
  };
}

export interface Attachment {
  attachmentId: string;
  messageId?: string;
  uploadedBy: string;
  fileUrl: string;
  fileType: string;
  originalName: string;
  uploadedAt: Date;
}
