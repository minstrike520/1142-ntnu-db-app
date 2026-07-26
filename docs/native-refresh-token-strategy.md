# Native Client Refresh Token Strategy (ADR, #328)

This document records the investigation requested by issue #328: how the future Flutter desktop/mobile clients should carry and store the refresh token, given the backend today only exposes it through an `HttpOnly` cookie (`backend/src/auth/cookies.ts`) with no fallback in the JSON response body.

**Decision (TL;DR): Keep the existing cookie-based `/auth/refresh` contract unchanged (Option A, "cookie mimicry"). Native clients do not use a generic cookie-jar library; instead a `dio` interceptor extracts the `refresh_token` value from the raw `Set-Cookie` response header on `/auth/register`, `/auth/login`, and `/auth/refresh`, stores it in `flutter_secure_storage` alongside its `Secure` flag (re-validated against the current base URL on every send, not just once), and manually attaches it as a `Cookie: refresh_token=<value>` request header on `/auth/refresh` and `/auth/logout` calls, both sharing one single-flight lock and desktop builds enforcing single-instance to avoid cross-process races. No backend API contract change is required — though a known, pre-existing gap in the backend's rotation design (loss of the response after the server has already rotated) remains unresolved; see "Known limitation" below.**

## Background

`backend/src/auth/cookies.ts` sets `refresh_token` as `httpOnly: true`, `sameSite: 'strict'`, and `secure: NODE_ENV !== 'development' && NODE_ENV !== 'test'`. `POST /auth/refresh` (`backend/src/controllers/authController.ts`) reads the token exclusively from `req.headers.cookie` — there is no `refreshToken` field anywhere in the JSON response body of `/auth/register`, `/auth/login`, or `/auth/refresh`. A non-browser client (Flutter desktop/mobile) has no automatic cookie jar, so it cannot rely on this transport unless it replicates cookie handling itself, or the backend is changed to also return the token in the body.

Two candidate approaches were evaluated, per the issue:

- **Option A — Cookie mimicry**: the Flutter client parses `Set-Cookie` itself and resends the value as a `Cookie` header, without changing the backend.
- **Option B — Body return**: the backend is changed to also return `refreshToken` in the JSON body (behind a client-type switch), and the Flutter client stores it directly via `flutter_secure_storage`.

## Test methodology

The project's Docker daemon was not available in the sandbox used for this investigation (`docker info` fails with "cannot connect to the Docker daemon"). As a substitute with identical code paths, the backend was run directly against a real PostgreSQL 16 instance (`initdb` + `pg_ctl`, port 5555) using the unmodified `backend/` source (`pnpm run migrate:up && pnpm run dev`), with the same `.env.example` values otherwise. This exercises the exact same `authController.ts` / `cookies.ts` / `refreshTokenTtl.ts` code that runs under `docker compose up`, so the results below should transfer directly; a maintainer with Docker access may re-run the same `curl` commands against `docker compose up -d db backend` to double check.

## Option A: Cookie mimicry — empirical results

**Full flow (`NODE_ENV=development`, matches the default local Docker Compose dev stack):**

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

$ curl -i -X POST http://localhost:4099/api/v1/auth/refresh    # no cookie at all
HTTP/1.1 400 Bad Request
{"statusCode":400,"message":"Missing refresh token","code":"VALIDATION_ERROR"}
```

Findings:
- `Max-Age=1209600` seconds = exactly 14 days, confirming `DEFAULT_REFRESH_TTL_DAYS = 14` (not the `7` days previously written in `docs/api-documentation.md` — corrected in this PR, see below).
- The refresh token **rotates** on every call (new value each time), and the cookie's `Max-Age` is always freshly re-issued to 14 days, so `getRefreshCookieMaxAgeMs()` and the DB-side TTL stay aligned by construction.
- A request with no `Cookie` header at all gets a clean, typed `400 VALIDATION_ERROR` — never a crash — so a native client that simply doesn't send the header degrades safely to "please log in again."
- Re-using an already-rotated-out token is rejected (`400`), confirming basic refresh-token-reuse protection is already in place server-side.

**The `secure` flag pitfall named in the issue — reproduced and scoped:**

```
# Login over plain HTTP against "localhost" (curl, and browsers, treat
# localhost as a Secure Context exception even without TLS):
$ curl -i -c cookies.txt -X POST http://localhost:4099/api/v1/auth/login ...
Set-Cookie: refresh_token=...; ...; Secure; SameSite=Strict
$ curl -v -b cookies.txt -X POST http://localhost:4099/api/v1/auth/refresh
> Cookie: refresh_token=...        # sent fine — localhost is exempted

