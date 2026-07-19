import { Pool } from 'pg';
import type { Room, RoomSummary } from '@shared/types';
import type { CreateRoomData, IRoomRepository, UpdateRoomData } from './IRoomRepository';

function mapRowToRoom(row: any): Room {
  return {
    roomId:          row.room_id,
    type:            row.type,
    name:            row.name ?? undefined,
    avatarUrl:       row.avatar_url ?? undefined,
    inviteCode:      row.invite_code ?? undefined,
    requireApproval: row.require_approval,
    viewHistory:     row.view_history,
    isArchived:      row.is_archived,
    isReadonly:      row.is_readonly ?? false,
    createdAt:       row.created_at,
  };
}

function mapRowToRoomSummary(row: any): RoomSummary {
  const summary: RoomSummary = {
    ...mapRowToRoom(row),
    unreadCount: Number(row.unread_count ?? 0),
    otherMemberId: row.other_member_id ?? undefined,
    lastReadId: row.last_read_id ?? undefined,
    role: row.role ?? undefined,
  };

  if (row.latest_message_id) {
    summary.latestMessage = {
      messageId: row.latest_message_id,
      senderId: row.latest_sender_id ?? null,
      content: row.latest_content,
      sentAt: row.latest_sent_at,
    };
  }

  return summary;
}

interface MemberRoomRow {
  room_id: string;
  type: Room['type'];
  name?: string | null;
  avatar_url?: string | null;
  invite_code?: string | null;
  require_approval: boolean;
  view_history: boolean;
  is_archived: boolean;
  is_readonly?: boolean | null;
  created_at: Date;
  join_time: Date;
  last_read_id?: string | null;
  last_read_sent_at?: Date | null;
  latest_message_id?: string | null;
  latest_sender_id?: string | null;
  latest_content?: string | null;
  latest_sent_at?: Date | null;
  role: string;
}

interface VisibleMessageRow {
  room_id: string;
  sender_id?: string | null;
  sent_at: Date;
}

interface OtherMemberRow {
  room_id: string;
  user_id: string;
}

export class RoomRepository implements IRoomRepository {
  constructor(private db: Pool) {}

  async findById(roomId: string): Promise<Room | null> {
    const res = await this.db.query(
      'SELECT * FROM chat_rooms WHERE room_id = $1',
      [roomId]
    );
    return res.rows.length === 0 ? null : mapRowToRoom(res.rows[0]);
  }

  async findByInviteCode(code: string): Promise<Room | null> {
    const res = await this.db.query(
      'SELECT * FROM chat_rooms WHERE invite_code = $1',
      [code]
    );
    return res.rows.length === 0 ? null : mapRowToRoom(res.rows[0]);
  }

  async findPrivateRoomByMembers(userA: string, userB: string): Promise<Room | null> {
    const res = await this.db.query(
      `SELECT r.* FROM chat_rooms r
       JOIN room_members rm1 ON r.room_id = rm1.room_id AND rm1.user_id = $1
       JOIN room_members rm2 ON r.room_id = rm2.room_id AND rm2.user_id = $2
       WHERE r.type = 'private'
       ORDER BY r.is_archived ASC, r.created_at DESC
       LIMIT 1`,
      [userA, userB]
    );
    return res.rows.length === 0 ? null : mapRowToRoom(res.rows[0]);
  }

