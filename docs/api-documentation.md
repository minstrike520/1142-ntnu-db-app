# API Documentation

This document defines the RESTful API and Socket.IO real-time communication interface provided by the backend.

---

## API Overview

### RESTful API

| Category | Method | Path | Auth Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| **Authentication & Profile** | `POST` | [`/auth/register`](#post-authregister) | No | Register a new account |
| | `POST` | [`/auth/login`](#post-authlogin) | No | User login |
| | `POST` | [`/auth/refresh`](#post-authrefresh) | No | Refresh access token |
| | `POST` | [`/auth/logout`](#post-authlogout) | Yes | User logout |
| | `GET` | [`/users/me`](#get-usersme) | Yes | Get profile of current user |
| | `GET` | [`/users/:id`](#get-usersid) | Yes | Get public profile of specified user |
| | `PATCH` | [`/users/me`](#patch-usersme) | Yes | Update profile of current user |
| | `GET` | [`/users/me/settings`](#get-usersmesettings) | Yes | Get settings of current user |
| | `PATCH` | [`/users/me/settings`](#patch-usersmesettings) | Yes | Update settings of current user |
| | `DELETE` | [`/users/me`](#delete-usersme) | Yes | Delete account of current user (soft delete) |
| | `GET` | [`/users`](#get-users) | Yes | Search users |
| **Friends & Blocks** | `GET` | [`/friends`](#get-friends) | Yes | Get friends list |
| | `DELETE` | [`/friends/:id`](#delete-friendsid) | Yes | Remove friend relationship |
| | `GET` | [`/friend-requests`](#get-friend-requests) | Yes | Get pending friend requests |
| | `POST` | [`/friend-requests`](#post-friend-requests) | Yes | Send friend request |
| | `PATCH` | [`/friend-requests/:id`](#patch-friend-requestsid) | Yes | Respond to friend request |
| | `POST` | [`/blocks`](#post-blocks) | Yes | Block user |
| | `DELETE` | [`/blocks/:id`](#delete-blocksid) | Yes | Unblock user |
| **Chat Rooms** | `GET` | [`/rooms`](#get-rooms) | Yes | Get rooms list and summaries |
| | `POST` | [`/rooms`](#post-rooms) | Yes | Create room (private or group) |
| | `GET` | [`/rooms/:id`](#get-roomsid) | Yes | Get specified room details |
| | `PATCH` | [`/rooms/:id`](#patch-roomsid) | Yes | Update room settings or transfer ownership |
| | `POST` | [`/rooms/:id/members`](#post-roomsidmembers) | Yes | Join room via invite code |
| | `DELETE` | [`/rooms/:id/members/me`](#delete-roomsidmembersme) | Yes | Leave room |
| | `DELETE` | [`/rooms/:id`](#delete-roomsid) | Yes | Archive room (Owner only) |
| **Member Management** | `GET` | [`/rooms/:id/members`](#get-roomsidmembers) | Yes | Get room members list |
| | `PATCH` | [`/rooms/:id/members/:userId`](#patch-roomsidmembersuserid) | Yes | Approve member join or update member role/nickname |
| | `DELETE` | [`/rooms/:id/members/:userId`](#delete-roomsidmembersuserid) | Yes | Kick member (Owner or Admin only) |
| **Messages & Attachments** | `GET` | [`/rooms/:roomId/messages`](#get-roomsroomidmessages) | Yes | Get room message history (paginated) |
| | `POST` | [`/rooms/:roomId/messages`](#post-roomsroomidmessages) | Yes | Create a durable message command |
| | `PATCH` | [`/rooms/:roomId/messages/:messageId`](#patch-roomsroomidmessagesmessageid) | Yes | Edit a message with optimistic concurrency |
| | `POST` | [`/rooms/:roomId/messages/:messageId/recall`](#post-roomsroomidmessagesmessageidrecall) | Yes | Recall a message with optimistic concurrency |
| | `PUT` | [`/rooms/:roomId/read-position`](#put-roomsroomidread-position) | Yes | Advance the member read position |
| **Recovery** | `GET` | [`/sync`](#get-sync) | Yes | Recover durable message changes after a cursor |
| | `POST` | [`/attachments`](#post-attachments) | Yes | Upload attachment file |
| | `GET` | [`/attachments/:id`](#get-attachmentsid) | Yes | Download attachment file |
| **Folders** | `GET` | [`/folders`](#get-folders) | Yes | Get folders list |
| | `POST` | [`/folders`](#post-folders) | Yes | Create new folder |
| | `DELETE` | [`/folders/:id`](#delete-foldersid) | Yes | Delete folder |
| | `PUT` | [`/folders/:id/rooms`](#put-foldersidrooms) | Yes | Update rooms associated with folder |
| **Emergency Contacts** | `GET` | [`/users/me/emergency-contacts`](#get-usersmeemergency-contacts) | Yes | Get emergency contacts list |
| | `POST` | [`/users/me/emergency-contacts`](#post-usersmeemergency-contacts) | Yes | Add or update emergency contact |
| | `DELETE` | [`/users/me/emergency-contacts/:contactId`](#delete-usersmeemergency-contactscontactid) | Yes | Delete emergency contact |
| | `POST` | [`/users/me/emergency-alert/check-inactivity`](#post-usersmeemergency-alertcheck-inactivity) | Yes | Check inactivity to trigger alert automatically |

### Socket.IO Real-Time Communication

Socket.IO is a server-to-client event transport. Durable commands are REST
requests so authentication, `Idempotency-Key`, `If-Match`, transactions and
retries share one contract. The server derives room subscriptions from active
membership when a socket connects.

| Type | Event Name | Auth Required | Description |
| :--- | :--- | :--- | :--- |
| | `typing` | Yes (On connection) | Broadcast typing state to other room members |
| **Server-to-Client** | `new_message` | Yes (On connection) | Receive new message notification (including mentions) |
| | `message_recalled` | Yes (On connection) | Message has been recalled by the sender |
| | `user_typing` | Yes (On connection) | Typing state changes of other members |
| | `read_update` | Yes (On connection) | Read receipt updates of other members |
| | `room_update` | Yes (On connection) | Room settings changes, member changes, or kick notifications. See [room_update subtypes](#room_update-subtypes). |
| | `friend_request` | Yes (On connection) | Real-time notification for friend request status changes (sent, accepted, rejected) |
| | `user_status` | Yes (On connection) | Online/offline presence change of a friend |
| | `emergency_alert` | Yes (On connection) | Receive emergency alert notification from contact |
| | `error` | Yes (On connection) | Error report for failed event processing |

---

## 0. General Rules

### Local Integration Environment

Docker Compose exposes the following host ports:
- **Frontend App**: `http://localhost:3005` (container port `3000`)
- **Backend API / Socket Server**: `http://localhost:4005` (container port `4000`)
- **PostgreSQL Database**: `localhost:5435` (container port `5432`)

When connecting the frontend to the backend, configure the environment variable:
```env
NEXT_PUBLIC_API_URL=http://localhost:4005
```

### Base URL

All REST API paths start with `/api/v1`.

### Authentication

Except for `POST /auth/register`, `POST /auth/login`, and `POST /auth/refresh`, all endpoints require authentication:

1. **Bearer Token**: The client must include `Authorization: Bearer <token>` in the Request Header (where `<token>` is the access token returned after successful registration, login, or refresh).
2. **HttpOnly Cookie (Refresh Token)**: After successful login or registration, the server automatically sets a Cookie named `refresh_token` in the browser. When the access token expires, a new access token can be obtained by sending a `POST /auth/refresh` request, which automatically includes this Cookie.

Access tokens expire in `15m` by default (configurable via `JWT_EXPIRES_IN`). Refresh tokens expire in `7` days by default (configurable via `JWT_REFRESH_EXPIRES_IN_DAYS`).

### Error Response Format

All errors return the following JSON structure:

```json
{
  "statusCode": 400,
  "message": "Human-readable description",
  "code": "MACHINE_READABLE_CODE"
}
```

| `code` | `statusCode` | Description |
| :--- | :---: | :--- |
| _(No code)_ | 401 | Missing or invalid token |
| `VALIDATION_ERROR` | 400 | Invalid request parameters |
| `NOT_FOUND` | 404 | Resource not found |
| `FORBIDDEN` | 403 | Forbidden / insufficient permissions |
| `CONFLICT` | 409 | Resource conflict (e.g., duplicate friend request) |
| `INTERNAL_ERROR` | 500 | Internal server error |

---

## 1. Shared Types

#### PublicUser
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `userId` | UUID | Unique user identifier |
  | `name` | String | Username |
  | `avatarUrl` | String \| null | User avatar URL |
- **Example**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "Alex",
    "avatarUrl": "https://example.com/avatar.png"
  }
  ```

#### UserProfile
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `userId` | UUID | Unique user identifier |
  | `name` | String | Username |
  | `bio` | String \| null | Biography |
  | `avatarUrl` | String \| null | User avatar URL |
- **Example**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "Alex",
    "bio": "Hello, this is my bio.",
    "avatarUrl": "https://example.com/avatar.png"
  }
  ```

#### MyProfile
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `userId` | UUID | Unique user identifier |
  | `name` | String | Username |
  | `email` | String | Email address |
  | `bio` | String \| null | Biography |
  | `avatarUrl` | String \| null | User avatar URL |
- **Example**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "Alex",
    "email": "alex@example.com",
    "bio": "Hello, this is my bio.",
    "avatarUrl": "https://example.com/avatar.png"
  }
  ```

#### UserSettings
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `warningEnabled` | Boolean | Whether emergency contact mode is enabled |
  | `warningDays` | Integer | Days of inactivity before alert, minimum 0 |
  | `language` | String | Language preference, e.g., 'zh-TW', 'en' |
  | `theme` | String | UI theme, 'light' or 'dark' |
  | `notifyDesktop` | Boolean | Whether desktop notifications are enabled |
  | `notifySound` | Boolean | Whether sound notifications are enabled |
- **Example**:
  ```json
  {
    "warningEnabled": false,
    "warningDays": 3,
    "language": "zh-TW",
    "theme": "dark",
    "notifyDesktop": true,
    "notifySound": true
  }
  ```

#### AuthResponse
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `token` | String | Access token |
  | `user` | Object | `PublicUser` object |
- **Example**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "Alex",
      "avatarUrl": "https://example.com/avatar.png"
    }
  }
  ```

#### Room
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `roomId` | UUID | Unique chat room identifier |
  | `type` | String | Room type, 'group' or 'private' |
  | `name` | String \| null | Room name (group rooms only) |
  | `avatarUrl` | String \| null | Room avatar URL |
  | `inviteCode` | String \| null | Invite code (group rooms only) |
  | `requireApproval` | Boolean | Whether joining requires approval |
  | `viewHistory` | Boolean | Whether new members can view historical messages |
  | `isArchived` | Boolean | Whether archived (becomes read-only) |
  | `createdAt` | String | Creation timestamp |
- **Example**:
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "type": "group",
    "name": "Project Discussion Group",
    "avatarUrl": "https://example.com/room-avatar.png",
    "inviteCode": "JOIN123",
    "requireApproval": false,
    "viewHistory": true,
    "isArchived": false,
    "createdAt": "2026-06-14T22:18:13Z"
  }
  ```

#### RoomSummary
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `roomId` | UUID | Unique chat room identifier |
  | `type` | String | Room type, 'group' or 'private' |
  | `name` | String \| null | Room name |
  | `avatarUrl` | String \| null | Room avatar URL |
  | `inviteCode` | String \| null | Invite code |
  | `requireApproval` | Boolean | Whether joining requires approval |
  | `viewHistory` | Boolean | Whether new members can view history |
  | `isArchived` | Boolean | Whether archived |
  | `createdAt` | String | Creation timestamp |
  | `latestMessage` | Object \| null | Summary of the latest message, null if none |
  | `unreadCount` | Number | Number of unread messages |
  | `role` | String \| null | The caller's role in this room ('owner', 'admin', 'member', 'pending') |
- **Example**:
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "type": "group",
    "name": "Project Discussion Group",
    "avatarUrl": "https://example.com/room-avatar.png",
    "inviteCode": "JOIN123",
    "requireApproval": false,
    "viewHistory": true,
    "isArchived": false,
    "createdAt": "2026-06-14T22:18:13Z",
    "latestMessage": {
      "messageId": "9f9a9b9c-9d9e-9f9a-9b9c-9d9e9f9a9b9c",
      "senderId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "content": "Good evening everyone",
      "sentAt": "2026-06-14T22:15:00Z"
    },
    "unreadCount": 2
  }
  ```

#### RoomInvitePreview
- **Description**: Read-only preview of a group room resolved from an invite code, shown before the caller confirms joining. Returned by `GET /rooms/invite/:code`.
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `roomId` | UUID | Unique chat room identifier |
  | `name` | String (optional) | Group name. Omitted from the response when unset |
  | `avatarUrl` | String (optional) | Group avatar URL. Omitted from the response when the group has no avatar |
  | `requireApproval` | Boolean | Whether joining requires owner/admin approval |
  | `isMember` | Boolean | Whether the caller already has a membership row, including a pending one |
  | `isPending` | Boolean | Whether the caller has already requested to join and is awaiting approval |
- **Example**:
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "name": "Project Discussion Group",
    "avatarUrl": "https://example.com/room-avatar.png",
    "requireApproval": false,
    "isMember": false,
    "isPending": false
  }
  ```
- **Example (group without an avatar)**: optional fields are absent rather than `null`.
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "name": "Project Discussion Group",
    "requireApproval": false,
    "isMember": false,
    "isPending": false
  }
  ```

#### RoomMember
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `roomId` | UUID | Unique chat room identifier |
  | `userId` | UUID | Unique member user identifier |
  | `role` | String | Member role: 'owner', 'admin', 'member', or 'pending' |
  | `nickname` | String \| null | Custom nickname in this room |
  | `isMuted` | Boolean | Whether muted |
  | `lastReadId` | UUID \| null | Last read message ID |
  | `joinTime` | String | Join timestamp |
- **Example**:
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "role": "admin",
    "nickname": "AlexNickname",
    "isMuted": false,
    "lastReadId": "9f9a9b9c-9d9e-9f9a-9b9c-9d9e9f9a9b9c",
    "joinTime": "2026-06-14T18:00:00Z"
  }
  ```

#### MessageWithSender
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `messageId` | UUID | Unique message identifier |
  | `roomId` | UUID | Unique chat room identifier |
  | `senderId` | UUID \| null | Sender ID, null if account is deleted |
  | `content` | String | Message content |
  | `replyToId` | UUID \| null | ID of the replied parent message |
  | `isRecalled` | Boolean | Whether recalled |
  | `sentAt` | String | Sent timestamp |
  | `attachments` | Array | Array of `Attachment` objects |
  | `sender` | Object \| null | Sender `PublicUser` data, null if deleted |
  | `mentions` | Array | Array of mentioned user IDs |
- **Example**:
  ```json
  {
    "messageId": "9f9a9b9c-9d9e-9f9a-9b9c-9d9e9f9a9b9c",
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "senderId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "content": "Alex mentioned @Bob",
    "replyToId": null,
    "isRecalled": false,
    "sentAt": "2026-06-14T22:15:00Z",
    "attachments": [],
    "sender": {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "Alex",
      "avatarUrl": "https://example.com/avatar.png"
    },
    "mentions": ["e4c08495-e224-4a67-b6dd-5958952d3d42"]
  }
  ```

#### FriendRequestResponse
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `requesterId` | UUID | Requester user ID |
  | `addresseeId` | UUID | Addressee user ID |
  | `status` | String | Status, 'pending' or 'accepted' |
  | `createdAt` | String | Creation timestamp |
  | `requester` | Object | Requester `PublicUser` data (optional) |
  | `addressee` | Object | Addressee `PublicUser` data (optional) |
- **Example**:
  ```json
  {
    "requesterId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "addresseeId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
    "status": "pending",
    "createdAt": "2026-06-14T20:00:00Z",
    "requester": {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "Alex",
      "avatarUrl": null
    }
  }
  ```

#### Attachment
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `attachmentId` | UUID | Unique attachment identifier |
  | `messageId` | UUID \| null | Associated message ID |
  | `fileUrl` | String | File URL |
  | `originalName` | String | Original filename |
  | `fileType` | String | MIME type |
  | `uploadedAt` | String | Uploaded timestamp |
- **Example**:
  ```json
  {
    "attachmentId": "f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5",
    "messageId": "9f9a9b9c-9d9e-9f9a-9b9c-9d9e9f9a9b9c",
    "fileUrl": "http://localhost:4005/api/v1/attachments/f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5",
    "originalName": "report.pdf",
    "fileType": "application/pdf",
    "uploadedAt": "2026-06-14T22:15:00Z"
  }
  ```

#### FriendResponse
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `friend` | Object | Friend `PublicUser` data |
  | `friendshipCreatedAt` | String | Friendship creation timestamp |
- **Example**:
  ```json
  {
    "friend": {
      "userId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
      "name": "Bob",
      "avatarUrl": "https://example.com/bob-avatar.png"
    },
    "friendshipCreatedAt": "2026-06-14T21:00:00Z"
  }
  ```

#### Folder
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `folderId` | UUID | Unique folder identifier |
  | `userId` | UUID | Owner user ID |
  | `name` | String | Folder name |
  | `createdAt` | String | Creation timestamp |
  | `roomIds` | Array | Array of chat room IDs inside the folder |
- **Example**:
  ```json
  {
    "folderId": "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1",
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "Work Chats",
    "createdAt": "2026-06-14T22:18:13Z",
    "roomIds": ["8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d"]
  }
  ```

#### ApiError
- **Field Details**:
  | Field | Type | Description |
  | :--- | :--- | :--- |
  | `statusCode` | Number | HTTP status code |
  | `message` | String | Error message |
  | `code` | String \| null | Error code (optional) |
- **Example**:
  ```json
  {
    "statusCode": 400,
    "message": "Invalid request parameters",
    "code": "VALIDATION_ERROR"
  }
  ```

---

## 2. RESTful API

### A. Authentication & Profile

#### `POST /auth/register`
- **Description**: Register a new account and log in automatically.
- **Authentication & Authorization**: No authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `email` | String | Yes | Email address (valid email format) |
  | `name` | String | Yes | Username (minimum 1 character) |
  | `password` | String | Yes | Password (minimum 8 characters) |
- **Request Example**:
  ```json
  {
    "email": "user@example.com",
    "name": "user123",
    "password": "securepassword123"
  }
  ```
- **Response**:
  - `201 Created`: Registration successful.
- **Response Example**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "user123",
      "avatarUrl": null
    }
  }
  ```

---

#### `POST /auth/login`
- **Description**: Log in with email and password.
- **Authentication & Authorization**: No authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `email` | String | Yes | Email address |
  | `password` | String | Yes | Password |
- **Request Example**:
  ```json
  {
    "email": "user@example.com",
    "password": "securepassword123"
  }
  ```
- **Response**:
  - `200 OK`: Login successful.
- **Response Example**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "user123",
      "avatarUrl": null
    }
  }
  ```

---

#### `POST /auth/refresh`
- **Description**: Refresh access token.
- **Authentication & Authorization**: No authentication required, but the browser must automatically include a valid `refresh_token` HttpOnly Cookie.
- **Response**:
  - `200 OK`: Token refreshed successfully.
- **Response Example**:
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "user123",
      "avatarUrl": null
    }
  }
  ```

---

#### `POST /auth/logout`
- **Description**: Log out, invalidating current access and refresh tokens.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `204 No Content`: Cookie cleared and token revoked in the database.

---

#### `GET /users/me`
- **Description**: Get full profile of the currently logged-in user.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Profile fetched successfully.
- **Response Example**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "user123",
    "email": "user@example.com",
    "bio": "I am a new user.",
    "avatarUrl": null
  }
  ```

---

#### `GET /users/:id`
- **Description**: Get public profile of the specified user.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Profile fetched successfully.
- **Response Example**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "user123",
    "bio": "I am a new user.",
    "avatarUrl": null
  }
  ```

---

#### `PATCH /users/me`
- **Description**: Update profile fields of the currently logged-in user.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `name` | String | No | Username (minimum 1 character) |
  | `email` | String | No | Email address |
  | `password` | String | No | Password (minimum 8 characters) |
  | `bio` | String | No | Biography |
  | `avatarUrl` | String | No | Avatar URL |
- **Request Example**:
  ```json
  {
    "bio": "Updated bio details"
  }
  ```
- **Response**:
  - `200 OK`: Update successful.
- **Response Example**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "user123",
    "email": "user@example.com",
    "bio": "Updated bio details",
    "avatarUrl": null
  }
  ```

---

#### `GET /users/me/settings`
- **Description**: Get preferences and emergency alert settings of the current user.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Settings fetched successfully.
- **Response Example**:
  ```json
  {
    "warningEnabled": false,
    "warningDays": 0,
    "language": "en",
    "theme": "light",
    "notifyDesktop": true,
    "notifySound": true
  }
  ```

---

#### `PATCH /users/me/settings`
- **Description**: Update preferences and alert settings of the current user.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `warningEnabled` | Boolean | No | Whether inactivity alert mode is enabled |
  | `warningDays` | Number | No | Days of inactivity before alert, minimum 0 |
  | `language` | String | No | Language preference |
  | `theme` | String | No | UI theme: 'light' or 'dark' |
  | `notifyDesktop` | Boolean | No | Whether desktop notifications are enabled |
  | `notifySound` | Boolean | No | Whether sound notifications are enabled |
- **Request Example**:
  ```json
  {
    "theme": "dark",
    "notifySound": false
  }
  ```
- **Response**:
  - `200 OK`: Update successful.
- **Response Example**:
  ```json
  {
    "warningEnabled": false,
    "warningDays": 0,
    "language": "en",
    "theme": "dark",
    "notifyDesktop": true,
    "notifySound": false
  }
  ```

---

#### `DELETE /users/me`
- **Description**: Terminate/delete account of the currently logged-in user (soft delete).
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `204 No Content`: Account successfully marked as deleted.

---

#### `GET /users`
- **Description**: Search for users in the system.
- **Authentication & Authorization**: Authentication required.
- **Query Parameters**:
  | Parameter | Required | Description |
  | :--- | :---: | :--- |
  | `q` | Yes | Search query (minimum 1 character) to filter name or ID |
- **Response**:
  - `200 OK`: Search successful.
- **Response Example**:
  ```json
  [
    {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "user123",
      "avatarUrl": null
    }
  ]
  ```

---

### B. Friends & Blocks

#### `GET /friends`
- **Description**: Get friends list of the current user.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Friends list fetched successfully.
- **Response Example**:
  ```json
  [
    {
      "friend": {
        "userId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
        "name": "Bob",
        "avatarUrl": null
      },
      "friendshipCreatedAt": "2026-06-14T21:00:00Z"
    }
  ]
  ```

---

#### `DELETE /friends/:id`
- **Description**: Remove friend relationship with the specified user. `:id` is the friend's user ID.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `204 No Content`: Friend relationship removed successfully.

---

#### `GET /friend-requests`
- **Description**: Get all pending friend requests of the current user (sent and received).
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Requests fetched successfully.
- **Response Example**:
  ```json
  [
    {
      "requesterId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "addresseeId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
      "status": "pending",
      "createdAt": "2026-06-14T20:00:00Z",
      "requester": {
        "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
        "name": "Alex",
        "avatarUrl": null
      }
    }
  ]
  ```

---

#### `POST /friend-requests`
- **Description**: Send a friend request to a specified user.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `targetUserId` | UUID | Yes | Target user UUID |
- **Request Example**:
  ```json
  {
    "targetUserId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **Response**:
  - `201 Created`: Request sent successfully.
- **Response Example**:
  ```json
  {
    "requesterId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "addresseeId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
    "status": "pending",
    "createdAt": "2026-06-14T22:18:13Z"
  }
  ```

---

#### `PATCH /friend-requests/:id`
- **Description**: Respond to a received friend request. `:id` is the requester's user ID.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `status` | String | Yes | Response status, 'accepted' or 'rejected' |
- **Request Example**:
  ```json
  {
    "status": "accepted"
  }
  ```
- **Response**:
  - `200 OK`: Response updated successfully.
- **Response Example**:
  ```json
  {
    "requesterId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "addresseeId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
    "status": "accepted",
    "createdAt": "2026-06-14T20:00:00Z"
  }
  ```

---

#### `POST /blocks`
- **Description**: Block a specified user.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `targetUserId` | UUID | Yes | Target user UUID |
- **Request Example**:
  ```json
  {
    "targetUserId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **Response**:
  - `201 Created`: User blocked successfully.

---

#### `DELETE /blocks/:id`
- **Description**: Unblock a specified user. `:id` is the blocked user's ID.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `204 No Content`: User unblocked successfully.

---

### C. Chat Rooms

#### `GET /rooms`
- **Description**: Get all chat rooms the current user has joined, including summaries and unread counts.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Rooms list fetched successfully.
- **Response Example**:
  ```json
  [
    {
      "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
      "type": "group",
      "name": "Project Discussion Group",
      "avatarUrl": null,
      "inviteCode": "JOIN123",
      "requireApproval": false,
      "viewHistory": true,
      "isArchived": false,
      "createdAt": "2026-06-14T22:18:13Z",
      "latestMessage": {
        "messageId": "9f9a9b9c-9d9e-9f9a-9b9c-9d9e9f9a9b9c",
        "senderId": "d3b07384-d113-4956-a5cc-4847841c2c31",
        "content": "Hello",
        "sentAt": "2026-06-14T22:15:00Z"
      },
      "unreadCount": 0
    }
  ]
  ```

---

#### `POST /rooms`
- **Description**: Create a new chat room (private or group). Fields depend on the `type` parameter.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `type` | String | Yes | Creation type: 'group' or 'private' |
  | `name` | String | No | Group name (required for group type, minimum 1 character) |
  | `avatarUrl` | String | No | Group avatar URL (group only) |
  | `requireApproval` | Boolean | No | Whether joining requires approval, default false (group only) |
  | `viewHistory` | Boolean | No | Whether new members can view history, default true (group only) |
  | `targetUserId` | UUID | No | Target user ID (required for private type) |
- **Request Example — Group Room**:
  ```json
  {
    "type": "group",
    "name": "New Project Chat",
    "requireApproval": true
  }
  ```
- **Request Example — Private Room**:
  ```json
  {
    "type": "private",
    "targetUserId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **Response**:
  - `201 Created`: Chat room successfully created, returns room details.
  - `200 OK`: If a private chat with this user already exists, returns the existing room details instead of creating a duplicate.
- **Response Example**:
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "type": "group",
    "name": "New Project Chat",
    "avatarUrl": null,
    "inviteCode": "NEWGRP1",
    "requireApproval": true,
    "viewHistory": true,
    "isArchived": false,
    "createdAt": "2026-06-14T22:18:13Z"
  }
  ```

---

#### `GET /rooms/:id`
- **Description**: Get detailed info of a specific chat room.
- **Authentication & Authorization**: Authentication required, and the caller must be a member of the room.
- **Response**:
  - `200 OK`: Room info fetched successfully.
- **Response Example**:
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "type": "group",
    "name": "New Project Chat",
    "avatarUrl": null,
    "inviteCode": "NEWGRP1",
    "requireApproval": true,
    "viewHistory": true,
    "isArchived": false,
    "createdAt": "2026-06-14T22:18:13Z"
  }
  ```

---

#### `PATCH /rooms/:id`
- **Description**: Update group settings or transfer ownership.
- **Authentication & Authorization**: Authentication required, and the user must be the owner or admin of the group.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `ownerId` | UUID | No | New owner ID when transferring group ownership |
  | `name` | String | No | New group name (minimum 1 character) |
  | `avatarUrl` | String | No | New avatar URL |
  | `requireApproval` | Boolean | No | Update whether joining requires approval |
  | `viewHistory` | Boolean | No | Update whether new members can view history |
  | `isArchived` | Boolean | No | Update whether room is archived |
- **Request Example — Transfer Ownership**:
  ```json
  {
    "ownerId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **Request Example — Update Group Name**:
  ```json
  {
    "name": "Updated Group Name"
  }
  ```
- **Response**:
  - `200 OK`: Update successful.
- **Response Example**:
  *When transferring ownership:*
  ```json
  {
    "message": "Ownership transferred"
  }
  ```
  *When updating settings:*
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "type": "group",
    "name": "Updated Group Name",
    "avatarUrl": null,
    "inviteCode": "NEWGRP1",
    "requireApproval": true,
    "viewHistory": true,
    "isArchived": false,
    "createdAt": "2026-06-14T22:18:13Z"
  }
  ```

---

#### `POST /rooms/:id/members`
- **Description**: Join a group chat using an invite code.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `inviteCode` | String | Yes | Invite code to join the group |
- **Request Example**:
  ```json
  {
    "inviteCode": "NEWGRP1"
  }
  ```
- **Response**:
  - `200 OK`: Join successful.
- **Response Example**:
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "type": "group",
    "name": "New Project Chat",
    "avatarUrl": null,
    "inviteCode": "NEWGRP1",
    "requireApproval": true,
    "viewHistory": true,
    "isArchived": false,
    "createdAt": "2026-06-14T22:18:13Z"
  }
  ```

---

#### `GET /rooms/invite/:code`
- **Description**: Preview the group a share-able invite link points at, without joining it. Used by the accept-invite page to show the group name and avatar before the user confirms.
- **Authentication & Authorization**: Authentication required. Any authenticated user may preview a valid invite code; no membership is required.
- **Path Parameters**:
  | Parameter | Type | Description |
  | :--- | :--- | :--- |
  | `code` | String | Invite code taken from the invite link |
- **Response**:
  - `200 OK`: Returns a [`RoomInvitePreview`](#roominvitepreview). This call is read-only and never adds the caller to the room.
  - `404 Not Found`: No group matches this invite code.
- **Response Example** (this group has no avatar, so `avatarUrl` is absent):
  ```json
  {
    "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
    "name": "New Project Chat",
    "requireApproval": true,
    "isMember": false,
    "isPending": false
  }
  ```

---

#### `DELETE /rooms/:id/members/me`
- **Description**: Voluntarily leave the specified chat room.
- **Authentication & Authorization**: Authentication required, and the user must be a member.
- **Response**:
  - `204 No Content`: Room left successfully.

---

#### `DELETE /rooms/:id`
- **Description**: Archive the chat room. Archives preserve history but make the room read-only.
- **Authentication & Authorization**: Authentication required, and the user must be the owner of the group.
- **Response**:
  - `204 No Content`: Room archived successfully.

---

### D. Member Management

#### `GET /rooms/:id/members`
- **Description**: Get list of members in the specified room.
- **Authentication & Authorization**: Authentication required, and the user must be a member.
- **Response**:
  - `200 OK`: Members list fetched successfully.
- **Response Example**:
  ```json
  [
    {
      "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "role": "owner",
      "nickname": null,
      "isMuted": false,
      "lastReadId": null,
      "joinTime": "2026-06-14T22:18:13Z"
    }
  ]
  ```

---

#### `PATCH /rooms/:id/members/:userId`
- **Description**: Approve joining members, or update a member's role and nickname.
- **Authentication & Authorization**: Authentication required, and the user must be an owner or admin of the room.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `status` | String | No | Approval status: must be 'approved' |
  | `role` | String | No | Member role: 'admin' or 'member' |
  | `nickname` | String | No | Custom nickname in this room |
  | `isMuted` | Boolean | No | Whether to mute this member |
- **Request Example — Approve Member**:
  ```json
  {
    "status": "approved"
  }
  ```
- **Request Example — Update Role & Mute**:
  ```json
  {
    "role": "admin",
    "isMuted": true
  }
  ```
- **Response**:
  - `200 OK`: Update or approval successful.
- **Response Example**:
  *When approving a member:*
  ```json
  {
    "message": "Member approved"
  }
  ```
  *When updating details:*
  ```json
  {
    "message": "Member updated"
  }
  ```

---

#### `DELETE /rooms/:id/members/:userId`
- **Description**: Kick a member out of the group chat room.
- **Authentication & Authorization**: Authentication required, and the user must be the owner or admin of the room.
- **Response**:
  - `204 No Content`: Member removed successfully.

---

### E. Messages & Attachments

#### `GET /rooms/:roomId/messages`
- **Description**: Get message history for the room using cursor-based pagination.
- **Authentication & Authorization**: Authentication required, and the user must be a member.
- **Query Parameters**:
  | Parameter | Required | Description |
  | :--- | :---: | :--- |
  | `before_id` | No | Cursor ID, fetches messages before this message ID |
  | `limit` | No | Paginated limit, 1 to 100, default 50 |
- **Response**:
  - `200 OK`: Messages fetched successfully.
- **Response Example**:
  ```json
  [
    {
      "messageId": "9f9a9b9c-9d9e-9f9a-9b9c-9d9e9f9a9b9c",
      "roomId": "8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d",
      "senderId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "content": "Hello",
      "replyToId": null,
      "isRecalled": false,
      "sentAt": "2026-06-14T22:15:00Z",
      "attachments": [],
      "sender": {
        "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
        "name": "Alex",
        "avatarUrl": null
      },
      "mentions": []
    }
  ]
  ```

---

#### `POST /rooms/:roomId/messages`
- **Description**: Create one durable message and its `created` Message Change.
- **Headers**: `Idempotency-Key` is required and must be stable across retries.
- **Request body**: `{ "content": "Hello", "replyToId": null, "attachmentIds": [] }`.
- **Response**: `201 Created` with `MessageWithSender`, including `messageSequence`, `changeSequence`, and `revision`.
- **Retry rule**: Repeating the same key for the same sender returns the original message without allocating another sequence.

#### `PATCH /rooms/:roomId/messages/:messageId`
- **Description**: Edit a message.
- **Headers**: `Idempotency-Key` and `If-Match` are required. `If-Match` contains the expected integer `revision`.
- **Response**: `200 OK` with the updated message and incremented `revision`.
- **Conflict**: `409 CONFLICT` when the revision is stale.

#### `POST /rooms/:roomId/messages/:messageId/recall`
- **Description**: Recall a message.
- **Headers**: `Idempotency-Key` and `If-Match` are required.
- **Response**: `200 OK` with the recalled message projection.

#### `PUT /rooms/:roomId/read-position`
- **Description**: Advance the caller's durable read position to a message.
- **Headers**: `Idempotency-Key` is required.
- **Request body**: `{ "messageId": "..." }`.
- **Response**: `200 OK` with the updated room membership projection. Read positions only move forward.

#### `GET /sync`
- **Description**: Recover durable Message Changes visible to the authenticated user.
- **Query parameters**: `cursor` (non-negative integer, default `0`) and `limit` (1–500, default `100`).
- **Response**: `{ "changes": [...], "nextCursor": 42, "hasMore": false }` where each change contains `changeSequence`, `messageSequence`, `revision`, `changeType`, and `message`.
- **Visibility**: Membership is checked on every request. For rooms with hidden history, changes at or before the member's Join Boundary are excluded.

#### `POST /attachments`
- **Description**: Upload a file attachment.
- **Authentication & Authorization**: Authentication required.
- **Request Content Type**: `multipart/form-data`
- **Request Parameters**:
  | Parameter | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `file` | Binary | Yes | Binary file to upload |
  | `messageId` | String | No | If provided, binds to the message ID immediately; otherwise remains unbound |
- **Response**:
  - `201 Created`: Upload successful.
- **Response Example**:
  ```json
  {
    "attachmentId": "f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5",
    "messageId": null,
    "fileUrl": "http://localhost:4005/api/v1/attachments/f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5",
    "originalName": "avatar.png",
    "fileType": "image/png",
    "uploadedAt": "2026-06-14T22:18:13Z"
  }
  ```

---

#### `GET /attachments/:id`
- **Description**: Download or retrieve the specified attachment file.
- **Authentication & Authorization**: Authentication required, and the user must have read access to the associated room.
- **Response**:
  - `200 OK`: Returns file stream with header `Content-Disposition: attachment`.

---

### F. Folders

#### `GET /folders`
- **Description**: Get all chat room classification folders created by the current user.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Folders list fetched successfully.
- **Response Example**:
  ```json
  [
    {
      "folderId": "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1",
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "name": "Project Folder",
      "createdAt": "2026-06-14T22:18:13Z",
      "roomIds": ["8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d"]
    }
  ]
  ```

---

#### `POST /folders`
- **Description**: Create a new chat room classification folder.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `name` | String | Yes | Folder name (1 to 50 characters) |
- **Request Example**:
  ```json
  {
    "name": "Study Folder"
  }
  ```
- **Response**:
  - `201 Created`: Folder created successfully.
- **Response Example**:
  ```json
  {
    "folderId": "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1",
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "Study Folder",
    "createdAt": "2026-06-14T22:18:13Z",
    "roomIds": []
  }
  ```

---

#### `DELETE /folders/:id`
- **Description**: Delete the specified classification folder.
- **Authentication & Authorization**: Authentication required, and the user must be the owner.
- **Response**:
  - `204 No Content`: Folder deleted successfully.

---

#### `PUT /folders/:id/rooms`
- **Description**: Batch update the list of rooms inside a folder. This is a full overwrite update; passing an empty array clears all rooms.
- **Authentication & Authorization**: Authentication required, and the user must be the owner.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `roomIds` | Array | Yes | Array of room IDs inside this folder (empty array clears folder) |
- **Request Example**:
  ```json
  {
    "roomIds": ["8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d"]
  }
  ```
- **Response**:
  - `200 OK`: Update successful.
- **Response Example**:
  ```json
  {
    "success": true
  }
  ```

---

### G. Emergency Contacts

#### `GET /users/me/emergency-contacts`
- **Description**: Get all emergency contacts set up by the current user.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Emergency contacts list fetched successfully.
- **Response Example**:
  ```json
  [
    {
      "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
      "contactId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
      "message": "The system has detected that I have been inactive for a long time. This is an auto-alert message.",
      "createdAt": "2026-06-14T22:18:13Z"
    }
  ]
  ```

---

#### `POST /users/me/emergency-contacts`
- **Description**: Add or update an emergency contact (upsert). The contact must be an existing registered user.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `contactId` | UUID | Yes | User ID of the designated emergency contact |
  | `message` | String | Yes | Default message sent when alert is triggered (minimum 1 character) |
- **Request Example**:
  ```json
  {
    "contactId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
    "message": "Auto-alert message"
  }
  ```
- **Response**:
  - `201 Created`: Emergency contact added successfully.
  - `200 OK`: Emergency contact updated successfully.
- **Response Example**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "contactId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
    "message": "Auto-alert message",
    "createdAt": "2026-06-14T22:18:13Z"
  }
  ```

---

#### `DELETE /users/me/emergency-contacts/:contactId`
- **Description**: Delete the specified emergency contact. `:contactId` is the contact's user ID.
- **Authentication & Authorization**: Authentication required.
- **Response**:
  - `200 OK`: Delete successful.
- **Response Example**:
  ```json
  {
    "success": true
  }
  ```

---

#### `POST /users/me/emergency-alert/check-inactivity`
- **Description**: Check if the current user has crossed the inactivity threshold. If met, an alert is automatically dispatched.
- **Authentication & Authorization**: Authentication required.
- **Request Body**:
  | Field | Type | Required | Description |
  | :--- | :--- | :---: | :--- |
  | `now` | String | No | ISO 8601 timestamp reference, defaults to server time |
- **Request Example**:
  ```json
  {
    "now": "2026-06-14T22:18:13Z"
  }
  ```
- **Response**:
  - `200 OK`: Check completed.

---

## 3. Socket.IO Real-Time Communication

### Connection

- **URL**: Same host as REST API (default port `4000`)
- **Namespace**: `/`
- **Authentication**: Connection requires the access token in the Socket.IO `auth.token` handshake field.
- **Subscriptions**: Upon connection, the server adds the socket to `user_<userId>` and to every non-pending room in `room_members`. Membership revocation removes every session from that room.
- **Recovery**: Clients wait for the server's `realtime_ready` event, then call `GET /sync` after every connection and token refresh. `connectionStateRecovery` is disabled; Sync Cursor is the single recovery path. If subscription restoration fails, the server disconnects the socket without sending `realtime_ready`, so the client retries the handshake.

### Client-to-Server Events

| Event Name | Payload | Description |
| :--- | :--- | :--- |
| `typing` | `{ roomId: string, isTyping: boolean }` | Broadcast typing state |

### Server-to-Client Events

| Event Name | Payload Type | Description |
| :--- | :--- | :--- |
| `new_message` | `MessageWithSender` | Receive new message (mentions also trigger this event) |
| `message_updated` | `MessageWithSender` | Receive the canonical edited message |
| `message_recalled` | `{ roomId: string, messageId: string, messageSequence: number, changeSequence: number, revision: number }` | Message has been recalled; `roomId` lets clients update an unloaded room's latest-message projection |
| `user_typing` | `{ roomId: string, userId: string, isTyping: boolean }` | Typing status of other members |
| `read_update` | `{ roomId: string, userId: string, messageId: string, readPosition?: number }` | Read receipt updates of other members |
| `room_update` | `{ type: string, roomId: string, data: unknown }` | Room or membership state change. `type` determines the subtype. See [`room_update` Subtypes](#room_update-subtypes). |
| `friend_request` | `{ requesterId: string, addresseeId: string, status: 'pending' \| 'accepted' \| 'rejected' \| 'deleted' \| 'unblocked', createdAt: string }` | Friend lifecycle notification. Delivered to the relevant user; the client should refresh friend and pending-request lists upon receiving this event regardless of `status`. |
| `user_status` | `{ userId: string, status: 'online' \| 'offline' }` | Presence update for a friend. Delivered when a friend connects or disconnects. |
| `emergency_alert` | `{ userId: string, message: string }` | Receive emergency alert from contact |
| `realtime_ready` | `void` | Initial durable room subscriptions have been restored; the client may begin `/sync` |
| `error` | `ApiError` | Error report for failed event processing |

---

### `room_update` Subtypes

All `room_update` events share the envelope `{ type: string, roomId: string, data: any }`. The `type` field determines how the payload should be handled.

#### Room-level subtypes
Broadcast to all current members of the room (`room_<roomId>` socket channel).

| `type` | `data` shape | Trigger | Who receives it |
| :--- | :--- | :--- | :--- |
| `ROOM_SETTINGS_UPDATED` | `Room` object | `PATCH /rooms/:id` (name, avatar, settings) | All room members |
| `ROOM_AVATAR_UPDATED` | `{ roomId: string, avatarUrl: string }` | Room avatar upload | All room members |
| `ROOM_DELETED` | `{ roomId: string }` | `DELETE /rooms/:id` (archive/delete) | All room members |

#### Member-level subtypes
Broadcast to all current members of the room.

| `type` | `data` shape | Trigger | Who receives it |
| :--- | :--- | :--- | :--- |
| `MEMBER_JOINED` | `{ userId: string }` | User joins via invite code (no approval required) | All existing room members |
| `MEMBER_APPROVED` | `{ userId: string }` | Pending member approved by owner/admin | All existing room members |
| `MEMBER_UPDATED` | `{ userId: string, role?: string, nickname?: string, isMuted?: boolean }` | Member role/nickname/mute changed | All room members |
| `MEMBER_KICKED` | `{ userId: string }` | Member removed by owner/admin | All room members (including kicked user) |
| `MEMBER_LEFT` | `{ userId: string }` | Member voluntarily left | All remaining room members |
| `OWNERSHIP_TRANSFERRED` | `{ oldOwner: string, newOwner: string }` | Group ownership transferred | All room members |
| `USER_UPDATED` | `{ userId: string, name?: string, avatarUrl?: string }` | Member updates their own profile | All rooms the user belongs to |

#### Personal subtypes
Sent **only** to the target user's personal socket channel (`user_<userId>`), not to the room.

| `type` | `data` shape | Trigger | Who receives it |
| :--- | :--- | :--- | :--- |
| `ROOM_JOINED` | `{}` | User joins via invite code **or** pending member is approved | Only the joining / approved user |

> **Client handling**: When `ROOM_JOINED` is received, the client should call `GET /rooms` to refresh the full room list. The next socket connection derives the room subscription from durable membership; no client-side `join_room` call is required.
