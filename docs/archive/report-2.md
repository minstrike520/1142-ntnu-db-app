# Project Report 2
第 9 組
組員：江禹叡、楊銘煌、趙偉恆、姚承希

## 資料分析
- **使用者**
    - 帳號名稱
    - 個人簡介
    - 頭貼連結
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

## ER-digram
![1142-db-project-report2-group9.drawio](https://hackmd.io/_uploads/SJzWFHqRZg.png)



### Entities

- 使用者 (User)
    - user_id (Primary Key): 使用者唯一識別碼。
    - name (Unique): 帳號名稱。
    - email (Unique): 電子信箱。
    - password_hash: 雜湊後的密碼。
    - bio: 個人簡介。
    - avatar_URL: 頭像路徑。
    - warning_enabled: 遺言模式是否開啟。
    - warning_days: 幾天未上線觸發遺言。
    - last_activity: 用於自動聯絡觸發的最後活躍時間紀錄。

- 資料夾 (Folder)
    - folder_id (Primary Key): 資料夾唯一識別碼。
    - name: 使用者自訂的分類名稱。
    - created_time: 建立時間。

- 聊天室 (ChatRoom)
    - room_id (Primary Key): 聊天室唯一識別碼。
    - type: 類型（私訊、群組）。
    - name（群組專用）: 群組名稱
    - create_time: 建立時間。
    - is_archived: 是否已封存（私聊被封鎖或群組封存）
    - invited_code（群組專用）: 群組邀請代碼。
    - avatar_URL（群組專用）: 群組頭像。
    - require_approval（群組專用）: 是否需要管理員審核才能加入。
    - view_history（群組專用）: 新加入成員是否可查看歷史訊息

- 訊息 (Message)
    - message_id (Primary Key): 訊息唯一識別碼。
    - content: 訊息文字內容。
    - sent_time: 發送時間。
    - is_recalled: 是否已被收回。

- 附件 (Attachment)
    - attachment_id (Primary Key): 附件編號。
    - file_path: 伺服器儲存路徑。
    - file_type: 檔案類型（MIME type）。
    - original_filename: 原始檔名。
    - uploaded_at: 上傳時間。

- 聊天室成員 (RoomMember) —— Weak Entity
    - 依賴表： User (user_id), ChatRoom (room_id)
    - 依賴欄位： 複合主鍵由 User.user_id 與 ChatRoom.room_id 組成。
    - role: 成員身分（擁有者、管理員、一般成員、待申請）。
    - nickname: 使用者在該聊天室的專屬暱稱。
    - join_time: 加入時間。
    - is_mute: 是否被禁言。

### Relationships

- 好友關係 (friend)
    - 連結實體： User - User (自關聯)
    - 基數： (0, N) - (0, N)
    - 屬性： status (狀態：待確認、已接受)、establish time (建立時間)。
    - 說明： 紀錄雙方的好友邀請與成立狀態。

- 封鎖關係 (blocks)
    - 連結實體： User - User (自關聯)
    - 基數： (0, N) - (0, N)
    - 說明： 單向紀錄誰封鎖了誰，影響訊息發送權限。

- 資料夾擁有權 (owns)
    - 連結實體： User - Folder
    - 基數： (0, N) - (1, 1)
    - 說明： 一個資料夾必屬於一位使用者。

- 資料夾收納內容 (contains)
    - 連結實體： Folder - ChatRoom
    - 基數： (0, N) - (0, N)
    - 說明： 多對多關係。聊天室分類至使用者特定資料夾，一個聊天室亦可被不同使用者的資料夾收納，但須注意不可同時分類至同一使用者的多個資料夾。

- 成員身分識別 (is_member)
    - 連結實體： User - RoomMember
    - 基數：
      - User 端：(0, N)
      - RoomMember 端：(1, 1) (識別性關聯)

- 成員歸屬聊天室 (belongs to)
    - 連結實體： RoomMember - ChatRoom
    - 基數：
      - RoomMember 端：(1, 1) (識別性關聯)
      - ChatRoom 端：(2, N) 每個聊天室至少須有兩位成員紀錄。

- 最後已讀位置 (last_read)
    - 連結實體： RoomMember - Message
    - 基數：
      - RoomMember 端：(1, 1) 每個成員在該聊天室僅有一筆已讀進度。
      - message 端：(0, N) 一則訊息可以是多人的已讀進度。
    - 說明： 水位線機制，紀錄成員讀取到的最後一則訊息 ID，用於未讀通知。
    - 未讀通知採事件觸發，新訊息觸發事件，通知還沒讀到的人，不多做欄位

- 訊息發送 (sends)
    - 連結實體： User - Message
    - 基數： (0, N) - (1, 1)
    - 說明： 一則訊息必由一位使用者發出。

- 訊息所屬聊天室 (belongs to)
    - 連結實體： Message - ChatRoom
    - 基數： (1, 1) - (0, N)
    - 說明：一個訊息必屬於一個聊天室。

- 訊息提及 (mentions)
    - 連結實體： User - Message
    - 基數： (0, N) - (0, N)
    - 說明： 紀錄訊息中標記（@mention）了哪些使用者。

- 訊息回覆 (reply_to)
    - 連結實體： Message - Message (自關聯)
    - 基數： (0, 1) - (0, N)
    - 說明： 紀錄一則訊息回覆了哪一則先前的訊息。

- 附件歸屬 (has)
    - 連結實體： Message - Attachment
    - 基數： (0, N) - (1, 1)
    - 說明：一則訊息可帶多個附件，一個附件一定並且最多屬於一則訊息

- 緊急聯絡任務 (emergency contact)
  - 連結實體： User - User (自關聯)
  - 基數： (0, N) - (0, N)
  - 屬性： message (預設發送的訊息內容)。
  - 說明： 紀錄委託人與緊急聯絡人之間的發送任務設定。

--- 

