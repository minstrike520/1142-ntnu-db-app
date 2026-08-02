# 原生即時通訊協議採用邏輯傳遞語意

原生即時通訊的 JSON 訊框將 `reliable` 定義為應用層傳遞策略，而非 WebSocket 的傳輸保證；`streamId` 則是跨連線、backend instance 與傳輸層保持穩定的邏輯排序通道，不對應 WebSocket connection 或 QUIC stream number，以便未來由 WebTransport adapter 將可靠訊框映射至 stream、可丟棄訊框映射至 datagram。

每個 client command 使用同一個 client-generated `id` 進行 ACK correlation 與冪等重送，ACK 僅表示 command 已通過驗證且業務狀態已成功提交至資料庫，不保證所有訂閱者均已收到廣播；`send_message` 必須持久化該 ID，讓重送回傳原有訊息而不建立重複資料。

瀏覽器在連線前以 access JWT 呼叫 authenticated REST endpoint 取得短效、僅限 WebSocket audience 的簽名 ticket，再將 ticket 而非 access JWT 放入 `/ws` query；server 必須驗證 ticket、期限與 `Origin`，重連則取得新 ticket，並在 #283 提供 Redis 後以 `jti` 加強為跨節點 single-use。

握手成功只建立不超過原 access token 到期時間的 WebSocket session lease；server 於到期前通知 client，client 以重新整理後的 access token 取得新 ticket，並用可靠的 `auth.renew` command 原地延長 lease，未在期限內更新則關閉連線，避免長連線繞過短效憑證邊界。

所有 JSON 訊框使用帶 `version` 的 discriminated envelope，並以 `kind` 區分 `command`、`event`、`ack` 與 `nack`；每個 frame 有唯一 `id`，由 command 衍生的回應與事件以 `correlationId` 指向原 command ID，使版本不相容可被明確處理，同時避免另設重複的 client message identity。

WebSocket upgrade 必須先協商 `near-chat.v1` subprotocol，成功後由 `session.ready` 公布 connection lease 與 limits，JSON envelope 仍保留版本作 runtime defense；Protocol v1 使用 namespaced type vocabulary，以 `message.send`、`rooms.sync` 等動詞表示 commands，以 `message.created`、`presence.changed` 等已發生事實表示 events，並不提供舊 Socket.IO snake-case event name aliases，因為 envelope 的 `kind` 已承擔方向判別且本次為協調式協議切換。

ACK／NACK 只用於 client commands；server 端的 Message change events 不建立 per-connection ACK backlog，而以 revision、delta sync 與 canonical snapshots 修復漏件，Typing indication 等短暫 events 則允許丟棄，避免重複維護兩套 delivery cursors。
