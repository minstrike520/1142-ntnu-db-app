# Near Chat

Real-time group chat. This context covers rooms, the messages posted in them, and
how changes to those messages reach connected clients.

## Language

### Messages

**Message**:
A piece of content posted by a user into a room. Identified by a stable ID that
never changes across edits or recall.
_Avoid_: Chat, post, text

**Message Change**:
A durable mutation of a message — its creation, an edit to its content, or its
recall. The unit that clients recover after a disconnection.
_Avoid_: Update, event, delta

**Revision**:
A message's version count. Monotonic per message, starting at 1 on creation and
incrementing on every subsequent Message Change.
_Avoid_: Version, generation

**Recall**:
Withdrawing a message so its content is no longer shown, while the message itself
remains addressable. Distinct from deletion, which does not exist in this context.
_Avoid_: Delete, remove, unsend

### Ordering

**Message Sequence**:
A message's permanent position in the global creation order. Assigned once and
never changed, including by edits.
_Avoid_: Timestamp, offset, index

**Change Sequence**:
A message's position in the global order of Message Changes. Advances on every
Message Change, so an edited message moves ahead of messages created after it.
_Avoid_: Version, offset

Message Sequence answers "which message came first"; Change Sequence answers
"what has happened since". They are deliberately separate: an edit must not
reorder a conversation, and a read position must not move because someone
edited an old message.

**Sync Cursor**:
The Change Sequence a client has already applied. What it presents to ask for
everything it missed.
_Avoid_: Offset, checkpoint, watermark

**Join Boundary**:
The Message Sequence at which a user became a member of a room. In rooms that
do not expose history, it is the earliest message that member may ever see.
_Avoid_: Join time, cutoff

**Read Position**:
The furthest Message Sequence a user has read in a room. Only ever moves forward.
_Avoid_: Last read, receipt, bookmark

### Realtime

**Command**:
A client's request to change durable state. Always carries the identity of the
attempt, so repeating it cannot produce a second change.
_Avoid_: Action, mutation, message

**Event**:
A server's notification that durable state changed. Carries no delivery
guarantee — a client that misses one recovers it through its Sync Cursor.
_Avoid_: Message, notification, push

The separation is strict: durable intent only ever travels as a Command, and an
Event is never the sole record that something happened.

**Session**:
One authenticated connection between a single browser tab and the server. A user
may hold several at once; each is independent.
_Avoid_: Connection, socket, client

**Room Subscription**:
A Session's entitlement to receive Events for a room. Derived from durable
membership, never from what the client claims.
_Avoid_: Join, channel, topic

**Presence**:
Whether a user is reachable. True while the user holds at least one Session, and
for a grace period after the last one ends.
_Avoid_: Online status, availability

**Typing Indication**:
A short-lived signal that a user is composing in a room. Expires on its own and
is never recovered after a disconnection.
_Avoid_: Typing event, activity

**Emergency Alert**:
A notification raised on a user's behalf to their designated contacts. Durable
before it is ever announced, because a recipient who was offline must still
receive it.
_Avoid_: Panic, SOS, urgent message

## Decisions

Architectural decisions that shaped this language are recorded in
[`docs/adr/`](./docs/adr/).
