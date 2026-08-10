import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { RoomRepository } from '../../../src/models/roomRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('RoomRepository (pg)', () => {
  const repo = new RoomRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  it('create → findById → findByMember → update → delete', async () => {
    const userRes = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id
    `;
    const userId: string = userRes[0].user_id;

    // create
    const room = await repo.create({
      type: 'group',
      name: 'Study Room',
      requireApproval: false,
      viewHistory: true,
    });

    expect(typeof room.roomId).toBe('string');
    expect(room.type).toBe('group');
    expect(room.name).toBe('Study Room');
    expect(room.requireApproval).toBe(false);
    expect(room.viewHistory).toBe(true);
    expect(room.isArchived).toBe(false);
    expect(room.createdAt).toBeInstanceOf(Date);

    // findById
    const fetched = await repo.findById(room.roomId);
    expect(fetched).toEqual(room);

    // findByMember — add membership first, then verify room appears
    const role = 'owner';
    await testPool`
      INSERT INTO room_members (room_id, user_id, role) VALUES (${room.roomId}, ${userId}, ${role})
    `;
    const rooms = await repo.findByMember(userId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].roomId).toBe(room.roomId);

    // update
    const updated = await repo.update(room.roomId, {
      name: 'Updated Room',
      isArchived: true,
    });
    expect(updated.name).toBe('Updated Room');
    expect(updated.isArchived).toBe(true);
    expect(updated.roomId).toBe(room.roomId);

    const afterUpdate = await repo.findById(room.roomId);
    expect(afterUpdate).toEqual(updated);

    // delete
    await repo.delete(room.roomId);
    const afterDelete = await repo.findById(room.roomId);
    expect(afterDelete).toBeNull();
  });

  it('findById returns null for non-existent room', async () => {
    const result = await repo.findById('00000000-0000-0000-0000-000000000000');
    expect(result).toBeNull();
  });

  it('findByMember returns empty array when user has no rooms', async () => {
    const userRes = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'bob@test.com', 'hash') RETURNING user_id
    `;
    const result = await repo.findByMember(userRes[0].user_id);
    expect(result).toEqual([]);
  });

  it('create accepts type="private"', async () => {
    const room = await repo.create({
      type: 'private',
      name: undefined,
      requireApproval: false,
      viewHistory: false,
    });
    expect(room.type).toBe('private');
    expect(typeof room.roomId).toBe('string');
  });

  it('findByMember unreadCount logic: unread count correctly reflects read status', async () => {
    const user1Res = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id
    `;
    const user2Res = await testPool`
      INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'bob@test.com', 'hash') RETURNING user_id
    `;
    const aliceId = user1Res[0].user_id;
    const bobId = user2Res[0].user_id;

    const room = await repo.create({
      type: 'group',
      name: 'Group Chat',
      requireApproval: false,
      viewHistory: true,
    });

    const ownerRole = 'owner';
    const memberRole = 'member';
    await testPool`
      INSERT INTO room_members (room_id, user_id, role) VALUES (${room.roomId}, ${aliceId}, ${ownerRole}), (${room.roomId}, ${bobId}, ${memberRole})
    `;

    // 1. Bob sends a message, Alice's last_read_id is NULL (unread count should be 1)
    const contentBob = 'Hello from Bob';
    const msg1Res = await testPool`
      INSERT INTO messages (room_id, sender_id, content) VALUES (${room.roomId}, ${bobId}, ${contentBob}) RETURNING message_id
    `;
    const msg1Id = msg1Res[0].message_id;

    let rooms = await repo.findByMember(aliceId);
    expect(rooms).toHaveLength(1);
    expect(rooms[0].unreadCount).toBe(1);

    // 2. Alice updates last_read_id to Bob's message (unread count should be 0)
    await testPool`
      UPDATE room_members SET last_read_id = ${msg1Id} WHERE room_id = ${room.roomId} AND user_id = ${aliceId}
    `;
    rooms = await repo.findByMember(aliceId);
    expect(rooms[0].unreadCount).toBe(0);

    // 3. Alice sends a message, and updates her last_read_id to her own message (unread count should be 0)
    const contentAlice = 'Hello from Alice';
    const msg2Res = await testPool`
      INSERT INTO messages (room_id, sender_id, content) VALUES (${room.roomId}, ${aliceId}, ${contentAlice}) RETURNING message_id
    `;
    const msg2Id = msg2Res[0].message_id;

    await testPool`
      UPDATE room_members SET last_read_id = ${msg2Id} WHERE room_id = ${room.roomId} AND user_id = ${aliceId}
    `;
    rooms = await repo.findByMember(aliceId);
    expect(rooms[0].unreadCount).toBe(0);
  });

  it('the blocks trigger closes the private room in the same transaction as the block', async () => {
    const users = await testPool`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Blocker', 'blocker@test.com', 'hash'), ('Blocked', 'blocked@test.com', 'hash')
      RETURNING user_id
    `;
    const blockerId: string = users[0].user_id;
    const blockedId: string = users[1].user_id;

    const room = await repo.create({ type: 'private', requireApproval: false, viewHistory: true });
    await testPool`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES (${room.roomId}, ${blockerId}, 'member'), (${room.roomId}, ${blockedId}, 'member')
    `;
    expect((await repo.findById(room.roomId))!.isReadonly).toBe(false);

    // The service layer deliberately no longer writes this flag, so the
    // trigger being the sole owner of the invariant is now load-bearing.
    await testPool`
      INSERT INTO blocks (blocker_id, blocked_id) VALUES (${blockerId}, ${blockedId})
    `;
    expect((await repo.findById(room.roomId))!.isReadonly).toBe(true);
  });

  it('findPrivateRoomIdIfBlocked reports the room only while a block exists', async () => {
    const users = await testPool`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Blocker', 'blocker@test.com', 'hash'), ('Blocked', 'blocked@test.com', 'hash')
      RETURNING user_id
    `;
    const blockerId: string = users[0].user_id;
    const blockedId: string = users[1].user_id;

    const room = await repo.create({ type: 'private', requireApproval: false, viewHistory: true });
    await testPool`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES (${room.roomId}, ${blockerId}, 'member'), (${room.roomId}, ${blockedId}, 'member')
    `;

    // No block: a request whose block was lifted concurrently gets nothing
    // back and therefore revokes nothing.
    expect(await repo.findPrivateRoomIdIfBlocked(blockerId, blockedId)).toBeNull();

    await testPool`
      INSERT INTO blocks (blocker_id, blocked_id) VALUES (${blockerId}, ${blockedId})
    `;
    expect(await repo.findPrivateRoomIdIfBlocked(blockerId, blockedId)).toBe(room.roomId);
    // The pair is matched in either direction, and the lookup never writes.
    expect(await repo.findPrivateRoomIdIfBlocked(blockedId, blockerId)).toBe(room.roomId);

    await testPool`DELETE FROM blocks`;
    await repo.update(room.roomId, { isReadonly: false });
    expect(await repo.findPrivateRoomIdIfBlocked(blockerId, blockedId)).toBeNull();
    expect((await repo.findById(room.roomId))!.isReadonly).toBe(false);
  });
});
