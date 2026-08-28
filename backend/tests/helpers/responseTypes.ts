export interface AuthUser {
  userId: string;
  name: string;
}

export interface AuthResponse {
  token: string;
  accessToken?: string;
  user: AuthUser;
}

export interface ApiErrorResponse {
  code: string;
  message?: string;
}

export interface AdminHealthResponse {
  status: string;
  code?: string;
}

export interface UserProfileResponse extends AuthUser {
  email?: string;
}

export interface RoomResponse {
  roomId: string;
  type?: string;
  name?: string;
  avatarUrl?: string;
  inviteCode?: string;
  requireApproval?: boolean;
  isMember?: boolean;
  isPending?: boolean;
  roomHash?: string;
  unreadCount?: number;
}

export interface RoomListEntry extends RoomResponse {
  roomId: string;
}

export interface MessageResponse {
  messageId: string;
  code?: string;
  roomId?: string;
  content: string;
  messageSequence?: number;
  changeSequence?: number;
  revision: number;
  isRecalled?: boolean;
}

export interface SyncResponse {
  changes: Array<{
    changeSequence: number;
    messageSequence: number;
    revision: number;
    changeType: string;
  }>;
}

export interface ReadPositionResponse {
  readPosition: number;
}

export interface FriendRequestResponse {
  status: string;
  requester?: AuthUser;
  requesterId?: string;
  addressee?: AuthUser;
  addresseeId?: string;
}

export interface PendingFriendRequestResponse extends FriendRequestResponse {
  requester: AuthUser;
}

export interface FriendListEntry {
  friend: AuthUser;
}

export type BlockedUser = AuthUser;

export interface AttachmentResponse {
  attachmentId: string;
  fileType?: string;
  originalName?: string;
  fileUrl?: string;
}

export interface EmergencyContactResponse {
  contactId: string;
  message: string;
  contact: AuthUser;
  warningEnabled?: boolean;
  warningDays?: number;
}

export interface FolderResponse {
  folderId: string;
  name: string;
  description?: string;
  roomIds?: string[];
}

export interface RoomMemberResponse {
  userId: string;
  role: string;
}

export interface AdminMetricsResponse {
  requests: {
    totalRequests: number;
    statusClasses: Record<string, number>;
    latency: Record<string, number>;
  };
  process: {
    memory: { rssBytes: number };
    uptimeSeconds: number;
    cpu: { percent: number | null };
  };
  at: number;
}

export interface AdminLogsResponse {
  retained: number;
  capacity: number;
  entries: Array<{ msg: string }>;
}

export interface AdminSlowQueriesResponse {
  thresholdMs: number;
  retained: number;
  capacity: number;
  queries: Array<{ query: string; durationMs: number; at: number }>;
}
