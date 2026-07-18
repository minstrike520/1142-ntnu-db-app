# 前端 Bundle 分析基準

本文件定義以 Turbopack 原生 analyzer 量測前端 production bundle 的可重現流程，並附上一份一次性的基準快照。在效能相關 PR（見 issue #380-#383）之前與之後，皆應以相同方法比較 bundle 組成，而非憑感覺猜測。

## 為何不使用 `@next/bundle-analyzer`

`@next/bundle-analyzer`是掛在 Webpack build pipeline 上的工具。本專案的 production build（`next build`）預設由 Turbopack 執行，因此該 plugin 不適用。Next.js 16.1 以後改為提供 Turbopack 原生的對應指令：`next experimental-analyze`。

## 可重現指令

```bash
cd frontend
pnpm run analyze
```

此指令會執行 `next experimental-analyze --output`，以分析模式建置應用程式，並將靜態分析結果寫入 `frontend/.next/diagnostics/analyze/`，而非啟動互動式 UI 伺服器。整個 `.next/` 目錄樹已被 gitignore（`frontend/.gitignore` 與根目錄 `.gitignore` 皆忽略 `/.next/`），因此產生的目錄不會有被誤提交的風險。

若想改為互動瀏覽結果而非寫入檔案，可省略 `--output`/`-o`，改執行 `pnpm exec next experimental-analyze`，會在本機啟動一個網頁 UI（預設 port 4000）。

**注意：** `experimental-analyze` 是 Next.js 的實驗性 CLI 指令，其參數與輸出格式可能隨 Next.js 版本更新而改變。若 Next.js 升級後 `pnpm run analyze` 或下方的解析步驟失效，請重新檢查 `pnpm exec next experimental-analyze --help` 並更新本文件。

## 本次基準量測所使用的工具鏈版本

| 工具 | 版本 |
| :--- | :--- |
| Next.js | 16.2.10 |
| Node.js | v22.22.2（本次量測所在沙盒環境；專案 `package.json` engines 要求 Node >=24） |
| pnpm | 11.13.1 |
| Commit | `a087b50`（`dev`，2026-07-18） |

Bundle 位元組大小會隨環境與相依套件版本而變動（隨 `pnpm-lock.yaml`、Node/pnpm 版本、作業系統而變化）。請將下方數字視為**錨定於上述 commit 的近似基準**，而非精確、可跨環境複製的量測值。若需要精確的前後比較，請在同一個 PR 內自行重新執行本指令。

## 未來 PR 如何比較變更前後差異

1. 在 base 分支（或變更前），執行 `pnpm run analyze`，並依下方方法記錄你變更所影響路由的模組體積排行表。
2. 套用你的變更。
3. 再次執行 `pnpm run analyze`，並以相同方法重新萃取排行表。
4. 比較兩次結果：受影響路由的 client JS 總體積是否下降？你鎖定的特定模組是否縮小或從排行榜前段消失？
5. 在 PR 說明中附上你執行的指令與簡短的前後比較摘要（這是本專案 bundle／效能相關 PR 驗收標準的一部分）。

### 萃取模組體積排行的方法

`next experimental-analyze --output` 會在 `frontend/.next/diagnostics/analyze/data/` 下為每個路由產生一份 `analyze.data`（例如 `/` 對應 `data/analyze.data`、`data/chat/[chatId]/analyze.data`、`data/settings/analyze.data`），並額外產生共用的 `data/modules.data`。每個 `.data` 檔案格式為「4 bytes big-endian 長度前綴」加上「JSON payload」（JSON 之後還有一段供互動式 UI 內部使用的二進位相依關係（adjacency list）附加資料，本基準文件不解析該段）。JSON 內容包含 `output_files`、`chunk_parts`（各筆含 `source_index`、`output_file_index`、`size`）與 `sources`（各筆含 `path` 與 `parent_source_index`）。

要依體積排序某路由的 client-side JS 模組：

1. 讀取該路由的 `analyze.data`，去除開頭 4 bytes 長度前綴後以 `json.loads` 解析剩餘內容。
2. 篩選 `output_files` 中 `filename` 含有 `static/chunks` 的項目（可排除 SSR／伺服器端 chunk 與字型／圖片等 media 檔案，只留下 client JS chunk）。
3. 將 `chunk_parts[].size` 依 `source_index` 加總，僅限 `output_file_index` 落在上述篩選集合內的項目。
4. 依大小遞減排序，並透過 `sources[i].path`（視需要沿 `parent_source_index` 往上重建完整路徑）將 `source_index` 對應回實際路徑。

