# API 文件

本文件定義後端提供的 RESTful API 與原生 WebSocket 即時通訊協議。

---

## API 總覽

### RESTful API

| 分類 | 方法 | 路徑 | 驗證要求 | 說明 |
| :--- | :--- | :--- | :--- | :--- |
| **認證與帳號** | `POST` | [`/auth/register`](#post-authregister) | 無需驗證 | 註冊新帳號 |
| | `POST` | [`/auth/login`](#post-authlogin) | 無需驗證 | 帳號登入 |
| | `POST` | [`/auth/refresh`](#post-authrefresh) | 無需驗證 | 刷新存取權杖 |
| | `POST` | [`/auth/logout`](#post-authlogout) | 需驗證 | 帳號登出 |
| | `GET` | [`/users/me`](#get-usersme) | 需驗證 | 取得目前登入者的個人資料 |
| | `GET` | [`/users/:id`](#get-usersid) | 需驗證 | 取得指定使用者的公開個人資料 |
| | `PATCH` | [`/users/me`](#patch-usersme) | 需驗證 | 更新目前登入者的個人資料 |
| | `GET` | [`/users/me/settings`](#get-usersmesettings) | 需驗證 | 取得目前登入者的設定偏好 |
| | `PATCH` | [`/users/me/settings`](#patch-usersmesettings) | 需驗證 | 更新目前登入者的設定偏好 |
| | `DELETE` | [`/users/me`](#delete-usersme) | 需驗證 | 刪除目前登入者的帳號（軟刪除） |
| | `GET` | [`/users`](#get-users) | 需驗證 | 搜尋使用者 |
| **好友與封鎖** | `GET` | [`/friends`](#get-friends) | 需驗證 | 取得好友列表 |
| | `DELETE` | [`/friends/:id`](#delete-friendsid) | 需驗證 | 移除好友關係 |
| | `GET` | [`/friend-requests`](#get-friend-requests) | 需驗證 | 取得所有待處理的好友邀請 |
| | `POST` | [`/friend-requests`](#post-friend-requests) | 需驗證 | 發送好友邀請 |
| | `PATCH` | [`/friend-requests/:id`](#patch-friend-requestsid) | 需驗證 | 回覆好友邀請 |
| | `POST` | [`/blocks`](#post-blocks) | 需驗證 | 封鎖使用者 |
| | `DELETE` | [`/blocks/:id`](#delete-blocksid) | 需驗證 | 解除封鎖使用者 |
| **聊天室** | `GET` | [`/rooms`](#get-rooms) | 需驗證 | 取得聊天室列表與摘要 |
| | `POST` | [`/rooms`](#post-rooms) | 需驗證 | 建立聊天室（私聊或群組） |
| | `GET` | [`/rooms/:id`](#get-roomsid) | 需驗證 | 取得特定聊天室資訊 |
| | `PATCH` | [`/rooms/:id`](#patch-roomsid) | 需驗證 | 更新聊天室設定或轉讓擁有權 |
| | `POST` | [`/rooms/:id/members`](#post-roomsidmembers) | 需驗證 | 透過邀請碼加入聊天室 |
| | `DELETE` | [`/rooms/:id/members/me`](#delete-roomsidmembersme) | 需驗證 | 退出聊天室 |
| | `DELETE` | [`/rooms/:id`](#delete-roomsid) | 需驗證 | 封存聊天室（僅限擁有者） |
| **成員管理** | `GET` | [`/rooms/:id/members`](#get-roomsidmembers) | 需驗證 | 取得聊天室成員列表 |
| | `PATCH` | [`/rooms/:id/members/:userId`](#patch-roomsidmembersuserid) | 需驗證 | 審核成員加入或修改成員權限與暱稱 |
| | `DELETE` | [`/rooms/:id/members/:userId`](#delete-roomsidmembersuserid) | 需驗證 | 踢出成員（需擁有者或管理員） |
| **訊息與附件** | `GET` | [`/rooms/:roomId/messages`](#get-roomsroomidmessages) | 需驗證 | 取得聊天室歷史訊息（分頁） |
| | `POST` | [`/attachments`](#post-attachments) | 需驗證 | 上傳附件檔案 |
| | `GET` | [`/attachments/:id`](#get-attachmentsid) | 需驗證 | 下載附件檔案 |
| **資料夾分類** | `GET` | [`/folders`](#get-folders) | 需驗證 | 取得資料夾列表 |
| | `POST` | [`/folders`](#post-folders) | 需驗證 | 建立新資料夾 |
| | `DELETE` | [`/folders/:id`](#delete-foldersid) | 需驗證 | 刪除資料夾 |
| | `PUT` | [`/folders/:id/rooms`](#put-foldersidrooms) | 需驗證 | 更新資料夾內的聊天室關聯列表 |
| **緊急聯絡** | `GET` | [`/users/me/emergency-contacts`](#get-usersmeemergency-contacts) | 需驗證 | 取得緊急聯絡人列表 |
| | `POST` | [`/users/me/emergency-contacts`](#post-usersmeemergency-contacts) | 需驗證 | 新增或更新緊急聯絡人設定 |
| | `DELETE` | [`/users/me/emergency-contacts/:contactId`](#delete-usersmeemergency-contactscontactid) | 需驗證 | 刪除緊急聯絡人設定 |
| | `POST` | [`/users/me/emergency-alert/check-inactivity`](#post-usersmeemergency-alertcheck-inactivity) | 需驗證 | 檢查不活躍狀態以判定是否發送警報 |
| **即時通訊** | `POST` | [`/realtime/ticket`](#post-realtimeticket) | 需驗證 | 核發短效、單次使用的 WebSocket ticket |
| | `GET` | [`/realtime/emergency-notifications`](#get-realtimeemergency-notifications) | 需驗證 | 補取持久化的緊急通知 |

### 原生 WebSocket 協議 (`near-chat.v1`)

| 類型 | 訊框類型 | 驗證要求 | 說明 |
| :--- | :--- | :--- | :--- |
| **命令** | `auth.renew`, `rooms.sync` | 連線需驗證 | 更新 session lease 與同步伺服器授權的房間訂閱 |
| | `message.send`, `message.edit`, `message.recall`, `message.delta` | 連線需驗證 | 異動或補取持久化訊息變更 |
| | `read.advance`, `typing.set` | 連線需驗證 | 推進單調已讀位置或發布會過期的輸入狀態 |
| **事件** | `session.ready`, `auth.expiring`, `rooms.synced`, `room.access_revoked` | 連線需驗證 | Session 與訂閱生命週期 |
| | `message.created`, `message.updated`, `message.recalled`, `message.delta` | 連線需驗證 | 持久化訊息變更與修復 |
| | `read.advanced`, `typing.changed`, `presence.changed` | 連線需驗證 | 互動狀態 |
| | `room.updated`, `friend.requested`, `emergency.alert`, `server.draining` | 連線需驗證 | 領域與伺服器生命週期通知 |
| **回應** | `command.ack`, `command.nack` | 連線需驗證 | 命令關聯、canonical 結果或穩定錯誤碼 |

---

## 0. 通用規則

### 本機整合環境

Docker Compose 在本機映射的連接埠如下：
- **前端應用**: `http://localhost:3005` (容器內部埠 `3000`)
- **後端 API / WebSocket 伺服器**: `http://localhost:4005` (容器內部埠 `4000`)
- **PostgreSQL 資料庫**: `localhost:5435` (容器內部埠 `5432`)

在前端連接後端時，應設定環境變數：
```env
NEXT_PUBLIC_API_URL=http://localhost:4005
```

### Base URL

所有 REST API 路徑以 `/api/v1` 開頭。

### 認證方式

除 `POST /auth/register`、`POST /auth/login` 與 `POST /auth/refresh` 外，所有端點均需驗證：

1. **Bearer Token**: 客戶端需在 Request Header 中包含 `Authorization: Bearer <token>`（`<token>` 為登入、註冊或刷新成功後回傳的存取權杖）。
2. **HttpOnly Cookie (更新權杖)**: 登入或註冊成功後，伺服器會自動在瀏覽器中設置名為 `refresh_token` 的 Cookie。當存取權杖過期後，可透過發送 `POST /auth/refresh` 並自動帶上此 Cookie 來取得新的存取權杖。

存取權杖預設有效期為 `15m`，可透過環境變數 `JWT_EXPIRES_IN` 調整。更新權杖預設有效期為 `7` 天，可透過環境變數 `JWT_REFRESH_EXPIRES_IN_DAYS` 調整。

### 錯誤回應格式

所有錯誤均回傳以下 JSON 結構之錯誤模型：

```json
{
  "statusCode": 400,
  "message": "Human-readable description",
  "code": "MACHINE_READABLE_CODE"
}
```

| `code` | `statusCode` | 說明 |
| :--- | :---: | :--- |
| _(無 code)_ | 401 | 未提供或無效的 Token |
| `VALIDATION_ERROR` | 400 | 請求參數不合法 |
| `NOT_FOUND` | 404 | 資源不存在 |
| `FORBIDDEN` | 403 | 無操作權限 |
| `CONFLICT` | 409 | 資源衝突（如重複的好友邀請） |
| `INTERNAL_ERROR` | 500 | 伺服器內部錯誤 |

---

## 1. 共用型別

#### PublicUser
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `userId` | UUID | 使用者唯一識別碼 |
  | `name` | 字串 | 使用者名稱 |
  | `avatarUrl` | 字串 \| null | 使用者頭像網址 |
- **範例**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "Alex",
    "avatarUrl": "https://example.com/avatar.png"
  }
  ```

#### UserProfile
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `userId` | UUID | 使用者唯一識別碼 |
  | `name` | 字串 | 使用者名稱 |
  | `bio` | 字串 \| null | 個人簡介 |
  | `avatarUrl` | 字串 \| null | 使用者頭像網址 |
- **範例**:
  ```json
  {
    "userId": "d3b07384-d113-4956-a5cc-4847841c2c31",
    "name": "Alex",
    "bio": "Hello, this is my bio.",
    "avatarUrl": "https://example.com/avatar.png"
  }
  ```

#### MyProfile
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `userId` | UUID | 使用者唯一識別碼 |
  | `name` | 字串 | 使用者名稱 |
  | `email` | 字串 | 電子郵件信箱 |
  | `bio` | 字串 \| null | 個人簡介 |
  | `avatarUrl` | 字串 \| null | 使用者頭像網址 |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `warningEnabled` | 布林值 | 是否啟用緊急聯絡人通知模式 |
  | `warningDays` | 整數 | 判定不活躍的天數，最少為 0 |
  | `language` | 字串 | 語言設定，例如 'zh-TW', 'en' |
  | `theme` | 字串 | 佈景主題，可為 'light' 或 'dark' |
  | `notifyDesktop` | 布林值 | 是否啟用桌面通知 |
  | `notifySound` | 布林值 | 是否啟用聲音通知 |
- **範例**:
  ```json
  {
    "warningEnabled": false,
    "warningDays": 3,
    "language": "en",
    "theme": "dark",
    "notifyDesktop": true,
    "notifySound": true
  }
  ```

#### AuthResponse
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `token` | 字串 | 存取權杖 |
  | `user` | 物件 | `PublicUser` 結構的使用者資料 |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `roomId` | UUID | 聊天室唯一識別碼 |
  | `type` | 字串 | 聊天室類型：'group' 或 'private' |
  | `name` | 字串 \| null | 聊天室名稱（僅群組聊天室有值） |
  | `avatarUrl` | 字串 \| null | 聊天室頭像網址 |
  | `inviteCode` | 字串 \| null | 邀請碼（僅群組聊天室有值） |
  | `requireApproval` | 布林值 | 加入此聊天室是否需要審核 |
  | `viewHistory` | 布林值 | 新加入的成員是否能查看歷史訊息 |
  | `isArchived` | 布林值 | 是否已封存，封存後聊天室為唯讀狀態 |
  | `createdAt` | 字串 | 建立時間（時間格式） |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `roomId` | UUID | 聊天室唯一識別碼 |
  | `type` | 字串 | 聊天室類型：'group' 或 'private' |
  | `name` | 字串 \| null | 聊天室名稱 |
  | `avatarUrl` | 字串 \| null | 聊天室頭像網址 |
  | `inviteCode` | 字串 \| null | 邀請碼 |
  | `requireApproval` | 布林值 | 是否需要審核 |
  | `viewHistory` | 布林值 | 是否可看歷史訊息 |
  | `isArchived` | 布林值 | 是否已封存 |
  | `createdAt` | 字串 | 建立時間（時間格式） |
  | `latestMessage` | 物件 \| null | 最新一筆訊息摘要，若無訊息則為 null |
  | `unreadCount` | 數字 | 未讀訊息數量 |
  | `role` | 字串 \| null | 調用者在此聊天室的角色 ('owner', 'admin', 'member', 'pending') |
- **範例**:
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
- **說明**: 以邀請碼解析出的群組唯讀預覽，用於使用者確認加入前顯示群組資訊。由 `GET /rooms/invite/:code` 回傳。
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `roomId` | UUID | 聊天室唯一識別碼 |
  | `name` | 字串（選填） | 群組名稱。未設定時不會出現在回應中 |
  | `avatarUrl` | 字串（選填） | 群組頭像網址。群組沒有頭像時不會出現在回應中 |
  | `requireApproval` | 布林值 | 加入是否需要 owner/admin 審核 |
  | `isMember` | 布林值 | 呼叫者是否已有成員資料列（含尚待審核者） |
  | `isPending` | 布林值 | 呼叫者是否已送出加入申請、尚待審核 |
- **範例**:
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
- **範例（沒有頭像的群組）**：選填欄位會直接省略，而不是回傳 `null`。
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `roomId` | UUID | 聊天室唯一識別碼 |
  | `userId` | UUID | 成員唯一識別碼 |
  | `role` | 字串 | 成員角色：'owner', 'admin', 'member', 'pending' |
  | `nickname` | 字串 \| null | 在此聊天室的自訂暱稱 |
  | `isMuted` | 布林值 | 是否已被靜音 |
  | `lastReadId` | UUID \| null | 最後已讀的訊息唯一識別碼 |
  | `joinTime` | 字串 | 加入時間（時間格式） |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `messageId` | UUID | 訊息唯一識別碼 |
  | `roomId` | UUID | 聊天室唯一識別碼 |
  | `senderId` | UUID \| null | 發送者唯一識別碼，若帳號已刪除則為 null |
  | `content` | 字串 | 訊息內容 |
  | `replyToId` | UUID \| null | 被引用的父訊息唯一識別碼 |
  | `isRecalled` | 布林值 | 訊息是否已被收回 |
  | `sentAt` | 字串 | 發送時間（時間格式） |
  | `attachments` | 陣列 | 附帶的 `Attachment` 陣列 |
  | `sender` | 物件 \| null | 發送者的 `PublicUser` 資料，若帳號已刪除則為 null |
  | `mentions` | 陣列 | 被提及的使用者 ID 陣列 |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `requesterId` | UUID | 發出邀請的使用者 ID |
  | `addresseeId` | UUID | 接收邀請的使用者 ID |
  | `status` | 字串 | 狀態：'pending' 或 'accepted' |
  | `createdAt` | 字串 | 建立時間（時間格式） |
  | `requester` | 物件 | 發出者的 `PublicUser` 資料（選填） |
  | `addressee` | 物件 | 接收者的 `PublicUser` 資料（選填） |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `attachmentId` | UUID | 附件唯一識別碼 |
  | `messageId` | UUID \| null | 關聯的訊息唯一識別碼 |
  | `fileUrl` | 字串 | 檔案下載連結 |
  | `originalName` | 字串 | 上傳時的原始檔案名稱 |
  | `fileType` | 字串 | 檔案 MIME 類型 |
  | `uploadedAt` | 字串 | 上傳時間（時間格式） |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `friend` | 物件 | 好友的 `PublicUser` 資料 |
  | `friendshipCreatedAt` | 字串 | 好友關係建立時間（時間格式） |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `folderId` | UUID | 資料夾唯一識別碼 |
  | `userId` | UUID | 擁有者使用者 ID |
  | `name` | 字串 | 資料夾名稱 |
  | `createdAt` | 字串 | 建立時間（時間格式） |
  | `roomIds` | 陣列 | 此資料夾所包含的聊天室 ID 陣列 |
- **範例**:
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
- **欄位說明**:
  | 欄位 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `statusCode` | 數字 | HTTP 狀態碼 |
  | `message` | 字串 | 錯誤說明訊息 |
  | `code` | 字串 \| null | 錯誤代碼（選填） |
- **範例**:
  ```json
  {
    "statusCode": 400,
    "message": "Invalid request parameters",
    "code": "VALIDATION_ERROR"
  }
  ```

---

## 2. RESTful API

### A. 認證與帳號

#### `POST /auth/register`
- **說明**: 註冊新帳號並自動登入。
- **驗證與權限**: 無需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `email` | 字串 | 是 | 電子郵件信箱（合法的電子郵件格式） |
  | `name` | 字串 | 是 | 使用者名稱（最少 1 個字元） |
  | `password` | 字串 | 是 | 密碼（最少 8 個字元） |
- **請求範例**:
  ```json
  {
    "email": "user@example.com",
    "name": "user123",
    "password": "securepassword123"
  }
  ```
- **回應**:
  - `201 Created`: 註冊成功。
- **回應範例**:
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
- **說明**: 使用電子郵件與密碼登入帳號。
- **驗證與權限**: 無需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `email` | 字串 | 是 | 電子郵件信箱 |
  | `password` | 字串 | 是 | 密碼 |
- **請求範例**:
  ```json
  {
    "email": "user@example.com",
    "password": "securepassword123"
  }
  ```
- **回應**:
  - `200 OK`: 登入成功。
- **回應範例**:
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
- **說明**: 刷新存取權杖。
- **驗證與權限**: 無需驗證，但瀏覽器必須自動帶上有效的更新權杖之 HttpOnly Cookie。
- **回應**:
  - `200 OK`: 刷新成功。
- **回應範例**:
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
- **說明**: 登出帳號，失效目前的存取與更新權杖。
- **驗證與權限**: 需驗證。
- **回應**:
  - `204 No Content`: 成功清除 Cookie，並於資料庫中註銷此更新權杖。

---

#### `GET /users/me`
- **說明**: 取得目前登入使用者的完整個人資料。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 取得指定使用者的公開個人資料。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 更新目前登入使用者的個人資料欄位。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `name` | 字串 | 否 | 使用者名稱（最少 1 個字元） |
  | `email` | 字串 | 否 | 電子郵件信箱 |
  | `password` | 字串 | 否 | 密碼（最少 8 個字元） |
  | `bio` | 字串 | 否 | 個人簡介 |
  | `avatarUrl` | 字串 | 否 | 頭像網址 |
- **請求範例**:
  ```json
  {
    "bio": "Updated bio details"
  }
  ```
- **回應**:
  - `200 OK`: 更新成功。
- **回應範例**:
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
- **說明**: 取得目前登入使用者的應用程式偏好設定與緊急警報設定。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 更新目前登入使用者的應用程式與警報設定欄位。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `warningEnabled` | 布林值 | 否 | 是否啟用不活躍警報模式 |
  | `warningDays` | 數字 | 否 | 不活躍判定天數，最少為 0 |
  | `language` | 字串 | 否 | 語言偏好設定 |
  | `theme` | 字串 | 否 | 佈景主題：可選為 'light' 或 'dark' |
  | `notifyDesktop` | 布林值 | 否 | 是否啟用桌面通知 |
  | `notifySound` | 布林值 | 否 | 是否啟用聲音通知 |
- **請求範例**:
  ```json
  {
    "theme": "dark",
    "notifySound": false
  }
  ```
- **回應**:
  - `200 OK`: 更新成功。
- **回應範例**:
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
- **說明**: 註銷/刪除目前登入使用者的帳號。
- **驗證與權限**: 需驗證。
- **回應**:
  - `204 No Content`: 成功將帳號標記為已刪除（軟刪除）。

---

#### `GET /users`
- **說明**: 搜尋系統中的使用者。
- **驗證與權限**: 需驗證。
- **查詢參數**:
  | 參數 | 必填 | 說明 |
  | :--- | :---: | :--- |
  | `q` | 是 | 搜尋字串（最少 1 個字元），用於篩選姓名或 ID |
- **回應**:
  - `200 OK`: 搜尋成功。
- **回應範例**:
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

### B. 好友與封鎖

#### `GET /friends`
- **說明**: 取得目前使用者的好友列表。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 移除與指定使用者的好友關係。`:id` 為對方的使用者 ID。
- **驗證與權限**: 需驗證。
- **回應**:
  - `204 No Content`: 成功解除好友關係。

---

#### `GET /friend-requests`
- **說明**: 取得目前使用者所有待處理的好友邀請。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 向指定使用者發送好友邀請。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `targetUserId` | UUID | 是 | 目標使用者的 UUID |
- **請求範例**:
  ```json
  {
    "targetUserId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **回應**:
  - `201 Created`: 發送成功。
- **回應範例**:
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
- **說明**: 回覆收到的好友邀請。`:id` 為發出邀請者的使用者 ID。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `status` | 字串 | 是 | 回覆結果，可選為 'accepted' 或 'rejected' |
- **請求範例**:
  ```json
  {
    "status": "accepted"
  }
  ```
- **回應**:
  - `200 OK`: 回覆成功。
- **回應範例**:
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
- **說明**: 封鎖指定使用者。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `targetUserId` | UUID | 是 | 目標使用者的 UUID |
- **請求範例**:
  ```json
  {
    "targetUserId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **回應**:
  - `201 Created`: 封鎖成功。

---

#### `DELETE /blocks/:id`
- **說明**: 解除對指定使用者的封鎖關係。`:id` 為被封鎖者的使用者 ID。
- **驗證與權限**: 需驗證。
- **回應**:
  - `204 No Content`: 成功解除封鎖。

---

### C. 聊天室

#### `GET /rooms`
- **說明**: 取得目前使用者加入的所有聊天室列表及最新訊息摘要與未讀數。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 建立新的聊天室。依據建立類型帶入對應欄位。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `type` | 字串 | 是 | 建立類型：可選為 'group' 或 'private' |
  | `name` | 字串 | 否 | 群組名稱（建立群組時為必填，最少 1 字元） |
  | `avatarUrl` | 字串 | 否 | 群組頭像網址（群組專用） |
  | `requireApproval` | 布林值 | 否 | 加入是否需審核，預設為 false（群組專用） |
  | `viewHistory` | 布林值 | 否 | 新成員是否可查看歷史，預設為 true（群組專用） |
  | `targetUserId` | UUID | 否 | 目標使用者 ID（建立一對一私聊時為必填） |
- **請求範例 — 建立群組**:
  ```json
  {
    "type": "group",
    "name": "New Project Chat",
    "requireApproval": true
  }
  ```
- **請求範例 — 建立私聊**:
  ```json
  {
    "type": "private",
    "targetUserId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **回應**:
  - `201 Created`: 成功建立新私聊或群組，回傳聊天室資料。
  - `200 OK`: 若已存在與對方的私聊房間，直接回傳既有的聊天室資料。
- **回應範例**:
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
- **說明**: 取得特定聊天室的詳細資訊。
- **驗證與權限**: 需驗證，且操作者必須為該房間成員。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 更新群組聊天室的設定，或轉讓群組的擁有權。
- **驗證與權限**: 需驗證，且操作者需為擁有者或管理員身份。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `ownerId` | UUID | 否 | 轉讓群組擁有權時指定的新擁有者 ID |
  | `name` | 字串 | 否 | 新群組名稱（最少 1 字元） |
  | `avatarUrl` | 字串 | 否 | 新頭像網址 |
  | `requireApproval` | 布林值 | 否 | 修改是否需要加入審核 |
  | `viewHistory` | 布林值 | 否 | 修改新成員是否可看歷史訊息 |
  | `isArchived` | 布林值 | 否 | 修改是否封存聊天室 |
- **請求範例 — 轉讓群組擁有權**:
  ```json
  {
    "ownerId": "e4c08495-e224-4a67-b6dd-5958952d3d42"
  }
  ```
- **請求範例 — 更新群組名稱**:
  ```json
  {
    "name": "Updated Group Name"
  }
  ```
- **回應**:
  - `200 OK`: 更新或轉讓成功。
- **回應範例**:
  *當轉讓擁有權時：*
  ```json
  {
    "message": "Ownership transferred"
  }
  ```
  *當更新設定時：*
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
- **說明**: 使用邀請碼加入指定的群組聊天室。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `inviteCode` | 字串 | 是 | 欲加入群組聊天室的邀請碼 |
- **請求範例**:
  ```json
  {
    "inviteCode": "NEWGRP1"
  }
  ```
- **回應**:
  - `200 OK`: 加入成功。
- **回應範例**:
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
- **說明**: 預覽邀請連結所指向的群組，但不會加入該群組。供接受邀請頁面在使用者確認前顯示群組名稱與頭像。
- **驗證與權限**: 需驗證。任何已登入使用者皆可預覽有效的邀請碼，不需為該房間成員。
- **路徑參數**:
  | 參數 | 型別 | 說明 |
  | :--- | :--- | :--- |
  | `code` | 字串 | 取自邀請連結的邀請碼 |
- **回應**:
  - `200 OK`: 回傳 [`RoomInvitePreview`](#roominvitepreview)。此為唯讀操作，不會將呼叫者加入該房間。
  - `404 Not Found`: 找不到符合此邀請碼的群組。
- **回應範例**（此群組沒有頭像，因此不含 `avatarUrl` 欄位）:
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
- **說明**: 主動退出指定的聊天室。
- **驗證與權限**: 需驗證，且必須為該房間成員。
- **回應**:
  - `204 No Content`: 成功退出該聊天室。

---

#### `DELETE /rooms/:id`
- **說明**: 封存聊天室。封存後歷史訊息仍可讀取，但將不再允許發送新訊息。
- **驗證與權限**: 需驗證，且操作者必須為該群組的擁有者。
- **回應**:
  - `204 No Content`: 成功封存該聊天室。

---

### D. 成員管理

#### `GET /rooms/:id/members`
- **說明**: 取得指定聊天室的成員列表。
- **驗證與權限**: 需驗證，且操作者必須為該房間成員。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 審核成員加入，或更新指定成員的權限與暱稱。
- **驗證與權限**: 需驗證，且操作者需為該房間的擁有者或管理員身份。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `status` | 字串 | 否 | 審核狀態：必須為 'approved' |
  | `role` | 字串 | 否 | 成員角色權限：可為 'admin' 或 'member' |
  | `nickname` | 字串 | 否 | 自訂成員在此聊天室的暱稱 |
  | `isMuted` | 布林值 | 否 | 是否將該成員禁言 |
- **請求範例 — 審核成員**:
  ```json
  {
    "status": "approved"
  }
  ```
- **請求範例 — 修改權限及禁言**:
  ```json
  {
    "role": "admin",
    "isMuted": true
  }
  ```
- **回應**:
  - `200 OK`: 修改或審核成功。
- **回應範例**:
  *審核成員時：*
  ```json
  {
    "message": "Member approved"
  }
  ```
  *修改權限時：*
  ```json
  {
    "message": "Member updated"
  }
  ```

---

#### `DELETE /rooms/:id/members/:userId`
- **說明**: 將指定的成員踢出群組聊天室。
- **驗證與權限**: 需驗證，且操作者必須為該房間的擁有者或管理員。
- **回應**:
  - `204 No Content`: 成功將成員移除。

---

### E. 訊息與附件

#### `GET /rooms/:roomId/messages`
- **說明**: 取得指定聊天室的歷史訊息紀錄，採用游標分頁。
- **驗證與權限**: 需驗證，且操作者必須為該房間成員。
- **查詢參數**:
  | 參數 | 必填 | 說明 |
  | :--- | :---: | :--- |
  | `before_id` | 否 | 游標欄位，取得此訊息 ID 之前的訊息 |
  | `limit` | 否 | 每頁回傳筆數，介於 1 到 100 之間，預設為 `50` |
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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

#### `POST /attachments`
- **說明**: 上傳檔案附件。
- **驗證與權限**: 需驗證。
- **請求格式**: `multipart/form-data`
- **請求參數**:
  | 參數欄位 | 類型 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `file` | binary | 是 | 上傳的二進位檔案 |
  | `messageId` | string (UUID) | 否 | 若提供，將會立即與該訊息 ID 綁定；若未提供則為待綁定狀態 |
- **回應**:
  - `201 Created`: 上傳成功。
- **回應範例**:
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
- **說明**: 下載或取得指定的附件檔案。
- **驗證與權限**: 需驗證，且操作者需對關聯房間有讀取權限。
- **回應**:
  - `200 OK`: 回傳檔案串流，並附帶 Header `Content-Disposition: attachment`。

---

### F. 資料夾分類

#### `GET /folders`
- **說明**: 取得目前使用者建立的所有聊天室分類資料夾。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 建立一個新的聊天室分類資料夾。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `name` | 字串 | 是 | 資料夾名稱（長度需介於 1 到 50 個字元） |
- **請求範例**:
  ```json
  {
    "name": "Study Folder"
  }
  ```
- **回應**:
  - `201 Created`: 建立成功。
- **回應範例**:
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
- **說明**: 刪除指定的分類資料夾。
- **驗證與權限**: 需驗證，且操作者需為資料夾的擁有者。
- **回應**:
  - `204 No Content`: 成功刪除資料夾。

---

#### `PUT /folders/:id/rooms`
- **說明**: 整批更新資料夾內所含的房間列表。此操作為全量覆蓋更新，若傳入空陣列則會清空資料夾內所有房間。
- **驗證與權限**: 需驗證，且操作者需為資料夾的擁有者。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `roomIds` | 陣列 | 是 | 包含在此資料夾的房間 ID 陣列（傳入空陣列清空） |
- **請求範例**:
  ```json
  {
    "roomIds": ["8f8b8c8d-8e8f-8a8b-8c8d-8e8f8a8b8c8d"]
  }
  ```
- **回應**:
  - `200 OK`: 更新成功。
- **回應範例**:
  ```json
  {
    "success": true
  }
  ```

---

### G. 緊急聯絡

#### `GET /users/me/emergency-contacts`
- **說明**: 取得目前使用者設定的所有緊急聯絡人資訊。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 取得成功。
- **回應範例**:
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
- **說明**: 新增或更新緊急聯絡人設定（採用 Upsert 機制）。緊急聯絡人必須為系統內已註冊的使用者。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `contactId` | UUID | 是 | 被設定為緊急聯絡人的使用者 ID |
  | `message` | 字串 | 是 | 觸發警報時預設發送之內容（最少 1 字元） |
- **請求範例**:
  ```json
  {
    "contactId": "e4c08495-e224-4a67-b6dd-5958952d3d42",
    "message": "Auto-alert message"
  }
  ```
- **回應**:
  - `201 Created`: 新增緊急聯絡人成功。
  - `200 OK`: 更新現有緊急聯絡人設定成功。
- **回應範例**:
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
- **說明**: 刪除指定的緊急聯絡人設定。`:contactId` 為該聯絡人的使用者 ID。
- **驗證與權限**: 需驗證。
- **回應**:
  - `200 OK`: 刪除成功。
- **回應範例**:
  ```json
  {
    "success": true
  }
  ```

---

#### `POST /users/me/emergency-alert/check-inactivity`
- **說明**: 檢查使用者當前是否已達不活躍門檻。若符合門檻，將會自動觸發警報訊息發送。
- **驗證與權限**: 需驗證。
- **請求主體**:
  | 欄位 | 型別 | 必填 | 說明 |
  | :--- | :--- | :---: | :--- |
  | `now` | 字串 | 否 | 時間格式的參考時間點，預設為伺服器時間 |
- **請求範例**:
  ```json
  {
    "now": "2026-06-14T22:18:13Z"
  }
  ```
- **回應**:
  - `200 OK`: 檢查完成。

---

## 3. 原生 WebSocket 即時通訊協議

#### `POST /realtime/ticket`

- **驗證**：需 Bearer access token。
- **回應**：`201 Created`，內容為 `{ ticket, expiresAt, leaseExpiresAt }`。

#### `GET /realtime/emergency-notifications`

- **驗證**：需 Bearer access token。
- **回應**：`200 OK`，內容為依新到舊排序的 `{ notificationId, userId, message, createdAt }` 陣列。

### Ticket 與連線

1. 以 access token 的 Bearer header 呼叫 `POST /api/v1/realtime/ticket`。`201` 回應包含 `ticket`、`expiresAt` 與 `leaseExpiresAt`。
2. 連線至 `ws(s)://<api-host>/ws?ticket=<ticket>`，並提供 `near-chat.v1` WebSocket subprotocol；瀏覽器的 `Origin` 必須在允許清單內。
3. Ticket 最長 45 秒後失效、在單一 backend process 內只能使用一次、audience 固定為 `near-chat-ws`，且不會晚於 access token 到期。Upgrade 時只傳 ticket，不把 access token 放入 URL。
4. Upgrade 後伺服器送出 `session.ready`；lease 到期前送出 `auth.expiring`。客戶端應取得新 ticket，再透過 `auth.renew` 原地延長 lease。

`POST /api/v1/realtime/ticket` 與 `GET /api/v1/realtime/emergency-notifications` 均需 Bearer 驗證。後者回傳目前使用者的持久化緊急通知，也能補取離線期間錯過的警報。

### Envelope

每個訊框都是 strict JSON，含 `version: 1`、唯一 `id`、邏輯 `streamId` 與傳遞策略 `reliable`。客戶端命令使用 `kind: "command"`；伺服器使用 `kind: "event"`、`"ack"` 或 `"nack"`。回應透過 `correlationId` 指向原命令。

```json
{
  "version": 1,
  "kind": "command",
  "id": "019-command-id",
  "type": "message.send",
  "streamId": "room:8ea2...",
  "reliable": true,
  "payload": { "roomId": "8ea2...", "content": "Hello" }
}
```

除 `typing.set` 外，所有命令都必須設定 `reliable: true`。ACK 表示授權檢查通過且持久化業務異動已完成，不代表所有訂閱者均已收到廣播。穩定 NACK code 包含 `INVALID_PAYLOAD`、`AUTH_EXPIRED`、`FORBIDDEN`、`NOT_FOUND`、`VERSION_CONFLICT`、`IDEMPOTENCY_CONFLICT`、`CURSOR_INVALID`、`RATE_LIMITED`、`LIMIT_EXCEEDED`、`BACKPRESSURE` 與 `RETRY_LATER`；payload 另含 `retryable`、可選的 `retryAfterMs` 與 `traceId`。

### 命令

| `type` | Payload | 語意 |
| :--- | :--- | :--- |
| `auth.renew` | `{ ticket }` | 消耗同一使用者的新 ticket 並延長 lease |
| `rooms.sync` | `{ roomIds?: string[] }` | 以伺服器授權結果完整取代房間訂閱；client 清單僅供參考 |
| `message.send` | `{ roomId, content, replyToId?, attachmentIds? }` | 建立訊息；至少需要非空白 `content` 或一個附件；命令 `id` 是冪等鍵，同一意圖重送會回傳原訊息 |
| `message.edit` | `{ roomId, messageId, content, expectedRevision }` | 僅在 `expectedRevision` 相符時編輯 |
| `message.recall` | `{ roomId, messageId, expectedRevision? }` | 冪等地收回訊息 |
| `message.delta` | `{ cursor?, limit? }` | 透過簽名 opaque cursor 與固定 high-water 視窗補取有權存取的訊息變更 |
| `read.advance` | `{ roomId, messageId }` | 依 canonical 訊息順序向前推進已讀位置，不允許倒退 |
| `typing.set` | `{ roomId, isTyping, ttlMs? }` | 發布 best-effort 且會過期的輸入狀態；預設 TTL 3 秒 |

訊息內容上限為 16 KiB UTF-8、附件 20 個、單一訊框 64 KiB、每條連線 1,000 個訂閱、每位使用者 10 條同時連線。預設命令額度為每秒 20 個、burst 40 個。

### 事件

| `type` | Payload 摘要 |
| :--- | :--- |
| `session.ready` | 使用者識別、lease 到期時間與協商後資源上限 |
| `auth.expiring` | 目前 lease 到期時間 |
| `rooms.synced` | 伺服器授權後的房間訂閱清單 |
| `room.access_revoked` | 已立即移除訂閱的房間 |
| `message.created`, `message.updated`, `message.recalled` | `{ revision, message }` canonical snapshot |
| `message.delta` | 有序 `changes`、opaque `cursor`、固定 `highWaterRevision` 與 `complete` |
| `read.advanced` | `{ roomId, userId, messageId }` |
| `typing.changed` | `{ roomId, userId, isTyping, expiresAt }` |
| `presence.changed` | `{ userId, status: "online" | "offline" }`；離線具短暫斷線 grace，且會合併同一使用者所有 session |
| `room.updated` | `{ roomId, change, data }` 房間與成員異動 |
| `friend.requested` | `{ data }` 好友關係異動 |
| `emergency.alert` | `{ notificationId, userId, message }`；即時發布前已持久化 |
| `server.draining` | `{ retryAfterMs }`，於 graceful restart 前送出 |

等待 ACK 的可靠命令會在重連後沿用同一 ID 重送。每次連線先送 `rooms.sync`，再執行 `message.delta`；高於 recovery high-water 的 live message change 會暫存到 delta 視窗完成。重複或亂序 snapshot 會依每則訊息的 revision 忽略；typing 不由 delta 修復。
