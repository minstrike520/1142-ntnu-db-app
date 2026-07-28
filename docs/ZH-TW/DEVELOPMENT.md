# 開發者與測試指南

本文件提供此應用程式的安裝說明、開發工作流程、測試指南以及測試資料的說明。

---

## 1. 快速開始

### 步驟 1: 準備環境變數
從專案根目錄複製 `.env.example` 檔案並重命名為 `.env`：

```bash
cp .env.example .env
```

*注意：`.env` 檔案已被列入 `.gitignore` 中，不應提交至 Git 儲存庫。*

### 步驟 2: 啟動容器
使用 Docker Compose 啟動所有服務：

```bash
# 在首次設定或修改 Dockerfile 後重新建置
docker compose build

# 在背景模式啟動服務
docker compose up -d
```

上傳的檔案會儲存在掛載到後端容器內 `/app/uploads` 的來源中。預設為 Docker 命名磁碟卷 `app_uploads`。附件會存放在 `/app/uploads/attachments/`，而頭像則會使用 `/app/uploads/avatars/`。

如果您希望將上傳檔案儲存在主機上的自訂資料夾中，而非預設的命名磁碟卷，請在執行 Docker Compose 前在 `.env` 中設定 `UPLOADS_MOUNT_SOURCE`：

```env
UPLOADS_MOUNT_SOURCE=C:/chat-uploads
```

### 步驟 3: 檢查容器狀態

```bash
# 檢視容器狀態
docker compose ps

# 檢視後端日誌
docker compose logs -f backend
```

---

## 2. 環境變數與連接埠存取

### 本機服務連接埠

Docker Compose 會將容器內部連接埠映射至主機的外部連接埠，對應如下：