## 基準：各頁面主要 client 模組（於上述 commit 量測）

下表中的框架／第三方套件模組在三個路由間共用，是每個路由無論如何都要負擔的基礎成本。

### 三個路由共用（近似值）

| 大小 | 模組 |
| ---: | :--- |
| ~199 KB | `react-dom/cjs/react-dom-client.production.js` |
| ~112 KB | Next.js `polyfill-nomodule.js`（舊版瀏覽器相容 fallback bundle） |
| ~44 KB | `src/app/globals.css` |
| ~27.5 KB | `src/context/ChatContext.tsx` |
| ~27 KB | `tailwind-merge/dist/bundle-mjs.mjs` |
| ~24 KB | `react-server-dom-turbopack-client.browser.production.js` |
| ~17 KB | `@iconify/react/dist/iconify.js`（icon 執行期） |
| ~15 KB | `src/components/layout/Sidebar.tsx` |
| ~13 KB | `src/components/layout/ChatList.tsx` |
| ~12 KB | `src/locales/en.json` |

### `/`（首頁）

除上方共用集合外，首頁沒有特別突出的路由專屬模組；根路由主要就是外殼（Sidebar／ChatList），尚未選取任何聊天室。

### `/chat/[chatId]`

除共用集合外，額外包含：

| 大小 | 模組 |
| ---: | :--- |
| ~21 KB | `src/components/chat/Chatroom.tsx` |
| ~18.7 KB | `src/components/settings/GroupSettings.tsx` |
| ~10.3 KB | `src/components/ui/ChatBubble.tsx` |

### `/settings`

除共用集合外，額外包含：

| 大小 | 模組 |
| ---: | :--- |
| ~9.9 KB | `src/components/settings/ProfileSettings.tsx` |

## Import Chain 與後續優化候選

以下為至少三個具體且有實證依據的候選項目，供後續效能 issue 使用：

1. **聊天頁面條件式顯示的側邊面板被靜態匯入至初始 bundle**（對應 #381）。`src/components/pages/ChatroomPageContent.tsx` 在模組頂層靜態匯入 `GroupSettings`、`RoomMembersPanel`、`FriendInfoPanel`，卻只在布林狀態為真時才渲染（例如 `{showSettings && <GroupSettings .../>}`）。由於是靜態匯入，這三者即使在從未開啟過的工作階段中，也會一併出現在 `/chat/[chatId]` 路由的初始 client chunk 中——單是 `GroupSettings.tsx` 就佔約 18.7 KB。這是明確的 `next/dynamic` 候選項目。

2. **以執行期圖示名稱查找取代按需圖示元件匯入**（對應 #382）。`Chatroom.tsx`、`Sidebar.tsx`、`MobileNav.tsx` 皆匯入 `{ Icon } from "@iconify/react"`，並透過執行期字串查找 API 渲染圖示（`<Icon icon="bx:home" />`）。專案已在相依套件中包含 `@iconify-react/boxicons`（一個可依需求 tree-shake 的逐圖示元件套件），但目前沒有任何檔案從中匯入具名圖示元件。改為按需匯入可讓未使用的圖示被 tree-shake 掉，而非在每個路由都透過 `iconify.js` 執行期（約 17 KB）於執行期解析。

3. **每個路由都攜帶舊版瀏覽器 polyfill bundle**（對應 #380）。`polyfill-nomodule.js`（約 112 KB）是 Next.js 針對不支援 `<script type="module">` 瀏覽器的預設 fallback bundle，且出現在每個路由的 client chunk 清單中。本專案實際支援的瀏覽器矩陣是否真的需要它，本次基準量測並未驗證——此處僅將其標記為 #380（Turbopack 程式碼分割策略／限制調查）的調查候選項目，而非已確認可移除的成本。

上述描述刻意使用「被靜態匯入」／「出現在每個路由中」等用語，而非因果式的體積論斷：上方排行表呈現的是各路由 client bundle 中實際攜帶的內容，並不能證明任一模組主導了渲染成本或載入時間。後續 issue 應在每次針對性變更後，依本文件的方法重新量測。

## 範圍說明

本任務僅新增 `analyze` 指令與本基準文件，刻意不修改任何 production code、不加入 `next/dynamic` 邊界、不變更圖示匯入方式、也不調整 chunk splitting 設定——這些屬於 #380-#383 的範圍。
