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

`next experimental-analyze --output` 會在 `frontend/.next/diagnostics/analyze/data/` 下為每個路由產生一份 `analyze.data`（例如 `/` 對應 `data/analyze.data`、`data/chat/[chatId]/analyze.data`、`data/settings/analyze.data`），並額外產生共用的 `data/modules.data`。每個 `.data` 檔案格式為「4 bytes big-endian 長度前綴 `n`」，後接**恰好 `n` bytes** 的 JSON payload，再之後是供互動式 UI 內部使用的二進位相依關係（adjacency list）附加資料——這段附加資料**不是** JSON，不可當作 JSON 解析。JSON payload 內容包含 `output_files`、`chunk_parts`（各筆含 `source_index`、`output_file_index`、`size`）與 `sources`（各筆含 `path` 與 `parent_source_index`）。

要依體積排序某路由的 client-side JS 模組：

1. 讀取該路由的 `analyze.data`，將開頭 4 bytes 以 big-endian `uint32` 解讀為長度 `n`，僅解析 `data[4:4+n]` 作為 JSON——不要對前綴之後的全部內容執行 `json.loads`，因為 `4+n` 之後的附加資料並非合法 JSON，會導致解析錯誤。
2. 篩選 `output_files` 中 `filename` 同時符合「含有 `static/chunks`」**且**「以 `.js` 結尾」的項目（可排除 SSR／伺服器端 chunk、CSS chunk 與字型／圖片等 media 檔案，只留下 client JS chunk——單純以 `static/chunks` 篩選也會匹配到 CSS chunk 檔案，例如包含 `globals.css` 的那個，因此必須加上 `.js` 副檔名檢查，才能讓此指標真正只計入 JS）。
3. 將 `chunk_parts[].size` 依 `source_index` 加總，僅限 `output_file_index` 落在上述篩選集合內的項目。
4. **從加總結果中排除舊版 `nomodule` polyfill。** 它本身就是一個 `static/chunks/*.js` 檔案，光靠步驟 2 並不會排除它——請在排行前明確排除 `path` 含有檔名 `polyfill-nomodule.js` 的來源。請只比對檔名，不要比對完整目錄前綴：重建出的路徑雖然是以 `/` 串接各段 `path`，但各段本身就已經包含雙斜線（例如實際路徑長得像 `.../node_modules//next//dist//build//polyfills//polyfill-nomodule.js`），因此像 `next/dist/build/polyfills/polyfill-nomodule.js` 這種單斜線字串比對會悄悄比對失敗、完全不排除任何項目。若省略（或誤用）此步驟，每個路由的「client JS」總計會被悄悄加回約 112 KB 現代瀏覽器不會執行的 payload（原因見下方獨立說明）。
5. 依大小遞減排序，並透過 `sources[i].path`（視需要沿 `parent_source_index` 往上重建完整路徑）將 `source_index` 對應回實際路徑。

## 基準：各頁面主要 client 模組（於上述 commit 量測）

以下數字皆僅計入 **client JS**（`static/chunks/*.js`），依照上方修正後的篩選方法萃取。下表中的框架／第三方套件模組在三個路由間共用，是每個路由無論如何都要負擔的 JS 基礎成本。

有兩項成本刻意獨立列出、不併入下表，因為它們不是「現代瀏覽器工作階段會執行的 JS」：

- **CSS**：`src/app/globals.css` 會編譯成獨立的 `static/chunks/*.css` chunk（約 44 KB）。它確實是每個路由都會下載的共用資源，但屬於 CSS 而非 JS——若併入「client JS」排行，未來的 CSS 迴歸／改善會被誤判為 JS 的變化。
- **舊版瀏覽器 polyfill**：見下方獨立說明。

### 三個路由共用（client JS，近似值）

| 大小 | 模組 |
| ---: | :--- |
| ~199 KB | `react-dom/cjs/react-dom-client.production.js` |
| ~27.5 KB | `src/context/ChatContext.tsx` |
| ~27 KB | `tailwind-merge/dist/bundle-mjs.mjs` |
| ~24 KB | `react-server-dom-turbopack-client.browser.production.js` |
| ~17 KB | `@iconify/react/dist/iconify.js`（icon 執行期） |
| ~15 KB | `src/components/layout/Sidebar.tsx` |
| ~13 KB | `src/components/layout/ChatList.tsx` |
| ~12 KB | `src/locales/en.json` |

**舊版 `nomodule` polyfill（未計入上表）：** analyzer 輸出中，每個路由也都列出一個約 112 KB 的 `polyfill-nomodule.js`。這是 Next.js 透過 `<script nomodule>` 標籤提供給不支援 `<script type="module">` 瀏覽器的 fallback bundle；支援 module script 的瀏覽器不會執行它，因此對現代瀏覽器工作階段而言，它並非實際執行的 JS payload，即使 analyzer 的靜態輸出仍將它列在每個路由的檔案清單中。為避免高估一般情況下的共用 JS 預算約 112 KB，此處刻意將它排除於上表與下方各路由總計之外。後續請見候選項目 3。

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

