import { SQL } from "bun";
import defaultSql from "./db";
import type { RoomMember } from '@shared/types';
import type { IRoomMemberRepository } from './IRoomMemberRepository';

export interface RoomMemberRow {
  room_id: string;
  user_id: string;
  role: 'owner' | 'admin' | 'member' | 'pending';
  nickname?: string | null;
  is_muted: boolean;
  last_read_id?: string | null;
  join_time: Date;
  join_seq?: string | number | null;
  last_read_seq?: string | number | null;
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
    joinSeq: row.join_seq === null || row.join_seq === undefined ? undefined : Number(row.join_seq),
    lastReadSeq: row.last_read_seq === null || row.last_read_seq === undefined ? undefined : Number(row.last_read_seq),
  };
}

export class RoomMemberRepository implements IRoomMemberRepository {
  constructor(private sql: SQL = defaultSql) {}

  async findMember(roomId: string, userId: string): Promise<RoomMember | null> {
    const rows = await this.sql<RoomMemberRow[]>`
      SELECT * FROM room_members WHERE room_id = ${roomId} AND user_id = ${userId}
    `;
    return rows.length === 0 ? null : mapRowToRoomMember(rows[0]);
  }

  async findByRoom(roomId: string): Promise<RoomMember[]> {
    const rows = await this.sql<RoomMemberRow[]>`
      SELECT * FROM room_members WHERE room_id = ${roomId} ORDER BY join_time ASC
    `;
    return rows.map(mapRowToRoomMember);
  }

  async add(data: Pick<RoomMember, 'roomId' | 'userId' | 'role'>): Promise<RoomMember> {
    // The Join Boundary is the room's newest message at the moment of joining, so
    // a room that does not publish history can exclude everything before it.
    const rows = await this.sql<RoomMemberRow[]>`
      INSERT INTO room_members (room_id, user_id, role, join_seq)
      VALUES (
        ${data.roomId},
        ${data.userId},
        ${data.role},
        COALESCE((SELECT MAX(message_seq) FROM messages WHERE room_id = ${data.roomId}), 0)
      )
      RETURNING *
    `;
    return mapRowToRoomMember(rows[0]);
  }

  async update(
    roomId: string,
    userId: string,
    data: Partial<Pick<RoomMember, 'role' | 'nickname' | 'isMuted' | 'lastReadId'>>,
  ): Promise<RoomMember> {
    const roleVal = data.role !== undefined ? data.role : this.sql`role`;
    const nickVal = data.nickname !== undefined ? data.nickname : this.sql`nickname`;
    const muteVal = data.isMuted !== undefined ? data.isMuted : this.sql`is_muted`;

    // The Read Position only moves forward: a late-arriving or replayed request
    // carrying an older message must not reopen messages the user has read.
    // last_read_id is kept as a denormalised companion and advances in lockstep.
    const readSeqVal = data.lastReadId !== undefined
      ? this.sql`GREATEST(room_members.last_read_seq, COALESCE((SELECT message_seq FROM messages WHERE message_id = ${data.lastReadId}), 0))`
      : this.sql`last_read_seq`;
    const readIdVal = data.lastReadId !== undefined
      ? this.sql`CASE
            WHEN COALESCE((SELECT message_seq FROM messages WHERE message_id = ${data.lastReadId}), 0) > room_members.last_read_seq
            THEN ${data.lastReadId}::uuid
            ELSE room_members.last_read_id
          END`
      : this.sql`last_read_id`;

    const rows = await this.sql<RoomMemberRow[]>`
      UPDATE room_members SET
        role = ${roleVal},
        nickname = ${nickVal},
        is_muted = ${muteVal},
        last_read_seq = ${readSeqVal},
        last_read_id = ${readIdVal}
      WHERE room_id = ${roomId} AND user_id = ${userId}
      RETURNING *
    `;

    if (rows.length === 0) throw new Error('Room member not found');
    return mapRowToRoomMember(rows[0]);
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

  async remove(roomId: string, userId: string): Promise<void> {
    await this.sql`
      DELETE FROM room_members WHERE room_id = ${roomId} AND user_id = ${userId}
    `;
  }
}
