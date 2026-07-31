# Near Chat

[English](README.md) | 繁體中文

國立臺灣師範大學資料庫系統概論期末專案——即時文字通訊與群組聊天系統。本專案採 Monorepo 架構，結合 Next.js 前端、Node.js/Express 後端，以 Raw SQL 直接操作 PostgreSQL 進行高效查詢，並實現自訂群組權限、聊天分類資料夾、訊息生命週期，以及離線警報（遺言模式）等具體資料庫應用。

---

## 目錄

- [核心功能](#核心功能)
- [資料庫與架構設計](#資料庫與架構設計)
- [技術棧](#技術棧)
- [專案目錄結構](#專案目錄結構)
- [快速開始](#快速開始)
- [生產環境部署](#生產環境部署)
- [測試指令](#測試指令)

---

## 核心功能

1. **即時訊息與狀態**: 基於 Socket.IO 實現的即時單人與群組對話，包含動態在線狀態指示器。
2. **細粒度群組權限管理**:
   - 可自訂成員權限角色（`owner`、`admin`、`member`、`pending`）。
   - 包含禁言狀態 (`is_muted`)、聊天室別名、加入審核機制 (`require_approval`) 等功能。
   - 新成員可選擇性檢視聊天室歷史紀錄 (`view_history`)。
3. **遺言模式與緊急警報**:
   - 定期調度器會檢查使用者的 `last_activity` 活躍時間。
   - 當使用者離線天數超過設定的 `warning_days` 時，系統會自動向設定好的緊急聯絡人發送預設訊息。
4. **聊天分類資料夾**: 使用者可透過自訂資料夾分類聊天對話框（透過 `folders` 及 `folder_rooms` 關聯）。
5. **訊息生命週期控制**: 支援回覆訊息 (`reply_to_id`)、訊息收回 (`is_recalled`)、檔案附件關聯以及軟刪除機制 (`deleted_at`)。

## 技術棧

- **前端**: Next.js 16.2 (App Router), React 19, Tailwind CSS v4, Socket.IO Client。
- **後端**: Node.js, Express v5, Socket.IO, `pg` (PostgreSQL 原始驅動)。
- **資料庫**: PostgreSQL 18。
- **環境編排**: Docker 與 Docker Compose。
- **套件管理**: pnpm。

## 專案目錄結構

```text
.
├── backend/                # Express API 後端服務
│   ├── src/                # 後端 TypeScript 源碼 (routes, controllers, services, repositories)
│   ├── migrations/         # PostgreSQL node-pg-migrate 遷移腳本
│   └── Dockerfile          # 後端映像檔配置
├── frontend/               # Next.js 前端網頁應用
│   ├── app/                # React App Router 頁面與佈局
│   ├── components/         # 樣式與 UI 元件
│   └── Dockerfile          # 前端映像檔配置
├── shared/                 # 前後端共享 TypeScript 型別定義 (唯讀掛載)
├── docs/                   # 系統設計、開發指南、測試及 API 完整文檔
├── docker-compose.yml      # 本地多容器開發環境配置
└── README.md               # 專案概覽與索引
```

## 快速開始

詳細的開發說明文件請參考：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

### 1. 複製環境變數範本
複製本地開發環境變數設定檔（預設值已完成配置，複製後即可直接使用）：
```bash
cp .env.example .env
```

以下是您可以在 `.env` 中設定的核心環境變數說明：

| 參數名稱 | 說明 | 預設值 |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL 連線 URL | `postgresql://chatuser:chatpassword@db:5432/chatdb` |
| `JWT_SECRET` | 用於簽署 JWT 的密鑰鍵值 | `dev_secret_key` |
| `RATE_LIMIT_DISABLED` | 關閉 API 請求速率限制（供測試使用） | `true`（生產環境請設為 `false` 或移除） |
| `NEXT_PUBLIC_API_URL` | 瀏覽器端存取後端 API 的外部 URL | `http://localhost:4005` |
| `ALLOWED_DEV_ORIGINS` | 允許進行開發連線的外部來源網域或 IP (如 Tailscale) | *(空)* |
| `UPLOADS_MOUNT_SOURCE` | 附件上傳的儲存掛載路徑或 Docker Volume 名稱 | `app_uploads` |
| `ATTACHMENT_TYPE_RESTRICTION_ENABLED` | 是否啟用附件檔案類型（MIME 與副檔名）限制檢查 | `false` |
| `ATTACHMENT_ALLOWED_MIME_TYPES` | 允許上傳的 MIME 類型列表（逗號分隔） | `image/jpeg,image/png,image/gif,application/pdf,application/zip,text/plain` |
| `ATTACHMENT_ALLOWED_EXTENSIONS` | 允許上傳的副檔名列表（逗號分隔） | `.jpg,.jpeg,.png,.gif,.pdf,.zip,.txt` |
| `ATTACHMENT_MAX_BYTES` | 附件上傳的單一檔案大小限制上限（以 Byte 為單位） | `10485760`（即 10 MB） |
| `TUNNEL_TOKEN` | 用於生產環境部署的 Cloudflare Tunnel Token | *(空)* |

當您修改了 `.env` 設定（特別是資料庫設定或附件大小限制）後，請執行 `docker compose up -d --build` 重新建置並啟動服務，以使新設定生效。

### 2. 啟動服務容器
使用 Docker Compose 編譯並啟動所有服務：
```bash
docker compose up -d
```
### 3. 匯入 mock 測試資料
執行 Seeding 腳本以建立測試用使用者：
```bash
docker compose exec backend pnpm run db:seed
```
*備註: Seeding 腳本會重置資料庫，並自動建立 6 位預設的使用者（如：`alice@test.com`，預設密碼為 `password123`）供開發測試。*

### 4. 服務連接埠對照表

| 服務名稱 | 訪問網址 | 描述 |
| :--- | :--- | :--- |
| **前端應用 (Frontend)** | [http://localhost:3005](http://localhost:3005) | 主 Next.js 網頁應用介面 |
| **後端服務 (Backend API)** | [http://localhost:4005](http://localhost:4005) | Express API 及 Socket.IO 伺服器 |
| **PostgreSQL 資料庫** | `localhost:5435` | PostgreSQL 18 資料庫 (容器內部對應 `5432` 連接埠) |

---

## 生產環境部署

本專案提供專為生產環境設計的配置檔 `docker-compose.prod.yml`。此配置會建置最佳化後的生產映像檔 (`Dockerfile.prod`)，並啟動 Cloudflare Tunnel 以實現安全的外網連線。

### 1. 配置生產環境變數
請確保 `.env` 檔案中已填寫所有生產環境所需的變數（例如 `POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`DATABASE_URL`、`JWT_SECRET`、`NEXT_PUBLIC_API_URL` 以及 Cloudflare Tunnel 的 `TUNNEL_TOKEN`）。

### 2. 啟動生產服務容器
在生產模式下建置並啟動所有容器：
```bash
docker compose -f docker-compose.prod.yml up -d --build
```

### 3. 執行資料庫遷移
於生產容器中套用最新的資料庫遷移：
```bash
docker compose -f docker-compose.prod.yml exec backend pnpm run migrate:up
```

### 4. 停止生產服務
若要停止並關閉生產環境服務：
```bash
docker compose -f docker-compose.prod.yml down
```

---

## 測試指令

關於如何執行單元測試、整合測試與 E2E 測試的詳細說明，請直接參閱 [開發者與測試指南](docs/ZH-TW/DEVELOPMENT.md#5-測試指南)。

