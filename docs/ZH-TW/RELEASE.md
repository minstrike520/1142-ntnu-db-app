# Near Chat Stack 版本發布

[English](../RELEASE.md) | 繁體中文

Near Chat 的版本 tag 代表一份可部署的完整 Stack，不只是 Express 後端。從 `v1.0.1` 起，每個版本都包含前端映像、後端映像、PostgreSQL 18 runtime digest、資料庫 migration runner，以及 Docker Compose 部署 bundle。既有的 `v1.0.0` 後端專用版本已不可變，仍永久保留供回滾。

## 發布版本

發布是自動的。你不需要挑版本號、也不需要推 tag —— Conventional Commit 合併進 `main` 就是全部的觸發條件。

### 版本號從哪裡來

PR 一律以 squash merge 合併，因此進入 `main` 的 commit 就是 **PR 標題**，`@semantic-release/commit-analyzer` 讀的也是它：

| Commit 前綴 | 效果 | 範例 |
| --- | --- | --- |
| `fix:` | Patch | `v1.0.1` → `v1.0.2` |
| `feat:` | Minor | `v1.0.1` → `v1.1.0` |
| `feat!:` 或帶 `BREAKING CHANGE:` footer | Major | `v1.0.1` → `v2.0.0` |
| `docs:`、`chore:`、`refactor:`、`test:`、`ci:` | 不發布 | — |

若一批合併全是不發布的型別，Semantic Release 會記錄 `no release` 並就此停下 —— 這是正常結果，不是失敗。

### 發布的三個階段

```
合併 commit M 進入 main
  1. ci.yml            lint、build、test、security gate
  2. release.yml       CI 成功 → Release App → commit R、tag、GitHub Release
  3. release-stack.yml tag push → 映像、attestation、bundle
```

1. **`ci.yml` — Gate。** 合併 commit `M` 必須讓 frontend lint／typecheck／test／build、backend build／unit／integration／E2E，以及 dependency security jobs 全部成功完成。CI 不持有發布 credential，也不發布任何內容。
2. **`release.yml` — Semantic Release。** `main` 上成功的 `CI` `workflow_run` 會啟動此 workflow。它先為專用 Release GitHub App 建立短效 installation token，再計算下一個版本號、執行 `scripts/update-versions.js` 同步 root 與 `backend/package.json`、`frontend/package.json` 的 `version`、更新 `CHANGELOG.md`、推送 `chore(release): X.Y.Z` commit `R` 與 `vX.Y.Z` tag，並由 `@semantic-release/github` 建立帶有 release notes 的 GitHub Release。Tag 與 Release 都由 Semantic Release 擁有。
3. **`release-stack.yml` — Stack。** App 的 tag push 會直接啟動此 workflow。它會建置並推送四個 GHCR 映像參照、簽署兩份 provenance attestation、把 Stack 區段附加到既有的 release notes 之後，並上傳 `near-chat-stack-vX.Y.Z.tar.gz`。

### Release App 身分與事件鏈

預設的 `secrets.GITHUB_TOKEN` 無法 bypass 限制建立 `v*` tag 的 repository ruleset。因此 `release.yml` 會以 `RELEASE_APP_CLIENT_ID` 與 `RELEASE_APP_PRIVATE_KEY` 換取短效 GitHub App installation token。該 App 只安裝在此 repository，具有 Contents、Issues、Pull Requests 寫入權限，也是版本 tag 建立規則中獲准 bypass 的 actor。

App installation token 產生的事件會啟動 workflow，因此可以直接串成三階段事件鏈。Release workflow 一定等 `M` 的 CI 成功且完整結束後才執行；它推送 tag 之後，不需要 bridge 或 Actions API dispatch 就能啟動 Stack 發布。

App 也會推送 `R`，所以 `R` 會有自己的 `CI` run。該次 run 完成後原本又會啟動 `release.yml`；release guard 會辨識完全符合 `chore(release): X.Y.Z` 的 subject，在要求 App token 前直接結束。若 `main` 已前進，guard 也會略過較舊的 CI 結果，讓最新且成功的 CI run 發布累積的 commits。

Tag push 可能在 `R` 的 CI 完成前啟動階段 3。因此，階段 3 仍接受 `R` 第一個父 commit `M` 已經成功的 CI，但必須先證明 `R` 確實是 Semantic Release 預期產生、範圍受到嚴格限制的版本資產 commit。它會比對 tag commit 與其第一個父 commit 的 diff，**兩個條件同時成立**才允許退回父 commit：

- 變更的路徑**全部**落在 `@semantic-release/git` 的四個 `assets` 之內（`package.json`、`frontend/package.json`、`backend/package.json`、`CHANGELOG.md`）；且
- 三份 `package.json` 相對父 commit **除了 `version` 之外完全相同**（以解析後的 JSON 比對，格式差異不影響判定）。

第二個條件不是多餘的。`backend/package.json` 會被複製進 runtime 映像（`backend/Dockerfile.prod`），其中的 `migrate:up` 正是映像 `CMD` 與部署 bundle 的 `migrate` service 實際執行的指令 —— 一個把三份版本號都正確同步、卻偷改該腳本的 commit，否則就能靠借來的綠燈把未經審查的行為送進正式環境。`CHANGELOG.md` 只比對路徑：沒有任何 Dockerfile 會複製它，也不會被執行，最壞情況只是 release notes 內容不實。

任一條件不成立的 commit，一律必須自己通過完整 CI。

Semantic Release 會先推送 tag，接著才由 `@semantic-release/github` 建立 GitHub Release。階段 3 由該 tag 啟動時，會等待仍在執行的 `release.yml` run 進入終態，避免兩個 workflow 競相建立同一筆 Release。若上游在推送 tag 後發布失敗，階段 3 會繼續走既有復原路徑並自行建立 Release；有限的等待逾時則會 fail closed，可由手動入口重試。

