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
| `message_seq` | BIGINT | 建立順序，建立時指派後永不改變，用於排序聊天室訊息串 | NOT NULL, UNIQUE, 由 trigger 指派 |
| `change_seq` | BIGINT | 每次變更都前進，用於排序全域變更串流 | NOT NULL, UNIQUE, 由 trigger 指派 |
| `revision` | INTEGER | 建立時為 1，每次成功變更後遞增；僅在單一訊息內有意義，不可跨訊息比較 | NOT NULL, 預設值: 1 |
| `client_command_id` | UUID | 發送端提供的命令識別碼，用於讓重送的發送操作具冪等性 | UNIQUE (`sender_id`, `client_command_id`)，僅在非 NULL 時生效 |

#### `message_sequence_counter` (序號計數器)
`message_seq` 與 `change_seq` 背後的單列計數器。序號由 `next_message_seq()` **在寫入交易內** 發放，因此該列的鎖會持有至 COMMIT，發號順序即等於提交順序。此處不可改用 PostgreSQL sequence：`nextval()` 不受交易保護，先取號的交易可能在後取號的交易之後才提交，而游標已越過較大號碼的讀者將永久且靜默地跳過較小的號碼。詳見 [ADR-0003](../adr/0003-change-sequence-from-transactional-counter.md)。

| 欄位名稱 | 類型 | 說明 | 條件約束 |
| :--- | :--- | :--- | :--- |
| `counter_id` | BOOLEAN | 將此表固定為單一列 | PK, 預設值: TRUE, CHECK (`counter_id`) |
| `current_seq` | BIGINT | 目前已發放的最大號碼 | NOT NULL, 預設值: 0 |

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
| `last_read_id` | UUID | 最後已讀的訊息 ID，為 `last_read_seq` 的反正規化對應欄位 | FK(`messages`), 刪除時設為 SET NULL |
| `join_time` | TIMESTAMPTZ | 加入聊天室時間 | NOT NULL, 預設值: CURRENT_TIMESTAMP |
| `join_seq` | BIGINT | Join Boundary：`message_seq` 小於或等於此值的訊息皆早於此成員加入 | NOT NULL, 預設值: 0 |
| `last_read_seq` | BIGINT | Read Position，以 `message_seq` 表達，且只能向前移動 | NOT NULL, 預設值: 0 |

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
