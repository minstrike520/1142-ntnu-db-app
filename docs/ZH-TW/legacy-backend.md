# Express／Node 舊後端封存

[English](../legacy-backend.md) | 繁體中文

本文件定義 Express 後端的凍結基線、允許用途與維護政策。封存範圍是完整 Monorepo，因為後端仍依賴共享型別、PostgreSQL migration、Docker 設定、前端合約及文件。

## 封存識別資訊

| 項目 | 凍結值 |
| --- | --- |
| 應用程式碼基線 | `f6debb622da60afcdd8071fe32c7f327cf6b2933`（`f6debb6`） |
| Annotated Release tag | `backend-express-node-v1.0.0` |
| 維護分支 | `legacy/backend-express-node` |
| Runtime | Node.js 24 |
| 套件管理器 | pnpm 11 |
| HTTP framework | Express 5.2.1 |
| 即時通訊伺服器 | Socket.IO 4.8.3 |
| 資料庫 | PostgreSQL 18 |

Release tag 會指向包含本政策與封存 workflow 的 freeze merge commit；該 commit 中的正式應用程式碼仍以 `f6debb6` 為基線。

## 啟動封存版本

請使用獨立 clone 或 worktree，以免 checkout 封存版本時干擾 Hono 原始碼。Worktree 只隔離 checkout，**不會**自動隔離 Docker container、volume、network 或 host port；只要封存 stack 會與其他 checkout 同時執行，就必須設定下列 Compose 變數：

```bash
export COMPOSE_PROJECT_NAME=near-chat-express-node
export COMPOSE_NETWORK_NAME=near-chat-express-node_network
export POSTGRES_HOST_PORT=55435
export BACKEND_HOST_PORT=44005
export FRONTEND_HOST_PORT=43005
export TEST_POSTGRES_HOST_PORT=55436
export NEXT_PUBLIC_API_URL=http://localhost:44005
export CORS_ORIGINS=http://localhost:43005
git fetch origin --tags
git worktree add ../near-chat-express-node backend-express-node-v1.0.0
cd ../near-chat-express-node
cp .env.example .env
docker compose up -d --build
docker compose ps
```

只要不是純本機開發，就必須先替換 `.env` 內的開發用密鑰。不得對需要保留的資料執行 `db:seed`，因為 seed 指令會重設應用資料。

`COMPOSE_PROJECT_NAME` 會讓此 checkout 使用獨立的 `near-chat-express-node_pgdata` 與 `near-chat-express-node_app_uploads` named volume；`COMPOSE_NETWORK_NAME` 與 host-port 變數則避免 network 和 port 衝突。每次執行 Compose 指令都必須維持同一組 shell exports。

套用上述設定後，後端位於 `http://localhost:44005`、前端位於 `http://localhost:43005`、PostgreSQL 位於 `localhost:55435`。後端容器啟動時會先套用尚未執行的 migration。

## 驗證與測試

Legacy CI 使用 Node.js 24 與 pnpm 11。每次 push 到 `legacy/backend-express-node`，以及每個以該分支為 target 的 Pull Request，都會忽略 changed paths，完整執行前端 lint／type／build、後端 build／type、unit test、PostgreSQL 18 integration test、E2E test 與 security scan；path filter 只用於減少 `main`／`dev` 的工作。若要在本機透過 Docker 重現檢查、同時隔離開發資料庫，請執行：

```bash
export COMPOSE_PROJECT_NAME=near-chat-express-node
export COMPOSE_NETWORK_NAME=near-chat-express-node_network
export POSTGRES_HOST_PORT=55435
export BACKEND_HOST_PORT=44005
export FRONTEND_HOST_PORT=43005
export TEST_POSTGRES_HOST_PORT=55436
export NEXT_PUBLIC_API_URL=http://localhost:44005
export CORS_ORIGINS=http://localhost:43005
cp backend/.env.test.example backend/.env.test
docker compose up -d --build
docker compose -f docker-compose.test.yml up -d --wait
docker compose exec backend pnpm run build
docker compose exec backend pnpm exec tsc --noEmit
docker compose exec frontend pnpm run lint
docker compose exec frontend pnpm exec tsc --noEmit
docker compose exec backend pnpm run test:unit
docker compose exec -e DATABASE_URL=postgresql://postgres:postgres@db-test:5432/ntnu_test backend pnpm run migrate:up
docker compose exec backend pnpm run test:integration
docker compose exec backend pnpm run test:e2e
docker compose -f docker-compose.test.yml down
```

測試資料庫位於 `localhost:55436`、使用 tmpfs，並與封存專案自己的 `pgdata` volume 隔離。封存驗證期間不得執行 `docker compose down -v`，因為該指令會刪除此封存專案的持久化開發資料與 uploads。

## Release 映像與回滾

