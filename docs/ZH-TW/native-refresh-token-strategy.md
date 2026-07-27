# 原生用戶端 Refresh Token 傳遞策略（ADR，#328）

本文件記錄 issue #328 所要求的調查：後端目前只透過 `HttpOnly` Cookie（`backend/src/auth/cookies.ts`）傳遞 refresh token，回應內容（body）中完全沒有備援欄位，未來的 Flutter 桌面／行動用戶端該如何攜帶與儲存此憑證。

**決策（TL;DR）：維持現有以 Cookie 為基礎的 `/auth/refresh` 契約不變（方案 A，「Cookie 模擬」）。原生用戶端不使用通用的 cookie jar 套件；改由 `dio` 攔截器從 `/auth/register`、`/auth/login`、`/auth/refresh` 回應中的原始 `Set-Cookie` Header 解析出 `refresh_token` 的值，連同其 `Secure` 旗標、簽發 origin 與到期時間，以單一 JSON 記錄、單次原子寫入儲存於 `flutter_secure_storage`——這三項屬性都必須在每次送出時對照當下 base URL 與時鐘重新驗證，而非只在寫入時驗證一次。攔截器在呼叫 `/auth/refresh` 與 `/auth/logout` 時手動附上 `Cookie: refresh_token=<value>` 請求 Header，兩者共用同一個 single-flight 鎖（並以 session 世代機制確保過期的 refresh 回應無法復原已完成的登出），桌面版強制單一執行個體以避免跨程序競態，登出時並一併清除記憶體中的存取權杖。不需要變更後端 API 契約——但後端輪替設計中有兩個既有、尚未解決的缺口（輪替成功後遺失回應，以及輪替更新並非真正的 compare-and-swap），詳見下方「已知限制」段落。**

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
| `refresh_token_record` | **單一 JSON 物件**，將權杖與其三項屬性一併保存：`{"token": "...", "secure": true, "origin": "https://api.example.com", "expiresAt": 1788000000000}`。以單次 `write()` 寫入單一值，**且僅在下方各項屬性檢查皆通過時才寫入**。為何不可拆成多個鍵，詳見下方〈以單一記錄保存，而非四個鍵〉。（不保存 `Path`／`SameSite`——生命週期由 App 端自行管理，不依賴 cookie 語意。） | `POST /auth/register`、`POST /auth/login`、`POST /auth/refresh` 成功時 | `POST /auth/logout`（用戶端主動觸發）、`POST /auth/refresh` 回傳 `400`／`401` 時，以及下方任一屬性檢查失敗時（對應伺服器端 `authController.refresh` 在 `ValidationError` 時清除自身 cookie 的邏輯） |
| `access_token` | 不持久化，僅保存於記憶體中（Riverpod 狀態）；App 冷啟動時以持久化的記錄透過 `/auth/refresh` 重新取得。由於存取權杖僅 15 分鐘有效，持久化的效益本就不高，此設計可縮小其暴露於磁碟的時間窗。 | — | App 重新啟動（因僅存於記憶體，本就會自然清除），**以及登出時與 `/auth/refresh` 回傳 `400`／`401` 時必須明確清除**——`authController.logout` 只能撤銷 refresh token，無法撤銷已簽發的無狀態 JWT 存取權杖；若登出後不動記憶體中的值，同一個仍在執行的 App 程序內的程式碼，仍可在其剩餘最長 15 分鐘的效期內繼續呼叫受保護 API。登出與 refresh 遭拒必須在同一步驟中清除此值並將 `AuthNotifier` 導向 `unauthenticated`，而不是等待程序結束。 |

`refresh_token_record` 的欄位：

| 欄位 | 意義 |
| :--- | :--- |
| `token` | 從 `Set-Cookie` 回應 Header 中 `refresh_token=` 區段解析出的原始值。 |
| `secure` | 該 `Set-Cookie` 是否帶有 `Secure` 屬性。 |
| `origin` | 簽發此權杖的 API base URL 完整 origin（`scheme://host:port`），例如 `https://api.example.com`。用以還原真實 Cookie 原有的 host-only 隔離（`cookies.ts` 未設定 `Domain` 屬性，因此後端簽發的 Cookie 本來就是 host-only；此欄位存在的唯一目的，就是在手動模擬下補回這道傳輸層本來就有、但模擬機制沒有的邊界）。 |
| `expiresAt` | 同一份 `Set-Cookie` 的 `Max-Age`／`Expires`，換算為絕對 epoch 時間戳。通常等同 `getRefreshTokenTtlMs()`（14 天），但仍需明確記錄，因為 `backend/src/auth/cookies.ts` 允許將 `REFRESH_COOKIE_MAX_AGE_MS` 設得比資料庫端 TTL 更短（本專案目前的 `.env`／`docker-compose*.yml` 皆未設定此變數，但程式碼路徑確實存在）——原生用戶端若忽略它，會在瀏覽器早已丟棄 Cookie 之後仍繼續送出該權杖。 |

