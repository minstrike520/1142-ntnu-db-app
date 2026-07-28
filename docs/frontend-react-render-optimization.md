# 前端 React 重新渲染熱點量測與修正(issue #383)

本文記錄一次以量測數據為依據的 React 重新渲染最佳化:量測環境與固定情境、找到的熱點與證據、實際修正內容,以及相同情境的前後數據對照。後續要再做 render 效能相關的 PR 時,請沿用同一套量測流程比較前後數據,而不是憑感覺加 `React.memo` / `useMemo`。

## 結論摘要

| 情境 | 修正前 | 修正後 |
| :--- | :--- | :--- |
| 收到 5 則訊息(40 則訊息的房間) | 223.8ms,430 次泡泡子樹 render | 64.0ms,5 次 |
| 遠端 typing 指示器亮/滅 | 38.8ms,80 次泡泡子樹 render | 1.1ms,0 次 |
| 本地輸入 5 個按鍵 | 90.3ms,200 次泡泡子樹 render | 15.3ms,0 次 |

三個熱點的修正各自獨立成 commit,可單獨 revert(見下方各節)。

## 量測環境

| 項目 | 值 |
| :--- | :--- |
| 量測方式 | vitest + @testing-library/react(jsdom),掛載真實 `(main)` layout(ChatProvider、Sidebar、MobileNav、ChatroomPageContent) |
| React Compiler | 有套用 — `frontend/vitest.config.ts` 內自訂 vite plugin 以 `@babel/core` 對 `src/**` 執行 `babel-plugin-react-compiler`,與 `next.config.ts` 的 `reactCompiler: true` 對齊 |
| 外部依賴 | REST 以 fixture mock(`tests/mocks/api.ts`)、socket 以記憶體內 fake(`tests/mocks/socket-io-client.ts`)、`next/navigation` 以可控 mock 取代;不需要 backend/DB/Redis |
| 測試資料規模 | 2 個群組房(各 8 名成員;40/30 則訊息)+ 6 個私訊房(各 10 則)+ 2 個資料夾 + 6 位好友(`tests/fixtures.ts`) |
| 指標 | App 層 `<Profiler>`:commit 次數、總 actualDuration;instrumented wrapper(`tests/instrumented/`):ChatBubble / Chatroom / Sidebar 子樹實際 render 次數 |
| Node / vitest | Node v22.22.2、vitest 4.1.10、React 19.2.7(dev build) |

注意:duration 是 React dev build + jsdom 的數字,**只能做同環境的相對前後比較**,不是產線絕對值;render/commit「次數」則與瀏覽器中的行為一致。

### 重現步驟

```bash
cd frontend
bun run test                                  # 全部(行為 + memoization + 量測)
bunx vitest run tests/perf/render-perf.test.tsx   # 只跑量測情境
cat tests/perf/.last-results.txt           # 量測結果(gitignored)
```

固定情境(對應 `tests/perf/render-perf.test.tsx` 內的測試):

- **S1 開啟並切換聊天室**:掛載於 `/chat/room-1`(40 則訊息)後,點擊側欄切到 room-2(30 則)。
- **S2 收/送訊息**:S2a 依序收到 5 則目前房間的訊息;S2b 收到 3 則背景房間的訊息;S2c 輸入並送出 1 則訊息 + 伺服器回音。
- **S3 輸入、typing、面板**:S3a 遠端 typing 指示器亮/滅;S3b 本地連續輸入 5 個按鍵;S3c 右側面板關/開各一次。

### 判斷元件是否被 React Compiler 編譯

量測過程中的關鍵診斷:用 `babel-plugin-react-compiler` 的 `logger.logEvent` 檢查每個元件是編譯成功(`CompileSuccess`)還是 bailout(`CompileError` + reason)。任何在元件函式內的 `try/finally`,或 `try/catch` 區塊中出現條件/邏輯/optional chaining「value block」,都會讓**整個元件**被跳過。

## 熱點清單與證據

Baseline(修正前,React Compiler 已套用):

| 情境 | commits | 總 duration | ChatBubble 子樹 renders | Chatroom 子樹 | Sidebar 子樹 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| S1 切換聊天室 | 6 | 70.0ms | 90 | 5 | 4 |
| S2a 收 5 則(前景) | 15 | 223.8ms | 430 | 10 | 10 |
| S2b 收 3 則(背景) | 6 | 56.8ms | 120 | 3 | 3 |
| S2c 送 1 則+回音 | 6 | 55.5ms | 121 | 5 | 2 |
| S3a 遠端 typing 亮/滅 | 2 | 38.8ms | 80 | 2 | 2 |
| S3b 本地輸入 x5 | 10 | 90.3ms | 200 | 10 | 0 |
| S3c 面板切換 x2 | 2 | 40.7ms | 80 | 2 | 2 |

