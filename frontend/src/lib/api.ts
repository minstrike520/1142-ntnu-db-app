import type {
  Attachment,
  AuthResponse,
  EmergencyContactResponse,
  Folder as ApiFolder,
  FriendRequestResponse,
  FriendResponse,
  LoginRequest,
  MessageWithSender,
  MyProfile,
  RegisterRequest,
  Room,
  RoomMember,
  RoomSummary,
  SearchUserResult,
  UserProfile,
  UserSettings,
} from '@shared/types';

export const getApiBaseUrl = (): string => {
  const envUrl = process.env.NEXT_PUBLIC_API_URL;
  
  // Use dynamic string lookup on globalThis to prevent the build-time compiler from
  // statically evaluating and constant-folding the window checks.
  const w = typeof globalThis !== 'undefined' ? (globalThis as unknown as Record<string, { location: { hostname: string; protocol: string; port: string } }>)['win' + 'dow'] : undefined;
  
  if (w && w.location) {
    const hostname = w.location.hostname;
    const protocol = w.location.protocol;
    const port = w.location.port;
    
    // Prioritize dynamic resolution if we are on the standard ports.
    // In Docker Compose, frontend is exposed at port 3005, backend is at port 4005.
    // In local dev, frontend is exposed at port 3000, backend is at port 4000.
    if (port === '3005') {
      return `${protocol}//${hostname}:4005`;
    } else if (port === '3000') {
      return `${protocol}//${hostname}:4000`;
    }
    
    // If the envUrl is set and is NOT localhost, use it directly.
    if (envUrl && !envUrl.includes('localhost') && !envUrl.includes('127.0.0.1')) {
      return envUrl;
    }
    
    // Fallback: if accessed via a custom domain/host (like Tailscale funnel or tailscale IP)
    // and port is not 3005/3000, we check if it is not localhost.
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      return `${protocol}//${hostname}:4005`;
    }
  }
  
  return envUrl ?? 'http://localhost:4000';
};
const API_PREFIX = '/api/v1';

type UpdateMeRequest = Partial<Pick<MyProfile, 'name' | 'email' | 'bio' | 'avatarUrl'>> & {
  password?: string;
  currentPassword?: string;
};
type UpdateMySettingsRequest = Partial<
  Pick<UserSettings, 'warningEnabled' | 'warningDays' | 'language' | 'theme' | 'notifyDesktop' | 'notifySound' | 'roomOrder'>
>;

type CreateGroupRequest = {
  name: string;
  avatarUrl?: string;
};

type CreatePrivateRequest = {
  targetUserId: string;
};

type UpdateRoomRequest = Partial<
  Pick<Room, 'name' | 'avatarUrl' | 'requireApproval' | 'viewHistory' | 'isArchived'>
>;

type TransferOwnerResponse = {
  message: string;
};

type UpdateRoomMemberRequest = {
  role?: 'admin' | 'member';
  nickname?: string;
  isMuted?: boolean;
};

type RoomMemberMutationResponse = {
  message: string;
};

type ListMessagesRequest = {
  beforeId?: string;
  limit?: number;
};

type UploadAttachmentResponse = Attachment;

type EmergencyAlertResult = {
  alerted: boolean;
  recipients: string[];
  reason?: string;
};

type UpsertEmergencyContactRequest = {
  contactId: string;
  message: string;
};

type RequestOptions = {
  token?: string;
};

let activeAccessToken: string | null = null;
export const getActiveAccessToken = (): string | null => activeAccessToken;
export const setActiveAccessToken = (token: string | null): void => {
  activeAccessToken = token;
};

const buildUrl = (path: string): string => `${getApiBaseUrl()}${API_PREFIX}${path}`;
const resolveRequestUrl = (path: string): string => {
  if (path.startsWith('http')) return path;
  if (path.startsWith('/api/')) return `${getApiBaseUrl()}${path}`;
  return buildUrl(path);
};

const authHeaders = (token?: string): HeadersInit => {
  const actualToken = token ?? activeAccessToken;
  return actualToken ? { Authorization: `Bearer ${actualToken}` } : {};
};

export const refreshTokens = (): Promise<AuthResponse> =>
  requestJson<AuthResponse>('/auth/refresh', {
    method: 'POST',
  }).then((res) => {
    setActiveAccessToken(res.token);
    return res;
  });