**以單一記錄保存，而非四個鍵。** `flutter_secure_storage` 並未提供跨多次 `write()` 的交易機制，因此若把權杖與其屬性分別存放在不同鍵，輪替就變成一組不具原子性的多次寫入。若 App 在寫入途中被作業系統終止——這在行動裝置上是常態事件——儲存可能停留在被撕裂的中間狀態：例如新屬性已寫入、但 `token` 尚未覆寫，冷啟動後所有檢查依然全部通過，用戶端便會理直氣壯地重送一個伺服器早已輪替撤銷的權杖，命中重用偵測並撤銷該使用者的所有工作階段。將四個欄位序列化為單一值後，更新即為單次 `write()`，而各平台後端（Keychain、EncryptedSharedPreferences、libsecret／DPAPI）對單次寫入皆為原子操作，因此中途被終止只可能留下「完整的舊記錄」或「完整的新記錄」，不會出現混合狀態。本文件先前版本所寫的「同步寫入各鍵」並無法達成此保證，不應被解讀為可接受的替代做法。若未來的實作確有使用多個鍵的必要，則必須改為明確定義具提交標記（commit marker）且在啟動時具備復原路徑的更新協定；此處偏好單一記錄形式，正是為了免除這項額外協定。

**下列三項屬性必須在每次送出時重新檢查，而非只在寫入時檢查一次**（依 review 回饋，將本文件先前版本僅涵蓋 `Secure` 的規則，擴及 host 綁定與到期時間）：

1. **`secure`。** `backend/src/auth/cookies.ts` 僅在 `NODE_ENV` 為 `development`／`test` 時省略 `Secure`——在其餘任何環境（即正式環境）下，此 Cookie 都被標記為 `Secure`，目的正是確保它絕不會透過純 HTTP 傳送。App 設定的 base URL 可能在權杖儲存之後才改變（App 更新、切換 build flavor，或使用者手動改連別的後端），因此必須在每次 `onRequest` 時對照*當下*的 base URL scheme 重新驗證：若 `secure` 為 `true` 且目前 scheme 不是 `https`，應拒絕附上該 Cookie，並將已儲存的記錄視為無效。
2. **`origin`。** 真實瀏覽器 Cookie 預設為 host-only（`cookies.ts` 未設定 `Domain` 屬性），因此由 `api-a.example` 簽發的 Cookie 絕不會被送往 `api-b.example`。手動模擬機制若不明確檢查，就沒有等效的隔離——base URL 從一個 HTTPS 主機改為另一個 HTTPS 主機時，會靜默地把前者簽發的權杖重放給後者。必須在每次 `onRequest` 時比對當下 base URL 的 origin 與 `origin`，只要不符即拒絕附上 Cookie 並將記錄視為無效。
3. **`expiresAt`。** 每次 `onRequest` 時與當下時間比對；若已過期，比照無效記錄處理（不附上 Cookie，讓請求正常收到 401，或主動清除並強制重新登入）。

上述三種情況的失敗處理方式一致：拒絕附上 `Cookie` Header、刪除 `refresh_token_record`，並將 `AuthNotifier` 導向 `unauthenticated`——絕不可靜默降級為「照樣送出」，也不可靜默丟棄一個原本合法的權杖。

送出請求的處理方式（`dio` 攔截器，供 #332 實作）：
- 針對 `POST /auth/refresh` 與 `POST /auth/logout` 的 `onRequest`：讀出並反序列化 `refresh_token_record`，依上述規則對照目前 base URL 與時鐘重新驗證 `secure`／`origin`／`expiresAt`，三者皆通過後才設定請求 Header `Cookie: refresh_token=<token>`。登出也必須附上此 Header——`authController.logout` 只有在能從請求中讀到 cookie 時才會呼叫 `revokeToken`，若登出時漏帶，會導致清除了本地儲存，但伺服器端的權杖仍維持有效，直到最長 14 天後自然過期。
- 針對 `/auth/register`、`/auth/login`、`/auth/refresh` 的 `onResponse`：讀取 `set-cookie` 回應 Header，解析出 `refresh_token=<value>` 區段及其 `Secure` 旗標與 `Max-Age`／`Expires`，僅在上述 `Secure` 檢查通過時，才以單次 `write()` 寫入組裝好的記錄（整筆取代舊記錄——權杖每次呼叫皆會輪替）。
- 當 `/auth/refresh` 回傳 `400`／`401`：刪除 `refresh_token_record` 與記憶體中的 `access_token`，並將 `AuthNotifier` 導向 `unauthenticated`（#333 的啟動時 session 恢復流程應將「本地無記錄」與「refresh 呼叫遭拒」視為相同情況處理）。
- **登出與 refresh 必須共用同一個 single-flight 互斥區段**，不能只讓 refresh 單獨序列化。若在 refresh 進行中發起登出，兩者不可交錯執行：可以讓登出等待進行中的 refresh 結束後再清除並撤銷；但更簡單、也更建議的做法是——登出取得同一把鎖後，任何在此之後才抵達的 refresh 回應一律捨棄、不寫回。具體做法：以單調遞增的 session 世代（generation）計數器包住此互斥區段；refresh 的 `onResponse` 在請求發起時記下當時的世代，只有在回應抵達時世代仍相同才允許寫回輪替後的權杖。若不這麼做，一次剛好在使用者登出前於伺服器端完成輪替的 refresh，其回應可能在登出清除儲存「之後」才抵達，把新權杖寫回去，使下次冷啟動時悄悄復原本應登出的工作階段。
- **Single-flight 不能只侷限於單一程序（process）。** 與行動裝置不同，Flutter 桌面版可能同時有多個程序共用同一份 OS Keychain／DPAPI 支援的 `flutter_secure_storage`（例如使用者把 App 開了兩次）。僅限程序內的 `Future`／鎖只能協調同一程序內的 refresh 呼叫；兩個程序可能都在對方寫回輪替後權杖之前讀到同一份舊值，其中較晚寫回的一方會觸發伺服器的重用偵測，撤銷該使用者的所有工作階段。因此桌面版必須擇一：在啟動時強制單一執行個體（第二次啟動導向既有視窗，而非另起新程序——這是此類問題的標準解法），或以作業系統層級的跨程序鎖（例如安全儲存底層檔案旁的 lock file）包住「讀取—刷新—寫回」的臨界區段。本 ADR 建議採用單一執行個體，因為做法較單純，且 #333 本就需要設計殼層／視窗架構，可以自然地一併納入。

