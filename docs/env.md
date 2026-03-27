# 環境變數與常數管理

本專案採用環境變數集中管理所有部署常數（如 URL、DB 密碼、Secret Key）。

## 開發環境 (Dev)
1. **建立 `.env`**：首次開發請複製專案根目錄的 `.env.example` 並重新命名為 `.env`。
2. **安全性**：`.env` 檔案已加入 `.gitignore`，**絕對不會**被推送到 Git。這保護了開發用的密碼與機密。
3. **前端限制**：Vite 規定前端環境變數必須以 `VITE_` 開頭（例如 `VITE_API_URL`）才會被編譯並暴露給瀏覽器，請勿在這些變數中放入敏感密碼。

## 部署注意事項 (Release)
1. **正式環境不要依賴源碼中的 `.env` 檔**：在 Vercel、AWS、Railway 或 K8s 等雲端服務部署時，應直接透過該平台的「環境變數 (Environment Variables / Secrets) 面板」注入，或者由 CI/CD (如 GitHub Actions) 注入。
2. **自管伺服器部署**：若是透過實體機或 EC2 執行 `docker compose up -d`，請在伺服器專案根目錄手動建立一份 **正式版號的 `.env` 檔案**，並設定嚴格的檔案權限（如 `chmod 600 .env`）。
3. **維護範本**：如有新增變數，請同步更新至 `.env.example` 讓團隊成員知曉，但維持留空或填入假資料，切勿填入真實的 Release 密碼。
