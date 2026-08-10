# Issue #528：即時傳輸層獨立 Spike 研究

研究日期：2026-08-10

Repo 基準：`docs/realtime-architecture-decisions` / `7976b79`

範圍：官方 Bun.serve、Hono `getConnInfo`、Socket.IO Bun engine／heartbeat、Cloudflare Tunnel／proxy headers，以及目前 repo 實作。

## 結論摘要

1. `Bun.serve` + Hono + `@socket.io/bun-engine` 的組合有官方整合範例，且本機以 Bun 1.3.11 實際完成 Socket.IO handshake 與 server-to-client event。這條 transport 路徑目前沒有被官方文件否定。
2. repo 的 Engine.IO heartbeat 是 `pingInterval=25s`、`pingTimeout=20s`。Socket.IO 官方定義的 client 偵測窗口是 `25s + 20s = 45s`；repo 的 Bun server `idleTimeout=60s`，目前設定留有餘裕。`@socket.io/bun-engine` 的 `handler()` 在本機套件版本中也為 25 秒 heartbeat 推導出 50 秒 idle timeout。
3. Cloudflare Tunnel 官方支援 WebSocket；但 origin 的 TCP peer 是 `cloudflared`，不是訪客。Cloudflare 官方對 HTTP 應用建議使用 `CF-Connecting-IP`，而不是把 `X-Forwarded-For` 當作唯一真實來源。repo 目前用 `TRUST_PROXY_HOPS=1` 讀取 XFF，仍必須透過真實 tunnel 核對 header 形狀與 rate-limit 行為，不能只用本機 synthetic header test 宣稱完成。
4. 真實 Cloudflare hostname、跨網路 IP 分桶、WebSocket 長時間 idle、public tunnel latency、tunnel／backend 重啟後 reconnect 尚未完成實測，因此 #528 的外部環境驗收仍未完成。

## 官方 primary sources

### Bun 與 Hono

