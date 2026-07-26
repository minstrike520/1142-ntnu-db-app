# 原生用戶端 Refresh Token 傳遞策略（ADR，#328）

本文件記錄 issue #328 所要求的調查：後端目前只透過 `HttpOnly` Cookie（`backend/src/auth/cookies.ts`）傳遞 refresh token，回應內容（body）中完全沒有備援欄位，未來的 Flutter 桌面／行動用戶端該如何攜帶與儲存此憑證。

**決策（TL;DR）：維持現有以 Cookie 為基礎的 `/auth/refresh` 契約不變（方案 A，「Cookie 模擬」）。原生用戶端不使用通用的 cookie jar 套件；改由 `dio` 攔截器從 `/auth/register`、`/auth/login`、`/auth/refresh` 回應中的原始 `Set-Cookie` Header 解析出 `refresh_token` 的值，連同其 `Secure` 旗標一併儲存於 `flutter_secure_storage`（每次送出時都對照當下 base URL 重新驗證，而非只驗證一次），並在呼叫 `/auth/refresh` 與 `/auth/logout` 時手動附上 `Cookie: refresh_token=<value>` 請求 Header，兩者共用同一個 single-flight 鎖，桌面版並強制單一執行個體以避免跨程序競態。不需要變更後端 API 契約——但後端輪替設計中一個既有、尚未解決的缺口（伺服器完成輪替後遺失回應）仍然存在，詳見下方「限制」段落。**

## 背景

`backend/src/auth/cookies.ts` 將 `refresh_token` 設定為 `httpOnly: true`、`sameSite: 'strict'`、`secure: NODE_ENV !== 'development' && NODE_ENV !== 'test'`。`POST /auth/refresh`（`backend/src/controllers/authController.ts`）僅從 `req.headers.cookie` 讀取此權杖——`/auth/register`、`/auth/login`、`/auth/refresh` 三者的 JSON 回應 body 中都沒有 `refreshToken` 欄位。非瀏覽器用戶端（Flutter 桌面／行動端）沒有自動的 cookie jar，因此除非自行實作 cookie 處理，或後端改為在 body 中一併回傳權杖，否則無法沿用此傳遞機制。

依 issue 所述，評估以下兩種候選方案：

- **方案 A — Cookie 模擬**：Flutter 用戶端自行解析 `Set-Cookie`，並以 `Cookie` Header 的形式回送該值，不變更後端。
- **方案 B — Body 回傳**：修改後端，依 client 類型切換，在 JSON body 中一併回傳 `refreshToken`，Flutter 端直接以 `flutter_secure_storage` 儲存。

## 測試方法

本次調查所使用的沙盒環境中無法連線 Docker daemon（`docker info` 回報 "cannot connect to the Docker daemon"）。作為替代方案且程式碼路徑完全相同，改以未經修改的 `backend/` 原始碼，搭配真實的 PostgreSQL 16 執行個體（`initdb` + `pg_ctl`，port 5555，`pnpm run migrate:up && pnpm run dev`）直接啟動後端，其餘設定沿用 `.env.example`。此方式執行的是與 `docker compose up` 完全相同的 `authController.ts`／`cookies.ts`／`refreshTokenTtl.ts` 程式碼，因此下列結果應可直接套用；若維護者有 Docker 環境，可對 `docker compose up -d db backend` 重跑相同的 `curl` 指令以再次確認。

## 方案 A：Cookie 模擬 — 實測結果

**完整流程（`NODE_ENV=development`，與本機 Docker Compose 開發環境預設一致）：**