推送符合 `backend-express-node-v*` 的 tag 後，workflow 會以 repo root 為 build context、使用 `backend/Dockerfile.prod` 發布下列兩個映像參照：

- `ghcr.io/nearcsie/near-chat-backend:express-node-v1.0.0`
- `ghcr.io/nearcsie/near-chat-backend:sha-<12-character-commit>`

雖然 trigger 使用 glob，實際發布只接受完全符合 `backend-express-node-vX.Y.Z` 的格式。該 ref 必須是 annotated tag，其 peeled commit 必須同時等於遠端 `legacy/backend-express-node` HEAD，並且已有一筆 completed 且 successful 的 `ci.yml` run。

GitHub Release 會記錄完整 commit SHA 與內容 digest。需要確定性回滾時，應使用 digest 而非可變 tag：

```bash
docker pull ghcr.io/nearcsie/near-chat-backend@sha256:<digest-from-release>
```

替換 Hono 前，必須先備份 PostgreSQL 與 uploads 掛載來源、確認目前 schema 仍與 Express 相容，並且只停止 backend service，不得刪除 volume。部署 digest-pinned 映像時，沿用既有後端環境變數、network、`4000` port 與 `/app/uploads` mount。映像啟動 Express 前會先執行 legacy migration。若 schema 已超過下節定義的相容期，請還原經測試的資料庫備份，不得臨時嘗試未規劃的 `migrate:down`。

若採原始碼回滾，請從 `backend-express-node-v1.0.0` 的乾淨 checkout 搭配 `docker-compose.prod.yml` 部署，並在部署變更紀錄中填入 Release 的實際 digest，以便日後稽核執行檔來源。

發布 workflow 將版本與 commit 兩個映像參照都視為不可變，只允許乾淨的首次發布（Release 不存在且兩個映像參照都不存在），或驗證完整的既有發布（Release 已存在且兩個參照解析為相同 digest）。任何只有映像、沒有 Release 的 partial publish 都必須人工調查；workflow 不會替既有 artifact 補簽 provenance，也不會以它自動建立缺少的 Release。既有 Release 絕不編輯，其 body 必須已包含預期 commit SHA 與 digest。若 Release 已存在但任一映像參照遺失，workflow 不會自動重建，因為新 build 可能產生不同 digest。

## 維護與資料庫相容規則

- 維護分支只接受安全漏洞、資料遺失或毀損、無法啟動，以及阻斷性相容問題的修補；不接受新功能。
- 所有變更都必須透過 Pull Request、通過必要 CI 並取得至少一人核准。Branch protection 只要求固定的 `Legacy required checks` status；任何適用的 lint、type、build、test 或 security job 失敗或取消時，該 gate 都會失敗。禁止直接 push、force-push 或刪除分支。
- 每次接受的修補都建立 patch tag，例如 `backend-express-node-v1.0.1`。適用的修補再以 cherry-pick 或獨立實作同步到 Hono；禁止將 Hono 變更反向 merge 到 legacy 分支。
- 在 Hono 被宣告於 production 穩定後的 30 個日曆天內，migration 必須維持 Express 向後相容。先加入 additive schema、再遷移 reader／writer，最後才在相容期結束後移除或重新命名（expand-and-contract）。
- Hono production 穩定日期與推算出的 EOL 日期必須記錄在專案 Release 或追蹤 Issue。EOL 時將維護分支設為唯讀；tag、Release、digest 與 provenance attestation 永久保留。

## 已知限制與封存衛生

- 此版本是凍結的相容目標，不是平行產品線；功能需求應在 Hono 實作。
- 可透過文件指定的 project、network 與 host-port 變數隔離 Compose 資源，但獨立 worktree 不會自動完成隔離。未設定時，仍可能與其他 checkout 的 port 或 `near-chat_network` 衝突。
- 開發與正式 Dockerfile 目前追蹤 `node:lts-slim` 並啟用 `pnpm@latest`。Node 24／pnpm 11 是驗證基線；已發布映像的 digest 才是可重現部署的最終依據。
- Partial publish 一律不自動修復。既有映像沒有 Release、只存在單一參照、digest mismatch、既有 Release 不一致，或 Release 已存在但映像遺失時，都必須人工調查。Workflow 不替既有 artifact 簽署 provenance、不以它新建 Release、不覆寫已發布參照或 Release，也不會在既有 Release 下重建遺失映像。
- Uploads 使用檔案系統儲存，不屬於 Git 或容器映像的一部分，必須另行備份與還原。
- 資料庫相容性只保證到定義的過渡期結束；EOL 後的 Hono-only 破壞性 migration 可能使 Express 無法啟動。
- 封存 tag 與 Release 只能包含原始碼及產生的 metadata。禁止提交或附加 `.env`、包含真實資料的 database volume／dump、uploads、token、credential 或任何其他 secret。
