# Near Chat Stack 版本發布

[English](../RELEASE.md) | 繁體中文

Near Chat 的版本 tag 代表一份可部署的完整 Stack，不只是 Express 後端。從 `v1.0.1` 起，每個版本都包含前端映像、後端映像、PostgreSQL 18 runtime digest、資料庫 migration runner，以及 Docker Compose 部署 bundle。既有的 `v1.0.0` 後端專用版本已不可變，仍永久保留供回滾。

## 發布版本

發布是自動的。Conventional Commit 合併進 `main` 後會觸發 `.github/workflows/ci.yml` 的 `release` job 執行 Semantic Release：計算下一個版本號、同步 root 與 `backend/package.json`、`frontend/package.json` 的 `version`、更新 `CHANGELOG.md`、推送版本號 commit 與 `vX.Y.Z` tag，並建立帶有 release notes 的 GitHub Release。接著由 `.github/workflows/release-stack.yml` 在**同一個** Release 上補齊 Stack artifact —— 映像、provenance attestation 與部署 bundle。

Tag 以 Semantic Release 為準。它建立的是 **lightweight tag**，`release-stack.yml` 對 lightweight 與 annotated 一律接受，不檢查 tag 型別。仍然強制的條件是：tag 名稱必須完全符合 `vX.Y.Z`、數字版本必須同時等於三份 `package.json`、tag 必須指向目前 `main` HEAD，且該 commit 必須通過 main CI 的 frontend lint／typecheck／build、backend build、unit、integration、E2E 與 security jobs。

作為備援 —— 自動流程失敗、需要人工發布某個版本時 —— 手動推 tag 仍然可行：

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

發布成果不得包含 `.env`、credential、包含真實資料的 database volume／dump，或使用者 uploads。