### 熱點一:ChatContext value 與 handler 識別性不穩定(commit `daca745`、lint 補強 `2eb4887`)

`ChatContext.tsx` 因既有的 hook 依賴抑制註解被 React Compiler 跳過(檔頭本來就記載),所以 provider 每次 render 都重建 context value 物件與全部 37 個 handler closure——任何 provider 狀態變動都讓所有 `useChat()` consumer 重新 render,而且下游任何 memo 邊界都會被不穩定的 handler prop 打穿。這是熱點二、三能生效的前提。

修正(`frontend/src/context/ChatContext.tsx`):

- context value 以 `useMemo` 建立,依賴只剩實際資料欄位。
- handler 以「ref + 恆定 proxy」曝露(沿用檔內既有 `markRoomAsRead` 的模式):proxy 識別性永不變,呼叫時委派到最後一次 commit 的實作。proxy 只會在事件/effect 中被呼叫;**於 render 期間被呼叫**的 `getReadAvatarsForMessage` 則改為 `useCallback` 帶真實依賴,避免讀到上一個 commit 的狀態。
- 此修正單獨量測時七個情境數字幾乎不變(各情境仍有合法的資料變動),屬結構性前置。

### 熱點二:高頻/UI-local 狀態擠在單一 context value(commit `e914d33`)

`typingUsers` 隨對方每個按鍵變動;`uiLanguage` 透過 `useTranslation` 被幾乎每個元件訂閱;`activeProfilePopover`、`showRightPanel` 是純 UI 狀態。它們在單一 value 裡,任何一個變動都會重繪整個 consumer 樹——S3a 的證據:typing 亮/滅共重繪 80 個泡泡子樹 + Sidebar,總 38.8ms,而畫面上只需要更新一行指示文字。

修正(狀態仍留在 `ChatProvider`,只把訂閱通道拆成四個巢狀 leaf context;不是 ChatContext 架構重構):

- `TypingUsersContext` + `useTypingUsers()`:`Chatroom.tsx` 抽出 `TypingIndicator` 元件,typing 事件只重繪指示器。
- `UiLanguageContext` + `useUiLanguage()`:`useTranslation` 改訂閱語言,不再因聊天資料變動重繪。
- `ProfilePopoverContext` + `useProfilePopover()`:`ChatBubble`、`RoomMembersPanel` 改用,解除每顆泡泡對主 context 的訂閱。
- `RightPanelContext` + `useRightPanel()`:`Chatroom`、`ChatroomPageContent`。

效果:S3a 從 38.8ms / 80 次泡泡 render → **1.4ms / 0 次**。

### 熱點三:訊息列表沒有 memo 邊界 + Chatroom/ChatBubble 被 compiler 跳過(commit `b51b61d`)

bailout 診斷顯示 **`Chatroom` 與 `ChatBubble` 在產線 build 中都沒有被 React Compiler 編譯**:

| 元件 | bailout 原因 |
| :--- | :--- |
| `Chatroom` | `handleSend` 的 `try { … } finally { … }`(BuildHIR: TryStatement with finalizer) |
| `ChatBubble` | `handleDownloadAttachment` 的 `try/finally`;另外 catch 內的三元運算式屬「value blocks within try/catch」也會 bailout |

因此每次 `Chatroom` render 都會整串重建訊息列 JSX:收 1 則訊息重繪 86 個泡泡子樹(S2a 430/5 則)、每個按鍵重繪 40 個(S3b)、背景房訊息也重繪整個前景列表(S2b)。

修正(`frontend/src/components/chat/Chatroom.tsx`、`frontend/src/components/ui/ChatBubble.tsx`):

