# Near Chat

Near Chat is a real-time group chat context for exchanging messages and transient interaction signals between room members.

## Language

**Room membership**:
A durable relationship that grants a user access to a room subject to the membership's current role and status.
_Avoid_: Room subscription, room connection

**Room subscription**:
A transient association between a realtime session and a room for receiving room events; it exists only while Room membership permits access.
_Avoid_: Membership, room access

**Read position**:
The furthest point in a room's canonical message order that a member has read; it moves only forward.
_Avoid_: Read receipt, last-read event

**Emergency alert**:
A durable notification to a user's designated emergency contacts when the user's inactivity threshold is crossed; a realtime signal alone does not mean it was delivered.
_Avoid_: Emergency event, transient alert

**Message change**:
A durable creation, edit, or recall affecting a message in a room; it forms part of recoverable chat history.
_Avoid_: Message event, delta

**Presence**:
A transient indication that a user is reachable through at least one authenticated realtime session; brief connection gaps do not immediately end it.
_Avoid_: Online flag, connection status

**Typing indication**:
A transient, expiring signal that a room member is currently composing content in a room; it is not part of durable chat history.
_Avoid_: Typing state, typing history
