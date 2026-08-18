import { SQL } from "bun";
import defaultSql from "./db";
import type { Room, RoomSummary, RoomMemberRole } from '@shared/types';
import type { CreateRoomData, IRoomRepository, UpdateRoomData } from './IRoomRepository';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/AppError';

export interface RoomRow {
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
}

function mapRowToRoom(row: RoomRow): Room {
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

function mapRowToRoomSummary(row: RoomRow & {
  unread_count?: number;
  other_member_id?: string | null;
  last_read_id?: string | null;
  role?: string;
  latest_message_id?: string | null;
  latest_sender_id?: string | null;
  latest_content?: string | null;
  latest_sent_at?: Date | null;
  latest_message_sequence?: number | string | null;
  latest_change_sequence?: number | string | null;
  latest_revision?: number | null;
  latest_is_recalled?: boolean | null;
}): RoomSummary {
  const summary: RoomSummary = {
    ...mapRowToRoom(row),
    unreadCount: Number(row.unread_count ?? 0),
    otherMemberId: row.other_member_id ?? undefined,
    lastReadId: row.last_read_id ?? undefined,
    role: (row.role as RoomMemberRole) ?? undefined,
  };

  if (row.latest_message_id) {
    summary.latestMessage = {
      messageId: row.latest_message_id,
      senderId: row.latest_sender_id ?? null,
      content: row.latest_is_recalled ? '' : row.latest_content!,
      sentAt: row.latest_sent_at!,
      isRecalled: row.latest_is_recalled ?? false,
      messageSequence: Number(row.latest_message_sequence ?? 0),
      changeSequence: Number(row.latest_change_sequence ?? 0),
      revision: Number(row.latest_revision ?? 1),
    };
  }

  return summary;
}

export interface MemberRoomRow extends RoomRow {
  join_time: Date;
  last_read_id?: string | null;
  last_read_sent_at?: Date | null;
  join_boundary: number | string;
  read_position: number | string;
  latest_message_id?: string | null;
  latest_sender_id?: string | null;
  latest_content?: string | null;
  latest_sent_at?: Date | null;
  latest_message_sequence?: number | string | null;
  latest_change_sequence?: number | string | null;
  latest_revision?: number | null;
  latest_is_recalled?: boolean | null;
  role: string;
}

export interface OtherMemberRow {
  room_id: string;
  user_id: string;
}

export class RoomRepository implements IRoomRepository {
  constructor(private sql: SQL = defaultSql) {}

  async findById(roomId: string): Promise<Room | null> {
    const rows = await this.sql<RoomRow[]>`
      SELECT * FROM chat_rooms WHERE room_id = ${roomId}
    `;
    return rows.length === 0 ? null : mapRowToRoom(rows[0]);
  }

  async findByInviteCode(code: string): Promise<Room | null> {
    const rows = await this.sql<RoomRow[]>`
      SELECT * FROM chat_rooms WHERE invite_code = ${code}
    `;
    return rows.length === 0 ? null : mapRowToRoom(rows[0]);
  }

  async findPrivateRoomByMembers(userA: string, userB: string): Promise<Room | null> {
    const rows = await this.sql<RoomRow[]>`
      SELECT r.* FROM chat_rooms r
      JOIN room_members rm1 ON r.room_id = rm1.room_id AND rm1.user_id = ${userA}
      JOIN room_members rm2 ON r.room_id = rm2.room_id AND rm2.user_id = ${userB}
      WHERE r.type = 'private'
      ORDER BY r.is_archived ASC, r.created_at DESC
      LIMIT 1
    `;
    return rows.length === 0 ? null : mapRowToRoom(rows[0]);
  }

  /**
   * The private room these two share, but only while a block between them is
   * still recorded. Read-only on purpose: the `blocks` insert trigger is the
   * single owner of the block → read-only invariant, so the block flow must
   * not write room state itself. This exists so that flow can find the room
   * whose sockets need revoking, and so a request whose block was already
   * lifted by a concurrent unblock stops short instead of revoking access to
   * a room that is legitimately open again.
   */
  async findPrivateRoomIdIfBlocked(userA: string, userB: string): Promise<string | null> {
    const rows = await this.sql<{ room_id: string }[]>`
      SELECT r.room_id FROM chat_rooms r
      JOIN room_members rm1 ON r.room_id = rm1.room_id AND rm1.user_id = ${userA}
      JOIN room_members rm2 ON r.room_id = rm2.room_id AND rm2.user_id = ${userB}
      WHERE r.type = 'private'
        AND EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = ${userA} AND b.blocked_id = ${userB})
             OR (b.blocker_id = ${userB} AND b.blocked_id = ${userA})
        )
      ORDER BY r.is_archived ASC, r.created_at DESC
      LIMIT 1
    `;
    return rows.length === 0 ? null : rows[0].room_id;
  }

  async reopenPrivateRoomIfUnblocked(roomId: string, userA: string, userB: string): Promise<Room | null> {
    const rows = await this.sql<RoomRow[]>`
      UPDATE chat_rooms cr
      SET is_readonly = false
      WHERE cr.room_id = ${roomId}
        AND cr.type = 'private'
        AND EXISTS (
          SELECT 1 FROM room_members rm
          WHERE rm.room_id = cr.room_id AND rm.user_id = ${userA}
        )
        AND EXISTS (
          SELECT 1 FROM room_members rm
          WHERE rm.room_id = cr.room_id AND rm.user_id = ${userB}
        )
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = ${userA} AND b.blocked_id = ${userB})
             OR (b.blocker_id = ${userB} AND b.blocked_id = ${userA})
        )
      RETURNING cr.*
    `;
    return rows.length === 0 ? null : mapRowToRoom(rows[0]);
  }

  async findByMember(userId: string): Promise<RoomSummary[]> {
    const roomRows = await this.sql<MemberRoomRow[]>`
      SELECT
        cr.*,
        rm.join_time,
        rm.last_read_id,
        rm.join_boundary,
        rm.read_position,
        rm.role,
        last_read.sent_at AS last_read_sent_at,
        latest.message_id AS latest_message_id,
        latest.sender_id AS latest_sender_id,
        latest.content AS latest_content,
        latest.sent_at AS latest_sent_at
        , latest.message_sequence AS latest_message_sequence
        , latest.change_sequence AS latest_change_sequence
        , latest.revision AS latest_revision
        , latest_message.is_recalled AS latest_is_recalled
      FROM chat_rooms cr
      JOIN room_members rm ON rm.room_id = cr.room_id
      LEFT JOIN messages last_read ON last_read.message_id = rm.last_read_id
      LEFT JOIN room_last_message_view latest ON latest.room_id = cr.room_id
      LEFT JOIN messages latest_message ON latest_message.message_id = latest.message_id
      WHERE rm.user_id = ${userId}
        AND NOT (
          cr.type = 'private'
          AND EXISTS (
            SELECT 1
            FROM room_members other
            JOIN blocks b ON (
              (b.blocker_id = ${userId} AND b.blocked_id = other.user_id)
              OR (b.blocker_id = other.user_id AND b.blocked_id = ${userId})
            )
            WHERE other.room_id = rm.room_id
              AND other.user_id <> ${userId}
              AND other.role <> 'pending'
          )
        )
    `;

    if (roomRows.length === 0) {
      return [];
    }

    const roomIds = roomRows.map((row) => row.room_id);
    const pgRoomIds = `{${roomIds.join(',')}}`;

    const [unreadRows, privateRoomMemberRows] = await Promise.all([
      this.sql<{ room_id: string; unread_count: number }[]>`
        WITH filtered_unread_messages AS (
          SELECT 
            m.room_id,
            ROW_NUMBER() OVER (
              PARTITION BY m.room_id 
              ORDER BY m.message_sequence DESC, m.sent_at DESC, m.message_id DESC
            ) as rn
          FROM messages m
          JOIN chat_rooms cr ON cr.room_id = m.room_id
          JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ${userId}
          LEFT JOIN messages last_read ON last_read.message_id = rm.last_read_id
          WHERE m.room_id = ANY(${pgRoomIds}::uuid[])
            AND rm.role <> 'pending'
            AND (
              m.message_sequence > rm.read_position
              OR (m.message_sequence = 0 AND (last_read.sent_at IS NULL OR m.sent_at > last_read.sent_at))
            )
            AND (
              cr.view_history = true
              OR m.message_sequence > rm.join_boundary
              OR (m.message_sequence = 0 AND m.sent_at >= rm.join_time)
            )
        )
        SELECT room_id, COUNT(*)::int AS unread_count
        FROM filtered_unread_messages
        WHERE rn <= 100
        GROUP BY room_id
      `,
      this.sql<OtherMemberRow[]>`
        SELECT room_id, user_id
        FROM room_members
        WHERE room_id = ANY(${pgRoomIds}::uuid[])
          AND user_id != ${userId}
      `,
    ]);

    const unreadCountByRoom = new Map<string, number>(
      unreadRows.map((row) => [row.room_id, row.unread_count])
    );

    const otherMemberByRoom = new Map<string, string>();
    for (const row of privateRoomMemberRows) {
      if (!otherMemberByRoom.has(row.room_id)) {
        otherMemberByRoom.set(row.room_id, row.user_id);
      }
    }

    const summaries = roomRows.map((room) => {
      const latestVisible =
        room.role !== 'pending' && room.latest_sent_at && (
          room.view_history
          || Number(room.latest_message_sequence ?? 0) > Number(room.join_boundary ?? 0)
          || (Number(room.latest_message_sequence ?? 0) === 0 && room.latest_sent_at >= room.join_time)
        )
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
        latest_message_sequence: latestVisible ? room.latest_message_sequence : null,
        latest_change_sequence: latestVisible ? room.latest_change_sequence : null,
        latest_revision: latestVisible ? room.latest_revision : null,
        latest_is_recalled: latestVisible ? room.latest_is_recalled : null,
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
    const rows = await this.sql<RoomRow[]>`
      INSERT INTO chat_rooms (type, name, avatar_url, invite_code, require_approval, view_history)
      VALUES (${data.type}, ${data.name ?? null}, ${data.avatarUrl ?? null}, ${data.inviteCode ?? null}, ${data.requireApproval}, ${data.viewHistory})
      RETURNING *
    `;
    return mapRowToRoom(rows[0]);
  }

  async update(
    roomId: string,
    data: UpdateRoomData
  ): Promise<Room> {
    const nameVal = data.name !== undefined ? data.name : this.sql`name`;
    const avatarVal = data.avatarUrl !== undefined ? data.avatarUrl : this.sql`avatar_url`;
    const reqAppVal = data.requireApproval !== undefined ? data.requireApproval : this.sql`require_approval`;
    const viewHistVal = data.viewHistory !== undefined ? data.viewHistory : this.sql`view_history`;
    const isArchVal = data.isArchived !== undefined ? data.isArchived : this.sql`is_archived`;
    const isReadonlyVal = data.isReadonly !== undefined ? data.isReadonly : this.sql`is_readonly`;

    const rows = await this.sql<RoomRow[]>`
      UPDATE chat_rooms SET
        name = ${nameVal},
        avatar_url = ${avatarVal},
        require_approval = ${reqAppVal},
        view_history = ${viewHistVal},
        is_archived = ${isArchVal},
        is_readonly = ${isReadonlyVal}
      WHERE room_id = ${roomId}
      RETURNING *
    `;

    if (rows.length === 0) throw new Error('Room not found');
    return mapRowToRoom(rows[0]);
  }

  async transferOwnership(roomId: string, callerId: string, targetUserId: string): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rooms = await tx<{ type: Room['type'] }[]>`
        SELECT type FROM chat_rooms WHERE room_id = ${roomId} FOR UPDATE
      `;
      if (rooms.length === 0) throw new NotFoundError('room', roomId);
      if (rooms[0].type !== 'group') throw new ValidationError('Cannot transfer ownership of a private room');

      const members = await tx<{ user_id: string; role: RoomMemberRole }[]>`
        SELECT user_id, role
        FROM room_members
        WHERE room_id = ${roomId}
          AND user_id IN (${callerId}, ${targetUserId})
        FOR UPDATE
      `;
      const caller = members.find((member) => member.user_id === callerId);
      const target = members.find((member) => member.user_id === targetUserId);
      if (!caller || caller.role !== 'owner') {
        throw new ForbiddenError('Only the owner can transfer ownership');
      }
      if (!target) throw new NotFoundError('member', targetUserId);
      if (target.role === 'pending') {
        throw new ValidationError('Cannot transfer ownership to a pending member');
      }

      await tx`
        UPDATE room_members
        SET role = CASE
          WHEN user_id = ${callerId} THEN 'admin'
          WHEN user_id = ${targetUserId} THEN 'owner'
          ELSE role
        END
        WHERE room_id = ${roomId}
          AND user_id IN (${callerId}, ${targetUserId})
      `;
    });
  }

  async delete(roomId: string): Promise<void> {
    await this.sql`DELETE FROM chat_rooms WHERE room_id = ${roomId}`;
  }
}
