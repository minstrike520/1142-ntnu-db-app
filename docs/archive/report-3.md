# Project Report 3
第 9 組
專題名稱：即時通訊系統
組員：江禹叡、楊銘煌、趙偉恆、姚承希

## 一、ER-diagram

![ER-digram](./ER_Digram.png)

- RoomMember 改為關係而非原本的弱實體關係
- send、last_read 改為與 User, ChatRoom 兩表 aggregation 的關係

## 二、DDL 

本章節以 PostgreSQL DDL 形式描述系統規劃採用的主要資料表、關聯表與支援表。

### 核心實體表

```sql
CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  bio TEXT,
  avatar_url VARCHAR(2048),
  warning_enabled BOOLEAN NOT NULL DEFAULT false,
  warning_days INTEGER NOT NULL DEFAULT 0,
  last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ DEFAULT NULL,
);

CREATE TABLE chat_rooms (
  room_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(10) NOT NULL CHECK (type IN ('private', 'group')),
  name VARCHAR(255),
  avatar_url VARCHAR(2048),
  invite_code VARCHAR(255),
  require_approval BOOLEAN NOT NULL DEFAULT false,
  view_history BOOLEAN NOT NULL DEFAULT true,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX chat_rooms_invite_code_unique
  ON chat_rooms (invite_code)
  WHERE invite_code IS NOT NULL;

CREATE TABLE messages (
  message_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES chat_rooms(room_id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  reply_to_id UUID REFERENCES messages(message_id) ON DELETE SET NULL,
  is_recalled BOOLEAN NOT NULL DEFAULT false,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_pagination
  ON messages (room_id, sent_at DESC, message_id DESC);

CREATE TABLE attachments (
  attachment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID REFERENCES messages(message_id) ON DELETE CASCADE,
  uploaded_by UUID REFERENCES users(user_id) ON DELETE SET NULL,
  file_path VARCHAR(255) NOT NULL,
  file_type VARCHAR(50) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 關係、弱實體與支援表

```sql
CREATE TABLE room_members (
  room_id UUID NOT NULL REFERENCES chat_rooms(room_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'pending')),
  nickname VARCHAR(255),
  is_muted BOOLEAN NOT NULL DEFAULT false,
  last_read_id UUID REFERENCES messages(message_id) ON DELETE SET NULL,
  join_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE friendships (
  requester_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  addressee_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'accepted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (requester_id, addressee_id),
  CONSTRAINT friendships_no_self_friendship CHECK (requester_id <> addressee_id)
);

CREATE TABLE blocks (
  blocker_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_no_self_block CHECK (blocker_id <> blocked_id)
);