```
$ curl -i -c cookies.txt -X POST http://localhost:4099/api/v1/auth/register \
    -H "Content-Type: application/json" \
    -d '{"email":"adr-test@example.com","name":"ADR Test","password":"password123"}'
HTTP/1.1 201 Created
Set-Cookie: refresh_token=d0d1a759...; Max-Age=1209600; Path=/; Expires=Thu, 06 Aug 2026 23:13:50 GMT; HttpOnly; SameSite=Strict
{"token":"eyJ...","user":{"userId":"...","name":"ADR Test"}}

$ curl -i -b cookies.txt -c cookies.txt -X POST http://localhost:4099/api/v1/auth/refresh
HTTP/1.1 200 OK
Set-Cookie: refresh_token=773cddb7...; Max-Age=1209600; Path=/; Expires=Thu, 06 Aug 2026 23:13:54 GMT; HttpOnly; SameSite=Strict
{"token":"eyJ...","user":{"userId":"...","name":"ADR Test"}}

$ curl -i -X POST http://localhost:4099/api/v1/auth/refresh    # 完全不帶 cookie
HTTP/1.1 400 Bad Request
{"statusCode":400,"message":"Missing refresh token","code":"VALIDATION_ERROR"}
```

觀察結果：
- `Max-Age=1209600` 秒＝恰好 14 天，證實 `DEFAULT_REFRESH_TTL_DAYS = 14`（並非先前 `docs/api-documentation.md` 所寫的 `7` 天——已於本 PR 修正，詳見下方）。
- Refresh token 每次呼叫都會**輪替**（每次回傳新值），且 Cookie 的 `Max-Age` 每次都會重新設為 14 天，因此 `getRefreshCookieMaxAgeMs()` 與資料庫端 TTL 天生保持一致。
- 完全不帶 `Cookie` Header 的請求會得到乾淨、型別化的 `400 VALIDATION_ERROR`，不會造成崩潰——因此原生用戶端若單純不送出該 Header，會安全地降級為「請重新登入」。
- 重複使用已輪替失效的舊權杖會被拒絕（`400`），證實伺服器端已具備基本的 refresh token 重用防護。

**issue 中提及的 `secure` 旗標陷阱 — 已重現並釐清適用範圍：**

```
# 以純 HTTP 對「localhost」登入（curl 與瀏覽器皆將 localhost
# 視為 Secure Context 例外，即使沒有 TLS）：
$ curl -i -c cookies.txt -X POST http://localhost:4099/api/v1/auth/login ...
Set-Cookie: refresh_token=...; ...; Secure; SameSite=Strict
$ curl -v -b cookies.txt -X POST http://localhost:4099/api/v1/auth/refresh
> Cookie: refresh_token=...        # 正常送出——localhost 屬於例外

# 以純 HTTP 對真實（非 localhost）區網位址登入，
# 即 Android 模擬器（10.0.2.2）或實機連上辦公室 Wi-Fi
# 存取開發後端時會使用的位址類型：
$ curl -i -c cookies.txt -X POST http://192.0.2.2:4099/api/v1/auth/login ...
Set-Cookie: refresh_token=...; ...; Secure; SameSite=Strict
$ cat cookies.txt        # curl 靜默地拒絕在純 HTTP 下保存 Secure cookie
(空)
$ curl -v -b cookies.txt -X POST http://192.0.2.2:4099/api/v1/auth/refresh
< HTTP/1.1 400 Bad Request         # 沒有 cookie 可送出——精確重現 issue 所述的疑慮
```

此結果證實了 issue 提出的疑慮，但也釐清了其適用範圍：**只有在後端以 `NODE_ENV=production`（或任何非 `development`／`test` 的值）執行、且用戶端以純 HTTP 連線至非 `localhost` 位址時，此問題才會發生。** 本專案本機開發環境預設（`docker-compose.yml`）已以 `NODE_ENV=development` 執行後端，與現有 Next.js Web 用戶端完全相同——因此 Flutter 預設開發流程（桌面連 `localhost:4005`、Android 模擬器連 `10.0.2.2:4005`、或實機連區網 IP，皆連到同一個 `NODE_ENV=development` 容器）不受影響。此陷阱僅會在開發者刻意以純 HTTP 讓行動用戶端連上 `NODE_ENV=production` 後端時出現；若未來確實需要此情境，現有的 Cloudflare Tunnel 設定（`docker-compose.prod.yml`）已提供 HTTPS，可直接迴避此問題。

