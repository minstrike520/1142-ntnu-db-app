# Message change delta 採用 opaque revision cursor

重連同步只增量取得可恢復的 Message changes，也就是訊息新增、編輯與收回；room、membership、read receipt 與 friendship 重新取得 canonical snapshot，而 Typing indication 與 presence 等短暫訊號不予重播，以避免將即時通訊改造成通用事件溯源系統。

每次 Message change 都取得由 server 管理的單調遞增 revision，delta API 以不透明 cursor 表示同步位置並回傳 canonical message state，client 僅以 `messageId` upsert 與去重；不採 `after_id` 或時間戳，因為兩者無法同時可靠識別編輯、收回與分頁邊界。

`streamId` 只界定排序與修復範圍，跨 backend instance 時不得將 frame arrival order 視為 canonical；client 依 revision 套用 Message changes，忽略重複或較舊 revision，並在偵測到缺口時使用 delta API 修復，而不為 Typing indication 等短暫訊號承諾嚴格順序。

Cursor 綁定 `userId` 與目前所有可存取 Room memberships（包含各 membership epoch）的 scope hash 以防跨範圍誤用，但不構成授權憑證；每次 delta request 都重新驗證目前的 Room membership 與 `viewHistory` horizon，離開、重新加入或任何存取範圍改變時回傳 `CURSOR_INVALID`，由 client 從合法 snapshot 重新開始。

每輪 delta sync 在第一個 request 固定 high-water revision，後續分頁只讀取該有限區間並由 opaque cursor 攜帶邊界；完成後同步位置前進至 high-water，再套用同步期間暫存且 revision 更高的 live events，避免忙碌 room 造成無限追逐或 snapshot/live race。
