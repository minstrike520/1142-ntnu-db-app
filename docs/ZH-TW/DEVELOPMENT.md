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

上傳的檔案會儲存在掛載到後端容器內 `/workspace/backend/uploads` 的來源中。預設為 Docker 命名磁碟卷 `app_uploads`。附件會存放在 `/workspace/backend/uploads/attachments/`，而頭像則會使用 `/workspace/backend/uploads/avatars/`。

> **從舊版 checkout 升級時**：開發容器現在以 pnpm workspace 的形式配置於 `/workspace`，
> 後端因此由 `/app` 移至 `/workspace/backend`。請以下列指令重新建置：
>
> ```bash
> docker compose up -d --build --renew-anon-volumes
> ```
>
> **請勿使用 `docker compose down -v`。** `-v` 會一併刪除具名的 `pgdata` 與 `app_uploads`，
> 也就是清空你的開發資料庫與所有已上傳檔案。此處並不需要這麼做：舊的匿名 `node_modules`
> volume 掛載於 `/app/node_modules`，新的則在 `/workspace/backend/node_modules`，
> 兩者路徑不同因而不會互相遮蔽 —— 舊 volume 只會被留下成為孤兒
> （日後可用 `docker volume prune` 清理）。
>
> 有一項已知影響是**刻意不以相容層處理**的：此變更之前上傳的附件，其入庫的是
> `/app/uploads/...` 絕對路徑，而 `attachmentRoutes.ts` 對絕對路徑是原樣使用、不重新定位，
> 因此這些記錄在搬遷後會 404。檔案本身仍在 `app_uploads` volume 中的新路徑下。
> 這只影響本機開發資料 —— 生產環境不受影響，因為 `docker-compose.prod.yml` 的工作目錄
> 仍是 `/app`。若仍需要這些附件，重新上傳即可。

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

### 安裝相依套件
本專案是**單一 lockfile 的 pnpm workspace**：整個 repo 只有根目錄一份 `pnpm-lock.yaml`，
同時涵蓋 root、`frontend/` 與 `backend/`。

```bash
# 一律在 repo 根目錄安裝
pnpm install
```

**切勿在 `frontend/` 或 `backend/` 目錄內執行 `pnpm install`。** 這麼做會產生巢狀的
`frontend/pnpm-lock.yaml` 或 `backend/pnpm-lock.yaml` 並與根 lockfile 分歧 ——
這正是 issue #420 所記錄的故障成因。CI 會拒絕任何被提交的巢狀 lockfile。

pnpm 版本由根 `package.json` 的 `"packageManager"` 欄位鎖定，執行 `corepack enable` 即可套用。
若要針對單一套件執行指令，請使用 workspace filter，並且用**套件名稱**而非目錄名稱：

```bash
pnpm --filter near-chat-frontend <script>
pnpm --filter near-chat-backend <script>
```

> **變更相依套件後，請以 `--renew-anon-volumes` 重新建置：**
>
> ```bash
> docker compose up -d --build --renew-anon-volumes
> ```
>
> 每個服務都會在自己的 `node_modules` 上掛一個匿名 volume，避免被原始碼的 bind mount 遮蔽。
> 但在 pnpm workspace 下，該目錄只是指向 `/workspace/node_modules/.pnpm` 這個真實 store 的
> symlink farm，而 store 位於**映像**中。`docker compose up --build` 會沿用既有的匿名 volume
> 而非以新映像重新產生其內容，因此套件版本變更後，被保留下來的 symlink 可能指向新映像已不存在的
> store 路徑 —— dev server 或 migration 便會因為找不到模組而失敗。
> `--renew-anon-volumes` 只會重建這些匿名 volume，具名的 `pgdata` 與 `app_uploads` 不受影響。

### 執行 TypeScript 型別檢查
```bash
# 後端檢查
pnpm --filter near-chat-backend exec tsc --noEmit

# 前端檢查
pnpm --filter near-chat-frontend exec tsc --noEmit
```

### 執行 ESLint 代碼品質與風格檢查
在提交代碼或於本地開發時，建議執行 Linter 檢查以確認代碼格式、撰寫風格以及 React 最佳實踐（例如 Hooks 規則）：

```bash
# 於前端目錄執行代碼檢查
pnpm --filter near-chat-frontend lint

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
pnpm --filter near-chat-backend test:db:up

# 2. 執行整合測試套件
docker compose exec backend bun run test:integration

# 3. 關閉測試資料庫
pnpm --filter near-chat-backend test:db:down
```

### 執行所有測試
```bash
pnpm --filter near-chat-backend test:db:up
docker compose exec backend bun run test
pnpm --filter near-chat-backend test:db:down
```

---

## 6. 撰寫測試

### 單元測試
* **路徑**：`backend/tests/unit/**/*.test.ts`
* **指南**：使用 `mock.module()` 模擬資料庫 Repository，在不建立真實資料庫連線的情況下，單獨測試業務邏輯。