### 仍然強制的條件

Tag 以 Semantic Release 為準。它建立的是 **lightweight tag**，`release-stack.yml` 對 lightweight 與 annotated 一律接受，不檢查 tag 型別。階段 3 仍然會在下列任一條件不成立時拒絕發布：tag 名稱必須完全符合 `vX.Y.Z`、數字版本必須同時等於三份 `package.json`、tag 指向的 commit 必須在 `main` 的歷史上，且 tag commit —— 或在 tag commit 未變更四個 release asset 以外任何檔案時，其第一個父 commit —— 必須有一次 main CI run，其 frontend lint／typecheck／build、backend build、unit、integration、E2E 與 security job 全部成功或被 paths filter 略過。

### 手動入口

階段 3 隨時可以人工觸發 —— Stack workflow 沒有完成時，這就是重試既有 tag 的標準做法：

```bash
gh workflow run release-stack.yml --ref v1.0.1
```

若連 tag 都不存在，就手動推一個；tag push 會直接啟動階段 3：

```bash
git switch main
git pull --ff-only origin main
git tag v1.0.1
git push origin v1.0.1
```

若該 tag 尚無對應的 GitHub Release，`release-stack.yml` 會自行建立。切勿為 Semantic Release 已經發布過的版本手動建立 tag，理由見下方「不可變性與失敗處理」。

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

Compose bundle 會啟動 PostgreSQL，使用固定版本的 backend image 執行一次 `pnpm run migrate:up`，再啟動 backend 與 frontend。PostgreSQL 資料與使用者上傳檔案仍由部署環境的 volume 持有，不會放入 image 或 Release archive。

正式部署應把 `BACKEND_IMAGE` 與 `FRONTEND_IMAGE` 固定為 manifest 記錄的 digest 參照。Frontend image 預設以 `http://localhost:4005` 建置 API URL；現有前端 runtime 邏輯會對標準 `3005`／`4005` host port 做對應，若公開拓撲不同，需另行設定建置參數。

## 資料庫相容規則

資料庫 runtime 固定為 digest 指定的 PostgreSQL 18 Alpine。Schema 由 `backend/migrations` 版本化，並隨 backend image 發布；`migrate` service 會在應用程式啟動前套用尚未執行的 migration。不得把資料庫 volume 或含真實資料的 dump 當成 Release artifact。破壞性 schema 變更必須採 expand-and-contract，並在 migration 期間維持對 legacy Express 部署的相容性。

## 不可變與失敗處理

四個應用程式 image 參照與掛在 GitHub Release 上的 Stack artifact 視為同一個不可變發布。Semantic Release 通常會在推送 tag 後立即建立 Release，`release-stack.yml` 也會等待仍在執行的上游 workflow 完成；不過「Release 是否存在」仍**不是**冪等性判準 —— 判準是 `near-chat-stack-vX.Y.Z.tar.gz` 這個 bundle asset 是否存在。乾淨的首次發布要求四個 image 參照與該 bundle asset 都不存在，`release-stack.yml` 會把 Stack 區段附加到既有 release notes 之後並上傳 bundle。重新執行時，只驗證四個參照的 digest、兩個 provenance attestation、Release manifest 與 bundle 是否完全一致。Partial publication、digest 不一致、attestation 缺失，或 bundle asset 存在但 image 遺失，都會 fail closed；workflow 不會覆寫既有版本。

因此，要從發布到一半的版本復原，必須先人工刪除 bundle asset 與四個 image 參照（或整個 Release 與 tag）再重跑。

### 發布卡住時該查哪裡

一次會發布的合併有三個發布階段，另外還會為版本號 commit `R` 產生預期的驗證 `CI` 與 guard `release.yml` run。找出最後出現的階段，對照下表：

| 你看到的 run | 發生了什麼 | 該怎麼做 |
| --- | --- | --- |
| `CI` 失敗 | 品質或安全 gate 擋下合併 commit | 讀失敗的 CI job；`release.yml` 正確地不會執行。 |
| `CI` 綠燈、`release.yml` 綠燈但沒有 tag | Semantic Release 判定沒有需要發布的 commit（log 中會有 `no release`）、略過版本號 commit，或略過已過期的 CI 結果 | 讀 guard 與 Semantic Release log；這些通常是預期結果。 |
| `release.yml` 失敗 | Semantic Release 算不出版本號或推不上去 | 常見原因是 shallow history、`RELEASE_APP_CLIENT_ID`／`RELEASE_APP_PRIVATE_KEY` 無效、App 權限或安裝遺漏，或 tag ruleset 的 bypass actor 沒有列出該 App。 |
| Tag 已存在但沒有 `發布完整 Near Chat Stack` run | App 產生的 tag event 沒有啟動階段 3 | 確認 `release-stack.yml` 仍監聽 `push.tags: v*`；同時先以手動入口補完階段 3。 |
| `發布完整 Near Chat Stack` 失敗 | 階段 3 的某道驗證擋下了發布 | 失敗的步驟會直接寫出原因：tag 格式、`package.json` 版本不一致、tag 不在 `main` 上、tag commit 與其父 commit 都沒有成功的 CI run，或發布不完整。 |

會發布的合併通常會為 `chore(release): X.Y.Z` commit 產生第二次 `CI`。這是預期行為，而且只做驗證；其下游 `release.yml` run 會在 release-commit guard 結束，避免形成循環。

原因排除後，以 `gh workflow run release-stack.yml --ref vX.Y.Z` 重跑階段 3。重複執行是安全的：bundle 已附上的版本會走純驗證路徑，不會改動任何東西。

發布成果不得包含 `.env`、credential、包含真實資料的 database volume／dump，或使用者 uploads。
