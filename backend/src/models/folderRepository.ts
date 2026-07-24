import { Pool } from 'pg';
import type { Folder } from '../../../shared/types';

export interface IFolderRepository {
  create(userId: string, name: string): Promise<Folder>;
  findByUserId(userId: string): Promise<Folder[]>;
  delete(folderId: string, userId: string): Promise<void>;
  updateRooms(folderId: string, userId: string, roomIds: string[]): Promise<void>;
  rename(folderId: string, userId: string, name: string): Promise<Folder>;
}

interface FolderRow {
  folder_id: string;
  user_id: string;
  name: string;
  created_at: Date;
}

interface FolderRoomRow {
  folder_id: string;
  room_id: string;
}

const mapFolderRow = (row: FolderRow, roomIds: string[]): Folder => ({
  folderId: row.folder_id,
  userId: row.user_id,
  name: row.name,
  createdAt: row.created_at,
  roomIds,
});

export class FolderRepository implements IFolderRepository {
  constructor(private db: Pool) {}

  async create(userId: string, name: string): Promise<Folder> {
    const res = await this.db.query(
      `INSERT INTO folders (user_id, name) VALUES ($1, $2) RETURNING *`,
      [userId, name]
    );
    return {
      folderId: res.rows[0].folder_id,
      userId: res.rows[0].user_id,
      name: res.rows[0].name,
      createdAt: res.rows[0].created_at,
      roomIds: [],
    };
  }

  async findByUserId(userId: string): Promise<Folder[]> {
    const [folderRes, folderRoomRes] = await Promise.all([
      this.db.query<FolderRow>(
        `SELECT folder_id, user_id, name, created_at
         FROM folders
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [userId]
      ),
      this.db.query<FolderRoomRow>(
        `SELECT folder_id, room_id
         FROM folder_rooms
         WHERE user_id = $1`,
        [userId]
      ),
    ]);

    const roomIdsByFolder = new Map<string, string[]>();
    for (const row of folderRoomRes.rows) {
      const roomIds = roomIdsByFolder.get(row.folder_id) ?? [];
      roomIds.push(row.room_id);
      roomIdsByFolder.set(row.folder_id, roomIds);
    }

    return folderRes.rows.map((row) => mapFolderRow(row, roomIdsByFolder.get(row.folder_id) ?? []));
  }

  async delete(folderId: string, userId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM folders WHERE folder_id = $1 AND user_id = $2`,
      [folderId, userId]
    );
  }

  async updateRooms(folderId: string, userId: string, roomIds: string[]): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      
      const checkRes = await client.query('SELECT 1 FROM folders WHERE folder_id = $1 AND user_id = $2', [folderId, userId]);
      if (checkRes.rowCount === 0) {
          throw new Error('Folder not found');
      }

      await client.query(`DELETE FROM folder_rooms WHERE folder_id = $1`, [folderId]);
      
      if (roomIds.length > 0) {
        const values = roomIds.map((_, i) => `($1, $${i + 2}, $${roomIds.length + 2})`).join(', ');
        const params = [folderId, ...roomIds, userId];
        await client.query(`INSERT INTO folder_rooms (folder_id, room_id, user_id) VALUES ${values}`, params);
      }
      
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async rename(folderId: string, userId: string, name: string): Promise<Folder> {
    const res = await this.db.query<FolderRow>(
      `UPDATE folders SET name = $1 WHERE folder_id = $2 AND user_id = $3 RETURNING *`,
      [name, folderId, userId]
    );
    if (res.rowCount === 0) {
      throw new Error('Folder not found');
    }
    const roomsRes = await this.db.query<{ room_id: string }>(
      `SELECT room_id FROM folder_rooms WHERE folder_id = $1`,
      [folderId]
    );
    const roomIds = roomsRes.rows.map((row) => row.room_id);
    return mapFolderRow(res.rows[0], roomIds);
  }
}
