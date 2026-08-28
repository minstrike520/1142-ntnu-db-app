# Near Chat Stack 版本發布

[English](../RELEASE.md) | 繁體中文

Near Chat 的版本 tag 代表一份可部署的完整 Stack，不只是單一應用套件。從 `v1.0.1` 起，每個版本都包含前端映像、後端映像、PostgreSQL 18 runtime digest、資料庫 migration runner，以及 Docker Compose 部署 bundle。既有的 `v1.0.0` 後端專用版本已不可變，仍永久保留供回滾。

## 發布版本

Release Please 會先以可審查的 PR 準備版本。一般變更合併進 `main` 本身不會建立正式 tag。

### 版本號從哪裡來

PR 一律以 squash merge 合併，因此進入 `main` 的 commit 就是 **PR 標題**，Release Please 會依其 Conventional Commit 前綴判斷版本：

| Commit 前綴 | 效果 | 範例 |
| --- | --- | --- |
| `fix:` | Patch | `v1.0.1` → `v1.0.2` |
| `feat:` | Minor | `v1.0.1` → `v1.1.0` |
| `feat!:` 或帶 `BREAKING CHANGE:` footer | Major | `v1.0.1` → `v2.0.0` |
| `docs:`、`chore:`、`refactor:`、`test:`、`ci:` | 不發布 | — |

若尚未發布的 commits 全是不發布的型別，Release Please 不會建立 Release PR；這是正常結果，不是失敗。

### 審查與發布流程

```
一般 PR 合併 → CI → release-please.yml → 建立或更新 Release PR
審查並合併 Release PR → CI → release-please.yml → vX.Y.Z 與 GitHub Release
vX.Y.Z push → release-stack.yml → 映像、attestation、bundle
```

1. **`ci.yml` — Gate。** 每個 `main` commit 都會產生完整結束的 CI run。單一 `detect` job 決定哪些 lane 必須執行，純文件變更因此會跳過昂貴的 lane；程式變更必須通過 frontend lane（lint／typecheck／test／build）、backend lane（lint／unit／build）、database lane（對 Postgres 執行 integration 與 E2E）、browser lane（以 Chromium 對前端 production build 執行 Playwright smoke tests），以及 dependency security lane。這些 lane 都是 reusable workflow，最後由單一彙總 job `required-checks` 把結果收斂成 branch protection 與發布流程唯一依賴的 status check。CI 不持有發布 credential，也不發布內容。
2. **`release-please.yml` — 審查邊界。** `main` 的同一個 commit 通過 CI 後，Release Please 依 `release-please-config.json` 與 `.release-please-manifest.json` 建立或更新一份 Release PR。該 PR 提出版本號、更新 `CHANGELOG.md`，並同步 root、backend、frontend 三份 `package.json` 的 `version`。PR 尚未合併時不建立 tag。
3. **合併 Release PR。** 維護者先審查預計版本、英文 changelog 結構、manifest 與三份 package 版本。合併後再次通過 CI，Release Please 才建立對應的 `vX.Y.Z` tag 與 GitHub Release；tag 指向的 commit 已包含所有受審查的版本資產。
4. **`release-stack.yml` — Stack。** App 產生的 tag push 會啟動此 workflow，建置並推送四個不可變 GHCR 參照、簽署兩份 provenance attestation、附加含完整 diff 連結的英文 Stack 區段，再上傳 `near-chat-stack-vX.Y.Z.tar.gz`。

Repository 以路徑 `.` 設定成單一邏輯發布套件；backend 與 frontend 是同步更新的 `extra-files`，不是各自產生版本的元件，因此整份 Stack 只會得到一個共用版本與 tag。

### Release App 身分與事件鏈

預設的 `secrets.GITHUB_TOKEN` 建立的資源不會再觸發 workflow，也無法 bypass 限制建立 `v*` tag 的 ruleset。因此 `release-please.yml` 會以 `RELEASE_APP_CLIENT_ID` 與 `RELEASE_APP_PRIVATE_KEY` 換取短效 GitHub App installation token。該 App 必須安裝在此 repository、具有 Contents／Issues／Pull Requests 寫入權限，也是版本 tag ruleset 獲准 bypass 的 actor。

Repository 的「Allow GitHub Actions to create and approve pull requests」只控制 `GITHUB_TOKEN`；本流程使用專用 App token 且不會自行核准 PR，因此該設定可以維持關閉。目前沒有會阻擋 App 建立 Release PR 的 branch protection；若日後新增保護，必須允許 App 建立與更新 PR branch，同時保留一般 CI 與維護者控制的 `main` 合併。App token 產生的事件會啟動 workflow，因此 Release PR 會取得 CI，`vX.Y.Z` push 也能直接啟動 Stack 發布。