## 方案 B：Body 回傳 — 未實測，予以否決

完整測試此方案本身就需要變更後端契約，而這已超出本 issue 範圍（「本 issue 僅止於提案，不修改 `backend/` 程式碼」）。因此改以書面方式否決：

- 需要後端新增 client 類型判斷機制（Header、query 參數，或另立 `/auth/refresh-native` 之類的端點）以決定何時在 body 中回傳 `refreshToken`——這會在即將被 Milestone #1 #279（Bun／Hono 重構）取代的程式碼中新增額外分支，屆時無論何時導入此變更，都需要重新與該重構協調。
- 相較方案 A 並無安全性提升：兩種方案最終都要把權杖放進同一套作業系統層級的安全儲存（`flutter_secure_storage`）。方案 B 唯一省去的只是解析 `Set-Cookie` 的工作，而這在 `dio` 攔截器中不過是幾行程式碼。
- 重複實作了瀏覽器端已經免費取得的憑證傳遞機制，卻沒有帶來對應的用戶端簡化效果。

## 決策細節

**選定方案：方案 A，但以手動解析權杖值取代通用 cookie jar 套件**（亦即「不」加入 `cookie_jar`／`dio_cookie_manager` 的 `PersistCookieJar`）。理由：通用 cookie jar 會將 cookie 以明文 JSON／SQLite 檔案保存於 App 儲存空間，且會如同上方 curl 實測一樣忠實遵守 `Secure` 屬性——而這正是本 ADR 想避免的區網 HTTP 開發陷阱。只解析並儲存權杖本身的值，並透過 `flutter_secure_storage` 保存，可同時迴避這兩個問題：儲存位置由作業系統 Keychain／Keystore／DPAPI 加密（與 #333 既有規格一致），且 App 端不再依賴 cookie 屬性的傳輸語意——它只是借用 cookie 的傳輸格式以相容既有端點，本質上是一種 bearer 風格的憑證。

**需要變更的後端 API 契約：無。** `/auth/register`、`/auth/login`、`/auth/refresh` 皆維持現況使用。

**Flutter 端憑證儲存規格**（供 #332、#333 依此實作）：

| `flutter_secure_storage` 鍵名 | 值 | 寫入時機 | 清除時機 |
| :--- | :--- | :--- | :--- |
| `refresh_token` | 從 `Set-Cookie` 回應 Header 中 `refresh_token=` 區段解析出的原始值，**僅在下方屬性檢查通過時才寫入**（`Path`／`SameSite` 忽略——生命週期由 App 端自行管理，不依賴 cookie 語意） | `POST /auth/register`、`POST /auth/login`、`POST /auth/refresh` 成功時 | `POST /auth/logout`（用戶端主動觸發），以及 `POST /auth/refresh` 回傳 `400`／`401` 時（對應伺服器端 `authController.refresh` 在 `ValidationError` 時清除自身 cookie 的邏輯） |
| `refresh_token_secure` | `"1"` 表示產生目前 `refresh_token` 的 `Set-Cookie` 帶有 `Secure` 屬性，`"0"` 表示沒有。必須與 `refresh_token` 同步寫入／清除——絕不可只讀取 `refresh_token` 而不一併讀取此旗標。 | 與 `refresh_token` 相同 | 與 `refresh_token` 相同 |
| `access_token` | 不持久化，僅保存於記憶體中（Riverpod 狀態）；App 冷啟動時以持久化的 `refresh_token` 透過 `/auth/refresh` 重新取得。由於存取權杖僅 15 分鐘有效，持久化的效益本就不高，此設計可縮小其暴露於磁碟的時間窗。 | — | App 重新啟動（因僅存於記憶體，本就會自然清除） |

