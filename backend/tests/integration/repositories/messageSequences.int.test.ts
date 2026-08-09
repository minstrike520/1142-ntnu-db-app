import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageRepository } from '../../../src/models/messageRepository';
import { RoomMemberRepository } from '../../../src/models/roomMemberRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('Message sequences (pg)', () => {
  const repo = new MessageRepository(testPool);
  const memberRepo = new RoomMemberRepository(testPool);

  let roomId: string;
  let senderId: string;

  beforeEach(async () => {
    await resetDb();
    const userRes = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id
    `;
    senderId = userRes[0].user_id;
    const roomRes = await testPool`
      INSERT INTO chat_rooms (type, name, require_approval, view_history)
      VALUES ('group', 'Seq Room', false, true) RETURNING room_id
    `;
    roomId = roomRes[0].room_id;
  });

  async function send(content: string, clientCommandId?: string) {
    return repo.create({ roomId, senderId, content, ...(clientCommandId ? { clientCommandId } : {}) });
  }

  it('assigns message_seq, change_seq and revision on creation', async () => {
    const first = await send('one');
    const second = await send('two');

    expect(first.revision).toBe(1);
    // A create is its own first change, so both numbers come from one allocation.
    expect(first.changeSeq).toBe(first.messageSeq!);
    expect(second.messageSeq!).toBeGreaterThan(first.messageSeq!);
  });

  it('keeps message_seq fixed while change_seq and revision advance on edit and recall', async () => {
    const created = await send('original');
    const createdSeq = created.messageSeq!;

    const edited = await repo.update(created.messageId, 'edited');
    expect(edited.messageSeq).toBe(createdSeq);
    expect(edited.revision).toBe(2);
    expect(edited.changeSeq!).toBeGreaterThan(created.changeSeq!);

    const recalled = await repo.markRecalled(created.messageId);
    expect(recalled.messageSeq).toBe(createdSeq);
    expect(recalled.revision).toBe(3);
    expect(recalled.changeSeq!).toBeGreaterThan(edited.changeSeq!);
  });

  it('does not burn a revision when a recall is repeated', async () => {
    const created = await send('to recall');
    const first = await repo.markRecalled(created.messageId);
    const second = await repo.markRecalled(created.messageId);

    expect(second.isRecalled).toBe(true);
    expect(second.revision).toBe(first.revision);
    expect(second.changeSeq).toBe(first.changeSeq);
  });

  it('allocates gapless, commit-ordered sequences under concurrent writes', async () => {
    const WRITERS = 8;

    // A reader running alongside the writers. If a transaction that drew a higher
    // number could become visible before one that drew a lower number, some
    // snapshot would show a hole below its own maximum.
    let reading = true;
    const snapshots: number[][] = [];
    const reader = (async () => {
      while (reading) {
        const rows = await testPool<{ change_seq: string }[]>`
          SELECT change_seq FROM messages ORDER BY change_seq
        `;
        snapshots.push(rows.map((row) => Number(row.change_seq)));
      }
    })();

    await Promise.all(
      Array.from({ length: WRITERS }, (_unused, index) => send(`concurrent ${index}`)),
    );
    reading = false;
    await reader;

    const finalRows = await testPool<{ change_seq: string }[]>`
      SELECT change_seq FROM messages ORDER BY change_seq
    `;
    const finalSeqs = finalRows.map((row) => Number(row.change_seq));
    expect(finalSeqs).toEqual(Array.from({ length: WRITERS }, (_unused, i) => i + 1));

    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) {
      // Every committed set must be a contiguous prefix: no reader can ever see
      // a change number while a smaller one is still missing.
      expect(snapshot).toEqual(Array.from({ length: snapshot.length }, (_unused, i) => i + 1));
    }
  });

  it('releases the sequence number when a write rolls back', async () => {
    const first = await send('kept');

    await expect(
      repo.create({
        roomId,
        senderId,
        content: 'rolled back',
        attachmentIds: ['00000000-0000-0000-0000-000000000000'],
      }),
    ).rejects.toThrow();

    const next = await send('after rollback');
    // Contiguous with the first message: the abandoned transaction left no hole.
    expect(next.messageSeq).toBe(first.messageSeq! + 1);
  });

  it('returns the original message when a command identifier is replayed', async () => {
    const commandId = '11111111-1111-4111-a111-111111111111';
    const first = await send('sent once', commandId);
    const replay = await send('sent once', commandId);

    expect(replay.messageId).toBe(first.messageId);
    expect(replay.messageSeq).toBe(first.messageSeq);

    const countRows = await testPool<{ count: string }[]>`
      SELECT COUNT(*)::int AS count FROM messages WHERE room_id = ${roomId}
    `;
    expect(Number(countRows[0].count)).toBe(1);
  });

  it('collapses concurrent replays of one command identifier to a single message', async () => {
    const commandId = '22222222-2222-4222-a222-222222222222';
    const results = await Promise.all([
      send('racing', commandId),
      send('racing', commandId),
      send('racing', commandId),
    ]);

    const distinctIds = new Set(results.map((message) => message.messageId));
    expect(distinctIds.size).toBe(1);

    const countRows = await testPool<{ count: string }[]>`
      SELECT COUNT(*)::int AS count FROM messages WHERE room_id = ${roomId}
    `;
    expect(Number(countRows[0].count)).toBe(1);
  });

  it('lets a different sender reuse the same command identifier', async () => {
    const commandId = '33333333-3333-4333-a333-333333333333';
    const otherRes = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'bob@test.com', 'hash') RETURNING user_id
    `;
    const otherSenderId = otherRes[0].user_id;

    const mine = await send('mine', commandId);
    const theirs = await repo.create({ roomId, senderId: otherSenderId, content: 'theirs', clientCommandId: commandId });

    expect(theirs.messageId).not.toBe(mine.messageId);
  });

  it('records the Join Boundary as the room\'s newest message when a member joins', async () => {
    const existing = await send('before the new member');

    const joinerRes = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Carol', 'carol@test.com', 'hash') RETURNING user_id
    `;
    const member = await memberRepo.add({ roomId, userId: joinerRes[0].user_id, role: 'member' });

    expect(member.joinSeq).toBe(existing.messageSeq!);
  });

  it('moves the Read Position forward only', async () => {
    const first = await send('first');
    const second = await send('second');

    const joinerRes = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Dave', 'dave@test.com', 'hash') RETURNING user_id
    `;
    const userId = joinerRes[0].user_id;
    await memberRepo.add({ roomId, userId, role: 'member' });

    const advanced = await memberRepo.update(roomId, userId, { lastReadId: second.messageId });
    expect(advanced.lastReadSeq).toBe(second.messageSeq!);

    // A late or replayed request carrying an older message must not reopen it.
    const rewound = await memberRepo.update(roomId, userId, { lastReadId: first.messageId });
    expect(rewound.lastReadSeq).toBe(second.messageSeq!);
    expect(rewound.lastReadId).toBe(second.messageId);
  });
});