## 繼承自既有後端設計、並非本 ADR 新引入的已知限制

以下兩項皆為 `backend/src/services/userService.ts` 與 `backend/src/repositories/refreshTokenRepository.ts` 既有的性質，本 ADR 的用戶端設計無法單方面解決，因為修正需要變更 `backend/`，而這已超出 issue #328 的範圍（「本 issue 僅止於提案，不修改 `backend/` 程式碼」）。兩者今天對現有 Web 用戶端的影響完全相同——都不是由上述原生策略引入，也不是原生端獨有。本 ADR 選擇明確記錄，而非默默假設它們已被處理便逕行採用；是否修正、如何修正，屬於後端 refresh 輪替邏輯負責人的決策。

1. **輪替成功但回應遺失。** 若網路在後端 `userService.refresh` 完成輪替交易之後、但用戶端收到 `Set-Cookie` 回應之前中斷，用戶端仍只持有舊權杖。即使是完全遵守 single-flight、單一執行個體等規範的用戶端，下次使用該舊權杖時仍會命中重用偵測分支，觸發 `revokeAllForUser`，讓使用者所有裝置都因為一次暫時性斷線而被強制登出，而非因為真的發生憑證外洩。此情況在行動數據網路下較容易發生，但現有 Web 用戶端今天有完全相同的曝險。要徹底解決需要伺服器端的配合，例如輪替後設一段短暫寬限期，允許緊接在前的舊權杖再被使用一次。

2. **輪替本身並非 compare-and-swap。** `refreshTokenRepository.rotate()` 先插入新權杖資料列，接著無條件執行 `UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = $2 WHERE token_id = $1`——該 `UPDATE` 並未附加 `revoked_at IS NULL` 條件，而 `userService.refresh` 也只有在 `findByHash` 讀到的資料列於「讀取當下」即為 `revoked_at IS NOT NULL` 時，才會進入重用偵測路徑（`revokeAllForUser`）。若兩次 `/auth/refresh` 都持同一份仍然有效的舊權杖，且雙方都在對方的 `rotate()` 交易提交前就完成 `findByHash`——注意這是「同一份權杖被真正並發地提出」，而非單一用戶端的並發 401（後者已由 single-flight 防住）——則 Postgres 的資料列鎖雖會把兩次 `UPDATE` 序列化，卻不會阻止第二次成功：兩個交易都會插入有效的新權杖資料列，而舊資料列的 `replaced_by` 最終指向較晚提交的那一方，等於默默丟棄「另一個後繼權杖同樣已被簽發」這項事實。結果是一次輪替產生兩個各自有效的後繼權杖，而非第二個呼叫者被判定為重用並遭撤銷——與上述第 1 點方向相反的失效模式，但同樣源自缺少原子性。要收斂此問題，必須改用條件式更新（例如 `... WHERE token_id = $1 AND revoked_at IS NULL` 並檢查受影響筆數），或在決定要輪替或判定重用之前，先對舊資料列執行明確的 `SELECT ... FOR UPDATE`。

## 本 PR 一併修正的文件錯誤

`docs/api-documentation.md` 與 `docs/ZH-TW/api-documentation.md` 原先皆記載 refresh token 有效期為 `7` 天；實測測得的 `Max-Age`（1209600 秒＝14 天）證實程式碼（`backend/src/auth/refreshTokenTtl.ts` 的 `DEFAULT_REFRESH_TTL_DAYS = 14`）一直以來的實際行為皆是如此。本 PR 已將兩份文件皆修正為 `14` 天。

## 對後續 issue 的範疇確認

- **#332（API 用戶端）**：範疇不變。其內文已正確引用 14 天，並將儲存／傳遞方式的決策留給本 ADR；上表即為可直接依循的具體規格。
- **#333（認證流程與路由架構）**：範疇不變。其內文已指定使用 `flutter_secure_storage`；本 ADR 確認此選擇，並補上明確的鍵名與生命週期規格。
