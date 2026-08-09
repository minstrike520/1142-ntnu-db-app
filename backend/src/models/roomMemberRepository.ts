import { SQL } from "bun";
import defaultSql from "./db";
import type { RoomMember } from '@shared/types';
import type { IRoomMemberRepository } from './IRoomMemberRepository';
import { ConflictError, ForbiddenError } from '../utils/AppError';

export interface RoomMemberRow {
  room_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'pending';
  nickname?: string | null;
  is_muted: boolean;
  last_read_id?: string | null;
  join_time: Date;
  join_boundary: number | string;
  read_position: number | string;
}

function mapRowToRoomMember(row: RoomMemberRow): RoomMember {
  return {
    roomId: row.room_id,
    userId: row.user_id,
    role: row.role,
    nickname: row.nickname ?? undefined,
    isMuted: row.is_muted,
    lastReadId: row.last_read_id ?? undefined,
    joinTime: row.join_time,
    joinBoundary: Number(row.join_boundary ?? 0),
    readPosition: Number(row.read_position ?? 0),
  };
}

export class RoomMemberRepository implements IRoomMemberRepository {
  constructor(private sql: SQL = defaultSql) {}

  async findMember(roomId: string, userId: string): Promise<RoomMember | null> {
    const rows = await this.sql<RoomMemberRow[]>`
      SELECT rm.*
      FROM room_members rm
      JOIN chat_rooms cr ON cr.room_id = rm.room_id
      WHERE rm.room_id = ${roomId}
        AND rm.user_id = ${userId}
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
    return rows.length === 0 ? null : mapRowToRoomMember(rows[0]);
  }

  async findByRoom(roomId: string): Promise<RoomMember[]> {
    const rows = await this.sql<RoomMemberRow[]>`
      SELECT * FROM room_members WHERE room_id = ${roomId} ORDER BY join_time ASC
    `;
    return rows.map(mapRowToRoomMember);
  }

  async findByUser(userId: string): Promise<RoomMember[]> {
    const rows = await this.sql<RoomMemberRow[]>`
      SELECT rm.*
      FROM room_members rm
      JOIN chat_rooms cr ON cr.room_id = rm.room_id
      WHERE rm.user_id = ${userId}
        AND NOT (cr.type = 'private' AND cr.is_readonly)
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
      ORDER BY rm.join_time ASC
    `;
    return rows.map(mapRowToRoomMember);
  }

  async add(data: Pick<RoomMember, 'roomId' | 'userId' | 'role'>): Promise<RoomMember> {
    let member: RoomMemberRow;
    await this.sql.begin(async (tx) => {
      const counter = await tx<{ message_sequence: number | string }[]>`
        SELECT message_sequence FROM realtime_counters WHERE counter_id = true FOR UPDATE
      `;
      const rows = await tx<RoomMemberRow[]>`
        INSERT INTO room_members (room_id, user_id, role, join_boundary)
        VALUES (${data.roomId}, ${data.userId}, ${data.role}, ${counter[0]?.message_sequence ?? 0})
        RETURNING *
      `;
      member = rows[0];
    });
    return mapRowToRoomMember(member!);
  }

  async update(
    roomId: string,
    userId: string,
    data: Partial<Pick<RoomMember, 'role' | 'nickname' | 'isMuted' | 'lastReadId' | 'readPosition'>>,
  ): Promise<RoomMember> {
    const roleVal = data.role !== undefined ? data.role : this.sql`role`;
    const nickVal = data.nickname !== undefined ? data.nickname : this.sql`nickname`;
    const muteVal = data.isMuted !== undefined ? data.isMuted : this.sql`is_muted`;
    const readVal = data.lastReadId !== undefined ? data.lastReadId : this.sql`last_read_id`;
    const positionVal = data.readPosition !== undefined ? data.readPosition : this.sql`read_position`;
    let updated: RoomMemberRow | undefined;

    await this.sql.begin(async (tx) => {
      const current = await tx<RoomMemberRow[]>`
        SELECT * FROM room_members WHERE room_id = ${roomId} AND user_id = ${userId} FOR UPDATE
      `;
      if (current.length === 0) throw new Error('Room member not found');

      let boundaryVal: number | string = current[0].join_boundary;
      if (current[0].role === 'pending' && data.role !== undefined && data.role !== 'pending') {
        const counter = await tx<{ message_sequence: number | string }[]>`
          SELECT message_sequence FROM realtime_counters WHERE counter_id = true FOR UPDATE
        `;
        boundaryVal = counter[0]?.message_sequence ?? 0;
      }

      const rows = await tx<RoomMemberRow[]>`
        UPDATE room_members SET
          role = ${roleVal},
          nickname = ${nickVal},
          is_muted = ${muteVal},
          last_read_id = ${readVal},
          read_position = ${positionVal},
          join_boundary = ${boundaryVal}
        WHERE room_id = ${roomId} AND user_id = ${userId}
        RETURNING *
      `;
      updated = rows[0];
    });

    return mapRowToRoomMember(updated!);
  }

  async resolveMentions(roomId: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const pgArray = `{${names.map(n => `"${n.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
    const rows = await this.sql<{ user_id: string }[]>`
      SELECT u.user_id 
      FROM room_members rm 
      JOIN users u ON rm.user_id = u.user_id 
      WHERE rm.room_id = ${roomId} 
        AND (u.name = ANY(${pgArray}) OR rm.nickname = ANY(${pgArray}))
    `;
    return rows.map(r => r.user_id);
  }

  async markRead(roomId: string, userId: string, messageId: string, commandId?: string): Promise<RoomMember> {
    let updated: RoomMemberRow | undefined;
    let replayedCommand = false;
    await this.sql.begin(async (tx) => {
      const memberRows = await tx<RoomMemberRow[]>`
        SELECT rm.*
        FROM room_members rm
        JOIN chat_rooms cr ON cr.room_id = rm.room_id
        WHERE rm.room_id = ${roomId}
          AND rm.user_id = ${userId}
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
        FOR UPDATE
      `;
      if (memberRows.length === 0) throw new Error('Room member not found');
      if (memberRows[0].role === 'pending') throw new ForbiddenError('Pending members cannot update read position');

      const messageRows = await tx<{ message_sequence: number | string; sent_at: Date }[]>`
        SELECT message_sequence, sent_at FROM messages
        WHERE message_id = ${messageId} AND room_id = ${roomId}
      `;
      if (messageRows.length === 0) throw new Error('Message not found');

      if (commandId) {
        const prior = await tx<{ room_id: string; message_id: string | null }[]>`
          SELECT room_id, message_id FROM read_position_commands
          WHERE user_id = ${userId} AND command_id = ${commandId}
        `;
        if (prior.length > 0) {
          if (prior[0].room_id !== roomId) throw new ConflictError('Idempotency-Key was already used for another room');
          if (prior[0].message_id && prior[0].message_id !== messageId) {
            throw new ConflictError('Idempotency-Key was already used for another message');
          }
          replayedCommand = true;
          updated = memberRows[0];
          return;
        }
        const receipt = await tx<{ command_id: string }[]>`
          INSERT INTO read_position_commands (user_id, command_id, room_id, message_id, read_position)
          VALUES (${userId}, ${commandId}, ${roomId}, ${messageId}, ${messageRows[0].message_sequence})
          ON CONFLICT (user_id, command_id) DO NOTHING
          RETURNING command_id
        `;
        if (receipt.length === 0) throw new ConflictError('The read-position command could not be applied');
      }

      const rows = await tx<RoomMemberRow[]>`
        UPDATE room_members
        SET last_read_id = CASE
              WHEN ${messageRows[0].message_sequence} > read_position
                OR (
                  ${messageRows[0].message_sequence} = 0
                  AND (
                    last_read_id IS NULL
                    OR (SELECT sent_at FROM messages WHERE message_id = room_members.last_read_id) < ${messageRows[0].sent_at}
                  )
                )
              THEN ${messageId}
              ELSE last_read_id
            END,
            read_position = GREATEST(read_position, ${messageRows[0].message_sequence})
        WHERE room_id = ${roomId} AND user_id = ${userId}
        RETURNING *
      `;
      updated = rows[0];
    });
    const member = mapRowToRoomMember(updated!);
    Object.defineProperty(member, '__replayedCommand', { value: replayedCommand, enumerable: false });
    return member;
  }

  async remove(roomId: string, userId: string): Promise<void> {
    await this.sql`
      DELETE FROM room_members WHERE room_id = ${roomId} AND user_id = ${userId}
    `;
  }

  async removeIfAuthorized(
    roomId: string,
    callerId: string,
    targetUserId: string,
    expectedRole: RoomMember['role'],
  ): Promise<boolean> {
    let removed = false;
    await this.sql.begin(async (tx) => {
      const members = await tx<{ user_id: string; role: RoomMember['role'] }[]>`
        SELECT user_id, role
        FROM room_members
        WHERE room_id = ${roomId}
          AND user_id IN (${callerId}, ${targetUserId})
        FOR UPDATE
      `;
      const caller = members.find((member) => member.user_id === callerId);
      const target = members.find((member) => member.user_id === targetUserId);
      if (!caller || !target || target.role !== expectedRole) return;
      if (caller.role !== 'owner' && caller.role !== 'admin') return;
      if (caller.role === 'admin' && (target.role === 'owner' || target.role === 'admin')) return;

      const rows = await tx<{ user_id: string }[]>`
        DELETE FROM room_members
        WHERE room_id = ${roomId} AND user_id = ${targetUserId} AND role = ${expectedRole}
        RETURNING user_id
      `;
      removed = rows.length > 0;
    });
    return removed;
  }
}
