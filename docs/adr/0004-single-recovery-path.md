# One recovery path; connection state recovery stays off

Status: accepted

Every disconnection — a three-second blip, a two-hour absence, a server restart,
a page reload — recovers through the same request: the client presents its Sync
Cursor and replays what it missed. Socket.IO's `connectionStateRecovery` is left
disabled.

## Why

`connectionStateRecovery` replays missed events and restores rooms for clients
that reconnect within a window (two minutes by default). It cannot be the only
recovery path: it holds packets in memory, so a server restart, a longer absence,
or eviction all leave it with nothing to give. The cursor-based path has to exist
regardless.

So the question is only whether to run a second mechanism alongside it, and the
answer is no — because of which path each one covers. Short blips are routine;
long disconnections and restarts are rare. Enabling both means the *durable,
correct* path is only exercised in the rare case, while the *lossy, in-memory*
one handles everyday traffic. That puts test coverage and production confidence
on the wrong path. With one path, ordinary use validates the mechanism that has
to work when it matters.

Two further problems made it easy:

`skipMiddlewares: true` would let a blocked or deleted user reconnect without
re-validation — Socket.IO's own documentation warns about this. So the auth
middleware has to re-run anyway, removing most of the latency saving.

Restored `socket.rooms` is a snapshot from the moment of disconnection. A user
removed from a room while offline would come back subscribed to it. Room
Subscriptions must derive from durable membership, so this is state we would
have to discard on arrival.

## Consequences

One indexed query returning zero rows on every reconnection, including trivial
ones. That is the entire cost.

Whether `connectionStateRecovery` even functions on `@socket.io/bun-engine` is
untested. Disabling it removes the question.

The reconnect path is also what runs after a token refresh (every 15 minutes per
tab, by `JWT_EXPIRES_IN`), so it is continuously exercised in normal operation
rather than only when something goes wrong.
