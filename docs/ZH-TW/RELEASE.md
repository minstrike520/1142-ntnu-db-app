# Near Chat Stack 版本發布

[English](../RELEASE.md) | 繁體中文

Near Chat 的版本 tag 代表一份可部署的完整 Stack，不只是 Express 後端。從 `v1.0.1` 起，每個版本都包含前端映像、後端映像、PostgreSQL 18 runtime digest、資料庫 migration runner，以及 Docker Compose 部署 bundle。既有的 `v1.0.0` 後端專用版本已不可變，仍永久保留供回滾。

## 發布版本

只有推送完全符合 `vX.Y.Z` 的 annotated tag 才會啟動發布。數字版本必須同時等於 root、`backend/package.json` 與 `frontend/package.json`。Tag 必須指向目前 `main` HEAD，且該 commit 必須通過 main CI 的 frontend lint／typecheck／build、backend build、unit、integration、E2E 與 security jobs。

```bash
git switch main
git pull --ff-only origin main
git tag -a v1.0.1 -m "Near Chat Stack v1.0.1"
git push origin v1.0.1
```

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

四個應用程式 image 參照與 GitHub Release 視為同一個不可變發布。乾淨的首次發布要求四個 image 參照與 Release 都不存在；重新執行時，只驗證四個參照的 digest、兩個 provenance attestation、Release manifest 與 bundle 是否完全一致。Partial publication、digest 不一致、attestation 缺失或 bundle asset 缺失都會 fail closed；workflow 不會覆寫既有版本。

發布成果不得包含 `.env`、credential、包含真實資料的 database volume／dump，或使用者 uploads。