| 服務 | 主機網址 / 連接埠 | 容器內部連接埠 | 說明 |
|---|------------------|----------------|-------------|
| **前端** | [http://localhost:3005](http://localhost:3005) | 3000 | Next.js 前端網頁應用程式 |
| **後端 API** | [http://localhost:4005](http://localhost:4005) | 4000 | Bun + Hono API 與 Socket.IO 伺服器 |
| **資料庫** | `localhost:5435` | 5432 | PostgreSQL 18 實例 |

對於瀏覽器端的前端請求，請將 API 環境變數設定為：
```env
NEXT_PUBLIC_API_URL=http://localhost:4005
```

### 環境變數規則
1. **前端前綴**：任何需要在 Next.js 瀏覽器端讀取的環境變數，都必須加上 `NEXT_PUBLIC_` 前綴。
2. **生產環境注入**：生產環境不應該依賴已提交的 `.env` 檔案，請改為透過雲端託管平台（例如 Vercel、AWS Secrets Manager）的設定來注入環境變數。
3. **範本維護**：新增環境變數時，請同步更新 `.env.example`，將欄位值留空或使用佔位符，以便他人參考。

---

## 3. 資料庫管理與種子資料

### 初始化流程
首次設定專案時，您必須初始化資料庫 Schema。請確認 Docker 容器已正常啟動，然後套用遷移：

```bash
docker compose exec backend bun run migrate:up
```

將測試用的種子資料寫入資料庫：
```bash
docker compose exec backend bun run db:seed
```

### 常見指令
- **建立新的遷移檔**：`docker compose exec backend bun run migrate:create <name>`
- **執行資料庫遷移**：`docker compose exec backend bun run migrate:up`
- **回滾資料庫遷移**：`docker compose exec backend bun run migrate:down`
- **寫入種子資料**：`docker compose exec backend bun run db:seed`

### 修復損壞的開發資料庫
如果遷移過程中遇到 `relation ... already exists` 錯誤，或者遷移狀態發生混亂：

```bash
# 1. 停止容器並刪除資料庫磁碟卷
docker compose down -v

# 2. 重啟容器
docker compose up -d

# 3. 等待資料庫就緒後，再次執行遷移
docker compose exec backend bun run migrate:up
```

---

## 4. 預設種子測試資料

執行 `db:seed` 會用以下可重複的測試資料填充開發資料庫。**所有測試使用者的預設密碼皆為：`password123`。**

### 種子使用者
| 姓名 | 電子郵件 | 使用者 ID | 角色 / 備註 |
| --- | --- | --- | --- |
| **Alice** | `alice@test.com` | `11111111-1111-4111-a111-111111111111` | 預設群組擁有者 |
| **Bob** | `bob@test.com` | `22222222-2222-4222-a222-222222222222` | 預設群組管理員 |
| **Charlie** | `charlie@test.com` | `33333333-3333-4333-a333-333333333333` | 一般成員 |
| **Dave** | `dave@test.com` | `44444444-4444-4444-a444-444444444444` | 群組外成員 |
| **Eve** | `eve@test.com` | `55555555-5555-4555-a555-555555555555` | 群組外成員 |
| **Frank** | `frank@test.com` | `66666666-6666-4666-a666-666666666666` | 一般成員 |

### 關係與群組
* **好友關係**：
  - Alice & Bob (已接受)
  - Alice & Charlie (已接受)
  - Dave → Alice (待處理的邀請)
* **封鎖關係**：
  - Eve 封鎖 Alice。
* **讀書會聊天室**：
  - **聊天室 ID**：`77777777-7777-4777-a777-777777777777`
  - **邀請碼**：`STUDY123`
  - **成員**：Alice (擁有者)、Bob (管理員)、Charlie (成員)、Frank (成員)
  - **初始訊息**：
    1. *Alice*："Hello everyone! Welcome to the study group."
    2. *Bob*："Hi Alice, thanks for inviting me!"

---

## 5. 測試指南

### 測試架構
開發環境完全運行於 Docker 中，主機上沒有 `node_modules`。所有 Bun 測試套件都必須在後端容器內部使用 `docker compose exec` 執行。

測試資料庫設定：整合測試會在一台臨時的 Postgres 測試資料庫實例（`db-test`）上運行，該實例定義於 `docker-compose.test.yml` 中，以將開發數據與測試數據隔離開來。

### 執行 TypeScript 型別檢查
```bash
# 後端檢查
pnpm --prefix backend exec tsc --noEmit

# 前端檢查
pnpm --prefix frontend exec tsc --noEmit
```

### 執行 ESLint 代碼品質與風格檢查
在提交代碼或於本地開發時，建議執行 Linter 檢查以確認代碼格式、撰寫風格以及 React 最佳實踐（例如 Hooks 規則）：

```bash
# 於前端目錄執行代碼檢查
pnpm --prefix frontend run lint

# 或於前端 Docker 容器內執行
docker compose exec frontend pnpm run lint
```

### 執行單元測試
單元測試不需要資料庫連線。
```bash
docker compose exec backend bun run test:unit
```

### 執行整合測試
整合測試需要啟動臨時的測試資料庫（`test:db:up` 會自動啟動容器並完成資料庫遷移）：

```bash
# 1. 啟動臨時測試資料庫並自動套用遷移
pnpm -C backend run test:db:up

# 2. 執行整合測試套件
docker compose exec backend bun run test:integration

# 3. 關閉測試資料庫
pnpm -C backend run test:db:down
```

### 執行所有測試
```bash
pnpm -C backend run test:db:up
docker compose exec backend bun run test
pnpm -C backend run test:db:down
```

---

## 6. 撰寫測試

### 單元測試
* **路徑**：`backend/tests/unit/**/*.test.ts`
* **指南**：使用 `mock.module()` 模擬資料庫 Repository，在不建立真實資料庫連線的情況下，單獨測試業務邏輯。

```typescript
// 範例：backend/tests/unit/services/userService.test.ts
import { describe, it, expect } from 'bun:test';

describe('userService', () => {
  it('adds two numbers', () => {
    expect(1 + 1).toBe(2);
  });
});
```

### 整合測試
* **路徑**：`backend/tests/integration/**/*.test.ts`
* **指南**：測試會查詢真實的 PostgreSQL 測試資料庫。在每個測試前使用 `testPool` 與 `resetDb` 輔助程式來管理連線並清空資料表。

```typescript
// 範例：backend/tests/integration/repositories/userRepository.test.ts
import { beforeEach, afterAll, describe, it, expect } from 'bun:test';
import { testPool } from '../helpers/testPool';
import { resetDb } from '../helpers/resetDb';

describe('userRepository', () => {
  beforeEach(async () => {
    await resetDb(); // 清空 users, rooms, messages, room_members
  });

  afterAll(async () => {
    await testPool.end(); // 關閉連接池
  });

  it('queries database successfully', async () => {
    const result = await testPool.query('SELECT 1 + 1 AS sum');
    expect(result.rows[0].sum).toBe(2);
  });
});
```

---

## 7. 疑難排解

* **`bun test 錯誤`**：後端容器的 `node_modules` 不同步。請重新建置容器：
  ```bash
  docker compose rm -v -s -f backend
  docker compose up -d --build backend
  ```
* **`DATABASE_URL_TEST is not set`**：請確認 `backend/.env.test` 是否存在。若不存在：
  ```bash
  cp backend/.env.test.example backend/.env.test
  ```
* **`db-test` 連線掛起或逾時**：請確認 `db-test` 正在運行，指令為：`docker compose -f docker-compose.test.yml ps`。如果沒啟動請將它啟動。
* **`TRUNCATE` 失敗**：請確認已透過以下指令在測試資料庫中套用了遷移：
  ```bash
  docker compose exec -e DATABASE_URL=postgresql://postgres:postgres@db-test:5432/ntnu_test backend bun run migrate:up
  ```

---

## 8. Git 工作流程、PR 規範與自動化發布

### Git 分支策略
* **主要開發分支**：本專案主要開發分支為 **`dev`**。
* **功能分支**：所有功能開發與 Bug 修復皆需自 `dev` 切出（例如：`feat/my-feature` 或 `fix/my-bug`）。
* **Pull Request**：所有 Pull Request 皆需提交回 `dev` 分支。嚴禁直接 Push 至 `main` 或 `dev` 分支。

### PR 合併規範：Squash and Merge
為保持 Git 歷史乾淨並避免發布日誌（Changelog）雜亂，**所有 Merge 至 `dev` 的 Pull Request 必須採用 Squash and Merge**。
* **PR 標題格式**：PR 標題必須遵循 [Conventional Commits](https://www.conventionalcommits.org/) 規範：
  - `feat(scope): 英文簡述` — 新增功能 (feature)
  - `fix(scope): 英文簡述` — 修正 Bug
  - `docs: 英文簡述` — 修改文件 (documentation)
  - `refactor(scope): 英文簡述` — 重構代碼
  - `chore: 英文簡述` — 建置流程或雜務變更
  - `BREAKING CHANGE:` 或 `feat!:` — 破壞性變更（重大 API / 資料庫架構調整）
* **Squash Merge 優點**：在合併時將 Feature 分支中多個微小的提交（如修飾註解、修復排版）壓縮為單一精確的提交。

### 自動化版本發布流程 (`dev` → `main`)
當 `dev` 分支累積階段變更並合併回 `main` 分支時，GitHub Actions (`.github/workflows/ci.yml`) 會於 CI 測試全數通過後自動執行 `semantic-release` 發布工作：

1. **語意化版本 (`a.b.c`) 計算**：
   - `fix:` $\rightarrow$ 遞增 **Patch (`c`)**（如 `v1.0.1` $\rightarrow$ `v1.0.2`）
   - `feat:` $\rightarrow$ 遞增 **Minor (`b`)**（如 `v1.0.1` $\rightarrow$ `v1.1.0`）
   - `BREAKING CHANGE:` $\rightarrow$ 遞增 **Major (`a`)**（如 `v1.0.1` $\rightarrow$ `v2.0.0`）
   - `docs:`, `chore:`, `refactor:` $\rightarrow$ 不遞增版本號
2. **三方版本號同步**：自動執行 `scripts/update-versions.js` 同步更新根目錄 `package.json`、`frontend/package.json` 與 `backend/package.json` 的版本。
3. **Changelog 與 Release 頁面**：自動更新 `CHANGELOG.md`，並**將格式化後的 Release Notes 直接發布於 GitHub Release 頁面**。
4. **Stack 映像檔與部署包發布**：建立 `vX.Y.Z` 標籤並觸發 `.github/workflows/release-stack.yml`，自動建置 Frontend/Backend 容器映像檔推至 GHCR、簽署 SLSA Provenance，並附加 `near-chat-stack-vX.Y.Z.tar.gz` 部署包至 GitHub Release。

