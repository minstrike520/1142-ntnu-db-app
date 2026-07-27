import { SQL } from "bun";
import defaultSql from "./db";
import type { FriendResponse } from "@shared/types";

export interface FriendshipRow {
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: Date;
}

export interface PendingRequestRow extends FriendshipRow {
  req_user_id: string;
  req_name: string;
  req_avatar_url?: string | null;
  add_user_id: string;
  add_name: string;
  add_avatar_url?: string | null;
}

export interface BlockRow {
  blocker_id: string;
  blocked_id: string;
  created_at: Date;
}

export interface FriendRequestResult {
  requesterId: string;
  addresseeId: string;
  status: 'pending' | 'accepted';
  createdAt: Date;
  requester?: { userId: string; name: string; avatarUrl?: string };
  addressee?: { userId: string; name: string; avatarUrl?: string };
}

export interface FriendRow {
  friendship_created_at: Date;
  user_id: string;
  name: string;
  email: string;
  avatar_url?: string | null;
}

export interface BlockedUserRow {
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

export const makeFriendRepository = (sql: SQL = defaultSql) => {
  return {
    async sendFriendRequest(requesterId: string, addresseeId: string): Promise<FriendRequestResult> {
      const rows = await sql<FriendshipRow[]>`
        INSERT INTO friendships (requester_id, addressee_id, status)
        VALUES (${requesterId}, ${addresseeId}, 'pending')
        RETURNING requester_id, addressee_id, status, created_at
      `;
      return {
        requesterId: rows[0].requester_id,
        addresseeId: rows[0].addressee_id,
        status: rows[0].status,
        createdAt: rows[0].created_at
      };
    },

    async getPendingRequests(userId: string): Promise<FriendRequestResult[]> {
      const rows = await sql<PendingRequestRow[]>`
        SELECT f.requester_id, f.addressee_id, f.status, f.created_at,
               ur.user_id as req_user_id, ur.name as req_name, ur.avatar_url as req_avatar_url,
               ua.user_id as add_user_id, ua.name as add_name, ua.avatar_url as add_avatar_url
        FROM friendships f
        JOIN users ur ON ur.user_id = f.requester_id AND ur.deleted_at IS NULL
        JOIN users ua ON ua.user_id = f.addressee_id AND ua.deleted_at IS NULL
        WHERE (f.addressee_id = ${userId} OR f.requester_id = ${userId}) AND f.status = 'pending'
      `;
      return rows.map(row => ({
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
      const rows = await sql<FriendshipRow[]>`
        UPDATE friendships
        SET status = 'accepted'
        WHERE requester_id = ${requesterId} AND addressee_id = ${addresseeId} AND status = 'pending'
        RETURNING requester_id, addressee_id, status, created_at
      `;
      if (rows.length === 0) throw new Error('Not found');
      return {
        requesterId: rows[0].requester_id,
        addresseeId: rows[0].addressee_id,
        status: rows[0].status,
        createdAt: rows[0].created_at
      };
    },

    async deleteFriendship(user1: string, user2: string): Promise<void> {
      await sql`
        DELETE FROM friendships
        WHERE (requester_id = ${user1} AND addressee_id = ${user2})
           OR (requester_id = ${user2} AND addressee_id = ${user1})
      `;
    },

    async rejectFriendRequest(requesterId: string, addresseeId: string): Promise<boolean> {
      const rows = await sql<{ requester_id: string }[]>`
        DELETE FROM friendships
        WHERE (requester_id = ${requesterId} AND addressee_id = ${addresseeId})
          AND status = 'pending'
        RETURNING requester_id
      `;
      return rows.length > 0;
    },

    async getFriends(userId: string): Promise<FriendResponse[]> {
      const [sentFriendships, receivedFriendships] = await Promise.all([
        sql<FriendRow[]>`
          SELECT f.created_at as friendship_created_at, u.user_id, u.name, u.email, u.avatar_url
          FROM friendships f
          JOIN users u ON u.user_id = f.addressee_id AND u.deleted_at IS NULL
          WHERE f.requester_id = ${userId}
            AND f.status = 'accepted'
            AND NOT EXISTS (
              SELECT 1
              FROM blocks b
              WHERE (b.blocker_id = f.requester_id AND b.blocked_id = f.addressee_id)
                 OR (b.blocker_id = f.addressee_id AND b.blocked_id = f.requester_id)
            )
        `,
        sql<FriendRow[]>`
          SELECT f.created_at as friendship_created_at, u.user_id, u.name, u.email, u.avatar_url
          FROM friendships f
          JOIN users u ON u.user_id = f.requester_id AND u.deleted_at IS NULL
          WHERE f.addressee_id = ${userId}
            AND f.status = 'accepted'
            AND NOT EXISTS (
              SELECT 1
              FROM blocks b
              WHERE (b.blocker_id = f.requester_id AND b.blocked_id = f.addressee_id)
                 OR (b.blocker_id = f.addressee_id AND b.blocked_id = f.requester_id)
            )
        `,
      ]);
      return [...sentFriendships, ...receivedFriendships].map(mapFriendRow);
    },

    async blockUser(blockerId: string, blockedId: string): Promise<void> {
      await sql`
        INSERT INTO blocks (blocker_id, blocked_id)
        VALUES (${blockerId}, ${blockedId})
        ON CONFLICT DO NOTHING
      `;
      await sql`
        DELETE FROM emergency_contacts
        WHERE (user_id = ${blockerId} AND contact_id = ${blockedId})
           OR (user_id = ${blockedId} AND contact_id = ${blockerId})
      `;
    },

    async unblockUser(blockerId: string, blockedId: string): Promise<void> {
      await sql`
        DELETE FROM blocks
        WHERE blocker_id = ${blockerId} AND blocked_id = ${blockedId}
      `;
    },

    async getBlockedUsers(userId: string): Promise<{ userId: string; name: string; email: string; avatarUrl?: string }[]> {
      const rows = await sql<BlockedUserRow[]>`
        SELECT u.user_id, u.name, u.email, u.avatar_url
        FROM blocks b
        JOIN users u ON u.user_id = b.blocked_id AND u.deleted_at IS NULL
        WHERE b.blocker_id = ${userId}
      `;
      return rows.map(row => ({
        userId: row.user_id,
        name: row.name,
        email: row.email,
        avatarUrl: row.avatar_url ?? undefined
      }));
    },

    async isBlocked(user1: string, user2: string): Promise<boolean> {
      const rows = await sql<{ exists: number }[]>`
        SELECT 1 as exists FROM blocks
        WHERE (blocker_id = ${user1} AND blocked_id = ${user2})
           OR (blocker_id = ${user2} AND blocked_id = ${user1})
      `;
      return rows.length > 0;
    },

    async areFriends(user1: string, user2: string): Promise<boolean> {
      const rows = await sql<{ exists: number }[]>`
        SELECT 1 as exists FROM friendships
        WHERE status = 'accepted'
          AND ((requester_id = ${user1} AND addressee_id = ${user2})
            OR (requester_id = ${user2} AND addressee_id = ${user1}))
      `;
      return rows.length > 0;
    }
  };
};
