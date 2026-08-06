# Durable commands travel over REST; WebSocket carries only events

Status: accepted

Sending, editing, recalling a message and updating a read position are HTTP
requests. The WebSocket connection carries server-to-client events and typing
indications, and nothing else. The HTTP response *is* the acknowledgement; a
409 *is* the rejection.

## Why

Message creation currently exists only as a Socket.IO event, while message
editing exists **twice** — as a Socket.IO event and as `PATCH /:roomId/messages/:messageId`,
both calling the same service. That duplication is the status quo, not something
this decision introduces.

The REST side already has what the realtime side was about to grow:

| Need | REST today | WebSocket today |
| --- | --- | --- |
| Payload validation | `zValidator` on every route | none — handlers destructure client input directly |
| Rate limiting | `makeGlobalRateLimiter()` over `/api/*` | none |
| Rejection vocabulary | HTTP status codes | none |
| Test harness | 13 E2E files | one |

Three of the planned sub-issues existed to rebuild those on the socket. Routing
durable commands through REST retires them instead of duplicating middleware.

Idempotency comes from a client-supplied command ID carried as `Idempotency-Key`
and enforced by a unique constraint, so a retried send cannot create a second
message. Optimistic concurrency comes from `If-Match` against the message's
revision, so a stale edit gets a 409 rather than silently overwriting.

## Consequences

One extra round trip versus emitting on an already-open socket. This is the real
cost and the only one.

There is no optimistic-send machinery in the frontend today — a sender sees their
own message via the server's broadcast echo — so nothing is being taken away. The
`POST` response now renders immediately and the echo is deduplicated by message
ID under the same revision rule used everywhere else.

Typing indications stay on the socket. They are high-frequency, worthless once
stale, and have no durable form.
