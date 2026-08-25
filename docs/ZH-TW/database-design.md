# 關聯綱要設計 (PostgreSQL 18)

本文件定義了即時群組聊天應用程式的關聯綱要設計。

---

### 核心實體資料表

#### `users` (使用者)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `user_id` | UUID | 使用者唯一識別碼 | PK, 預設值: `gen_random_uuid()` |
| `name` | VARCHAR(255) | 帳號名稱 | NOT NULL |
| `email` | VARCHAR(255) | 電子郵件信箱 | UNIQUE, NOT NULL |
| `password_hash` | VARCHAR(255) | Bcrypt 密碼雜湊值 | NOT NULL |
| `bio` | TEXT | 個人簡介 | |
| `avatar_url` | VARCHAR(2048) | 個人頭像網址或路徑 | |
| `warning_enabled`| BOOLEAN | 是否啟用緊急聯絡人警報模式 | NOT NULL, 預設值: FALSE |
| `warning_days` | INT | 不活躍判定天數，0 表示停用 | NOT NULL, 預設值: 0 |
| `last_activity` | TIMESTAMPTZ | 最後活動時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |
| `created_at` | TIMESTAMPTZ | 註冊時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |
| `deleted_at` | TIMESTAMPTZ | 軟刪除時間標記 | 可為 NULL |
| `lang_preference`| VARCHAR(10)| 語言偏好設定 | NOT NULL, 預設值: 'en' |
| `app_theme` | VARCHAR(10)| UI 主題偏好設定 | NOT NULL, 預設值: 'light', CHECK (app_theme IN ('light', 'dark')) |
| `notify_desktop` | BOOLEAN | 是否啟用桌面通知 | NOT NULL, 預設值: TRUE |
| `notify_sound` | BOOLEAN | 是否啟用聲音通知 | NOT NULL, 預設值: TRUE |
| `room_order` | JSONB | 各資料夾內的聊天室排序（API 欄位：`roomOrder`） | NOT NULL, 預設值: `'{}'` |
| `is_admin` | BOOLEAN | 是否可存取 `/api/v1/admin/*`；無法經由 HTTP 設定 | NOT NULL, 預設值: FALSE |

#### `chat_rooms` (聊天室)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `room_id` | UUID | 聊天室唯一識別碼 | PK, 預設值: `gen_random_uuid()` |
| `type` | VARCHAR(10) | 聊天室類型：可為 'private' 或 'group' | NOT NULL, CHECK (type IN ('private', 'group')) |
| `name` | VARCHAR(255) | 群組聊天室名稱 | |
| `avatar_url` | VARCHAR(2048) | 群組頭像網址 | |
| `invite_code` | VARCHAR(255) | 唯一的加入邀請碼 | UNIQUE INDEX (當 invite_code 不為 NULL 時) |
| `require_approval`| BOOLEAN | 加入群組是否需要擁有者/管理員審核 | NOT NULL, 預設值: FALSE |
| `view_history` | BOOLEAN | 新成員是否能檢視過去的歷史訊息 | NOT NULL, 預設值: TRUE |
| `is_archived` | BOOLEAN | 聊天室是否已封存（封存後變為唯讀） | NOT NULL, 預設值: FALSE |
| `is_readonly` | BOOLEAN | 聊天室是否為唯讀 | NOT NULL, 預設值: FALSE |
| `created_at` | TIMESTAMPTZ | 建立時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |

