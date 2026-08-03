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
    const rows = await this.sql<RoomMemberRow[]>`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES (${data.roomId}, ${data.userId}, ${data.role})
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
    const readVal = data.lastReadId !== undefined ? data.lastReadId : this.sql`last_read_id`;

    const rows = await this.sql<RoomMemberRow[]>`
      UPDATE room_members SET
        role = ${roleVal},
        nickname = ${nickVal},
        is_muted = ${muteVal},
        last_read_id = ${readVal}
      WHERE room_id = ${roomId} AND user_id = ${userId}
      RETURNING *
    `;

    if (rows.length === 0) throw new Error('Room member not found');
    return mapRowToRoomMember(rows[0]);
  }

  async resolveMentions(roomId: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const pgArray = this.sql.array(names, 'text');
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