1. **預設為關閉狀態的側邊面板被靜態匯入至初始 bundle**（對應 #381）。`src/components/pages/ChatroomPageContent.tsx` 在模組頂層靜態匯入 `GroupSettings`，僅由 `const [showSettings, setShowSettings] = useState(false)` 控制渲染（`{showSettings ? <GroupSettings .../> : <Chatroom .../>}`）。由於是靜態匯入，`GroupSettings.tsx`（約 18.7 KB）即使一開始就是隱藏狀態、且多數工作階段從未開啟過，仍會出現在 `/chat/[chatId]` 路由的初始 client chunk 中。這是明確乾淨的 `next/dynamic` 候選項目。

   `ChatroomPageContent.tsx` 同時也靜態匯入了 `RoomMembersPanel`，但這個候選項目沒有表面上看起來那麼理想：`ChatContext.tsx` 中 `showRightPanel` 預設為 `true`（`useState<boolean>(true)`），且當 `type === "group"` 時 `rightPanel` 會直接指向 `RoomMembersPanel` 並在預設檢視下立即渲染——它並不像 `GroupSettings` 那樣是「尚未開啟」的面板。只有在私聊（`type === "msg"`，此時 `rightPanel` 改指向 `FriendInfoPanel`，完全不會用到 `RoomMembersPanel`）或使用者已手動呼叫 `setShowRightPanel(false)` 關閉面板的工作階段中，它才是真正未使用卻仍被打包的匯入。後續若針對此項目做 `next/dynamic` 化，前後比較應鎖定在這些私聊／面板已關閉的情境，而非宣稱能縮小預設群組聊天檢視的體積。

   `ChatroomPageContent.tsx` 同時也靜態匯入了 `FriendInfoPanel`，但只改這一處的匯入方式並不會縮小初始 bundle：`src/components/layout/Sidebar.tsx`（第 12 行）本身就無條件靜態匯入 `FriendInfoPanel`，而 `Sidebar` 是由 `src/app/(main)/layout.tsx`（本表所列 `/`、`/chat/[chatId]`、`/settings` 三個路由共用的常駐外殼）所渲染。因此無論 `ChatroomPageContent` 怎麼匯入，`FriendInfoPanel` 都已經是初始已登入外殼 bundle 的一部分；本候選項目排除它，若要真正減少體積，需要另外針對 `Sidebar` 本身的匯入方式做調查（例如改從 `Sidebar` 做 dynamic import）。

2. **以執行期圖示名稱查找取代按需圖示元件匯入**（對應 #382）。`Chatroom.tsx`、`Sidebar.tsx`、`MobileNav.tsx` 皆匯入 `{ Icon } from "@iconify/react"`，並透過執行期字串查找 API 渲染圖示（`<Icon icon="bx:home" />`）。專案已相依 `@iconify-react/boxicons`，但它是一個「逐圖示 subpath」套件，並非從套件根目錄具名匯出：每個圖示都是各自 subpath 下的 default export，例如 `import Home from "@iconify-react/boxicons/home";`（已透過 `node_modules/@iconify-react/boxicons/package.json` 的 `exports` map 確認——套件根目錄並無具名匯出形式）。目前沒有任何檔案從這些 subpath 匯入。改為此逐圖示 default import 形式，可讓未使用的圖示被 tree-shake 掉，而非在每個路由都透過 `iconify.js` 執行期（約 17 KB）於執行期解析。

3. **每個路由的 client chunk 清單都列出舊版瀏覽器 `nomodule` polyfill bundle**（對應 #380）。如上方所述，`polyfill-nomodule.js`（約 112 KB）是 Next.js 針對不支援 `<script type="module">` 瀏覽器的預設 fallback bundle；現代瀏覽器不會執行它，但 analyzer 的靜態檔案清單仍在每個路由中列出它，值得先確認本專案實際支援的瀏覽器矩陣是否真的不需要它，再視為可捨棄的成本。此處僅將其標記為 #380（Turbopack 程式碼分割策略／限制調查）的調查候選項目，而非已確認可移除、或實際會被執行的成本。

上述描述刻意使用「被靜態匯入」／「出現在每個路由中」等用語，而非因果式的體積論斷：上方排行表呈現的是各路由 client bundle 中實際攜帶的內容，並不能證明任一模組主導了渲染成本或載入時間。後續 issue 應在每次針對性變更後，依本文件的方法重新量測。

## 範圍說明

本任務僅新增 `analyze` 指令與本基準文件，刻意不修改任何 production code、不加入 `next/dynamic` 邊界、不變更圖示匯入方式、也不調整 chunk splitting 設定——這些屬於 #380-#383 的範圍。
