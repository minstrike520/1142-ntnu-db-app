import type { Pool } from 'pg';

interface Friendship {
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: Date;
}

interface Block {
  blocker_id: string;
  blocked_id: string;
  created_at: Date;
}

interface FriendRequestResult {
  requesterId: string;
  addresseeId: string;
  status: 'pending' | 'accepted';
  createdAt: Date;
  requester?: { userId: string; name: string; avatarUrl?: string };
  addressee?: { userId: string; name: string; avatarUrl?: string };
}

interface FriendRow {
  friendship_created_at: Date;
  user_id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
}

const mapFriendRow = (row: FriendRow) => ({
  friend: {
    userId: row.user_id,
    name: row.name,
    email: row.email,
    avatarUrl: row.avatar_url ?? undefined
  },
  friendshipCreatedAt: row.friendship_created_at
});

export const makeFriendRepository = (db: Pool) => {
  return {
    async sendFriendRequest(requesterId: string, addresseeId: string): Promise<FriendRequestResult> {
      const res = await db.query(
        `INSERT INTO friendships (requester_id, addressee_id, status)
         VALUES ($1, $2, 'pending')
         RETURNING requester_id, addressee_id, status, created_at`,
        [requesterId, addresseeId]
      );
      return {
        requesterId: res.rows[0].requester_id,
        addresseeId: res.rows[0].addressee_id,
        status: res.rows[0].status,
        createdAt: res.rows[0].created_at
      };
    },

    async getPendingRequests(userId: string): Promise<FriendRequestResult[]> {
      const res = await db.query(
        `SELECT f.requester_id, f.addressee_id, f.status, f.created_at,
                ur.user_id as req_user_id, ur.name as req_name, ur.avatar_url as req_avatar_url,
                ua.user_id as add_user_id, ua.name as add_name, ua.avatar_url as add_avatar_url
         FROM friendships f
         JOIN users ur ON ur.user_id = f.requester_id AND ur.deleted_at IS NULL
         JOIN users ua ON ua.user_id = f.addressee_id AND ua.deleted_at IS NULL
         WHERE (f.addressee_id = $1 OR f.requester_id = $1) AND f.status = 'pending'`,
        [userId]
      );
      return res.rows.map(row => ({
        requesterId: row.requester_id,
        addresseeId: row.addressee_id,
        status: row.status,
        createdAt: row.created_at,
        requester: {
          userId: row.req_user_id,
          name: row.req_name,
          avatarUrl: row.req_avatar_url ?? undefined
        },
        addressee: {
          userId: row.add_user_id,
          name: row.add_name,
          avatarUrl: row.add_avatar_url ?? undefined
        }
      }));
    },

    async acceptFriendRequest(requesterId: string, addresseeId: string): Promise<FriendRequestResult> {
      const res = await db.query(
        `UPDATE friendships
         SET status = 'accepted'
         WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'
         RETURNING requester_id, addressee_id, status, created_at`,
        [requesterId, addresseeId]
      );
      if (res.rows.length === 0) throw new Error('Not found');
      return {
        requesterId: res.rows[0].requester_id,
        addresseeId: res.rows[0].addressee_id,
        status: res.rows[0].status,
        createdAt: res.rows[0].created_at
      };
    },

    async deleteFriendship(user1: string, user2: string): Promise<void> {
      await db.query(
        `DELETE FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2)
            OR (requester_id = $2 AND addressee_id = $1)`,
        [user1, user2]
      );
    },

    async rejectFriendRequest(requesterId: string, addresseeId: string): Promise<boolean> {
      const res = await db.query(
        `DELETE FROM friendships
         WHERE (requester_id = $1 AND addressee_id = $2)
           AND status = 'pending'
         RETURNING requester_id`,
        [requesterId, addresseeId]
      );
      return (res.rowCount ?? 0) > 0;
    },

    async getFriends(userId: string): Promise<any[]> {
      const [sentFriendships, receivedFriendships] = await Promise.all([
        db.query<FriendRow>(
          `SELECT f.created_at as friendship_created_at, u.user_id, u.name, u.email, u.avatar_url
           FROM friendships f
           JOIN users u ON u.user_id = f.addressee_id AND u.deleted_at IS NULL
           WHERE f.requester_id = $1
             AND f.status = 'accepted'
             AND NOT EXISTS (
               SELECT 1
               FROM blocks b
               WHERE (b.blocker_id = f.requester_id AND b.blocked_id = f.addressee_id)
                  OR (b.blocker_id = f.addressee_id AND b.blocked_id = f.requester_id)
             )`,
          [userId]
        ),
        db.query<FriendRow>(
          `SELECT f.created_at as friendship_created_at, u.user_id, u.name, u.email, u.avatar_url
           FROM friendships f
           JOIN users u ON u.user_id = f.requester_id AND u.deleted_at IS NULL
           WHERE f.addressee_id = $1
             AND f.status = 'accepted'
             AND NOT EXISTS (
               SELECT 1
               FROM blocks b
               WHERE (b.blocker_id = f.requester_id AND b.blocked_id = f.addressee_id)
                  OR (b.blocker_id = f.addressee_id AND b.blocked_id = f.requester_id)
             )`,
          [userId]
        ),
      ]);
      return [...sentFriendships.rows, ...receivedFriendships.rows].map(mapFriendRow);
    },

    async blockUser(blockerId: string, blockedId: string): Promise<void> {
      await db.query(
        `INSERT INTO blocks (blocker_id, blocked_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [blockerId, blockedId]
      );
      await db.query(
        `DELETE FROM emergency_contacts
         WHERE (user_id = $1 AND contact_id = $2)
            OR (user_id = $2 AND contact_id = $1)`,
        [blockerId, blockedId]
      );
    },

    async unblockUser(blockerId: string, blockedId: string): Promise<void> {
      await db.query(
        `DELETE FROM blocks
         WHERE blocker_id = $1 AND blocked_id = $2`,
        [blockerId, blockedId]
      );
    },

    async getBlockedUsers(userId: string): Promise<any[]> {
      const res = await db.query(
        `SELECT u.user_id, u.name, u.email, u.avatar_url
         FROM blocks b
         JOIN users u ON u.user_id = b.blocked_id AND u.deleted_at IS NULL
         WHERE b.blocker_id = $1`,
        [userId]
      );
      return res.rows.map(row => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        avatarUrl: row.avatar_url ?? undefined
      }));
    },

    async isBlocked(user1: string, user2: string): Promise<boolean> {
      const res = await db.query(
        `SELECT 1 FROM blocks
         WHERE (blocker_id = $1 AND blocked_id = $2)
            OR (blocker_id = $2 AND blocked_id = $1)`,
        [user1, user2]
      );
      return (res.rowCount ?? 0) > 0;
    },

    async areFriends(user1: string, user2: string): Promise<boolean> {
      const res = await db.query(
        `SELECT 1 FROM friendships
         WHERE status = 'accepted'
           AND ((requester_id = $1 AND addressee_id = $2)
             OR (requester_id = $2 AND addressee_id = $1))`,
        [user1, user2]
      );
      return (res.rowCount ?? 0) > 0;
    }
  };
};
