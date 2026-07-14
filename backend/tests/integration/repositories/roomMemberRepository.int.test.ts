import { describe, it, expect, beforeEach } from 'bun:test';
import { RoomMemberRepository } from '../../../src/repositories/roomMemberRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('RoomMemberRepository (pg)', () => {
  const repo = new RoomMemberRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  async function createUser(name: string, email: string) {
    const res = await testPool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
      [name, email, 'hash'],
    );
    return res.rows[0].user_id as string;
  }

  async function createRoom() {
    const res = await testPool.query(
      'INSERT INTO chat_rooms (type, name) VALUES ($1, $2) RETURNING room_id',
      ['group', 'Room Member Repo Room'],
    );
    return res.rows[0].room_id as string;
  }

  async function createMessage(roomId: string, userId: string) {
    const res = await testPool.query(
      'INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, $3) RETURNING message_id',
      [roomId, userId, 'read marker'],
    );
    return res.rows[0].message_id as string;
  }

  it('add -> findMember -> findByRoom -> remove manages membership records', async () => {
    const ownerId = await createUser('Owner', 'owner@test.com');
    const memberId = await createUser('Member', 'member@test.com');
    const roomId = await createRoom();

    const owner = await repo.add({ roomId, userId: ownerId, role: 'owner' });
    await repo.add({ roomId, userId: memberId, role: 'member' });

    expect(owner.roomId).toBe(roomId);
    expect(owner.userId).toBe(ownerId);
    expect(owner.role).toBe('owner');
    expect(owner.isMuted).toBe(false);
    expect(owner.joinTime).toBeInstanceOf(Date);

    const fetched = await repo.findMember(roomId, ownerId);
    expect(fetched).toEqual(owner);

    const members = await repo.findByRoom(roomId);
    expect(members).toHaveLength(2);
    expect(members.map((member) => member.userId)).toContain(ownerId);
    expect(members.map((member) => member.userId)).toContain(memberId);

    await repo.remove(roomId, memberId);
    const removed = await repo.findMember(roomId, memberId);
    expect(removed).toBeNull();
    await repo.remove(roomId, memberId);
  });

  it('update changes role, nickname, muted state, and lastReadId', async () => {
    const userId = await createUser('Reader', 'reader@test.com');
    const roomId = await createRoom();
    const messageId = await createMessage(roomId, userId);
    await repo.add({ roomId, userId, role: 'member' });

    const updated = await repo.update(roomId, userId, {
      role: 'admin',
      nickname: 'Project Lead',
      isMuted: true,
      lastReadId: messageId,
    });

    expect(updated.role).toBe('admin');
    expect(updated.nickname).toBe('Project Lead');
    expect(updated.isMuted).toBe(true);
    expect(updated.lastReadId).toBe(messageId);

    const noChange = await repo.update(roomId, userId, {});
    expect(noChange).toEqual(updated);
  });

  it('findMember returns null and update throws when membership is missing', async () => {
    const userId = await createUser('Missing', 'missing@test.com');
    const roomId = await createRoom();

    const missing = await repo.findMember(roomId, userId);
    expect(missing).toBeNull();

    await expect(repo.update(roomId, userId, { isMuted: true })).rejects.toThrow(
      'Room member not found',
    );
  });
});