  async findByMember(userId: string): Promise<RoomSummary[]> {
    const roomRes = await this.db.query<MemberRoomRow>(
      `SELECT
         cr.*,
         rm.join_time,
         rm.last_read_id,
         rm.role,
         last_read.sent_at AS last_read_sent_at,
         latest.message_id AS latest_message_id,
         latest.sender_id AS latest_sender_id,
         latest.content AS latest_content,
         latest.sent_at AS latest_sent_at
       FROM chat_rooms cr
       JOIN room_members rm ON rm.room_id = cr.room_id
       LEFT JOIN messages last_read ON last_read.message_id = rm.last_read_id
       LEFT JOIN room_last_message_view latest ON latest.room_id = cr.room_id
       WHERE rm.user_id = $1`,
      [userId]
    );

    if (roomRes.rows.length === 0) {
      return [];
    }

    const roomIds = roomRes.rows.map((row) => row.room_id);
    const [unreadRes, privateRoomMemberRes] = await Promise.all([
      this.db.query<{ room_id: string; unread_count: number }>(
        `WITH filtered_unread_messages AS (
           SELECT 
             m.room_id,
             ROW_NUMBER() OVER (
               PARTITION BY m.room_id 
               ORDER BY m.sent_at DESC
             ) as rn
           FROM messages m
           JOIN chat_rooms cr ON cr.room_id = m.room_id
           JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $1
           LEFT JOIN messages last_read ON last_read.message_id = rm.last_read_id
           WHERE m.room_id = ANY($2::uuid[])
             AND (last_read.sent_at IS NULL OR m.sent_at > last_read.sent_at)
             AND (cr.view_history = true OR m.sent_at >= rm.join_time)
         )
         SELECT room_id, COUNT(*)::int AS unread_count
         FROM filtered_unread_messages
         WHERE rn <= 100
         GROUP BY room_id`,
        [userId, roomIds]
      ),
      this.db.query<OtherMemberRow>(
        `SELECT room_id, user_id
         FROM room_members
         WHERE room_id = ANY($1::uuid[])
           AND user_id != $2`,
        [roomIds, userId]
      ),
    ]);

    const unreadCountByRoom = new Map<string, number>(
      unreadRes.rows.map((row) => [row.room_id, row.unread_count])
    );

    const otherMemberByRoom = new Map<string, string>();
    for (const row of privateRoomMemberRes.rows) {
      if (!otherMemberByRoom.has(row.room_id)) {
        otherMemberByRoom.set(row.room_id, row.user_id);
      }
    }

    const summaries = roomRes.rows.map((room) => {
      const latestVisible =
        room.latest_sent_at && (room.view_history || room.latest_sent_at >= room.join_time)
          ? {
              messageId: room.latest_message_id ?? null,
              senderId: room.latest_sender_id ?? null,
              content: room.latest_content ?? null,
              sentAt: room.latest_sent_at,
            }
          : null;
      const unreadCount = unreadCountByRoom.get(room.room_id) ?? 0;
      return mapRowToRoomSummary({
        ...room,
        latest_message_id: latestVisible?.messageId ?? null,
        latest_sender_id: latestVisible?.senderId ?? null,
        latest_content: latestVisible?.content ?? null,
        latest_sent_at: latestVisible?.sentAt ?? null,
        unread_count: unreadCount,
        other_member_id: otherMemberByRoom.get(room.room_id) ?? null,
      });
    });

    summaries.sort((a, b) => {
      const aTime = a.latestMessage?.sentAt ?? a.createdAt;
      const bTime = b.latestMessage?.sentAt ?? b.createdAt;
      return bTime.getTime() - aTime.getTime();
    });

    return summaries;
  }

  async create(data: CreateRoomData): Promise<Room> {
    const res = await this.db.query(
      `INSERT INTO chat_rooms (type, name, avatar_url, invite_code, require_approval, view_history)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        data.type,
        data.name ?? null,
        data.avatarUrl ?? null,
        data.inviteCode ?? null,
        data.requireApproval,
        data.viewHistory,
      ]
    );
    return mapRowToRoom(res.rows[0]);
  }

  async update(
    roomId: string,
    data: UpdateRoomData
  ): Promise<Room> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.name !== undefined)            { fields.push(`name = $${idx++}`);             values.push(data.name); }
    if (data.avatarUrl !== undefined)       { fields.push(`avatar_url = $${idx++}`);       values.push(data.avatarUrl); }
    if (data.requireApproval !== undefined) { fields.push(`require_approval = $${idx++}`); values.push(data.requireApproval); }
    if (data.viewHistory !== undefined)     { fields.push(`view_history = $${idx++}`);     values.push(data.viewHistory); }
    if (data.isArchived !== undefined)      { fields.push(`is_archived = $${idx++}`);      values.push(data.isArchived); }
    if (data.isReadonly !== undefined)      { fields.push(`is_readonly = $${idx++}`);      values.push(data.isReadonly); }

    if (fields.length === 0) {
      const res = await this.db.query('SELECT * FROM chat_rooms WHERE room_id = $1', [roomId]);
      if (res.rows.length === 0) throw new Error('Room not found');
      return mapRowToRoom(res.rows[0]);
    }

    values.push(roomId);
    const res = await this.db.query(
      `UPDATE chat_rooms SET ${fields.join(', ')} WHERE room_id = $${idx} RETURNING *`,
      values
    );
    if (res.rows.length === 0) throw new Error('Room not found');
    return mapRowToRoom(res.rows[0]);
  }

  async delete(roomId: string): Promise<void> {
    await this.db.query('DELETE FROM chat_rooms WHERE room_id = $1', [roomId]);
  }
}
