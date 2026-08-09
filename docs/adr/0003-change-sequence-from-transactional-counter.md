# ADR-0003: Allocate change sequences from a transactional counter row

- Status: Accepted
- Date: 2026-08-09
- Related: #282 (resumable realtime layer), #530 (this data model), #533 (sync cursor)

## Context

A client that has been disconnected must be able to ask "give me everything that
changed since X" and be certain the answer is complete. That requires a total order
over message *changes* — creation, edit and recall alike — that a client can carry
as a single cursor.

The existing schema cannot express this. `sent_at` does not change when a message is
edited or recalled, so a timestamp cursor is blind to exactly the changes recovery
exists to deliver. Message identifiers are UUIDs and carry no order.

So the model needs numbers. The question this ADR settles is where those numbers
come from.

## Decision

Message Sequence and Change Sequence are both drawn from a single counter row in
`message_sequence_counter`, allocated by `next_message_seq()` **inside the same
transaction that performs the write**.

Both numbers come from the *same* counter, and a newly created message takes one
allocation for both (`change_seq = message_seq`). A single cursor over `change_seq`
therefore covers creations and modifications as one stream, which is what #533 needs
to fetch changes across every accessible room in one request.

## Rationale

`INSERT ... ON CONFLICT DO UPDATE SET current_seq = current_seq + 1 RETURNING` holds
the counter row's lock until COMMIT. Two consequences follow, and they are the whole
point:

- **Allocation order equals commit order.** A transaction cannot draw a number and
  then commit after a transaction that drew a higher one, because the second
  transaction cannot draw at all until the first has committed or rolled back.
- **A rollback releases the number.** The increment is undone with the transaction,
  so an abandoned write leaves no hole in the stream.

Together these give the property a resumable client depends on: the set of committed
change numbers is always a contiguous prefix. A reader can treat "I have seen
everything up to N" as true without any risk of a straggler appearing below N later.

READ COMMITTED is sufficient. No SERIALIZABLE isolation and no retry loop is needed.

## Rejected alternatives

**A PostgreSQL sequence (`nextval()`).** This is the obvious choice and it is wrong
here. `nextval()` deliberately operates outside transaction semantics so that
concurrent inserters never block each other. That means a transaction which draws
sequence value 5 may commit *after* one which drew 6. A client whose cursor has
already advanced past 6 will never see 5 — and nothing anywhere reports an error.
The data loss is permanent and completely silent, which makes it far worse than a
contention problem. Sequences also do not roll back, so every failed write leaves a
permanent hole, and a reader cannot distinguish that hole from a change still in
flight.

**An advisory lock plus `MAX(change_seq) + 1`.** Correct, but it pays for an index
scan on every write to compute the next value, and it reimplements what a counter row
already does.

**A separate append-only `message_changes` log table.** The more conventional shape,
and a reasonable future direction. Rejected for now because it adds a table and a join
without removing any of the work in #530, and because #533 converges on message id
plus revision — clients re-fetch canonical state rather than replaying a change log,
so the log's extra expressiveness would go unused.

**Per-room counters.** Would reduce contention, but breaks the single-cursor
requirement: a client would have to track and reconcile one cursor per room, which is
precisely the "guess the gap room by room" behaviour #533 exists to remove. Multiple
counter rows would also introduce a lock-ordering problem that a single counter does
not have.

## Consequences

- **Every message write in the system serialises on one row.** This is a deliberate
  ceiling. It is comfortable at this project's scale, and the critical section is one
  row update, but it is a global one — so the transaction holding it must stay short.
  `messageRepository.create` batches its mention inserts into a single statement for
  this reason.
- **Nothing may treat `current_seq` as a visibility watermark.** The counter's value
  includes numbers drawn by transactions that have not yet committed. The head of the
  stream must be derived from `MAX(change_seq)` over committed rows.
- **Allocation must happen in the writing transaction.** Drawing a number in one
  transaction and inserting in another discards the guarantee entirely.
- Moving away from a single global counter after data exists would require renumbering
  every message, so this decision is expensive to reverse.
