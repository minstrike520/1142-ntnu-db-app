# API 文件

本文件定義後端提供的 RESTful API 以及 Socket.io 即時通訊接口。

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
| | `POST` | [`/rooms/:roomId/messages`](#post-roomsroomidmessages) | 需驗證 | 建立具持久性的訊息命令 |
| | `PATCH` | [`/rooms/:roomId/messages/:messageId`](#patch-roomsroomidmessagesmessageid) | 需驗證 | 以 optimistic concurrency 編輯訊息 |
| | `POST` | [`/rooms/:roomId/messages/:messageId/recall`](#post-roomsroomidmessagesmessageidrecall) | 需驗證 | 以 optimistic concurrency 收回訊息 |
| | `PUT` | [`/rooms/:roomId/read-position`](#put-roomsroomidread-position) | 需驗證 | 推進成員已讀位置 |
| **復原** | `GET` | [`/sync`](#get-sync) | 需驗證 | 依 cursor 復原持久化訊息變更 |
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

### Socket.io 即時通訊

Socket.IO 是伺服器到客戶端的事件傳輸層。持久化命令統一走 REST，讓
驗證、`Idempotency-Key`、`If-Match`、交易與重試使用同一份契約。socket
建立連線時，伺服器會依目前有效的 `room_members` 自動建立聊天室訂閱。

| 類型 | 事件名稱 | 驗證要求 | 說明 |
| :--- | :--- | :--- | :--- |
| | `typing` | 連線需驗證 | 廣播輸入狀態給房間內其他使用者 |
| **伺服器推送** | `new_message` | 連線需驗證 | 收到新訊息通知（含提及訊息） |
| | `message_recalled` | 連線需驗證 | 訊息已被原發送者收回 |
| | `user_typing` | 連線需驗證 | 其他成員正在輸入中之狀態 |
| | `read_update` | 連線需驗證 | 其他成員已讀游標的更新 |
| | `room_update` | 連線需驗證 | 房間設定變更、成員變動或被剔除之通知。詳見 [room_update 子類型](#room_update-子類型)。 |
| | `friend_request` | 連線需驗證 | 好友請求狀態變更的即時通知（已送出、已接受、已拒絕） |
| | `user_status` | 連線需驗證 | 好友的上線 / 下線狀態變更 |
| | `emergency_alert` | 連線需驗證 | 收到緊急聯絡人發送之警報通知 |
| | `error` | 連線需驗證 | 事件處理失敗之錯誤回報 |

---

## 0. 通用規則

### 本機整合環境

Docker Compose 在本機映射的連接埠如下：
- **前端應用**: `http://localhost:3005` (容器內部埠 `3000`)
- **後端 API / Socket 伺服器**: `http://localhost:4005` (容器內部埠 `4000`)
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

#### `POST /rooms/:roomId/messages`
- **說明**: 建立一筆持久化訊息及其 `created` Message Change。
- **標頭**: 必須提供重試時保持不變的 `Idempotency-Key`。
- **請求主體**: `{ "content": "Hello", "replyToId": null, "attachmentIds": [] }`。
- **回應**: `201 Created`，回傳含 `messageSequence`、`changeSequence`、`revision` 的 `MessageWithSender`。
- **重試規則**: 同一發送者重送相同 key 會回傳原訊息，不會再分配序號。

#### `PATCH /rooms/:roomId/messages/:messageId`
- **說明**: 編輯訊息。
- **標頭**: 必須提供 `Idempotency-Key` 與包含預期整數 `revision` 的 `If-Match`。
- **回應**: `200 OK`，回傳更新後且 revision 增加的訊息。
- **衝突**: revision 過期時回傳 `409 CONFLICT`。

#### `POST /rooms/:roomId/messages/:messageId/recall`
- **說明**: 收回訊息。
- **標頭**: 必須提供 `Idempotency-Key` 與 `If-Match`。
- **回應**: `200 OK`，回傳收回後的訊息投影。
- **重試規則**: 對已收回的訊息再次收回會直接成功，不會配發新的變更，也不會再發布事件；但該 key 仍算已使用。建立、編輯與收回共用同一個 idempotency namespace，把同一個 key 用於其他操作會得到 `409 CONFLICT`。

#### `PUT /rooms/:roomId/read-position`
- **說明**: 將呼叫者的持久化已讀位置推進至指定訊息。
- **標頭**: 必須提供 `Idempotency-Key`。
- **請求主體**: `{ "messageId": "..." }`。
- **回應**: `200 OK`，已讀位置只會向前推進。

#### `GET /sync`
- **說明**: 依 cursor 復原目前使用者可見的持久化 Message Change。
- **查詢參數**: `cursor`（非負整數，預設 `0`）與 `limit`（1–500，預設 `100`）。
- **回應**: `{ "changes": [...], "nextCursor": 42, "hasMore": false }`；每筆變更含 `changeSequence`、`messageSequence`、`revision`、`changeType` 與 `message`。
- **可見性**: 每次請求都重新檢查成員資格；隱藏歷史的聊天室會排除 Join Boundary 以前的變更。

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

## 3. Socket.io 即時通訊

### 連線

- **URL**: 與 REST API 相同主機（預設埠為 `4000`）
- **Namespace**: `/`
- **驗證**: 連線時需在 Socket.IO `auth.token` handshake 欄位帶上 access token。
- **訂閱**: 連線後伺服器會加入 `user_<userId>`，並加入 `room_members` 中所有非 pending 聊天室；撤銷成員資格時會移除該使用者的所有 session。
- **復原**: 客戶端必須先等待伺服器發出 `realtime_ready`，再於每次連線與 token refresh 後呼叫 `GET /sync`。不使用 `connectionStateRecovery`，Sync Cursor 是唯一復原路徑。若訂閱恢復失敗，伺服器會在發送 `realtime_ready` 前中斷 socket，讓客戶端重新握手。此外，當伺服器還原自己先前撤銷的訂閱時（條件式刪除失敗的踢除），也會在連線期間再次送出 `realtime_ready`：還原訂閱不會補送撤銷期間已發布的內容。

### 客戶端發送事件

| 事件名稱 | Payload | 說明 |
| :--- | :--- | :--- |
| `typing` | `{ roomId: string, isTyping: boolean }` | 廣播輸入中狀態 |

### 伺服器發送事件

| 事件名稱 | Payload 型別 | 說明 |
| :--- | :--- | :--- |
| `new_message` | `MessageWithSender` | 收到新訊息（提及機制亦透過此事件通知） |
| `message_updated` | `MessageWithSender` | 收到編輯後的 canonical 訊息 |
| `message_recalled` | `{ roomId: string, messageId: string, messageSequence: number, changeSequence: number, revision: number }` | 訊息被收回；`roomId` 讓客戶端可以更新尚未載入聊天室的最新訊息摘要 |
| `user_typing` | `{ roomId: string, userId: string, isTyping: boolean }` | 其他成員的輸入狀態 |
| `read_update` | `{ roomId: string, userId: string, messageId: string, readPosition?: number }` | 其他成員的已讀游標更新 |
| `room_update` | `{ type: string, roomId: string, data: unknown }` | 房間或成員狀態變更。`type` 欄位決定子類型，詳見 [`room_update` 子類型](#room_update-子類型)。 |
| `friend_request` | `{ requesterId: string, addresseeId: string, status: 'pending' \| 'accepted' \| 'rejected' \| 'deleted' \| 'blocked' \| 'unblocked', createdAt: string }` | 好友生命週期通知。傳送給相關使用者；客戶端收到後不論 `status` 為何，皆應重新拉取好友與待確認請求列表。 |
| `user_status` | `{ userId: string, status: 'online' \| 'offline' }` | 好友的上線 / 下線狀態更新。於好友連線或斷線時推送。 |
| `emergency_alert` | `{ userId: string, message: string }` | 收到緊急聯絡人的警報通知 |
| `realtime_ready` | `void` | 有效聊天室訂閱已恢復；客戶端可以開始 `/sync`。每次連線送出一次，伺服器還原先前撤銷的訂閱時也會再送 |
| `error` | `ApiError` | 事件處理失敗的錯誤回報 |

---

### `room_update` 子類型

所有 `room_update` 事件共用信封格式 `{ type: string, roomId: string, data: any }`，`type` 欄位決定應如何處理 payload。

#### 房間層級子類型
廣播至房間的所有現有成員（`room_<roomId>` socket 頻道）。

| `type` | `data` 格式 | 觸發時機 | 接收者 |
| :--- | :--- | :--- | :--- |
| `ROOM_SETTINGS_UPDATED` | `Room` 物件 | `PATCH /rooms/:id`（名稱、頭像、設定） | 所有房間成員 |
| `ROOM_AVATAR_UPDATED` | `{ roomId: string, avatarUrl: string }` | 上傳房間頭像 | 所有房間成員 |
| `ROOM_DELETED` | `{ roomId: string }` | `DELETE /rooms/:id`（封存／刪除） | 所有房間成員 |

#### 成員層級子類型
廣播至房間的所有現有成員。

| `type` | `data` 格式 | 觸發時機 | 接收者 |
| :--- | :--- | :--- | :--- |
| `MEMBER_JOINED` | `{ userId: string }` | 使用者以邀請碼加入（無需審核） | 所有現有房間成員 |
| `MEMBER_APPROVED` | `{ userId: string }` | 待審成員被管理員核准 | 所有現有房間成員 |
| `MEMBER_UPDATED` | `{ userId: string, role?: string, nickname?: string, isMuted?: boolean }` | 成員角色／暱稱／靜音狀態變更 | 所有房間成員 |
| `MEMBER_KICKED` | `{ userId: string }` | 成員被管理員移除 | 所有房間成員（含被移除者） |
| `MEMBER_LEFT` | `{ userId: string }` | 成員主動離開 | 剩餘所有房間成員 |
| `OWNERSHIP_TRANSFERRED` | `{ oldOwner: string, newOwner: string }` | 轉讓群組擁有權 | 所有房間成員 |
| `USER_UPDATED` | `{ userId: string, name?: string, avatarUrl?: string }` | 成員更新自己的個人資料 | 該使用者所在的所有房間 |

#### 個人專屬子類型
**僅**推送至目標使用者的個人 socket 頻道（`user_<userId>`），不廣播至房間。

| `type` | `data` 格式 | 觸發時機 | 接收者 |
| :--- | :--- | :--- | :--- |
| `ROOM_JOINED` | `{}` | 使用者以邀請碼加入**或**待審成員被核准 | 僅限加入 / 被核准的使用者 |

> **客戶端處理建議**：收到 `ROOM_JOINED` 後，客戶端應呼叫 `GET /rooms` 重新整理房間列表；下一次 socket 連線會依持久化成員資格自動建立訂閱，不需呼叫 `join_room`。