若某次 CI 結束後 `main` 已前進，較舊的 Release Please run 會在取得發布權限前正常結束，交由較新的 run 處理，確保 tag 來源就是通過 CI 的 commit。Release Please 會先建立 tag 再完成 GitHub Release，因此 `release-stack.yml` 會等待同一 commit 的 Release Please run 結束，以免兩邊競相建立 Release。

### 仍然強制的條件

Tag 以 Release Please 為準。若 tag 不完全符合 `vX.Y.Z`、數字版本不等於三份 `package.json`、tag commit 不在 `main` 歷史上，或該 exact commit 的 main CI run 中沒有成功的 `required-checks` job，`release-stack.yml` 都會拒絕發布。lane 層級的判斷收在 `required-checks` 內部：`detect` 標記為必要的 lane 必須成功，確實不需要執行的 lane 才可以是 skipped，任何 failed 或 cancelled 的 lane 都會讓 gate 失敗。因此發布流程不再指名任何個別 lane，lane 可以改名、拆分或新增而不必動到它。

### 手動入口

階段 3 隨時可以人工觸發 —— Stack workflow 沒有完成時，這就是重試既有 tag 的標準做法：

```bash
gh workflow run release-stack.yml --ref v1.0.1
```

正常流程不得手動建立正式 tag。若 Release Please 已建立 tag、卻沒有完成 GitHub Release，先等待或重跑 `release-please.yml`；上游進入終態後，`release-stack.yml` 仍保留建立缺失 Release 的復原路徑。

Workflow 會發布兩個不可變的應用程式映像，各自包含版本 tag 與 commit tag：

- `ghcr.io/nearcsie/near-chat-backend:1.0.1`
- `ghcr.io/nearcsie/near-chat-backend:sha-<12-character-commit>`
- `ghcr.io/nearcsie/near-chat-frontend:1.0.1`
- `ghcr.io/nearcsie/near-chat-frontend:sha-<12-character-commit>`

GitHub Release 也會記錄固定 digest 的 PostgreSQL runtime、兩個映像的 digest、provenance attestation，以及 `near-chat-stack-vX.Y.Z.tar.gz` 部署 bundle。不發布可變的 `latest` tag。

## 使用 Release bundle 部署

從 GitHub Release 下載 bundle、解壓縮、複製環境變數範例，再將所有 placeholder 換成部署環境的值。範例檔不包含任何 credential。

```bash
tar -xzf near-chat-stack-v1.0.1.tar.gz
cd near-chat-stack-v1.0.1
cp near-chat.env.example .env
docker compose --env-file .env -f docker-compose.release.yml up -d
```

Compose bundle 會啟動 PostgreSQL，使用固定版本的 backend image 執行一次 `bun run migrate:up`，接著以 `bun src/index.ts` 啟動 backend，最後啟動 frontend。backend 的兩個命令都只使用 bun：backend production image 以 bun runtime 直接執行 TypeScript 原始碼，其中沒有 `node`、沒有 `pnpm`，也沒有建置產物。PostgreSQL 資料與使用者上傳檔案仍由部署環境的 volume 持有，不會放入 image 或 Release archive。

升級 bundle 時請使用 `up -d`，不要用 `restart`：`docker compose restart backend` 不會重新評估 `depends_on`，因此不會執行 `migrate` service，會讓 backend 跑在尚未套用 migration 的 schema 上。

### 停止與重新部署 backend

`docker compose stop`、`down`，以及 `up -d` 對已變更 service 所做的停止動作，都會對 backend 送出 SIGTERM。Backend 收到後會執行 drain 而不是直接中止：停止接受新工作、中斷 realtime 連線、等待處理中的 HTTP request 完成、交還本 instance 持有的 presence lease（避免使用者一直顯示為上線直到 `PRESENCE_TTL_MS` 到期）、關閉 Redis，最後以 exit code 0 結束。每一步都有時間上限；若 drain 仍然卡住，會在 20 秒後自行放棄並結束。

因此 backend service 的 `stop_grace_period` 設為 `30s`，同時高於該 20 秒 deadline 與 drain 本身約 14 秒的最壞情況。Docker 預設值為 10 秒，正好落在 drain 中間，會在交還 presence lease 的過程中把它切斷。若你自行撰寫 Compose 或改用其他 orchestrator，請一併帶上這個 30 秒設定——少了它，應用程式無法履行上述關機約定。

有兩個時間窗刻意不予處理，也不需要處理：`migrate:up` 執行期間，以及 process 尚在啟動、handler 還沒註冊之前，container 會忽略 SIGTERM。Migration 在單一 transaction 中執行，並持有 session-scoped advisory lock，因此在該時間窗被強制終止時會完整 rollback，不會留下套用到一半的 schema 或殘留的 lock。

