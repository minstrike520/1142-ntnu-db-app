# Change Sequence comes from a transactional counter, not a Postgres sequence

Status: accepted

Message Sequence and Change Sequence are allocated by incrementing a single-row
counter table inside the writing transaction, not by `nextval()` on a sequence.

## Why

`nextval()` is deliberately non-transactional — that is what makes it fast and
gap-tolerant. It is also what makes it unusable as a sync cursor.

```
T1: nextval → 100          T2: nextval → 101
                            T2 COMMIT      ← a reader sees 101, not 100
                                           ← the reader advances its cursor to 101
T1 COMMIT                                  ← 100 is now visible, forever below the cursor
```

That message is permanently invisible to that client, and nothing reports it.
Two users posting at nearly the same instant plus one client reconnecting in
that window is enough. For a chat application, silent message loss is the worst
possible failure mode: it looks exactly like nothing happened.

Incrementing a counter row holds a row lock until commit, so commit order and
sequence order are the same and the gap cannot open. Delta recovery becomes
`WHERE change_seq > $cursor` with no high-water-mark correction, no snapshot
arithmetic, and no test that has to reproduce a race to prove it works.

The same lock gives us an unambiguous Join Boundary: reading the counter
`FOR UPDATE` when a user joins a room waits for in-flight message writes to
commit, so "everything from here on" means exactly that.

## Considered and rejected

**`nextval()` plus an `xmin`-based high-water mark.** Correct, and does not
serialize writes. Rejected because the delta query becomes materially harder to
read and nearly impossible to test convincingly — you would be asserting the
absence of a race.

**`nextval()` with the delta lagging a few hundred milliseconds.** Simplest to
build, but the guarantee is probabilistic. One slow transaction and data is lost
with no signal.

**Two ordinals in one column.** A single mutable sequence cannot serve both
purposes: bumping it on edit would push an edited message past messages created
after it, corrupting read positions and conversation order. Hence `seq`
(assigned once) and `change_seq` (advances on every change).

## Consequences

Every message write serializes on one row. At this project's scale this is
irrelevant, but it is a genuine throughput ceiling and should be revisited
before it isn't.

It behaves correctly across multiple backend nodes without any extra
coordination, because the ordering authority is Postgres rather than process
memory. That is an advantage over an in-process counter when #283 lands.
