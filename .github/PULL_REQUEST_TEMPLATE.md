## 變更描述 (Description)
<!-- 請在此處詳細描述此 Pull Request 做了哪些修改以及修改的動機。 -->

## 相關的 Issue (Related Issue)
<!-- 請連結相關的 Issue，例如：Closes #123 -->
Closes #

## 變更類型 (Type of Change)
請勾選適用的選項：
- [ ] `feat`: 新增功能 (Feature)
- [ ] `fix`: 修復 Bug
- [ ] `refactor`: 重構代碼
- [ ] `docs`: 修改文件
- [ ] `test`: 新增或修正測試案例
- [ ] `chore`: 建置流程或輔助工具變更
- [ ] `perf`: 效能優化
- [ ] `ci`: CI 設定變更

## 驗證與測試計畫 (Verification & Test Plan)
請詳細說明您是如何測試與驗證這些變更的：

### 本地測試 (Local Tests)
請勾選已在本地執行並通過的檢查：
- [ ] 後端型別檢查 (`docker compose exec backend pnpm exec tsc --noEmit`)
- [ ] 前端型別檢查 (`docker compose exec frontend pnpm exec tsc --noEmit`)
- [ ] 前端 Linter 檢查 (`docker compose exec frontend pnpm run lint`)
- [ ] 單元測試 (`docker compose exec backend pnpm run test:unit`)
- [ ] 整合測試 (`docker compose exec backend pnpm run test:integration` 已通過，含 ephemeral db-test)

### 手動測試 (Manual Verification)
<!-- 請描述您的手動測試步驟，如有前端 UI 的修改，建議附上螢幕截圖或錄影。 -->

## 資料庫變更 (Database Changes)
* 此變更是否包含資料庫 Schema 修改？ **[是 / 否]**
* 若為是，請寫明 Migration 檔案名稱：`____________________`
* 是否已確認遷移與 [docs/database-design.md](file:///home/ray0520/Projects/DB/near-chat/docs/database-design.md) 設計一致？ **[是 / 否]**

## API 與 WebSocket 協定一致性 (API & WebSocket Contract Check)
* 此變更是否涉及 API 路由或 WebSocket 事件的資料結構變更？ **[是 / 否]**
* 是否已確認與 [docs/api-documentation.md](file:///home/ray0520/Projects/DB/near-chat/docs/api-documentation.md) 規範完全一致？ **[是 / 否]**