Backend service 刻意不設定 `init: true`。應用程式本身即為 PID 1 並註冊自己的 handler，且不會產生任何子行程，沒有需要 init 回收的 zombie process。加上 tini 只會讓它卡在 Docker 與應用程式之間，而 Docker 執行 tini 時不帶 `-g`，只會將訊號送給它的直接子行程——若中間仍隔著一層 shell，結果會是快速、看似正常的 exit 143，實際上 drain 從未執行。它不能取代應用層的 handler。

`v2.1.1`（含）以前發布的 bundle，其 `docker-compose.release.yml` 中 backend 的啟動命令（`pnpm run migrate:up`、`node dist/backend/src/index.js`）在它所固定的 backend image 中並不存在。已發布的 tag 不可變更，因此這些 archive 無法就地修正——若要部署這些版本，請自行將該兩個 `command:` 改為上述 bun-only 形式。

正式部署應把 `BACKEND_IMAGE` 與 `FRONTEND_IMAGE` 固定為 manifest 記錄的 digest 參照。Frontend image 預設以 `http://localhost:4005` 建置 API URL；現有前端 runtime 邏輯會對標準 `3005`／`4005` host port 做對應，若公開拓撲不同，需另行設定建置參數。

## 資料庫相容規則

資料庫 runtime 固定為 digest 指定的 PostgreSQL 18 Alpine。Schema 由 `backend/migrations` 版本化，並隨 backend image 發布；`migrate` service 會在應用程式啟動前套用尚未執行的 migration。不得把資料庫 volume 或含真實資料的 dump 當成 Release artifact。破壞性 schema 變更必須採 expand-and-contract，並在 migration 期間維持對 legacy Express 部署的相容性。

## 不可變與失敗處理

四個應用程式 image 參照與 GitHub Release 上的 Stack artifacts 視為同一個不可變發布。Release Please 通常會緊接 tag 建立 Release，`release-stack.yml` 會等待該上游 run；不過「Release 是否存在」不是冪等性判準，`near-chat-stack-vX.Y.Z.tar.gz` bundle 才是。乾淨首次發布要求四個 image 參照與 bundle 都不存在。重跑只會驗證所有參照 digest、兩份 attestation、Release manifest 與 bundle 完全一致。Partial publication、digest 不一致、attestation 缺失，或 bundle 存在但 image 遺失都會 fail closed，不會覆寫已完成版本。

因此，要從發布到一半的版本復原，只能先人工刪除未完成的 bundle asset 與四個 image 參照再重跑。`v*` tag ruleset 禁止更新或刪除已發布 tag，所以 `v1.1.0`、`v2.0.0` 等歷史 tag 不得移到重寫後的 commit；若舊版說明不正確，可修改 GitHub Release body，並在後續 changelog 補記，但不可改變 tag 指向。

### 發布卡住時該查哪裡

發布會先經過 Release PR，再進入 Stack workflow。找出最後出現的階段，對照下表：

| 你看到的 run | 發生了什麼 | 該怎麼做 |
| --- | --- | --- |
| `CI` 失敗 | 品質或安全 gate 擋下 `main` commit | 讀失敗的 CI job；`release-please.yml` 正確地不會執行。 |
| `CI` 與 `release-please.yml` 綠燈、Release PR 尚開啟且沒有 tag | 正常的待發布狀態 | 審查預計版本、`CHANGELOG.md`、manifest 與三份 package 版本；準備好後再合併。 |
| `release-please.yml` 綠燈但沒有 Release PR | 沒有尚未發布的 `feat:`、`fix:` 或 breaking commit，或該 run 已被較新的 `main` 取代 | 讀 guard 與 Release Please log；此時不應有正式 tag。 |
| `release-please.yml` 失敗 | Release Please 無法建立／更新 PR、tag 或 Release | 檢查 App variables／secret、安裝與 Contents／Issues／Pull Requests 權限、branch rules 與 tag ruleset bypass actor。 |
| Tag 已存在但沒有 `發布完整 Near Chat Stack` run | App 產生的 tag event 沒有啟動階段 3 | 確認 `release-stack.yml` 仍監聽 `push.tags: v*`；同時先以手動入口補完階段 3。 |
| `發布完整 Near Chat Stack` 失敗 | Stack gate 擋下發布 | 失敗步驟會直接寫出原因：tag 格式、package 版本不一致、tag 不在 `main`、exact tag commit 沒有成功 CI，或 partial publication。 |

原因排除後，以 `gh workflow run release-stack.yml --ref vX.Y.Z` 重跑階段 3。重複執行是安全的：bundle 已附上的版本會走純驗證路徑，不會改動任何東西。

發布成果不得包含 `.env`、credential、包含真實資料的 database volume／dump，或使用者 uploads。
