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
  1. ci.yml              gate jobs → release job → Semantic Release 建立 commit R 與 tag
  2. release-bridge.yml  同一次 ci.yml run 完成時啟動 → 觸發階段 3
  3. release-stack.yml   映像、attestation、bundle
```

1. **`ci.yml` — Semantic Release。** 合併 commit `M` 的八個 gate job 通過後，`release` job 計算下一個版本號、執行 `scripts/update-versions.js` 同步 root 與 `backend/package.json`、`frontend/package.json` 的 `version`、更新 `CHANGELOG.md`、推送 `chore(release): X.Y.Z` commit `R` 與 `vX.Y.Z` tag，並由 `@semantic-release/github` 建立帶有 release notes 的 GitHub Release。Tag 與 Release 都由 Semantic Release 擁有。
2. **`release-bridge.yml` — 交棒。** 監聽的正是**同一次** `ci.yml` run 的完成事件。此時 `R` 與 tag 都已經存在，因此橋接會在 `M` 以及 `M` 在 `main` 上的直接子 commit（也就是 `R`）尋找 `vX.Y.Z` tag，確認該 tag 的 Release 尚未附上 bundle，才觸發階段 3。這次 run 沒有產生版本 tag 時安靜結束 —— 絕大多數的 `ci.yml` run 都會落在這裡。
3. **`release-stack.yml` — Stack。** 建置並推送四個 GHCR 映像參照、簽署兩份 provenance attestation、把 Stack 區段附加到既有的 release notes 之後，並上傳 `near-chat-stack-vX.Y.Z.tar.gz`。

### 為什麼版本號 commit 不會有自己的 CI run

`ci.yml` 交給 Semantic Release 的是預設的 `secrets.GITHUB_TOKEN`，而 [GitHub 會抑制該 token 所產生事件的 workflow run](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow)，只有 `workflow_dispatch` 與 `repository_dispatch` 例外。這個限制對 Semantic Release 的**兩次推送都成立**：

- 把 commit `R` 推上 `main`，不會為 `R` 產生 `ci.yml` run；
- 把 `vX.Y.Z` tag 推上去，不會啟動 `release-stack.yml`。

後者就是橋接存在的理由。前者則是為什麼階段 3 的 CI 驗證接受 tag commit **或其第一個父 commit** 的成功 run —— 要求 `R` 自己通過 CI 是一個永遠無法滿足的條件。

這個退路不是無條件的。階段 3 會比對 tag commit 與其第一個父 commit 的 diff，**兩個條件同時成立**才允許退回父 commit：

- 變更的路徑**全部**落在 `@semantic-release/git` 的四個 `assets` 之內（`package.json`、`frontend/package.json`、`backend/package.json`、`CHANGELOG.md`）；且
- 三份 `package.json` 相對父 commit **除了 `version` 之外完全相同**（以解析後的 JSON 比對，格式差異不影響判定）。

第二個條件不是多餘的。`backend/package.json` 會被複製進 runtime 映像（`backend/Dockerfile.prod`），其中的 `migrate:up` 正是映像 `CMD` 與部署 bundle 的 `migrate` service 實際執行的指令 —— 一個把三份版本號都正確同步、卻偷改該腳本的 commit，否則就能靠借來的綠燈把未經審查的行為送進正式環境。`CHANGELOG.md` 只比對路徑：沒有任何 Dockerfile 會複製它，也不會被執行，最壞情況只是 release notes 內容不實。

任一條件不成立的 commit，一律必須自己通過完整 CI。

### 仍然強制的條件

Tag 以 Semantic Release 為準。它建立的是 **lightweight tag**，`release-stack.yml` 對 lightweight 與 annotated 一律接受，不檢查 tag 型別。階段 3 仍然會在下列任一條件不成立時拒絕發布：tag 名稱必須完全符合 `vX.Y.Z`、數字版本必須同時等於三份 `package.json`、tag 指向的 commit 必須在 `main` 的歷史上，且 tag commit —— 或在 tag commit 未變更四個 release asset 以外任何檔案時，其第一個父 commit —— 必須有一次 main CI run，其 frontend lint／typecheck／build、backend build、unit、integration、E2E 與 security job 全部成功或被 paths filter 略過。

### 手動入口

階段 3 隨時可以人工觸發 —— 橋接沒有啟動時，這就是把發布補完的標準做法：

```bash
gh workflow run release-stack.yml --ref v1.0.1
```

若連 tag 都不存在，就手動推一個。以個人憑證推的 tag **會**直接觸發 `release-stack.yml`，因此橋接壞掉時這個方式一樣有效：

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

四個應用程式 image 參照與掛在 GitHub Release 上的 Stack artifact 視為同一個不可變發布。由於 Release 是 Semantic Release 在 `release-stack.yml` 執行前就先建立的，「Release 是否存在」**不是**冪等性判準 —— 判準是 `near-chat-stack-vX.Y.Z.tar.gz` 這個 bundle asset 是否存在。乾淨的首次發布要求四個 image 參照與該 bundle asset 都不存在，`release-stack.yml` 會把 Stack 區段附加到既有 release notes 之後並上傳 bundle。重新執行時，只驗證四個參照的 digest、兩個 provenance attestation、Release manifest 與 bundle 是否完全一致。Partial publication、digest 不一致、attestation 缺失，或 bundle asset 存在但 image 遺失，都會 fail closed；workflow 不會覆寫既有版本。

因此，要從發布到一半的版本復原，必須先人工刪除 bundle asset 與四個 image 參照（或整個 Release 與 tag）再重跑。

### 發布卡住時該查哪裡

一次會發布的合併總共會產生三個 workflow run。找出最後出現的那一個，對照下表：

| 你看到的 run | 發生了什麼 | 該怎麼做 |
| --- | --- | --- |
| 只有 `CI`，`release` job 綠燈但沒有 tag | Semantic Release 判定沒有需要發布的 commit（job log 中會有 `no release`） | 不用處理，這不是失敗。 |
| `CI` 綠燈但 `release` job 失敗 | Semantic Release 算不出版本號或推不上去 | 讀 job log。常見原因：shallow clone（`release` job 的 checkout 少了 `fetch-depth: 0`），或推送被分支保護規則拒絕 —— 預設的 `GITHUB_TOKEN` 無法推送受保護的分支。 |
| `CI` + tag + Release，但沒有 `橋接 CI 至 Stack 發布` | 橋接沒有啟動 | 確認橋接的 `workflow_run` 過濾條件仍指向 `CI` 這個 workflow。同時先以手動入口補完階段 3。 |
| 橋接跑了但安靜結束 | 合併 commit 與其子 commit 上都找不到 `vX.Y.Z` tag，或該 Release 已經有 bundle | 讀橋接的 log，它會明說是哪一種。多半是正確行為。 |
| `發布完整 Near Chat Stack` 失敗 | 階段 3 的某道驗證擋下了發布 | 失敗的步驟會直接寫出原因：tag 格式、`package.json` 版本不一致、tag 不在 `main` 上、tag commit 與其父 commit 都沒有成功的 CI run，或發布不完整。 |

這裡刻意沒有「第二次 `CI` run」可以找 —— 理由見上方「為什麼版本號 commit 不會有自己的 CI run」。

原因排除後，以 `gh workflow run release-stack.yml --ref vX.Y.Z` 重跑階段 3。重複執行是安全的：bundle 已附上的版本會走純驗證路徑，不會改動任何東西。

發布成果不得包含 `.env`、credential、包含真實資料的 database volume／dump，或使用者 uploads。
