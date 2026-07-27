import { SQL } from "bun";
import defaultSql from "./db";
import type { Folder } from '../../../shared/types';

export interface IFolderRepository {
  create(userId: string, name: string): Promise<Folder>;
  findByUserId(userId: string): Promise<Folder[]>;
  delete(folderId: string, userId: string): Promise<void>;
  updateRooms(folderId: string, userId: string, roomIds: string[]): Promise<void>;
  rename(folderId: string, userId: string, name: string): Promise<Folder>;
}

export interface FolderRow {
  folder_id: string;
  user_id: string;
  name: string;
  created_at: Date;
}

export interface FolderRoomRow {
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
  constructor(private sql: SQL = defaultSql) {}

  async create(userId: string, name: string): Promise<Folder> {
    const rows = await this.sql<FolderRow[]>`
      INSERT INTO folders (user_id, name) VALUES (${userId}, ${name}) RETURNING *
    `;
    return {
      folderId: rows[0].folder_id,
      userId: rows[0].user_id,
      name: rows[0].name,
      createdAt: rows[0].created_at,
      roomIds: [],
    };
  }

  async findByUserId(userId: string): Promise<Folder[]> {
    const [folderRows, folderRoomRows] = await Promise.all([
      this.sql<FolderRow[]>`
        SELECT folder_id, user_id, name, created_at
        FROM folders
        WHERE user_id = ${userId}
        ORDER BY created_at ASC
      `,
      this.sql<FolderRoomRow[]>`
        SELECT folder_id, room_id
        FROM folder_rooms
        WHERE user_id = ${userId}
      `,
    ]);

    const roomIdsByFolder = new Map<string, string[]>();
    for (const row of folderRoomRows) {
      const roomIds = roomIdsByFolder.get(row.folder_id) ?? [];
      roomIds.push(row.room_id);
      roomIdsByFolder.set(row.folder_id, roomIds);
    }

    return folderRows.map((row) => mapFolderRow(row, roomIdsByFolder.get(row.folder_id) ?? []));
  }

  async delete(folderId: string, userId: string): Promise<void> {
    await this.sql`
      DELETE FROM folders WHERE folder_id = ${folderId} AND user_id = ${userId}
    `;
  }

  async updateRooms(folderId: string, userId: string, roomIds: string[]): Promise<void> {
    await this.sql.begin(async (tx) => {
      const checkRes = await tx<{ folder_id: string }[]>`
        SELECT folder_id FROM folders WHERE folder_id = ${folderId} AND user_id = ${userId}
      `;
      if (checkRes.length === 0) {
        throw new Error('Folder not found');
      }

      await tx`DELETE FROM folder_rooms WHERE folder_id = ${folderId}`;

      for (const roomId of roomIds) {
        await tx`
          INSERT INTO folder_rooms (folder_id, room_id, user_id)
          VALUES (${folderId}, ${roomId}, ${userId})
        `;
      }
    });
  }

  async rename(folderId: string, userId: string, name: string): Promise<Folder> {
    const rows = await this.sql<FolderRow[]>`
      UPDATE folders SET name = ${name} WHERE folder_id = ${folderId} AND user_id = ${userId} RETURNING *
    `;
    if (rows.length === 0) {
      throw new Error('Folder not found');
    }
    const roomsRows = await this.sql<{ room_id: string }[]>`
      SELECT room_id FROM folder_rooms WHERE folder_id = ${folderId}
    `;
    const roomIds = roomsRows.map((row) => row.room_id);
    return mapFolderRow(rows[0], roomIds);
  }
}