#### `messages` (訊息)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `message_id` | UUID | 訊息唯一識別碼 | PK, 預設值: `gen_random_uuid()` |
| `room_id` | UUID | 目標聊天室 | FK(`chat_rooms`), NOT NULL, CASCADE DELETE |
| `sender_id` | UUID | 訊息發送者 | FK(`users`), 刪除帳號時設為 SET NULL |
| `content` | TEXT | 訊息文字內容 | NOT NULL |
| `reply_to_id` | UUID | 被引用的訊息 ID | FK(`messages`), 刪除時設為 SET NULL |
| `is_recalled` | BOOLEAN | 訊息是否已被收回 | NOT NULL, 預設值: FALSE |
| `sent_at` | TIMESTAMPTZ | 發送時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |
| `message_sequence` | BIGINT | 建立時固定的聊天室可見順序 | NOT NULL，於鎖定 counter row 時分配 |
| `change_sequence` | BIGINT | 最近一次持久化變更的全域順序 | NOT NULL，每次建立、編輯、收回都分配 |
| `revision` | INTEGER | optimistic concurrency 版本 | NOT NULL，從 1 開始，每次變更遞增 |
| `command_id` | VARCHAR(255) | 建立命令的冪等 key | 與 `sender_id` 建立 partial unique index |

#### `realtime_counters`
單例資料列儲存 `message_sequence` 與 `change_sequence`。訊息變更交易
會鎖定此資料列後才遞增，因此 rollback 不會消耗序號，重試也不會產生
缺口。

#### `message_changes`
供 Sync Cursor 復原使用的持久化變更歷史。每列保存一個
`change_sequence` 的完整訊息投影、固定的 `message_sequence`、`revision`、
`change_type`（`created`、`edited`、`recalled`）、操作者與命令 key。
`mentions` 與 `attachments` 是同一交易寫入的 JSONB snapshot，復原不會把舊訊息版本
與目前 relations 混在一起。`(actor_id, command_id)` 的 partial unique index 讓編輯／收回重試成為 no-op。

#### `message_command_receipts`
保存「確實沒有產生任何變更」的持久化訊息命令的 `(actor_id, command_id)` 收據；
目前唯一的情況是對已收回訊息再次執行收回。這類命令不會寫入 `message_changes`
（收回不得配發第二個 `change_sequence`，也不得再發布一次事件），若沒有這張表，
該 key 就會繼續可被建立或編輯重複使用，但建立、編輯與收回共用同一個 idempotency
namespace。每個命令查詢 key 時都會同時讀取本表與 `message_changes`。
`change_sequence` 指向該命令收斂到的變更，可為 NULL：在持久化 migration 之前
就被收回的訊息沒有對應的 `recalled` 列可指。

#### `attachments` (附件)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `attachment_id` | UUID | 附件唯一識別碼 | PK, 預設值: `gen_random_uuid()` |
| `message_id` | UUID | 關聯的訊息 ID | FK(`messages`), CASCADE DELETE |
| `uploaded_by` | UUID | 上傳者使用者 ID | FK(`users`), 刪除帳號時設為 SET NULL |
| `file_path` | VARCHAR(255) | 檔案儲存路徑 | NOT NULL |
| `file_type` | VARCHAR(50) | 檔案 MIME 類型 | NOT NULL |
| `original_name` | VARCHAR(255) | 原始上傳的檔案名稱 | NOT NULL |
| `uploaded_at` | TIMESTAMPTZ | 上傳時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |

---

### 關係與輔助資料表

#### `room_members` (聊天室成員)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `room_id` | UUID | 聊天室唯一識別碼 | PK, FK(`chat_rooms`), CASCADE DELETE |
| `user_id` | UUID | 成員使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `role` | VARCHAR(10) | 成員角色：'owner', 'admin', 'member', 'pending' | NOT NULL, 預設值: 'member', CHECK (role IN ('owner', 'admin', 'member', 'pending')) |
| `nickname` | VARCHAR(255) | 成員在此聊天室的自訂暱稱 | |
| `is_muted` | BOOLEAN | 成員在此聊天室是否被禁言 | NOT NULL, 預設值: FALSE |
| `last_read_id` | UUID | 最後已讀的訊息 ID | FK(`messages`), 刪除時設為 SET NULL |
| `join_time` | TIMESTAMPTZ | 加入聊天室時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |
| `join_boundary` | BIGINT | 成員啟用時可見的最高訊息序號 | NOT NULL, 預設值: 0 |
| `read_position` | BIGINT | 成員已確認的最高訊息序號 | NOT NULL, 預設值: 0 |