> **`mock.module()` 的作用範圍是整個 process。** 現在每個測試層級都以單一
> `bun test <dir>` process 執行，因此某個檔案呼叫 `mock.module()` 會替換掉**同一次執行中所有檔案**
> 的該模組；而且它在載入期就生效，連排在它前面的檔案都可能受影響。兩個結果：
> * `mock.module()` 只能用在 `tests/unit/`，不可用於 `tests/integration/` 或 `tests/e2e/`。
>   會 mock 掉 `src/models/db` 的測試在定義上就是單元測試；若它需要真實資料庫，就該歸到其他層級。
> * 若只需替換單一函式，優先使用 `spyOn(namespace, 'fn')` 搭配 `mockRestore()` —— 這才會真正還原；
>   在 `afterAll` 中重新呼叫 `mock.module()` 並不會還原。
>
> **不要在 hook 中關閉共用的 singleton。** `src/models/db` 與 `tests/helpers/testPool`
> 匯出的都是 process 層級的共用連線，在 `afterAll` 對其呼叫 `.end()` 會讓該次執行中
> 後續所有檔案的查詢全部失敗。交給 process 結束時自然釋放即可。

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
import { beforeEach, describe, it, expect } from 'bun:test';
import { testPool } from '../helpers/testPool';
import { resetDb } from '../helpers/resetDb';

describe('userRepository', () => {
  beforeEach(async () => {
    await resetDb(); // 清空 users, rooms, messages, room_members
  });

  // 請勿在此呼叫 `testPool.end()` —— 它是同一次執行中所有測試檔共用的 module singleton，
  // 關閉後會導致後續所有檔案失敗。

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
* **`bun test` 跑出遠多於預期的測試數量，或直接卡住**：`bun test <dir>` 的參數是**路徑子字串**過濾條件，
  而非目錄。由於 `backend/tsconfig.json` 的 `include` 包含 `tests/**/*`，執行 `pnpm build` 會把測試一併編譯到
  `backend/dist/backend/tests/…`，這些檔案同樣符合過濾條件，於是整套測試會以過期的第二份副本再跑一次。
  `backend/bunfig.toml` 已設定 `pathIgnorePatterns = ["**/dist/**"]` 來避免此問題；
  若你以繞過 bunfig 的方式呼叫 `bun test`，請自行加上 `--path-ignore-patterns='**/dist/**'`，
  或以 `rm -rf backend/dist` 清除過期建置產物。
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
* **主要開發分支**：本專案主要開發分支為 **`main`**。
* **功能分支**：所有功能開發與 Bug 修復皆需自 `main` 切出（例如：`feat/my-feature` 或 `fix/my-bug`）。
* **Pull Request**：所有 Pull Request 皆需提交回 `main` 分支。嚴禁直接 Push 至 `main` 分支。

### PR 合併規範：Squash and Merge
為保持 Git 歷史乾淨並避免發布日誌（Changelog）雜亂，**所有 Merge 至 `main` 的 Pull Request 必須採用 Squash and Merge**。
* **PR 標題格式**：PR 標題必須遵循 [Conventional Commits](https://www.conventionalcommits.org/) 規範：
  - `feat(scope): 英文簡述` — 新增功能 (feature)
  - `fix(scope): 英文簡述` — 修正 Bug
  - `docs: 英文簡述` — 修改文件 (documentation)
  - `refactor(scope): 英文簡述` — 重構代碼
  - `chore: 英文簡述` — 建置流程或雜務變更
  - `BREAKING CHANGE:` 或 `feat!:` — 破壞性變更（重大 API / 資料庫架構調整）
* **Squash Merge 優點**：在合併時將 Feature 分支中多個微小的提交（如修飾註解、修復排版）壓縮為單一精確的提交。

### 自動化版本發布流程（以 tag 發布）
當變更合併進 `main` 分支時，GitHub Actions (`.github/workflows/ci.yml`) 會於 CI 測試全數通過後自動執行 `semantic-release` 發布工作：

1. **語意化版本 (`a.b.c`) 計算**：
   - `fix:` $\rightarrow$ 遞增 **Patch (`c`)**（如 `v1.0.1` $\rightarrow$ `v1.0.2`）
   - `feat:` $\rightarrow$ 遞增 **Minor (`b`)**（如 `v1.0.1` $\rightarrow$ `v1.1.0`）
   - `BREAKING CHANGE:` $\rightarrow$ 遞增 **Major (`a`)**（如 `v1.0.1` $\rightarrow$ `v2.0.0`）
   - `docs:`, `chore:`, `refactor:` $\rightarrow$ 不遞增版本號
2. **三方版本號同步**：自動執行 `scripts/update-versions.js` 同步更新根目錄 `package.json`、`frontend/package.json` 與 `backend/package.json` 的版本。
3. **Tag 與 Release 頁面**：推送版本號 commit 與 **lightweight** `vX.Y.Z` tag、更新 `CHANGELOG.md`，並由 `@semantic-release/github` **建立 GitHub Release** 與格式化後的 Release Notes。Tag 與 Release 皆由 Semantic Release 擁有；此路徑下 `release-stack.yml` 不會自行建立，也不再要求 annotated tag。
4. **Stack 映像檔與部署包發布**：`.github/workflows/release-stack.yml` 建置 Frontend/Backend 容器映像檔推至 GHCR、簽署 SLSA Provenance，把 Stack 區段（image digest、PostgreSQL runtime、bundle SHA-256）附加到既有的 Release Notes 之後，並上傳 `near-chat-stack-vX.Y.Z.tar.gz` 部署包。判斷某版本是否已發布的冪等性依據是這個 bundle asset，而非 Release 本身。

