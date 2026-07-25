import { describe, it, expect, beforeEach } from 'bun:test';
import { testPool } from '../helpers/testPool';
import { resetDb } from '../helpers/resetDb';

describe('Database Schema & Constraints', () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe('users table constraints', () => {
    it('should successfully insert a user and hash password', async () => {
      const name = 'Alice';
      const email = 'alice@test.com';
      const passwordHash = 'hashedpassword';
      const res = await testPool`
        INSERT INTO users (name, email, password_hash) 
        VALUES (${name}, ${email}, ${passwordHash}) 
        RETURNING user_id, warning_enabled, warning_days, lang_preference
      `;
      expect(res[0].user_id).toBeDefined();
      expect(res[0].warning_enabled).toBe(false); // Default value
      expect(res[0].warning_days).toBe(0); // Default value
      expect(res[0].lang_preference).toBe('en'); // Default value
    });

    it('should prevent inserting duplicate emails', async () => {
      const name1 = 'Alice';
      const name2 = 'Bob';
      const email = 'alice@test.com';
      const hash = 'hash';
      await testPool`
        INSERT INTO users (name, email, password_hash) VALUES (${name1}, ${email}, ${hash})
      `;
      let error: any = null;
      try {
        await testPool`
          INSERT INTO users (name, email, password_hash) VALUES (${name2}, ${email}, ${hash})
        `;
      } catch (err) {
        error = err;
      }
      expect(error).not.toBeNull();
      expect(String(error)).toMatch(/unique constraint/i);
    });
  });

  describe('chat_rooms table constraints', () => {
    it('should allow valid room types ("private" and "group")', async () => {
      const res1 = await testPool`
        INSERT INTO chat_rooms (type, name) VALUES ('private', 'Direct Message') RETURNING room_id
      `;
      const res2 = await testPool`
        INSERT INTO chat_rooms (type, name) VALUES ('group', 'DB Study Group') RETURNING room_id
      `;
      expect(res1[0].room_id).toBeDefined();
      expect(res2[0].room_id).toBeDefined();
    });

    it('should reject invalid room types', async () => {
      const invalidType = 'invalid';
      let error: any = null;
      try {
        await testPool`INSERT INTO chat_rooms (type) VALUES (${invalidType})`;
      } catch (err) {
        error = err;
      }
      expect(error).not.toBeNull();
      expect(String(error)).toMatch(/check constraint/i);
    });
  });

  describe('room_members table constraints', () => {
    it('should allow valid roles ("owner", "admin", "member", "pending")', async () => {
      const userRes = await testPool`
        INSERT INTO users (name, email, password_hash) VALUES ('User', 'user@test.com', 'hash') RETURNING user_id
      `;
      const userId = userRes[0].user_id;

      const roomRes = await testPool`
        INSERT INTO chat_rooms (type) VALUES ('private') RETURNING room_id
      `;
      const roomId = roomRes[0].room_id;

      const memberRes = await testPool`
        INSERT INTO room_members (room_id, user_id, role) 
        VALUES (${roomId}, ${userId}, 'owner') RETURNING role
      `;
      expect(memberRes[0].role).toBe('owner');
    });

    it('should reject invalid member roles', async () => {
      const userRes = await testPool`
        INSERT INTO users (name, email, password_hash) VALUES ('User', 'user@test.com', 'hash') RETURNING user_id
      `;
      const userId = userRes[0].user_id;

      const roomRes = await testPool`
        INSERT INTO chat_rooms (type) VALUES ('private') RETURNING room_id
      `;
      const roomId = roomRes[0].room_id;
      const invalidRole = 'superuser';

      let error: any = null;
      try {
        await testPool`
          INSERT INTO room_members (room_id, user_id, role) VALUES (${roomId}, ${userId}, ${invalidRole})
        `;
      } catch (err) {
        error = err;
      }
      expect(error).not.toBeNull();
      expect(String(error)).toMatch(/check constraint/i);
    });
  });

  describe('Foreign Key Constraints and Cascades', () => {
    let userId: string;
    let roomId: string;

    beforeEach(async () => {
      const userRes = await testPool`
        INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id
      `;
      userId = userRes[0].user_id;

      const roomRes = await testPool`
        INSERT INTO chat_rooms (type) VALUES ('group') RETURNING room_id
      `;
      roomId = roomRes[0].room_id;

      await testPool`
        INSERT INTO room_members (room_id, user_id, role) VALUES (${roomId}, ${userId}, 'owner')
      `;
    });

    it('should delete room memberships when a room is deleted (ON DELETE CASCADE)', async () => {
      const beforeCount = await testPool`
        SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = ${roomId}
      `;
      expect(beforeCount[0].count).toBe(1);

      await testPool`DELETE FROM chat_rooms WHERE room_id = ${roomId}`;

      const afterCount = await testPool`
        SELECT COUNT(*)::int AS count FROM room_members WHERE room_id = ${roomId}
      `;
      expect(afterCount[0].count).toBe(0);
    });

    it('should delete room memberships when a user is deleted (ON DELETE CASCADE)', async () => {
      const beforeCount = await testPool`
        SELECT COUNT(*)::int AS count FROM room_members WHERE user_id = ${userId}
      `;
      expect(beforeCount[0].count).toBe(1);

      await testPool`DELETE FROM users WHERE user_id = ${userId}`;

      const afterCount = await testPool`
        SELECT COUNT(*)::int AS count FROM room_members WHERE user_id = ${userId}
      `;
      expect(afterCount[0].count).toBe(0);
    });

    it('should preserve message but set sender_id to NULL when a user is deleted (ON DELETE SET NULL)', async () => {
      const content = 'Hello world';
      const msgRes = await testPool`
        INSERT INTO messages (room_id, sender_id, content) VALUES (${roomId}, ${userId}, ${content}) RETURNING message_id
      `;
      const messageId = msgRes[0].message_id;

      await testPool`DELETE FROM users WHERE user_id = ${userId}`;

      const msgAfter = await testPool`
        SELECT sender_id, content FROM messages WHERE message_id = ${messageId}
      `;
      expect(msgAfter[0].sender_id).toBeNull();
      expect(msgAfter[0].content).toBe('Hello world');
    });

    it('should cascade delete messages when a chat room is deleted (ON DELETE CASCADE)', async () => {
      const content = 'Hello world';
      await testPool`
        INSERT INTO messages (room_id, sender_id, content) VALUES (${roomId}, ${userId}, ${content})
      `;

      await testPool`DELETE FROM chat_rooms WHERE room_id = ${roomId}`;

      const msgCount = await testPool`
        SELECT COUNT(*)::int AS count FROM messages WHERE room_id = ${roomId}
      `;
      expect(msgCount[0].count).toBe(0);
    });
  });
});
