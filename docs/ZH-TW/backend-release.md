# 後端版本發布

[English](../backend-release.md) | 繁體中文

`main` 上的 Express／Node 後端採用 Semantic Versioning。PR #392 合併的應用程式基線是 `5455d6a524c39eeafd4bfb860afb3a7c6fb8b27a`，套件版本為 `1.0.0`。第一個 Release tag 會指向稍後加入本發布自動化、但不改變後端行為的 `main` commit。

## 發布版本

只有推送完全符合 `vX.Y.Z` 的 annotated tag 才會啟動發布。數字版本必須等於 `backend/package.json`，tag 必須指向目前 `main` HEAD，而且同一個 commit 必須已有成功的 main CI run，包含 backend build、unit、integration、E2E 與 security jobs。

```bash
git switch main
git pull --ff-only origin main
git tag -a v1.0.0 -m "Near Chat backend v1.0.0"
git push origin v1.0.0
```

Workflow 會發布：

- `ghcr.io/nearcsie/near-chat-backend:1.0.0`
- `ghcr.io/nearcsie/near-chat-backend:sha-<12-character-commit>`
- provenance attestation，以及記錄完整 commit 與映像 digest 的繁體中文 GitHub Release

不發布可變的 `latest` tag。部署與回滾應固定使用 digest：

```bash
docker pull ghcr.io/nearcsie/near-chat-backend@sha256:<digest-from-release>
```

## 不可變與失敗處理

版本與 commit 映像參照都視為不可變。乾淨的首次發布要求 GitHub Release 與兩個映像參照都不存在。重新執行時，只驗證兩個參照解析為相同 digest、且 Release 已記錄該 commit 與 digest 的完整既有發布。

若發生 partial publication、digest 不一致、只有 Release 沒有映像，或只有映像沒有 Release，workflow 會停止。它不會自動覆寫或重建既有版本；必須先人工調查 registry 與 Release 再決定後續處理。

Production image 使用 Node.js 24 與 pnpm 11。發布成果不得包含 `.env`、credential、包含真實資料的 database volume／dump，或使用者 uploads。