**`Secure` 屬性仍須遵守，不可忽略——且必須在每次送出時重新檢查，而非只在寫入時檢查一次。** `backend/src/auth/cookies.ts` 僅在 `NODE_ENV` 為 `development`／`test` 時省略 `Secure`——在其餘任何環境（即正式環境）下，此 Cookie 都被標記為 `Secure`，目的正是確保它絕不會透過純 HTTP 傳送。若原生用戶端無視此屬性、一律儲存並重送權杖，一旦有人以純 HTTP 連線正式環境的 release build，就會直接破壞這道防護。只在權杖首次寫入時檢查也不夠：App 設定的 base URL 可能在權杖儲存之後才改變（App 更新、切換 build flavor，或使用者手動改連別的後端），因此攔截器必須將 `Secure` 旗標與權杖一併持久化（即上表的 `refresh_token_secure`），並在每次 `onRequest` 時，對照*當下*的 base URL scheme 重新驗證——而非只在儲存當下驗證一次。若 `refresh_token_secure` 為 `"1"` 且目前 base URL scheme 不是 `https`，應拒絕附上該 Cookie，並將已儲存的權杖視為無效（刪除它、將 `AuthNotifier` 導向 `unauthenticated`），而不是透過純 HTTP 洩漏它，也不是靜默丟棄一個原本合法的 development 權杖。

送出請求的處理方式（`dio` 攔截器，供 #332 實作）：
- 針對 `POST /auth/refresh` 與 `POST /auth/logout` 的 `onRequest`：從安全儲存讀出 `refresh_token`／`refresh_token_secure`，依上述規則對照目前 base URL scheme 重新驗證，通過後才設定請求 Header `Cookie: refresh_token=<value>`。登出也必須附上此 Header——`authController.logout` 只有在能從請求中讀到 cookie 時才會呼叫 `revokeToken`，若登出時漏帶，會導致清除了本地儲存，但伺服器端的權杖仍維持有效，直到最長 14 天後自然過期。
- 針對 `/auth/register`、`/auth/login`、`/auth/refresh` 的 `onResponse`：讀取 `set-cookie` 回應 Header，解析出 `refresh_token=<value>` 區段與 `Secure` 旗標，僅在上述 `Secure` 檢查通過時才將權杖與其 `refresh_token_secure` 旗標一併寫入安全儲存（覆蓋舊值——權杖每次呼叫皆會輪替）。
- 當 `/auth/refresh` 回傳 `400`／`401`：刪除已儲存的 `refresh_token`／`refresh_token_secure`，並將 `AuthNotifier` 導向 `unauthenticated`（#333 的啟動時 session 恢復流程應將「本地無 `refresh_token`」與「refresh 呼叫遭拒」視為相同情況處理）。
- **登出與 refresh 必須共用同一個 single-flight 互斥區段**，不能只讓 refresh 單獨序列化。若在 refresh 進行中發起登出，兩者不可交錯執行：可以讓登出等待進行中的 refresh 結束後再清除並撤銷；但更簡單、也更建議的做法是——登出取得同一把鎖後，任何在此之後才抵達的 refresh 回應一律捨棄、不寫回。具體做法：以單調遞增的 session 世代（generation）計數器包住此互斥區段；refresh 的 `onResponse` 在請求發起時記下當時的世代，只有在回應抵達時世代仍相同才允許寫回輪替後的權杖。若不這麼做，一次剛好在使用者登出前於伺服器端完成輪替的 refresh，其回應可能在登出清除儲存「之後」才抵達，把新權杖寫回去，使下次冷啟動時悄悄復原本應登出的工作階段。
- **Single-flight 不能只侷限於單一程序（process）。** 與行動裝置不同，Flutter 桌面版可能同時有多個程序共用同一份 OS Keychain／DPAPI 支援的 `flutter_secure_storage`（例如使用者把 App 開了兩次）。僅限程序內的 `Future`／鎖只能協調同一程序內的 refresh 呼叫；兩個程序可能都在對方寫回輪替後權杖之前讀到同一份舊值，其中較晚寫回的一方會觸發伺服器的重用偵測，撤銷該使用者的所有工作階段。因此桌面版必須擇一：在啟動時強制單一執行個體（第二次啟動導向既有視窗，而非另起新程序——這是此類問題的標準解法），或以作業系統層級的跨程序鎖（例如安全儲存底層檔案旁的 lock file）包住「讀取—刷新—寫回」的臨界區段。本 ADR 建議採用單一執行個體，因為做法較單純，且 #333 本就需要設計殼層／視窗架構，可以自然地一併納入。