`join_boundary` 會在鎖定 counter row 時擷取。歷史與 sync 查詢每次都套用
此邊界，因此隱藏歷史的聊天室不會洩漏加入前訊息；`read_position` 只會
向前移動，`last_read_id` 則保留作為 API 相容投影。

#### `read_position_commands`
儲存 `(user_id, command_id)` 的已讀命令 receipt，`message_id` 記錄命令目標，讓重試安全；
位置更新使用 `GREATEST(read_position, target_sequence)`。

#### `friendships` (好友關係)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `requester_id` | UUID | 發送好友邀請的使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `addressee_id` | UUID | 接收好友邀請的使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `status` | VARCHAR(20) | 好友關係狀態：'pending' 或 'accepted' | NOT NULL, CHECK (status IN ('pending', 'accepted')) |
| `created_at` | TIMESTAMPTZ | 邀請建立時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |

#### `blocks` (封鎖關係)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `blocker_id` | UUID | 封鎖者使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `blocked_id` | UUID | 被封鎖者使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `created_at` | TIMESTAMPTZ | 封鎖建立時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |

#### `folders` (分類資料夾)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `folder_id` | UUID | 資料夾唯一識別碼 | PK, 預設值: `gen_random_uuid()` |
| `user_id` | UUID | 建立此資料夾的使用者 ID | FK(`users`), CASCADE DELETE, NOT NULL |
| `name` | VARCHAR(50) | 資料夾名稱 | NOT NULL |
| `created_at` | TIMESTAMPTZ | 資料夾建立時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |

#### `folder_rooms` (資料夾內容)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `folder_id` | UUID | 資料夾唯一識別碼 | PK, FK(`folders`), CASCADE DELETE |
| `room_id` | UUID | 聊天室唯一識別碼 | PK, FK(`chat_rooms`), CASCADE DELETE |
| `user_id` | UUID | 擁有者使用者 ID (用於限制唯一性範圍) | FK(`users`), NOT NULL |
| `UNIQUE(user_id, room_id)` | | 限制每個使用者的一個聊天室只能加入一個資料夾 | |

#### `emergency_contacts` (緊急聯絡)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `user_id` | UUID | 帳號擁有者使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `contact_id` | UUID | 緊急聯絡人使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `message` | TEXT | 觸發緊急求救時發送的警報訊息範本 | NOT NULL |
| `created_at` | TIMESTAMPTZ | 緊急聯絡設定時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |

#### `message_mentions` (訊息提及)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `message_id` | UUID | 訊息唯一識別碼 | PK, FK(`messages`), CASCADE DELETE |
| `user_id` | UUID | 被提及的使用者 ID | PK, FK(`users`), CASCADE DELETE |

#### `refresh_tokens` (更新權杖)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `token_id` | UUID | 更新權杖的識別碼 | PK, 預設值: `gen_random_uuid()` |
| `user_id` | UUID | 使用者 ID | FK(`users`), CASCADE DELETE, NOT NULL |
| `token_hash` | VARCHAR(255) | 權杖的雜湊值 | UNIQUE, NOT NULL |
| `expires_at` | TIMESTAMPTZ | 到期時間 | NOT NULL |
| `created_at` | TIMESTAMPTZ | 建立時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |
| `revoked_at` | TIMESTAMPTZ | 撤銷時間標記 | 可為 NULL |
| `replaced_by` | UUID | 取代此權杖的新權杖 ID | FK(`refresh_tokens`), 刪除時設為 SET NULL |

#### `emergency_alert_logs` (緊急警報日誌)
| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `user_id` | UUID | 使用者 ID | PK, FK(`users`), CASCADE DELETE |
| `last_activity_at`| TIMESTAMPTZ| 使用者最後活動時間 | PK, NOT NULL |
| `alerted_at` | TIMESTAMPTZ | 警報觸發時間標記 | NOT NULL, 預設值: CURRENT_TIMESTAMP |