- 移除 `try/finally` 與 try/catch 內的條件運算(錯誤訊息組裝抽成模組層級 helper `reportActionError` / `toErrorMessage`),`Chatroom`、`ChatBubble`、`MessageRow`、`TypingIndicator` 全部恢復被 compiler 編譯。
- 訊息列抽成 `React.memo` 的 `MessageRow`(未讀分隔線 + 泡泡 + 已讀頭像 + hover 動作)。列表 callback 用 `useCallback`(`onReply`/`onEdit`)或 context 穩定 handler(`onRecall`)維持識別性;**不要**從父層傳新建立的物件/closure 給 `MessageRow`,否則 memo 邊界會靜默失效(`tests/chat-memoization.test.tsx` 有 render 次數上限測試守住)。
- 已讀頭像改為每次 render 建一次 `readersByMessageId` 查表(原本每則訊息掃描一次全成員、且呼叫兩次);私訊已讀判定用預建索引表取代逐訊息 `findIndex`,消除 O(N²)。

### 為什麼 React Compiler 沒有自動處理這些?

1. `ChatContext.tsx` 檔頭的 `eslint-disable react-hooks` 抑制讓 compiler 跳過整個 provider(熱點一)。
2. compiler 的自動 memoization 無法阻止「context value 識別性變動」造成的 consumer 重繪——訂閱粒度是 context 本身,只有拆 context 才能縮小(熱點二)。
3. `try/finally` 與 try/catch 內的 value block 是 compiler 目前不支援的語法模式,會讓**整個元件** bailout;而且 compiler 也不會為 `.map()` 的每個項目建立 per-item memo,列表級的 memo 邊界仍需 `React.memo` + 穩定 props(熱點三)。

## 前後數據對照(同一 harness、同一 fixture)

| 情境 | commits(前→後) | 總 duration(前→後) | ChatBubble 子樹 renders(前→後) |
| :--- | :--- | :--- | :--- |
| S1 切換聊天室 | 6 → 6 | 70.0ms → 51.2ms | 90 → 30(僅新房間 30 列首次掛載) |
| S2a 收 5 則(前景) | 15 → 15 | 223.8ms → 64.0ms | 430 → 5 |
| S2b 收 3 則(背景) | 6 → 6 | 56.8ms → 14.2ms | 120 → 0 |
| S2c 送 1 則+回音 | 6 → 6 | 55.5ms → 16.6ms | 121 → 1 |
| S3a 遠端 typing 亮/滅 | 2 → 2 | 38.8ms → 1.1ms | 80 → 0 |
| S3b 本地輸入 x5 | 10 → 10 | 90.3ms → 15.3ms | 200 → 0 |
| S3c 面板切換 x2 | 2 → 2 | 40.7ms → 9.4ms | 80 → 0 |

commit 次數不變是預期的:每個情境的 commit 都對應合法的狀態更新;改善的是每個 commit 內「被重繪的子樹範圍」與總 render 時間。

## 迴歸保護

- `tests/chat-behavior.test.tsx`:訊息顯示、房間切換、未讀標記與徽章、typing 指示器、已讀頭像、面板切換、送出/收回訊息等 12 個行為測試(修正前後皆綠)。
- `tests/chat-memoization.test.tsx`:memoization 合約——handler 識別性跨狀態變動不變、captured handler 仍讀得到最新狀態(防 stale closure)、typing/面板不影響主 context value 識別性、語言切換仍會傳達到翻譯、訊息列 render 次數上限(收 1 則 ≤ 3 列、背景房/本地輸入/遠端 typing = 0 列)、reply/recall 經穩定 callback 仍正常。

## 未處理事項與後續建議

1. **`ChatList` 仍被 compiler bailout**(useState initializer 與 `saveRoomOrder` 的 try/catch 內含 value block)。Sidebar 在量測中成本不高(每情境 0–10 次子樹 render),本次不動;若要處理,把 localStorage 讀寫抽成模組層級 helper 即可,修法與熱點三相同。
2. **ChatContext 整體架構**(rooms/messages/socket 全部在一個 provider、訊息未按房間分桶、unread/preview 用 effect 寫回 rooms)是更根本的重構,超出本 issue「不做大重構」的範圍,應另開 issue 追蹤;本文的量測 harness 可直接拿來驗證該重構。
3. 量測 duration 為 dev build 相對值;若需要瀏覽器端絕對數據,可在真實環境用 React DevTools Profiler 重跑同三個情境(操作步驟同上)。
4. 新增/修改元件時的守則:不要在元件函式內寫 `try/finally` 或在 try/catch 內放條件運算(會讓整個元件失去 compiler 最佳化;錯誤處理抽成模組層級 helper),傳給 `MessageRow` 等 memo 元件的 props 必須維持識別性穩定。