# Login over plain HTTP against a real (non-localhost) LAN-style address,
# i.e. what an Android emulator (10.0.2.2) or a real device on the office
# Wi-Fi would use to reach a dev backend:
$ curl -i -c cookies.txt -X POST http://192.0.2.2:4099/api/v1/auth/login ...
Set-Cookie: refresh_token=...; ...; Secure; SameSite=Strict
$ cat cookies.txt        # curl silently refused to persist a Secure cookie over plain HTTP
(empty)
$ curl -v -b cookies.txt -X POST http://192.0.2.2:4099/api/v1/auth/refresh
< HTTP/1.1 400 Bad Request         # no cookie to send — reproduces the issue's concern exactly
```

This confirms the pitfall the issue flagged, but also narrows it: **it only bites when the backend runs with `NODE_ENV=production` (or any value other than `development`/`test`) and the client talks to it over plain HTTP on a non-`localhost` address.** The project's default local dev stack (`docker-compose.yml`) already runs the backend with `NODE_ENV=development`, exactly like the existing Next.js web client does today — so the default Flutter dev workflow (against `localhost:4005` on desktop, `10.0.2.2:4005` on the Android emulator, or a LAN IP on a real device, all hitting the same `NODE_ENV=development` container) is unaffected. The pitfall would only appear if a developer deliberately points a mobile client at a `NODE_ENV=production` backend over plain HTTP; if that scenario is ever needed, the existing Cloudflare Tunnel setup (`docker-compose.prod.yml`) already provides HTTPS and sidesteps it.

## Option B: Body return — not empirically tested, and rejected

Testing this option end-to-end would itself require a backend contract change, which is out of scope for this issue ("本 issue 僅止於提案，不修改 `backend/` 程式碼"). It is rejected on paper instead:

- It requires the backend to grow a client-type switch (header, query param, or a separate `/auth/refresh-native`-style endpoint) to decide when to include `refreshToken` in the body — extra branching in code that Milestone #1's #279 (Bun/Hono rewrite) is about to replace anyway, so any such change would need to be re-coordinated with that migration regardless of when it lands.
- It does not improve on Option A's security: the token still needs to end up in the same OS-backed secure storage (`flutter_secure_storage`) either way. The only thing it removes is `Set-Cookie` parsing, which is a handful of lines in a `dio` interceptor.
- It duplicates the credential transport that browsers already use for free, for no corresponding client-side simplification.

## Decision details

**Chosen approach: Option A, with manual value extraction instead of a generic cookie-jar package** (i.e. do *not* add `cookie_jar` / `dio_cookie_manager` with `PersistCookieJar`). Rationale: a generic cookie jar persists cookies to a plaintext JSON/SQLite file under app storage and would also faithfully enforce the `Secure` attribute the same way curl did above — which is exactly the LAN-HTTP dev pitfall this ADR needs to avoid. Extracting just the token value and storing it via `flutter_secure_storage` sidesteps both problems: storage is OS-keychain/Keystore/DPAPI-backed (matching what #333 already specifies), and the app is no longer relying on cookie-attribute transport semantics at all — it is a bearer-style credential reusing the cookie wire format only for compatibility with the existing endpoint.

**Backend API contract changes required: none.** `/auth/register`, `/auth/login`, and `/auth/refresh` are used exactly as they exist today.

**Flutter-side credential storage spec** (for #332 and #333 to implement against):

| `flutter_secure_storage` key | Value | Written on | Cleared on |
| :--- | :--- | :--- | :--- |
| `refresh_token` | Raw value parsed out of the `refresh_token=` segment of the `Set-Cookie` response header, **only when the attribute check below passes** (`Path`/`SameSite` are ignored — lifecycle is managed app-side, not via cookie semantics) | Successful `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh` | `POST /auth/logout` (client-initiated), and any `400`/`401` response from `POST /auth/refresh` (mirrors the server clearing its own cookie on `ValidationError` in `authController.refresh`) |
| `refresh_token_secure` | `"1"` if the `Set-Cookie` that produced the current `refresh_token` carried the `Secure` attribute, `"0"` otherwise. Written and cleared in lockstep with `refresh_token` — never read `refresh_token` without also reading this flag. | Same as `refresh_token` | Same as `refresh_token` |
| `access_token` | Not persisted. Keep in memory only (Riverpod state); re-derive via `/auth/refresh` on cold start using the persisted `refresh_token`. Minimizes on-disk exposure window given the 15-minute lifetime already makes persistence low-value. | — | App restart (by construction, since it's memory-only) |

**`Secure` attribute must still be honored, not ignored — and it must be re-checked on every send, not only at write time.** `backend/src/auth/cookies.ts` only omits `Secure` when `NODE_ENV` is `development`/`test` — in any other environment (i.e. real production) the cookie is marked `Secure` specifically so it is never sent over plain HTTP. A native client that stores and resends the token regardless of this attribute defeats that guard the moment someone points a release build at a plain-HTTP host. Checking this only when the token is first written is not enough either: the app's configured base URL can change after the token was stored (an app update, a build flavor swap, or a user manually pointed at a different backend), so the interceptor must persist the `Secure` flag alongside the token (`refresh_token_secure` above) and re-validate it against the *current* base URL scheme on every `onRequest`, not just once at storage time — if `refresh_token_secure` is `"1"` and the current base URL scheme is not `https`, refuse to attach the cookie and treat the stored token as invalid (delete it, drive `AuthNotifier` to `unauthenticated`) rather than either leaking it over plain HTTP or silently dropping a legitimately non-`Secure` development token.

Outgoing request handling (`dio` interceptor, for #332):
- On `onRequest` for `POST /auth/refresh` and `POST /auth/logout`: read `refresh_token`/`refresh_token_secure` from secure storage, re-validate `refresh_token_secure` against the current base URL scheme as described above, and if it passes, set request header `Cookie: refresh_token=<value>`. Logout must attach it too — `authController.logout` only calls `revokeToken` when it can read the cookie from the request, so skipping this on logout would clear local storage while leaving the token valid server-side until it naturally expires (up to 14 days later).
- On `onResponse` for `/auth/register`, `/auth/login`, `/auth/refresh`: read the `set-cookie` response header, extract the `refresh_token=<value>` segment and the `Secure` flag, and write the value plus its `refresh_token_secure` flag to secure storage only if the `Secure` check above passes (overwriting the previous value — the token rotates every call).
- On a `400`/`401` from `/auth/refresh`: delete the stored `refresh_token`/`refresh_token_secure` and drive `AuthNotifier` to `unauthenticated` (#333's session-restore flow should treat "no stored refresh_token" and "refresh call rejected" identically).
- **Refresh and logout must share the same single-flight critical section**, not just refresh alone. If a logout is requested while a refresh is in flight, the two must not interleave: either logout waits for the in-flight refresh to finish and then immediately clears storage and revokes, or — simpler and preferred — logout acquires the same lock, and once it holds it, any refresh response that arrives afterward is discarded rather than written back. Concretely: guard the critical section with a monotonically increasing session generation counter; the `onResponse` refresh handler captures the generation at request start and only persists the rotated token if the generation is still current when the response arrives. Without this, a refresh that rotates server-side just before a user-initiated logout can write the new token back to storage *after* logout clears it, silently undoing the logout on the next cold start.
- **Single-flight must not be scoped to a single process.** Unlike mobile, Flutter desktop builds can have more than one process running against the same OS keychain/DPAPI-backed `flutter_secure_storage` at once (e.g. a user launches the app twice). An in-process `Future`/lock only serializes refresh calls within one process; two processes can each read the same stored token before either writes back its rotated replacement, and the second to write trips the server's reuse detection and revokes every session for that user. Desktop builds must therefore either enforce single-instance behavior at launch (redirect a second launch to the existing window instead of starting a second process — the standard fix for this class of problem) or wrap the read-refresh-write section in an OS-level cross-process lock (e.g. a lock file next to the secure storage backing store). This ADR recommends single-instance enforcement as the simpler of the two, since #333 already needs a shell/window architecture where this fits naturally.

**Known limitation carried over from the existing backend design, not introduced by this ADR:** if the network drops after the server commits the rotation in `userService.refresh` (`backend/src/services/userService.ts`) but before the client receives the `Set-Cookie` response, the client is left holding a token whose row now has `replacedBy` set. The next attempt to use it — even a single-flight, single-instance, otherwise-correct client — hits the reuse-detection branch and calls `revokeAllForUser`, forcibly logging out every device for that user because of a transient disconnect rather than an actual compromise. This is not new: the current web client has the same exposure today (a dropped connection between the server committing the rotation and the browser receiving the `Set-Cookie` has the identical outcome), just less likely to manifest on typical wired/Wi-Fi connections than on mobile data. Fixing it properly needs a server-side accommodation (e.g. a short grace window honoring the immediately-preceding token once after rotation) that is out of scope for this issue (`本 issue 僅止於提案，不修改 backend/ 程式碼`). This ADR does not resolve it and flags it as an explicit follow-up decision for whoever owns the backend refresh-rotation logic, rather than silently shipping the native strategy on the assumption that it is already handled.
- **Refresh calls must be serialized (single-flight), not fired per-request.** The backend treats reuse of an already-rotated-out refresh token as compromise and revokes every token for that user (`revokeAllForUser` in `backend/src/services/userService.ts`). If several concurrent requests each see a `401` and independently call `/auth/refresh` with the same stored token, only the first succeeds and the rest reuse a now-rotated-out token, triggering full session revocation. The existing web client already guards against exactly this (`runExclusiveRefresh` / `isRefreshing` + subscriber queue in `frontend/src/lib/api.ts`); the Flutter interceptor must implement the equivalent — e.g. a single in-flight `Future`/lock guarding `/auth/refresh` so concurrent 401s await one shared refresh instead of each issuing their own.

## Documentation fix included in this PR

`docs/api-documentation.md` and `docs/ZH-TW/api-documentation.md` both stated the refresh token TTL as `7` days; the empirically measured `Max-Age` (1209600s = 14 days) confirms the code (`DEFAULT_REFRESH_TTL_DAYS = 14` in `backend/src/auth/refreshTokenTtl.ts`) has always been the actual behavior. Both docs are corrected in this PR to say `14` days.

## Scope confirmation for downstream issues

- **#332 (API client)**: no scope change. Its body already correctly cites 14 days and defers storage/transport to this ADR; the table above is the concrete spec to implement against.
- **#333 (Auth flow & routing)**: no scope change. Its body already specifies `flutter_secure_storage`; this ADR confirms that choice and adds the exact key/lifecycle spec.
