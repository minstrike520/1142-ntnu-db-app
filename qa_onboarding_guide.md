# 測試員 (QA/Tester) 快速上手指南

歡迎加入測試行列！為了讓你能順暢地進行測試與回報問題，請參考以下指南。

## 一、 先備知識 (Prerequisite Knowledge)

1. **專案簡介**：
   這是一個具備即時通訊功能的社群應用程式（類似 LINE 或 Messenger）。主要功能包含：
   - 使用者註冊與登入
   - 好友系統（發送/接受/拒絕邀請、解除好友）
   - 私人聊天與群組聊天（支援即時 WebSocket 訊息傳遞）
   - 封鎖使用者功能、檔案與圖片傳輸
2. **架構概念**：
   - **Frontend (前端)**：使用 Next.js，負責畫面與使用者互動。
   - **Backend (後端)**：使用 Node.js (Express) + Socket.io，處理 API 請求與即時通訊。
   - **Database (資料庫)**：PostgreSQL。
3. **系統環境需求**：
   - 電腦需安裝並執行 **Docker** 以及 **Docker Compose**。
   - 電腦需安裝 **Git**。

---

## 二、 如何啟動 Docker 服務

本專案使用 Docker Compose 來一鍵啟動所有服務（前端、後端、資料庫）。

### 1. 準備環境變數
確保專案根目錄下有一個 `.env` 檔案（你可以從 `.env.example` 複製一份並填上相關數值，包含資料庫密碼與 JWT Secret 等）。
*(若系統有設定 `RATE_LIMIT_DISABLED=true`，可避免測試時踩到請求速率限制)*。

### 2. 啟動服務
打開終端機（Terminal），進入專案的根目錄（`near-chat`），輸入以下指令：

```bash
# 背景啟動所有服務，若有更新程式碼建議加上 --build 重新建置
docker compose up -d --build
```

### 3. 確認服務狀態
你可以用以下指令查看所有容器是否正常運行：
```bash
docker compose ps
```
啟動成功後，你可以在瀏覽器中輸入以下網址開始測試：
- **前端網站**：[http://localhost:3005](http://localhost:3005) (或根據 `.env` 設定的 Port)

---

## 三、 如何查 Log (除錯紀錄)

當你在測試過程中遇到畫面沒有反應、跳出錯誤訊息（如 `500 Internal Server Error`）時，你可以透過以下兩種方式查詢 Log，這對於工程師修復 Bug 非常有幫助：

### 1. 伺服器端 Log (Docker Logs)
你可以透過終端機查看後端、前端或資料庫的錯誤紀錄：

- **查看即時的後端 Log**（最常看這個，API 錯誤通常在這）：
  ```bash
  docker compose logs -f backend
  ```
- **查看即時的前端 Log**：
  ```bash
  docker compose logs -f frontend
  ```
- **查看資料庫 Log**：
  ```bash
  docker compose logs -f db
  ```
*(提示：按 `Ctrl + C` 可以退出追蹤模式)*

### 2. 客戶端 Log (瀏覽器開發者工具)
如果畫面的按鈕點了沒反應，可能是前端本身的報錯，請利用瀏覽器工具：
- **Console (主控台)**：按下 `F12` 或右鍵「檢查 (Inspect)」，切換到 `Console` 標籤，如果有紅字錯誤（如 Cannot read properties of undefined），請截圖。
- **Network (網路)**：切換到 `Network` 標籤，點擊發生錯誤的 API（通常會顯示紅色的 400 或 500 狀態碼），點開看 `Response`（回應）頁籤內的具體錯誤訊息。

---

## 四、 如何回報 GitHub Issue

發現 Bug 時，請前往 GitHub 專案頁面的 **Issues** 標籤，點擊 **New issue** 來回報。

為了讓工程師能快速重現並修復問題，專案中已經配置了專屬的 Bug 回報範本。
請參考專案目錄下的範本檔案（位於 `.github/ISSUE_TEMPLATE/bug_report.md`），或者在 GitHub 建立 Issue 時直接選擇 **Bug Report** 範本，並依照裡面的格式依序填寫以下資訊：

1. **問題描述**：發生了什麼問題。
2. **如何重現**：一步一步的操作流程。
3. **預期行為 vs 實際行為**：原本應該發生什麼，但實際卻發生了什麼。
4. **截圖或螢幕錄影**：視覺上的證據是最直接的。
5. **環境與 Log**：作業系統、瀏覽器版本，以及剛剛查到的前後端 Log 報錯。

只要依照範本的指示填寫，就能大幅減少溝通成本，幫助工程師秒懂你的問題！
