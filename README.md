# DB Chat Test App

這是一個可在目前 Docker Compose 環境直接啟動的測試用 APP，涵蓋常見 use case：

- 使用者註冊
- 使用者登入（JWT）
- 建立聊天室
- 加入聊天室
- 發送訊息
- 讀取歷史訊息

## 啟動

```bash
docker compose up --build
```

服務：

- Frontend: http://localhost:3000
- Backend: http://localhost:4000
- Postgres: localhost:5432

## API 快速測試（可選）

1. 註冊

```bash
curl -X POST http://localhost:4000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
```

2. 登入

```bash
curl -X POST http://localhost:4000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
```

3. 建立房間（把 TOKEN 換成登入回傳值）

```bash
curl -X POST http://localhost:4000/rooms \
  -H "Authorization: Bearer TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"dev-room"}'
```
