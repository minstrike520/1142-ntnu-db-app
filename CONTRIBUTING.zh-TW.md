# 貢獻指南 (Contributing to Near Chat)

[English](CONTRIBUTING.md) | 繁體中文

首先，非常感謝您願意花時間為 Near Chat 做出貢獻！本專案是一門資料庫課程的專案，結構為 Monorepo，包含 React/Next.js 前端、Bun/Hono 後端 API，以及 PostgreSQL 18 資料庫，並在本地透過 Docker Compose 進行容器編排與整合。

請仔細閱讀本指南，以瞭解我們的開發、測試與貢獻工作流程。

---

## 目錄
1. [Git 工作流程與分支規範](#1-git-工作流程與分支規範)
2. [Commit 訊息規範](#2-commit-訊息規範)
3. [GitHub 語言規範](#3-github-語言規範)
4. [資料庫與 Migration 規範](#4-資料庫與-migration-規範)
5. [本地開發與代碼驗證](#5-本地開發與代碼驗證)
6. [API 與 WebSocket 協定驗證](#6-api-與-websocket-協定驗證)
7. [提交 Pull Request](#7-提交-pull-request)

---

## 1. Git 工作流程與分支規範

* **主要開發分支**：本專案的主要開發分支為 **`main`**。
* **分支策略**：
  - 所有的開發都應從 `main` 分支切出（例如：`feat/my-feature` 或 `fix/my-bug`）。
  - 所有的 Pull Request 都必須提交回 `main` 分支。
  - 請避免將變更直接 Push 至 `main` 分支。
* **版本發布**：發布是在 `main` 上推送版本 tag（例如 `v1.2.0`）觸發，不再維護長期的發布分支。

---

## 2. Commit 訊息規範

我們遵循標準的 [Conventional Commits](https://www.conventionalcommits.org/) 規範來撰寫所有的 Commit 訊息。

### Commit 格式
```
<type>(<scope>): <description>
```
* **`<type>`**：必須使用小寫。常見類型包含：
  - `feat`：新增功能 (feature)
  - `fix`：修復 Bug
  - `refactor`：重構（既非修復 Bug 也非新增功能的代碼變更）
  - `docs`：僅修改文件 (documentation)
  - `test`：新增或修正測試案例
  - `chore`：建置流程或輔助工具與函式庫的變更
  - `perf`：提升效能的代碼變更
  - `ci`：CI 設定檔與指令碼的變更
* **`<scope>`**（選填）：變更的範圍（例如：`frontend`、`backend`、`db`、`shared`）。
* **`<description>`**：變更的簡短摘要，請使用**英文**撰寫。

### Commit 範例
* `feat(backend): add room invitation code validation`
* `fix(frontend): resolve memory leak in message list subscription`
* `docs: update setup steps in DEVELOPMENT.md`

---

## 3. GitHub 語言規範

為了保持專案溝通的一致性，請遵守以下規則：
1. **GitHub 介面文字**：所有供人閱讀的 GitHub 內容均必須使用 **繁體中文 (Traditional Chinese)** 撰寫。這包括：
   - PR 標題（位於 conventional-commit 類型前綴之後的中文描述）
   - PR 內容與說明
   - Issue 標題、說明與留言
2. **程式碼與 Commit 訊息**：程式碼識別字（類別、變數、函數等）以及 Git Commit 訊息本身，請維持使用**英文**。

---

## 4. 資料庫與 Migration 規範

* **原生 SQL 存取**：本專案已完全移除 Prisma。所有的資料庫存取皆使用原生 SQL 查詢（Raw SQL）。
* **資料庫遷移 (Migrations)**：
  - 請勿直接在資料庫中手動執行 SQL 來變更 Schema。
  - 所有 Schema 的變更都必須透過在 `backend/migrations/` 底下撰寫純 SQL 遷移檔來完成，並以 `-- Up migration` 與 `-- Down migration` 區分正向與回滾。
  - 欄位結構、預設值與外鍵條件請參考 [docs/database-design.md](docs/database-design.md)。
* **Migration 相關指令**（請於後端容器內執行）：
  - **建立遷移檔**：`docker compose exec backend pnpm run migrate:create <name>`
  - **執行資料庫遷移**：`docker compose exec backend pnpm run migrate:up`
  - **回滾資料庫遷移**：`docker compose exec backend pnpm run migrate:down`

---

## 5. 本地開發與代碼驗證

在提交 Pull Request 之前，請確保您的代碼能正常編譯、符合排版風格，並在本地通過所有的測試。

### 本地環境設定
請確保您已從專案根目錄將 `.env.example` 複製為 `.env`：
```bash
cp .env.example .env
```
啟動本地容器服務：
```bash
docker compose up -d
```
將種子資料寫入資料庫（這將清除現有資料並重建測試資料）：
```bash
docker compose exec backend pnpm run db:seed
```
*註：預設所有測試帳號的密碼均為 `password123`。*

### 代碼品質檢查點
1. **TypeScript 編譯檢查**：在兩個目錄中均執行檢查以確保無型別錯誤。
   ```bash
   # 後端型別檢查
   docker compose exec backend pnpm exec tsc --noEmit
   # 前端型別檢查
   docker compose exec frontend pnpm exec tsc --noEmit
   ```
2. **ESLint 檢查**：驗證語法、程式碼風格以及 React Hooks 遵循情況。
   ```bash
   docker compose exec frontend pnpm run lint
   ```
3. **執行 Bun 測試**：
   - **單元測試**：
     ```bash
     docker compose exec backend pnpm run test:unit
     ```
   - **整合測試**（會針對臨時的測試資料庫 `db-test` 執行）：
     ```bash
     # 1. 啟動測試資料庫
     pnpm -C backend run test:db:up
     # 2. 套用遷移至測試資料庫
     docker compose exec -e DATABASE_URL=postgresql://postgres:postgres@db-test:5432/ntnu_test backend pnpm run migrate:up
     # 3. 執行測試
     docker compose exec backend pnpm run test:integration
     # 4. 關閉測試資料庫
     pnpm -C backend run test:db:down
     ```

更多詳細資訊請參閱 [docs/ZH-TW/DEVELOPMENT.md](docs/ZH-TW/DEVELOPMENT.md)。

---

## 6. API 與 WebSocket 協定驗證

* 任何對 Hono 路由 (Routes)、後端服務 (Services) 或 Socket.IO 事件處理常式的修改，都必須精確對齊 [docs/api-documentation.md](docs/api-documentation.md) 中所定義的 Payload 與資料模型。
* 破壞協定契約將會導致前後端串接失敗，並使 CI 流程出錯。

---

## 7. 提交 Pull Request

1. **自我檢查**：請先在本地執行 ESLint、型別檢查與所有測試。
2. **分支對象**：確保 PR 的 Base Branch 設定為 **`main`**。
3. **Commit 訊息**：檢查 Commit 訊息是否符合 Conventional Commit 格式。
4. **內容描述**：請套用我們的 Pull Request 範本，並以 **繁體中文 (Traditional Chinese)** 描述您的變更。
5. **測試計畫**：在 PR 說明中清楚記錄您的驗證步驟。