// The refresh cookie is shared across tabs; two concurrent refreshes would
// trip the server's reuse detection and revoke every session. Serialize the
// refresh across tabs with the Web Locks API where available.
const runExclusiveRefresh = <T,>(task: () => Promise<T>): Promise<T> => {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    return navigator.locks.request('auth:refresh', task) as Promise<T>;
  }
  return task();
};

let isRefreshing = false;
let refreshSubscribers: { resolve: (token: string) => void; reject: (err: unknown) => void }[] = [];

const onTokenRefreshed = (token: string) => {
  refreshSubscribers.forEach((sub) => sub.resolve(token));
  refreshSubscribers = [];
};

const onRefreshFailed = (err: unknown) => {
  refreshSubscribers.forEach((sub) => sub.reject(err));
  refreshSubscribers = [];
};

const addRefreshSubscriber = (resolve: (token: string) => void, reject: (err: unknown) => void) => {
  refreshSubscribers.push({ resolve, reject });
};

const request = async (
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<Response> => {
  const headers = {
    ...authHeaders(options.token),
    ...init.headers,
  };

  const response = await fetch(resolveRequestUrl(path), {
    ...init,
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/auth/') && typeof window !== 'undefined') {
      if (!isRefreshing) {
        isRefreshing = true;
        runExclusiveRefresh(() => refreshTokens())
          .then((refreshResult) => {
            isRefreshing = false;
            setActiveAccessToken(refreshResult.token);
            window.dispatchEvent(
              new CustomEvent('auth:token-refreshed', { detail: refreshResult }),
            );
            onTokenRefreshed(refreshResult.token);
          })
          .catch((refreshErr) => {
            isRefreshing = false;
            onRefreshFailed(refreshErr);
            window.dispatchEvent(new Event('auth:token-expired'));
          });
      }

      return new Promise<Response>((resolve, reject) => {
        addRefreshSubscriber(
          (newToken) => {
            const newHeaders = {
              ...init.headers,
              Authorization: `Bearer ${newToken}`,
            };
            request(path, { ...init, headers: newHeaders }, { ...options, token: newToken })
              .then(resolve)
              .catch(reject);
          },
          (err) => {
            reject(err);
          },
        );
      });
    }

    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `Request failed with status ${response.status}`);
  }

  return response;
};

