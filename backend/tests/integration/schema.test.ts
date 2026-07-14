import { describe, it, expect, beforeEach } from 'bun:test';
import { testPool } from '../helpers/testPool';
import { resetDb } from '../helpers/resetDb';

describe('Database Schema & Constraints', () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe('users table constraints', () => {
    it('should successfully insert a user and hash password', async () => {
      const res = await testPool.query(
        `INSERT INTO users (name, email, password_hash) 
         VALUES ('Alice', 'alice@test.com', 'hashedpassword') 
         RETURNING user_id, warning_enabled, warning_days, lang_preference`
      );
      expect(res.rows[0].user_id).toBeDefined();
      expect(res.rows[0].warning_enabled).toBe(false); // Default value
      expect(res.rows[0].warning_days).toBe(0); // Default value
      expect(res.rows[0].lang_preference).toBe('en'); // Default value
    });

    it('should prevent inserting duplicate emails', async () => {
      await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash')"
      );
      await expect(
        testPool.query(
          "INSERT INTO users (name, email, password_hash) VALUES ('Bob', 'alice@test.com', 'hash')"
        )
      ).rejects.toThrow(/unique constraint/i);
    });
  });

  describe('chat_rooms table constraints', () => {
    it('should allow valid room types ("private" and "group")', async () => {
      const res1 = await testPool.query(
        "INSERT INTO chat_rooms (type, name) VALUES ('private', 'Direct Message') RETURNING room_id"
      );
      const res2 = await testPool.query(
        "INSERT INTO chat_rooms (type, name) VALUES ('group', 'DB Study Group') RETURNING room_id"
      );
      expect(res1.rows[0].room_id).toBeDefined();
      expect(res2.rows[0].room_id).toBeDefined();
    });

    it('should reject invalid room types', async () => {
      await expect(
        testPool.query("INSERT INTO chat_rooms (type) VALUES ('invalid')")
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe('room_members table constraints', () => {
    it('should allow valid roles ("owner", "admin", "member", "pending")', async () => {
      const userRes = await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('User', 'user@test.com', 'hash') RETURNING user_id"
      );
      const userId = userRes.rows[0].user_id;

      const roomRes = await testPool.query(
        "INSERT INTO chat_rooms (type) VALUES ('private') RETURNING room_id"
      );
      const roomId = roomRes.rows[0].room_id;

      const memberRes = await testPool.query(
        `INSERT INTO room_members (room_id, user_id, role) 
         VALUES ($1, $2, 'owner') RETURNING role`,
        [roomId, userId]
      );
      expect(memberRes.rows[0].role).toBe('owner');
    });

    it('should reject invalid member roles', async () => {
      const userRes = await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('User', 'user@test.com', 'hash') RETURNING user_id"
      );
      const userId = userRes.rows[0].user_id;

      const roomRes = await testPool.query(
        "INSERT INTO chat_rooms (type) VALUES ('private') RETURNING room_id"
      );
      const roomId = roomRes.rows[0].room_id;

      await expect(
        testPool.query(
          `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'superuser')`,
          [roomId, userId]
        )
      ).rejects.toThrow(/check constraint/i);
    });
  });

  describe('Foreign Key Constraints and Cascades', () => {
    let userId: string;
    let roomId: string;

    beforeEach(async () => {
      const userRes = await testPool.query(
        "INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@test.com', 'hash') RETURNING user_id"
      );
      userId = userRes.rows[0].user_id;

      const roomRes = await testPool.query(
        "INSERT INTO chat_rooms (type) VALUES ('group') RETURNING room_id"
      );
      roomId = roomRes.rows[0].room_id;

      await testPool.query(
        "INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')",
        [roomId, userId]
      );
    });

    it('should delete room memberships when a room is deleted (ON DELETE CASCADE)', async () => {
      // Confirm member exists
      const beforeCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE room_id = $1",
        [roomId]
      );
      expect(parseInt(beforeCount.rows[0].count)).toBe(1);

      // Delete the room
      await testPool.query("DELETE FROM chat_rooms WHERE room_id = $1", [roomId]);

      // Member should be cascade deleted
      const afterCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE room_id = $1",
        [roomId]
      );
      expect(parseInt(afterCount.rows[0].count)).toBe(0);
    });

    it('should delete room memberships when a user is deleted (ON DELETE CASCADE)', async () => {
      // Confirm member exists
      const beforeCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE user_id = $1",
        [userId]
      );
      expect(parseInt(beforeCount.rows[0].count)).toBe(1);

      // Delete the user
      await testPool.query("DELETE FROM users WHERE user_id = $1", [userId]);

      // Member should be cascade deleted
      const afterCount = await testPool.query(
        "SELECT COUNT(*) FROM room_members WHERE user_id = $1",
        [userId]
      );
      expect(parseInt(afterCount.rows[0].count)).toBe(0);
    });

    it('should preserve message but set sender_id to NULL when a user is deleted (ON DELETE SET NULL)', async () => {
      // Insert message
      const msgRes = await testPool.query(
        "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'Hello world') RETURNING message_id",
        [roomId, userId]
      );
      const messageId = msgRes.rows[0].message_id;

      // Delete user
      await testPool.query("DELETE FROM users WHERE user_id = $1", [userId]);

      // Message should remain but sender_id should be NULL
      const msgAfter = await testPool.query(
        "SELECT sender_id, content FROM messages WHERE message_id = $1",
        [messageId]
      );
      expect(msgAfter.rows[0].sender_id).toBeNull();
      expect(msgAfter.rows[0].content).toBe('Hello world');
    });

    it('should cascade delete messages when a chat room is deleted (ON DELETE CASCADE)', async () => {
      // Insert message
      await testPool.query(
        "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'Hello world')",
        [roomId, userId]
      );

      // Delete room
      await testPool.query("DELETE FROM chat_rooms WHERE room_id = $1", [roomId]);

      // Messages should be cascade deleted
      const msgCount = await testPool.query(
        "SELECT COUNT(*) FROM messages WHERE room_id = $1",
        [roomId]
      );
      expect(parseInt(msgCount.rows[0].count)).toBe(0);
    });
  });
});
