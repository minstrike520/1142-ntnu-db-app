import { Pool } from 'pg';
import type { RoomMember } from '@shared/types';
import type { IRoomMemberRepository } from './IRoomMemberRepository';

function mapRowToRoomMember(row: any): RoomMember {
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
  constructor(private db: Pool) {}

  async findMember(roomId: string, userId: string): Promise<RoomMember | null> {
    const res = await this.db.query(
      'SELECT * FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
    return res.rows.length === 0 ? null : mapRowToRoomMember(res.rows[0]);
  }

  async findByRoom(roomId: string): Promise<RoomMember[]> {
    const res = await this.db.query(
      'SELECT * FROM room_members WHERE room_id = $1 ORDER BY join_time ASC',
      [roomId],
    );
    return res.rows.map(mapRowToRoomMember);
  }

  async add(data: Pick<RoomMember, 'roomId' | 'userId' | 'role'>): Promise<RoomMember> {
    const res = await this.db.query(
      `INSERT INTO room_members (room_id, user_id, role)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [data.roomId, data.userId, data.role],
    );
    return mapRowToRoomMember(res.rows[0]);
  }

  async update(
    roomId: string,
    userId: string,
    data: Partial<Pick<RoomMember, 'role' | 'nickname' | 'isMuted' | 'lastReadId'>>,
  ): Promise<RoomMember> {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (data.role !== undefined) { fields.push(`role = $${idx++}`); values.push(data.role); }
    if (data.nickname !== undefined) { fields.push(`nickname = $${idx++}`); values.push(data.nickname); }
    if (data.isMuted !== undefined) { fields.push(`is_muted = $${idx++}`); values.push(data.isMuted); }
    if (data.lastReadId !== undefined) { fields.push(`last_read_id = $${idx++}`); values.push(data.lastReadId); }

    if (fields.length === 0) {
      const existing = await this.findMember(roomId, userId);
      if (!existing) throw new Error('Room member not found');
      return existing;
    }

    values.push(roomId, userId);
    const res = await this.db.query(
      `UPDATE room_members
       SET ${fields.join(', ')}
       WHERE room_id = $${idx} AND user_id = $${idx + 1}
       RETURNING *`,
      values,
    );
    if (res.rows.length === 0) throw new Error('Room member not found');
    return mapRowToRoomMember(res.rows[0]);
  }

  async resolveMentions(roomId: string, names: string[]): Promise<string[]> {
    if (names.length === 0) return [];
    const res = await this.db.query(
      `SELECT u.user_id 
       FROM room_members rm 
       JOIN users u ON rm.user_id = u.user_id 
       WHERE rm.room_id = $1 
         AND (u.name = ANY($2) OR rm.nickname = ANY($2))`,
      [roomId, names]
    );
    return res.rows.map(r => r.user_id);
  }

  async remove(roomId: string, userId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId],
    );
  }
}