CREATE TABLE folders (
  folder_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE folder_rooms (
  folder_id UUID NOT NULL REFERENCES folders(folder_id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES chat_rooms(room_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, room_id),
  UNIQUE (user_id, room_id)
);

CREATE TABLE emergency_contacts (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, contact_id),
  CONSTRAINT emergency_contacts_no_self_contact CHECK (user_id <> contact_id)
);

CREATE TABLE message_mentions (
  message_id UUID NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE emergency_alert_logs (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  last_activity_at TIMESTAMPTZ NOT NULL,
  alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, last_activity_at)
);
```

### 補充說明

- `attachments.message_id` 規劃允許為 `NULL`，以支援先上傳附件、後綁定訊息，因為附件上傳使用 http，而訊息使用 socket.io，傳送時間可能有落差。

## 三、系統內容功能詳細敘述

### 1. 帳號與個人設定
- **註冊與登入**：使用者可透過電子郵件與密碼進行註冊與登入。
- **個人資料管理**：系統紀錄使用者資訊，如顯示名稱、頭像、個人簡介等，使用者可隨時進行修改。
- **個人偏好設定**：使用者可自訂系統介面主題（深色/淺色模式）、顯示語言（繁體中文/英文），以及啟用或禁用桌面通知與訊息音效。
- **帳號刪除**：使用者可申請刪除帳號。帳號刪除後將無法被搜尋且無法再次登入，但為了保持對話歷史的完整性與脈絡，其先前發送的聊天訊息仍會保留並呈現給其他聊天成員。
- **自動聯絡模式**：使用者可啟用或禁用自動聯絡功能，自訂未上線的天數時限，並指定多位緊急聯絡人以及預設的聯絡訊息。當使用者未活躍上線的天數超過設定時限，系統會自動發送警報並將訊息送達指定的緊急聯絡人。

### 2. 好友與社交關係管理
- **好友搜尋與邀請**：使用者可透過帳號名稱、電子信箱或使用者 ID 搜尋其他使用者，並送出好友邀請，對方收到通知後可選擇接受或拒絕。
- **自動建立私聊**：當好友邀請被接受時，系統會建立雙方的好友關係。若雙方先前未曾建立私聊，系統會自動為雙方建立一個新的私訊聊天室；若已存在既有私訊聊天室，系統則會直接導向該聊天室，避免重複建立聊天室。
- **好友刪除**：使用者可刪除好友關係，刪除後雙方不再是好友，但可重新發送好友邀請。
- **封鎖機制**：使用者可單向封鎖其他使用者，封鎖後系統將拒絕對方的任何好友邀請或互動請求，且雙方的私訊聊天室將被限制為唯讀狀態。使用者亦可隨時解除封鎖。

### 3. 聊天室與群組管理
系統支援「私訊」與「群組」兩類聊天室。群組擁有四種身份等級：擁有者、管理員、一般成員、待審核，各自具備不同的操作與管理權限。
- **一般成員以上權限**：
  - 設定自己在該群組內的專屬暱稱。
  - 分享群組邀請代碼。
- **管理員與擁有者權限**：
  - 設定群組名稱與群組圖像。
  - 設定或修改其他成員的群組暱稱。
  - 控制新加入成員是否能查看加入之前的群組歷史訊息。
  - 將違規成員禁言（限制其發送訊息的權限）或解除禁言。
  - 踢出一般成員。
  - 刪除其他成員發送的訊息。
  - 開啟或關閉加入審核機制；若開啟，負責審核新成員的加入申請。
- **僅擁有者權限**：
  - **群組所有權轉移**：擁有者若欲退出群組，必須先指派並將所有權轉移給群組內的另一位成員，以確保群組在任何時候都有且僅有一位擁有者。
  - **封存群組**：擁有者可將群組封存，封存後群組將進入唯讀狀態，成員無法再傳送新訊息，但仍可閱讀歷史對話。
  - **刪除群組**：擁有者可將群組徹底刪除。
  - 指派或取消管理員身分。

### 4. 即時訊息與多媒體互動
- **即時訊息傳送**：使用者可在加入的聊天室中發送文字訊息。
- **訊息回覆與引用**：使用者可指定回覆聊天室中的某一則特定訊息，並在介面上顯示被回覆的引用內容。
- **提及標記 (@Mention)**：使用者可在訊息中以 `@成員名稱` 的格式標記聊天室內的其他成員。被標記的成員將在介面上獲得高亮顯示或特別通知。
- **訊息收回**：使用者可收回自己發送的訊息，收回後該訊息內容對所有成員隱藏，不會顯示。
- **已讀標示**：聊天介面會即時顯示其他成員的已讀進度（顯示誰讀到了哪一則訊息），系統在更新成員已讀進度時會進行房間安全比對，確保不會發生跨聊天室的已讀狀態混亂。
- **輸入狀態提示**：當使用者正在聊天室內輸入訊息時，其他成員可在聊天介面上看到即時的「正在輸入中...」狀態提示。
- **媒體附件**：使用者可上傳並發送圖片或檔案作為訊息附件，供聊天室成員下載或預覽。
- **刪除帳號訊息呈現**：若發送訊息的使用者帳號已被刪除，其發送的歷史訊息仍會保留，但訊息發送者將會顯示為空值（表示發送者已刪除）。

### 5. 聊天室資料夾分類
- **建立分類資料夾**：使用者可建立自訂資料夾，並將不同的私聊或群組聊天室加入資料夾中進行分類收納。
- **收納限制**：每個資料夾均屬於單一使用者。為維持側邊欄清晰度，同一個聊天室在同一位使用者的版面上，只能被歸類到最多一個資料夾中，不可重複分類。

## 四、系統功能實作規劃

### 1. 系統流程

#### 身分驗證與註冊流程

```mermaid
flowchart TD
    Start([開始]) --> Choice{註冊或登入？}

    Choice -- 註冊 --> RegInput[輸入名稱、信箱、密碼與確認密碼]
    RegInput --> RegValid{格式與密碼一致性驗證}
    RegValid -- 失敗 --> RegErr[提示錯誤訊息] --> RegInput
    RegValid -- 成功 --> CheckEmailExist{信箱是否已被註冊？}
    CheckEmailExist -- 是 --> RegErr
    CheckEmailExist -- 否 --> Bcrypt[密碼進行 bcrypt 加密]
    Bcrypt --> DBInsertUser[(寫入 users 資料表)]
    DBInsertUser --> RegSuccess[註冊成功] --> LoginInput

    Choice -- 登入 --> LoginInput[輸入信箱與密碼]
    LoginInput --> CheckUser{帳號是否存在且未被刪除？}
    CheckUser -- 否 --> LoginErr[提示信箱或密碼錯誤] --> LoginInput
    CheckUser -- 是 --> VerifyHash{比對密碼雜湊}
    VerifyHash -- 失敗 --> LoginErr
    VerifyHash -- 成功 --> GenJWT[產生 JWT Token]
    GenJWT --> SetCookie[設定 HttpOnly Cookie 或 Authorization]
    SetCookie --> RedirectMain[跳轉至主對話介面]
    RedirectMain --> End([結束])
```

#### 好友社交與封鎖邏輯流程

##### 1. 發送好友邀請流程
```mermaid
flowchart TD
    Start([開始]) --> CheckSelf{是否為自己？}
    CheckSelf -- 是 --> FailMsg[拒絕操作並報錯]
    CheckSelf -- 否 --> CheckBlocked{雙方是否存在封鎖關係？}
    CheckBlocked -- 是 --> FailMsg
    CheckBlocked -- 否 --> CheckPending{是否已有 pending 或 accepted 關係？}
    CheckPending -- 是 --> FailMsg
    CheckPending -- 否 --> InsertFriend[(寫入 friendships, status='pending')]
    InsertFriend --> NotifyUser[透過 Socket 發送好友邀請通知] --> End([結束])
```

##### 2. 回應好友邀請流程
```mermaid
flowchart TD
    Start([開始]) --> AcceptOrReject{接受或拒絕？}
    AcceptOrReject -- 接受 --> UpdateFriendAccepted[(更新 friendships 為 accepted)]
    UpdateFriendAccepted --> FindPrivateRoom{是否已有既有私聊？}
    FindPrivateRoom -- 是 --> ReturnExistingRoom[回傳既有 private room]
    FindPrivateRoom -- 否 --> CreatePrivateRoom[(建立 private chat_rooms)]
    CreatePrivateRoom --> InsertRoomMembers[(寫入雙方 room_members)]
    ReturnExistingRoom --> End([結束])
    InsertRoomMembers --> End

    AcceptOrReject -- 拒絕 --> DeletePending[(刪除 pending 好友邀請)] --> End
```

##### 3. 封鎖對象流程
```mermaid
flowchart TD
    Start([開始]) --> InsertBlock[(寫入 blocks)]
    InsertBlock --> SetRoomReadonly[若存在私聊則設為 is_readonly=true]
    SetRoomReadonly --> End([結束])
```

#### 聊天室與群組生命週期流程

##### 1. 建立群組流程
```mermaid
flowchart TD
    Start([開始]) --> CreateGroupRoom[(寫入 chat_rooms, type='group')]
    CreateGroupRoom --> InsertOwnerMember[(寫入 room_members, role='owner')]
    InsertOwnerMember --> InitFolder{是否加入資料夾？}
    InitFolder -- 是 --> GroupFolderMapping[(寫入 folder_rooms)] --> End([結束])
    InitFolder -- 否 --> End([結束])
```

##### 2. 使用邀請碼加入群組流程
```mermaid
flowchart TD
    Start([開始]) --> ReviewNeeded{是否需審核？}
    ReviewNeeded -- 是 --> InsertPending[(寫入 room_members, role='pending')] --> End([結束])
    ReviewNeeded -- 否 --> InsertNewMember[(寫入 room_members, role='member')] --> End([結束])
```

##### 3. 退出群組流程
```mermaid
flowchart TD
    Start([開始]) --> CheckRole{成員角色}
    CheckRole -- 一般成員或管理員 --> DeleteMember[(刪除 room_members)] --> End([結束])
    CheckRole -- 擁有者 --> NeedTransfer[需先轉移 ownership]
    NeedTransfer --> TransferFlow[指定新 owner]
    TransferFlow --> DBUpdateOwner[(更新舊 owner 為 member, 新 owner 為 owner)]
    DBUpdateOwner --> DeleteMember
```

##### 4. 封存群組流程
```mermaid
flowchart TD
    Start([開始]) --> ArchiveRoom[(更新 chat_rooms.is_archived=true)]
    ArchiveRoom --> End([結束])
```

#### 即時訊息發送與讀取狀態流程

```mermaid
flowchart TD
    Start([開始]) --> JoinRoom[客戶端送出 join_room]
    JoinRoom --> CheckMembership{是否為房間成員？}
    CheckMembership -- 否 --> ErrorJoin[回傳 error 事件]
    CheckMembership -- 是 --> Subscribed[加入 room_roomId 頻道]

    Subscribed --> MsgInput[輸入訊息內容、replyTo 與 attachmentIds]
    MsgInput --> CheckRoomState{聊天室是否可發言？}
    CheckRoomState -- 否 --> ErrorDeny[回傳 403 或 error]
    CheckRoomState -- 是 --> CheckMuted{是否被禁言？}
    CheckMuted -- 是 --> ErrorDeny
    CheckMuted -- 否 --> ValidateAttachments{附件是否存在且可綁定？}
    ValidateAttachments -- 否 --> ErrorDeny
    ValidateAttachments -- 是 --> InsertMsg[(寫入 messages)]
    InsertMsg --> BindAttachments[(更新 attachments.message_id)]
    BindAttachments --> ParseMentions{是否有 @提及？}
    ParseMentions -- 是 --> ResolveUsers[解析聊天室內使用者]
    ResolveUsers --> InsertMentions[(寫入 message_mentions)]
    ResolveUsers --> EmitRealtime
    ParseMentions -- 否 --> EmitRealtime[透過 Socket.io 廣播給其他成員]

    EmitRealtime --> ReceiversRead[其他成員閱讀訊息]
    ReceiversRead --> EmitReadReceipt[客戶端送出已讀回應]
    EmitReadReceipt --> CheckMsgRoom{messageId 是否屬於該 roomId？}
    CheckMsgRoom -- 否 --> IgnoreReceipt[拒絕更新並回傳 error]
    CheckMsgRoom -- 是 --> DBUpdateRead[(更新 room_members.last_read_id)]
    DBUpdateRead --> EmitReadUpdate[廣播 read_update] --> End([結束])
```

#### 緊急聯絡與不活躍檢查流程

```mermaid
flowchart TD
    Start([啟動排程或手動檢查]) --> GetActiveUsers[查詢 warning_enabled=true 且 warning_days > 0 的 User]
    GetActiveUsers --> LoopUsers{逐一檢查 User}

    LoopUsers -- 結束 --> End([結束])
    LoopUsers -- 尚有使用者 --> CheckInactivity{現在時間 - last_activity > warning_days？}

    CheckInactivity -- 否 --> LoopUsers
    CheckInactivity -- 是 --> CheckAlreadyAlerted{同一 last_activity 是否已通知過？}

    CheckAlreadyAlerted -- 是 --> LoopUsers
    CheckAlreadyAlerted -- 否 --> FetchContacts[查詢 emergency_contacts]
    FetchContacts --> LoopContacts{逐一通知聯絡人}

    LoopContacts -- 有聯絡人 --> SendAlert[發送訊息通知]
    SendAlert --> LoopContacts
    LoopContacts -- 結束 --> InsertLog[(寫入 emergency_alert_logs)] --> LoopUsers
```

### 2. 介面設計規劃
- **A. 登入與註冊頁面**
  - 註冊提供 email, password, name 等基本欄位，其餘之後至個人設定頁面中設定。
  - 登入成功後導向主界面。

- **B. 主介面**
  - 以類似分頁的型態切換四個頁面：聊天室、好友列表（包含新增好友與同意邀請功能）、緊急自動聯絡設定、個人設定
  - 聊天室採三欄配置：左側資料夾與聊天室列表、中間訊息區、右側群組為成員列表，私聊顯示好友個人資料。
  - 訊息區規劃支援回覆、提及、附件下載、已讀標示與輸入中提示。

### 3. 專案開發技術

採用容器化開發，將系統劃分為前端、後端與資料庫，並以 Docker Compose 進行本機與部署的統籌管理。

#### Docker 容器化技術
- 使用 `Docker Compose` 來統籌並連接三個主要容器服務：`db`、`backend`以及 `frontend`。
- 所有環境變數皆於專案根目錄的 `.env` 檔中統一宣告，由 Docker Compose 自動注入各個容器，確保開發與生產環境設定分離。

#### 前端開發技術
- 採用 `Next.js` 框架開發。
- 使用 React Context (`ChatContext`) 管理全域對話狀態與認證狀態；即時連線方面使用 `socket.io-client` 處理 WebSocket 即時事件。

#### 後端開發技術
- 使用 `Node.js`、`Express` 與 `TypeScript` 建立 RESTful API 伺服器，並搭載 `Socket.IO` 實作實時雙向事件發送。
- 身分驗證基於 `JSON Web Token (JWT)`，密碼加密採用 `bcryptjs` 進行高安全性單向雜湊。
- 使用 `Routes -> Controllers -> Services -> Repositories` 分層設計。
  1. **Routes**：定義 REST API 與 middleware 組裝方式。
  2. **Controllers**：處理 HTTP request / response，呼叫對應的 Service 來執行核心邏輯。
  3. **Services**：封裝系統規則邏輯，例如群組權限檢查、封鎖限制、訊息驗證。
  4. **Repositories**：與資料庫溝通，使用 SQL 操作資料庫。


#### 資料庫管理與操作 
- 使用 `PostgreSQL` 作為系統的主要關聯式資料庫。
- 使用原生 `pg` 客戶端連線池 (`pg.Pool`) 直接對資料庫下達參數化 SQL 查詢指令，確保最優化且安全的 SQL 語法執行速度。
- 使用 `node-pg-migrate` 管理資料庫結構版本，以 SQL Migration 腳本形式紀錄資料表的每一次結構變動。

## 五、預定工作分配

- 楊銘煌：前端界面設計、好友功能、Docker 維護
- 姚承希：前端架構、聊天室
- 趙偉恆：使用者帳號、緊急聯絡功能
- 江禹叡：後端伺服器架構、聊天訊息

# 附錄：Project Report 1

## 專題名稱
即時文字通訊系統

## 1. 專題動機與目標

### 動機
目前市面上的通訊軟體常呈現兩極化的發展：如 LINE、Messenger 等軟體雖然普及，但群組管理功能過於扁平簡單，缺乏精細的權限控管；而如 Discord 等軟體雖然權限完備，但多頻道伺服器的架構對一般使用者而言又過於龐大複雜。此外，隨著人口老化、獨居長者比例攀升，以及眾多青年學子與上班族隻身在外地求學工作，社會上對於「緊急狀態回報」與「自動聯絡」的需求日益增加。

### 第一階段目標

1. 實作私訊與群組聊天室
2. 打造具備高度自訂性的群組權限管理
3. 提供「聊天室分類資料夾」功能，解決聊天室雜亂問題。
4. 提供自動聯絡與緊急狀態回報功能，若多日未上線則傳送警告給緊急聯絡人。

### 第二階段目標（Out of Scope）

在第一階段實做完成後，挑戰導入端對端加密（E2E Encryption），讓歷史訊息以密文形式儲存於資料庫，並實作前端本地解密搜尋，達到極致的隱私安全。

## 2. 名詞界定

- 使用者：已註冊者
- 聊天室：私訊與群組的統稱
- 封鎖者/封鎖對象：以 A 封鎖 B 為例：對於 A 而言，B 是封鎖對象；對於 B 而言，A 是封鎖者。

## 3. 系統功能

### 帳號與個人設定
- 完成註冊並登入系統的使用者稱為**一般使用者**。
- 使用者可透過電子郵件與密碼進行註冊與登入。
- 系統須紀錄使用者資訊，如顯示名稱、頭像、個人簡介等。
- 使用者可建立「分類資料夾」，將好友私訊或不同群組歸納整理。

### 好友管理
- 使用者可依名稱或 ID 搜尋可加為好友的對象。
- 使用者可向目標使用者送出邀請，對方收到通知後可接受或拒絕。
- 好友邀請接受後立即建立私訊聊天室。
- 使用者可封鎖任意好友與解除封鎖
- 使用者可刪除好友，刪除後可再次發送邀請

### 聊天室

- 傳送文字訊息。
- 傳送附件（圖片或其他檔案）。
- 可收回自己發的訊息。
- 聊天界面有「已讀標示」（顯示誰讀到哪一則訊息）。
- 在傳送訊息時可指定為回覆之前的某一則訊息。
- 可在訊息中提及 (@) 聊天室中的其他使用者。

### 群組功能
群組有四種不同身份等級：擁有者、管理員、一般成員、待審核。不同身份具備不同的操作權限。

- **一般成員以上皆可使用**
    - 設定自己的群組暱稱
    - 分享邀請代碼（連結）

- **管理員與擁有者可使用**
    - 設定群組名稱、圖像
    - 設定其它成員的群組暱稱
    - 設定新成員是否可見加入前的歷史訊息
    - 將違規成員禁言
    - 踢出一般成員
    - 刪除一般成員的訊息
    - 設定新成員加入是否需要經過審核
    - 審核加入申請

- **僅擁有者可使用**
    - 封存群組
    - 刪除群組
    - 指派管理員

### 自動聯絡
- 使用者可啟用/禁用自動聯絡功能。
- 使用者可設定自動聯絡的時限。
- 使用者可指定自動聯絡的對象。

## 4. 資料分析
- **使用者**
    - 帳號名稱
    - 個人簡介
    - 頭貼
    - email
    - 最後登入時間
    - 未登入發送警告的天數
- **分類資料夾**
    - 資料夾名稱
    - 所屬使用者
    - 資料夾內的聊天室列表
- **好友關係**
    - 發送邀請者
    - （待）接受邀請者
    - 好友關係狀態（如待確認、已接受）
- **聊天室資料與設定**
    - 聊天室是私訊還是群組
    - 是否唯讀（私聊封鎖、群組封存）
    - 群組專用：
        - 群組圖示、名稱
        - 群組邀請代碼（可轉換為連結）
        - 各種設定包含是否需要加入審核、檢視歷史訊息
- **聊天室成員**
    - 使用者 ID
    - 聊天室 ID
    - 最後已讀訊息 ID（用於顯示已讀狀態）
    - 群組專用：
        - 群組身份（擁有者、管理員、一般成員、待審核）
        - 暱稱
        - 加入時間（用於判斷歷史訊息）
        - 是否被禁言
- **訊息**
    - 訊息內容
    - 傳送者
    - 所屬聊天室
    - 發送時間
    - 回覆的訊息 ID （選填）
- **附件**
    - 檔案路徑
    - 檔案類型
    - 原始檔名
    - 上傳時間
- **緊急自動聯絡人**
    - 使用者 ID
    - 緊急自動聯絡人 ID
- **封鎖**
    - 封鎖者 ID
    - 被封鎖者 ID

## 5. 資料關聯分析

- 一個好友關係對應兩個使用者。為了用於好友邀請，要紀錄是誰發給誰，還有目前的狀態。
- 一個資料夾對應使用者
- 資料夾與聊天室為多對多的關係，但是聊天室不能對應到同一個人的多個資料夾，只能一個使用者的其中一個
- 聊天室最少對應兩個使用者，私訊聊天是最多對應到兩個使用者，群組則無上限
- 聊天室有多則訊息
- 一則訊息對應一個使用者
- 一則訊息可回覆另一則訊息
- 一則訊息可附帶多個附件
- 一個使用者可以設置多個緊急自動聯絡人
- 一個使用者可以封鎖多個好友

## 6. 運作規則
1. 使用者
    - 每個帳號的電子郵件與使用者名稱必須唯一
    - 密碼不得以明文儲存，必須儲存雜湊值
2. 分類資料夾
    - 每個人只能把一個聊天室拉到一個資料夾，不能同時分到兩個資料夾
3. 好友系統
    - 使用者不可對自己發送好友邀請
    - 兩位使用者之間只能存在一筆好友關係紀錄
    - 非好友關係的使用者不可互相發送私訊
4. 私人聊天室
    - 加入好友後，若先前建立過兩人的聊天室則解除唯獨狀態，沒有則建立新聊天室
    - 被封鎖或刪除好友以後私訊聊天室轉為唯讀
5. 群組
    - 每個群組必須有且只有一位擁有者
    - 擁有者一定具有管理員的所有權限
    - 擁有者退出群組前，必須先將身分轉讓，否則拒絕退出操作
    - 同一使用者在同一群組中只能有一筆成員紀錄
    - 管理員可對成員進行禁言與踢出等動作，管理員無法對其他管理員進行動作
    - 每個人可設定自己的暱稱，而管理員可設定一般成員的暱稱
6. 訊息與附件
    - 若使用者帳號被刪除，其訊息仍予保留，僅標記發送者為已刪除狀態。
    - 附件必須對應到存在的訊息，不允許孤立紀錄
    - 若回覆的訊息不存在，則顯示「該訊息已被刪除」
7. 緊急自動聯絡人
    - 未上線天數達設置時，會自動發送使用者設置的緊急訊息