- [Bun HTTP server：`Bun.serve` 與 `idleTimeout`](https://bun.sh/docs/runtime/http/server)：`idleTimeout` 以秒計算，預設 10 秒、上限 255 秒，`0` 表示停用；`server.stop()` 預設等待 in-flight request/WebSocket 完成，`stop(true)` 才會立即終止。
- [Bun WebSockets](https://bun.sh/docs/runtime/http/websockets)：Bun.serve 使用 `websocket` handler 處理 upgrade 後的連線；WebSocket 的 `idleTimeout` 預設 120 秒，且可在 `websocket` handler 上單獨設定。文件也說明可用 ping/pong 維持長連線。
- [Bun.serve API reference](https://bun.sh/reference/bun/serve)：確認 `Bun.serve`、`server.requestIP()`、`server.stop()` 與 timeout API 的目前型別與生命週期契約。
- [Hono ConnInfo helper](https://hono.dev/docs/helpers/conninfo)：Bun adapter 的匯入是 `import { getConnInfo } from 'hono/bun'`，並從 `getConnInfo(c).remote.address` 取得連線 peer address。

### Socket.IO Bun engine 與 heartbeat

- [Socket.IO Bun engine 官方 README](https://github.com/socketio/bun-engine/blob/main/README.md)：提供 Bun HTTP server 與 Hono 的 `engine.handleRequest()`、`engine.handler()`、`io.bind(engine)` 整合方式；官方範例是把 `engine.handler()` 的結果交給 `Bun.serve`。
- [Socket.IO server options](https://socket.io/docs/v4/server-options/)：`pingInterval` 預設 25,000ms、`pingTimeout` 預設 20,000ms；server 發 ping 後，client 必須在 timeout 內回 pong，client 也會以 `pingInterval + pingTimeout` 判斷 server 是否失聯。
- [Socket.IO maintainer 的 Bun/Hono 整合範例](https://github.com/oven-sh/bun/discussions/14772)：示範 `const { websocket } = engine.handler()` 與 Bun top-level `idleTimeout`，並要求它大於 Engine.IO heartbeat interval。

### Cloudflare Tunnel、WebSocket 與 proxy headers

- [Cloudflare Tunnel FAQ](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/)：Cloudflare Tunnel 完整支援 WebSocket；origin request 是由 `cloudflared` 與 origin 之間的內部連線建立。
- [Cloudflare WebSockets](https://developers.cloudflare.com/network/websockets/)：Cloudflare 支援 proxied WebSocket；WebSocket 若一段時間沒有任何方向的資料會被 idle timeout 關閉，建議使用 keepalive；Cloudflare 網路更新也可能終止既有連線。
- [Cloudflare Tunnel routing](https://developers.cloudflare.com/tunnel/routing/)：HTTP published application 會把 public hostname proxy 到 tunnel 的 local service；TCP/SSH 等其他 protocol 的語意不同，不應拿來替代本題的 HTTP/WebSocket route。
- [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/)：`CF-Connecting-IP` 是 Cloudflare edge 傳給 origin 的訪客 IP header；XFF 會保留 proxy chain，若原 request 已有 XFF，Cloudflare 會追加連線到 Cloudflare 的 proxy address；Cloudflare 明確建議 origin 使用 `CF-Connecting-IP` 或 `True-Client-IP` 恢復原始訪客 IP。
- [Cloudflare WAN connectivity options](https://developers.cloudflare.com/cloudflare-wan/zero-trust/connectivity-options/)：Tunnel origin 的 network peer 是 `cloudflared` process；對 HTTP traffic 使用 `CF-Connecting-IP` 取得 client IP。

### 來源可用性與 repo fallback

上述官方連結在本次研究（2026-08-10）可正常取得，故官方結論沒有以二手文章替代。若後續執行環境無法存取官方網路來源，仍可用下列 repo source links 重現「本專案目前怎麼做」的部分，但它們不能取代 Cloudflare 官方行為證據：

- [`backend/src/bootstrap/realtime.ts`](../../backend/src/bootstrap/realtime.ts)：Bun server、Engine path、heartbeat、timeout 與 REST/Socket.IO 分流。
- [`backend/src/utils/clientIp.ts`](../../backend/src/utils/clientIp.ts)：Hono `getConnInfo`、XFF right-most 解析與 compatibility fallback。
- [`docker-compose.prod.yml`](../../docker-compose.prod.yml)：Cloudflare tunnel service、Compose network 與 loopback port binding。
- [`backend/tests/e2e/rateLimitBucketing.e2e.test.ts`](../../backend/tests/e2e/rateLimitBucketing.e2e.test.ts)：真實 Bun TCP peer fallback 與 synthetic XFF bucketing 測試；不代表真實 Cloudflare header 已驗證。
- [`docs/DEVELOPMENT.md`](../DEVELOPMENT.md)：目前 repo 對 tunnel、proxy trust 與驗收步驟的文件化假設。

因此，若官方來源不可用，報告仍可支持 Bun/Hono/Socket.IO 的 repo-level wiring 判讀；Cloudflare header、proxy chain、public idle timeout、外網 latency 與 tunnel route 則應標記為「未驗證」，不得只根據 repo source links 宣稱完成。

## Repo 實作對照

| 項目 | 目前實作 | 判定 |
|---|---|---|
| Runtime | `backend/src/bootstrap/realtime.ts:90-102` 以單一 `Bun.serve` 分流 Hono REST 與 `/socket.io/` 到 Engine | 符合官方整合模型 |
| Engine | `backend/src/bootstrap/realtime.ts:31-35` 使用 `/socket.io/`、25s ping、20s timeout、1MB buffer | 與 Socket.IO 官方預設 heartbeat 一致 |
| Bun timeout | `backend/src/bootstrap/realtime.ts:71-95` 預設 top-level `idleTimeout=60`，並使用 `engine.handler().websocket` | 目前 60s 大於本機 handler 推導的 50s；需避免未來調高 ping interval 後失去同步 |
| Hono peer IP | `backend/src/utils/clientIp.ts:1-2,56-68` 使用 `hono/bun` 的 `getConnInfo`，Node compatibility harness 才使用 fallback | import 與使用方式符合 Hono 文件 |
| Proxy trust | `backend/src/utils/clientIp.ts:38-54` 依 `TRUST_PROXY_HOPS` 從 XFF 右側取值；production Compose 固定 `TRUST_PROXY_HOPS=1` | 本機可驗證防止 synthetic caller 任意改 bucket；Cloudflare 真實 header 尚未驗證，且官方推薦 CF-Connecting-IP |
| Ingress | `docker-compose.prod.yml:31-32,73-88` 發布的 port 綁定 `127.0.0.1`，tunnel container 透過 Compose network 連 `frontend:3000`、`backend:4000` | repo 拓撲可避免外部直接繞過 tunnel；public route/hostname 設定在 Cloudflare 外部管理，repo 無法獨立證明 |
| Client recovery | `docs/DEVELOPMENT.md:99-112` 定義斷線後走 `/api/v1/sync` | 可吸收 Cloudflare 重啟或 WebSocket drop，但需 public tunnel reconnect test |

### 一個重要的設定細節

`@socket.io/bun-engine` README 的推薦寫法是完整 spread `...engine.handler()`。本 repo 為了把 REST Hono 與 Socket.IO 共用一個自訂 fetch，保留了 `engineHandler.websocket`，但自行指定 top-level `idleTimeout=60`。在目前安裝版本（`@socket.io/bun-engine@0.1.1`、`socket.io@4.8.3`、Hono `4.12.34`）直接讀取 `engine.handler()` 得到 `idleTimeout=50`、`maxRequestBodySize=1MB`；因此目前 60 秒設定是足夠的，但 timeout 與 engine heartbeat 是兩處設定，後續改動必須一起檢查。

另需注意 Bun 官方文件同時描述 top-level server `idleTimeout` 與 `websocket.idleTimeout`。本 repo 的實際 wiring 已用官方 bun-engine maintainer 範例驗證可工作，但應在升級 Bun 或 `@socket.io/bun-engine` 時重新跑長時間 idle test，不應只依賴 TypeScript compile。

## 本機驗證結果

### 已完成

- 直接啟動目前 production listener 的 ephemeral smoke：同一個 `Bun.serve` port `41865` 上，`GET /api/v1/health` 回 `200`、註冊回 `201`，Socket.IO websocket client 回報 `connected`。
- Docker container smoke：`docker compose up -d --build backend` 成功；`http://127.0.0.1:4005/api/v1/health` 回 `{"status":"ok"}`，同一個 `:4005` 以 Socket.IO client 註冊回 `201` 並連線成功。
- Docker websocket idle soak：靜置 `52,003ms`，收到 `2` 次 Engine.IO ping，`connectedAfterIdle=true`，沒有 disconnect。這覆蓋目前 `25s + 20s` heartbeat window，支持 top-level `idleTimeout=60s` 的本機配置。
- `pnpm exec bun test tests/e2e/rateLimitBucketing.e2e.test.ts`：**5 pass / 0 fail**。這確認真實 Bun TCP request 可被 Hono `getConnInfo` 取得 peer address，且目前 XFF right-most bucketing/fallback 行為符合測試預期。
- Docker message latency（同機 host → Docker backend，10 samples）：REST `POST /messages` median `8.97ms`、p95 `27.89ms`；live `new_message` delivery median `7.04ms`、p95 `22.88ms`。目前 ADR-0002 已移除 durable message 的 Socket.IO write/ack path，因此原 #528 所要求的「socket ack」沒有可比較的現行 API；HTTP response 是 command acknowledgement，本次沒有把 live event delivery 冒充成 socket ack。
- 一次性 ephemeral smoke test（未新增檔案）：以 `@socket.io/bun-engine@0.1.1`、Socket.IO client、`Bun.serve` 啟動 `/socket.io/`，使用 `transports: ['websocket']` 連線並收 server event：**connected=true、serverObserved=true、payload={ok:true}**。
- 靜態檢查版本：Bun `1.3.11`、`bun-types` `1.3.14`、Hono `4.12.34`、`@socket.io/bun-engine` `0.1.1`、Socket.IO `4.8.3`。

### 尚未完成、必須在本機／部署環境實測

1. **真實 Cloudflare Tunnel header**：從 public hostname 進入後，記錄或以一次性 diagnostic instrumentation 觀察 origin 收到的 `CF-Connecting-IP`、`X-Forwarded-For`、`getConnInfo(c).remote.address`。確認目前 `TRUST_PROXY_HOPS=1` 是否真的得到訪客 IP，而不是 tunnel peer 或 stacked proxy 的最後一跳。正式修正方向應優先評估直接信任已驗證來源的 `CF-Connecting-IP`，或由可信 proxy 先重寫成受控 header。
2. **跨 client rate-limit**：client A 連續失敗登入至 429；client B 使用另一個網路仍應得到 401；client A 偽造 XFF 不得建立新 bucket。這只能透過真 tunnel、不同來源網路與 `RATE_LIMIT_DISABLED` 未啟用的 production-like backend 驗證。
3. **WebSocket public handshake**：透過 `wss://<public-host>/socket.io/` 完成 Socket.IO handshake、auth、typing/event round trip；同時確認 Cloudflare WebSocket 設定與 tunnel route 沒有把 `/socket.io/` 錯送到 frontend。
4. **Idle/heartbeat soak**：至少觀察超過 45 秒（Socket.IO heartbeat window），建議 10–30 分鐘，確認沒有 idle disconnect；再測 client↔Cloudflare↔origin 的不同 network/protocol 條件。Cloudflare 文件沒有替本專案保證一個可直接代入的 public idle timeout，因此這不能由設定檔推導完成。
5. **重啟與恢復**：重啟 `cloudflared`、backend、或讓 public WebSocket 被 Cloudflare 終止，確認 client reconnect 後先收到 `realtime_ready`、再以 sync cursor 恢復，而不是依賴 Socket.IO connection-state recovery。
6. **Latency**：分別量測 local direct、public REST、public Socket.IO handshake/event RTT；至少收集 p50/p95/p99 與冷啟動／既有連線兩組資料。目前 repo 沒有可引用的實際 tunnel latency baseline。
7. **Origin bypass**：從另一台機器確認 host 的 backend `:4005` 與 database `:5435` 無法連線；只有 public tunnel 能到達應用。Compose 的 loopback binding 是設定結論，不等於已完成網路驗證。

## 最終判定

本 spike 已證明「Bun.serve + Hono + Socket.IO Bun engine」在 repo 版本組合中可以正常啟動並完成 real WebSocket event；heartbeat 的目前數值也有可說明的 timeout 餘裕。這足以支持保留目前 transport 方向。

但 #528 的 Cloudflare 部分不能標記為已完成：目前 repo 的 proxy trust 實作是 XFF-based，而 Cloudflare primary docs 的推薦是 `CF-Connecting-IP`；真實 tunnel header、長連線、跨來源 rate limit、public latency 與重啟恢復尚未有證據。這些項目應在有可用 Cloudflare hostname／tunnel route 的環境中完成一次獨立驗收後，再決定是否更新 proxy trust 實作與正式文件。