const requestJson = async <T>(
  path: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> => {
  const response = await request(path, init, options);

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
};

const withJsonBody = (body: unknown): Pick<RequestInit, 'body' | 'headers'> => ({
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

export const register = (data: RegisterRequest): Promise<AuthResponse> =>
  requestJson<AuthResponse>('/auth/register', {
    method: 'POST',
    ...withJsonBody(data),
  }).then((res) => {
    setActiveAccessToken(res.token);
    return res;
  });

export const login = (data: LoginRequest): Promise<AuthResponse> =>
  requestJson<AuthResponse>('/auth/login', {
    method: 'POST',
    ...withJsonBody(data),
  }).then((res) => {
    setActiveAccessToken(res.token);
    return res;
  });

export const logout = (token: string): Promise<void> =>
  requestJson<void>('/auth/logout', { method: 'POST' }, { token }).then(() => {
    setActiveAccessToken(null);
  });

export const getMe = (token: string): Promise<MyProfile> =>
  requestJson<MyProfile>('/users/me', {}, { token });

export const getUserProfile = (userId: string, token?: string): Promise<UserProfile> =>
  requestJson<UserProfile>(`/users/${userId}`, {}, { token });

export const updateMe = (token: string, data: UpdateMeRequest): Promise<MyProfile> =>
  requestJson<MyProfile>(
    '/users/me',
    {
      method: 'PATCH',
      ...withJsonBody(data),
    },
    { token },
  );

export const uploadAvatar = (token: string, file: File): Promise<MyProfile> => {
  const formData = new FormData();
  formData.append('file', file);

  return requestJson<MyProfile>(
    '/users/me/avatar',
    {
      method: 'POST',
      body: formData,
    },
    { token },
  );
};

export const deleteMe = (token: string): Promise<void> =>
  requestJson<void>('/users/me', { method: 'DELETE' }, { token });

export const getMySettings = (token: string): Promise<UserSettings> =>
  requestJson<UserSettings>('/users/me/settings', {}, { token });

export const updateMySettings = (
  token: string,
  data: UpdateMySettingsRequest,
): Promise<UserSettings> =>
  requestJson<UserSettings>(
    '/users/me/settings',
    {
      method: 'PATCH',
      ...withJsonBody(data),
    },
    { token },
  );

export const searchUsers = (
  token: string,
  params: { query: string; mode?: 'name' | 'userId' | 'email'; friendsOnly?: boolean },
): Promise<SearchUserResult[]> => {
  const qs = new URLSearchParams({ q: params.query });
  if (params.mode) qs.set('mode', params.mode);
  if (params.friendsOnly) qs.set('friendsOnly', 'true');
  return requestJson<SearchUserResult[]>(`/users?${qs.toString()}`, {}, { token });
};

export const listFriends = (token: string): Promise<FriendResponse[]> =>
  requestJson<FriendResponse[]>('/friends', {}, { token });

export const deleteFriend = (token: string, friendId: string): Promise<void> =>
  requestJson<void>(`/friends/${friendId}`, { method: 'DELETE' }, { token });

export const listFriendRequests = (token: string): Promise<FriendRequestResponse[]> =>
  requestJson<FriendRequestResponse[]>('/friend-requests', {}, { token });

export const sendFriendRequest = (
  token: string,
  targetUserId: string,
): Promise<FriendRequestResponse> =>
  requestJson<FriendRequestResponse>(
    '/friend-requests',
    {
      method: 'POST',
      ...withJsonBody({ targetUserId }),
    },
    { token },
  );

export const respondFriendRequest = (
  token: string,
  requesterId: string,
  status: 'accepted' | 'rejected',
): Promise<FriendRequestResponse | { status: 'rejected' }> =>
  requestJson<FriendRequestResponse | { status: 'rejected' }>(
    `/friend-requests/${requesterId}`,
    {
      method: 'PATCH',
      ...withJsonBody({ status }),
    },
    { token },
  );

export const getBlockedUsers = (token: string): Promise<{userId: string, name: string, email: string, avatarUrl?: string}[]> =>
  requestJson<{userId: string, name: string, email: string, avatarUrl?: string}[]>('/blocks', { method: 'GET' }, { token });

export const blockUser = (token: string, targetUserId: string): Promise<{ status: 'blocked' }> =>
  requestJson<{ status: 'blocked' }>(
    '/blocks',
    {
      method: 'POST',
      ...withJsonBody({ targetUserId }),
    },
    { token },
  );

export const unblockUser = (token: string, blockedId: string): Promise<void> =>
  requestJson<void>(`/blocks/${blockedId}`, { method: 'DELETE' }, { token });

export const listRooms = (token: string): Promise<RoomSummary[]> =>
  requestJson<RoomSummary[]>('/rooms', {}, { token });

export const createGroup = (token: string, data: CreateGroupRequest): Promise<Room> =>
  requestJson<Room>(
    '/rooms',
    {
      method: 'POST',
      ...withJsonBody({ ...data, type: 'group' }),
    },
    { token },
  );

export const createPrivateRoom = (token: string, data: CreatePrivateRequest): Promise<Room> =>
  requestJson<Room>(
    '/rooms',
    {
      method: 'POST',
      ...withJsonBody({ ...data, type: 'private' }),
    },
    { token },
  );

export const joinRoomByCode = (token: string, inviteCode: string): Promise<Room> =>
  requestJson<Room>(
    '/rooms/join',
    {
      method: 'POST',
      ...withJsonBody({ inviteCode }),
    },
    { token },
  );

export const updateRoom = (
  token: string,
  roomId: string,
  data: UpdateRoomRequest,
): Promise<Room> =>
  requestJson<Room>(
    `/rooms/${roomId}`,
    {
      method: 'PATCH',
      ...withJsonBody(data),
    },
    { token },
  );

export const uploadRoomAvatar = (token: string, roomId: string, file: File): Promise<Room> => {
  const formData = new FormData();
  formData.append('file', file);

  return requestJson<Room>(
    `/rooms/${roomId}/avatar`,
    {
      method: 'POST',
      body: formData,
    },
    { token },
  );
};

export const deleteRoom = (token: string, roomId: string): Promise<void> =>
  requestJson<void>(`/rooms/${roomId}`, { method: 'DELETE' }, { token });

export const leaveRoom = (token: string, roomId: string): Promise<void> =>
  requestJson<void>(`/rooms/${roomId}/members/me`, { method: 'DELETE' }, { token });

export const listRoomMembers = (token: string, roomId: string): Promise<RoomMember[]> =>
  requestJson<RoomMember[]>(`/rooms/${roomId}/members`, {}, { token });

export const approveRoomMember = (
  token: string,
  roomId: string,
  userId: string,
): Promise<RoomMemberMutationResponse> =>
  requestJson<RoomMemberMutationResponse>(
    `/rooms/${roomId}/members/${userId}`,
    {
      method: 'PATCH',
      ...withJsonBody({ status: 'approved' }),
    },
    { token },
  );

export const updateRoomMember = (
  token: string,
  roomId: string,
  userId: string,
  data: UpdateRoomMemberRequest,
): Promise<RoomMemberMutationResponse> =>
  requestJson<RoomMemberMutationResponse>(
    `/rooms/${roomId}/members/${userId}`,
    {
      method: 'PATCH',
      ...withJsonBody(data),
    },
    { token },
  );

export const kickRoomMember = (token: string, roomId: string, userId: string): Promise<void> =>
  requestJson<void>(`/rooms/${roomId}/members/${userId}`, { method: 'DELETE' }, { token });

export const transferRoomOwner = (
  token: string,
  roomId: string,
  ownerId: string,
): Promise<TransferOwnerResponse> =>
  requestJson<TransferOwnerResponse>(
    `/rooms/${roomId}`,
    {
      method: 'PATCH',
      ...withJsonBody({ ownerId }),
    },
    { token },
  );

export const listMessages = (
  token: string,
  roomId: string,
  params: ListMessagesRequest = {},
): Promise<MessageWithSender[]> => {
  const query = new URLSearchParams();
  if (params.beforeId) query.set('before_id', params.beforeId);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : '';

  return requestJson<MessageWithSender[]>(`/rooms/${roomId}/messages${suffix}`, {}, { token });
};

export const listFolders = (token: string): Promise<ApiFolder[]> =>
  requestJson<ApiFolder[]>('/folders', {}, { token });

export const createFolder = (token: string, name: string): Promise<ApiFolder> =>
  requestJson<ApiFolder>(
    '/folders',
    {
      method: 'POST',
      ...withJsonBody({ name }),
    },
    { token },
  );

export const deleteFolder = (token: string, folderId: string): Promise<void> =>
  requestJson<void>(`/folders/${folderId}`, { method: 'DELETE' }, { token });

export const renameFolder = (token: string, folderId: string, name: string): Promise<ApiFolder> =>
  requestJson<ApiFolder>(
    `/folders/${folderId}`,
    {
      method: 'PATCH',
      ...withJsonBody({ name }),
    },
    { token },
  );

export const updateFolderRooms = (
  token: string,
  folderId: string,
  roomIds: string[],
): Promise<{ success: boolean }> =>
  requestJson<{ success: boolean }>(
    `/folders/${folderId}/rooms`,
    {
      method: 'PUT',
      ...withJsonBody({ roomIds }),
    },
    { token },
  );

export const uploadAttachment = async (
  token: string,
  file: File,
): Promise<UploadAttachmentResponse> => {
  const formData = new FormData();
  formData.append('file', file);

  return requestJson<UploadAttachmentResponse>(
    '/attachments',
    {
      method: 'POST',
      body: formData,
    },
    { token },
  );
};

export const attachmentDownloadUrl = (fileUrl: string): string =>
  resolveRequestUrl(fileUrl);

export const downloadAttachment = async (fileUrl: string, filename: string): Promise<void> => {
  const response = await request(fileUrl);
  const blob = await response.blob();
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = downloadUrl;
  link.download = filename;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0);
};


export const listEmergencyContacts = (token: string): Promise<EmergencyContactResponse[]> =>
  requestJson<EmergencyContactResponse[]>('/users/me/emergency-contacts', {}, { token });

export const upsertEmergencyContact = (
  token: string,
  data: UpsertEmergencyContactRequest,
): Promise<EmergencyContactResponse> =>
  requestJson<EmergencyContactResponse>(
    '/users/me/emergency-contacts',
    {
      method: 'POST',
      ...withJsonBody(data),
    },
    { token },
  );

export const deleteEmergencyContact = (token: string, contactId: string): Promise<{ success: boolean }> =>
  requestJson<{ success: boolean }>(
    `/users/me/emergency-contacts/${contactId}`,
    { method: 'DELETE' },
    { token },
  );

export const checkEmergencyInactivity = (
  token: string,
  now?: string,
): Promise<EmergencyAlertResult> =>
  requestJson<EmergencyAlertResult>(
    '/users/me/emergency-alert/check-inactivity',
    {
      method: 'POST',
      ...withJsonBody(now ? { now } : {}),
    },
    { token },
  );
