# Keep Socket.IO, move it onto Bun's engine

Status: accepted

Near Chat's realtime layer was slated to be rewritten onto browser-native
WebSocket with a hand-rolled `near-chat.v1` protocol — ticket handshake,
versioned envelope, custom ACK/NACK vocabulary, session leases. We are keeping
Socket.IO instead and moving it onto `Bun.serve` via `@socket.io/bun-engine`.

## Why

The rewrite was motivated by two things, and they turned out to be separable.

The first was reliability: lost message ACKs, no recovery of changes missed
while disconnected, typing indications that never expire, room subscriptions
that survive revoked membership, emergency alerts announced before they were
persisted. **None of these are transport problems.** They live in the schema and
in the services, and they have to be fixed whichever transport is underneath.

The second was mobile compatibility — a raw WebSocket client cannot speak the
Socket.IO protocol without a Socket.IO client library. This is true, but the
planned client is Flutter, and `socket_io_client` is actively maintained
(216k downloads/30d, 150/160 pub points at the time of writing). The constraint
does not bind.

What the rewrite would have bought us on top of that, Socket.IO already
provides: heartbeat and half-open detection, reconnection with backoff, rooms,
acknowledgements, and a documented path to a multi-node adapter. Writing those
again is cost without benefit.

## Consequences

`@socket.io/bun-engine` was at `0.1.1` when this was decided — five releases,
three months old, though authored by Socket.IO's own maintainer. It is a real
risk and is why the migration starts with a throwaway spike rather than a PR.

Moving to `Bun.serve` finishes the runtime migration that #279 left incomplete,
and drops `@hono/node-server`. That is not free: `getConnInfo` must come from
`hono/bun` instead, and the rate-limit bucketing this feeds is security-relevant
(#522). The E2E suite's 184 supertest call sites need a shim.

One thing gets simpler for free. `new Engine()` needs no HTTP server, so the
circular dependency in the composition root — services emit through Socket.IO,
which could not exist before the HTTP server that serves the routes those same
services back — unties itself.

Socket.IO's per-node broadcast APIs (`socketsLeave`, `disconnectSockets`) only
reach connections on the local node. Everything here is correct single-node and
must be revisited when the Redis adapter lands (#283).