**以下限制繼承自既有後端設計，並非本 ADR 新引入：** 若網路在後端 `userService.refresh`（`backend/src/services/userService.ts`）已完成輪替交易之後、但用戶端收到 `Set-Cookie` 回應之前中斷，用戶端仍只持有舊權杖。即使是完全遵守 single-flight、單一執行個體等規範的用戶端，下次使用該舊權杖時仍會命中重用偵測分支，觸發 `revokeAllForUser`，讓使用者所有裝置都因為一次暫時性斷線而被強制登出，而非因為真的發生憑證外洩。這並非本 ADR 新增的風險：現有 Web 用戶端今天就有相同曝險（伺服器完成輪替與瀏覽器收到 `Set-Cookie` 之間若連線中斷，結果完全相同），只是在一般有線／Wi-Fi 連線下較不容易發生，行動數據網路下機率較高。要徹底解決需要伺服器端的配合（例如輪替後短暫寬限期，讓緊接在前的舊權杖仍可再用一次），而這已超出本 issue 範圍（「本 issue 僅止於提案，不修改 `backend/` 程式碼」）。本 ADR 不解決此問題，而是將其明確列為留給後端 refresh 輪替邏輯負責人裁決的後續決策，而非默默假設原生策略已經處理好這個情況便逕行採用。
- **Refresh 呼叫必須序列化（single-flight），不可每個請求各自呼叫。** 後端將「重複使用已輪替失效的 refresh token」視為憑證外洩，會呼叫 `revokeAllForUser`（`backend/src/services/userService.ts`）撤銷該使用者的所有權杖。若多個並發請求同時收到 `401`，各自以同一份已儲存的 refresh token 呼叫 `/auth/refresh`，只有第一個會成功，其餘會重用已輪替失效的舊權杖，進而觸發整個帳號的權杖全部被撤銷。現有 Web 用戶端已針對此情況做了防護（`frontend/src/lib/api.ts` 的 `runExclusiveRefresh`／`isRefreshing` 搭配訂閱佇列）；Flutter 攔截器必須實作等效機制——例如以單一進行中的 `Future`／鎖包住 `/auth/refresh`，讓並發的 401 共用同一次 refresh，而非各自發起。

## 本 PR 一併修正的文件錯誤

`docs/api-documentation.md` 與 `docs/ZH-TW/api-documentation.md` 原先皆記載 refresh token 有效期為 `7` 天；實測測得的 `Max-Age`（1209600 秒＝14 天）證實程式碼（`backend/src/auth/refreshTokenTtl.ts` 的 `DEFAULT_REFRESH_TTL_DAYS = 14`）一直以來的實際行為皆是如此。本 PR 已將兩份文件皆修正為 `14` 天。

## 對後續 issue 的範疇確認

- **#332（API 用戶端）**：範疇不變。其內文已正確引用 14 天，並將儲存／傳遞方式的決策留給本 ADR；上表即為可直接依循的具體規格。
- **#333（認證流程與路由架構）**：範疇不變。其內文已指定使用 `flutter_secure_storage`；本 ADR 確認此選擇，並補上明確的鍵名與生命週期規格。
