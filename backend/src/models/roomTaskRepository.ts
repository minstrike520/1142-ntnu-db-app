import { SQL } from 'bun';
import defaultSql from './db';
import type { PublicUser, RoomTaskStatus, RoomTaskWithDetails } from '@shared/types';
import type { CreateRoomTaskData, IRoomTaskRepository, UpdateRoomTaskData } from './IRoomTaskRepository';

export interface RoomTaskRow {
  task_id: string;
  room_id: string;
  title: string;
  description: string | null;
  created_by: string | null;
  due_at: Date | null;
  external_link: string | null;
  status: RoomTaskStatus;
  created_at: Date;
  updated_at: Date;
  creator_user_id?: string | null;
  creator_name?: string | null;
  creator_avatar_url?: string | null;
  creator_deleted_at?: Date | null;
}

export interface AssigneeRow {
  task_id: string;
  user_id: string;
  name: string;
  avatar_url: string | null;
  deleted_at: Date | null;
}

function mapUserRow(row: { user_id: string; name: string; avatar_url: string | null; deleted_at: Date | null }): PublicUser {
  if (row.deleted_at) {
    return { userId: row.user_id, name: 'Deleted User', avatarUrl: undefined };
  }
  return { userId: row.user_id, name: row.name, avatarUrl: row.avatar_url ?? undefined };
}

function mapRowToTask(row: RoomTaskRow, assignees: PublicUser[]): RoomTaskWithDetails {
  return {
    taskId: row.task_id,
    roomId: row.room_id,
    title: row.title,
    description: row.description ?? undefined,
    createdBy: row.created_by,
    dueAt: row.due_at ?? undefined,
    externalLink: row.external_link ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    creator: row.creator_user_id
      ? mapUserRow({
          user_id: row.creator_user_id,
          name: row.creator_name!,
          avatar_url: row.creator_avatar_url ?? null,
          deleted_at: row.creator_deleted_at ?? null,
        })
      : null,
    assignees,
  };
}

export class RoomTaskRepository implements IRoomTaskRepository {
  constructor(private sql: SQL = defaultSql) {}

  private async fetchAssigneesByTaskIds(taskIds: string[]): Promise<Map<string, PublicUser[]>> {
    const assigneesByTaskId = new Map<string, PublicUser[]>();
    if (taskIds.length === 0) {
      return assigneesByTaskId;
    }

    const pgTaskIds = `{${taskIds.join(',')}}`;
    const rows = await this.sql<AssigneeRow[]>`
      SELECT rta.task_id, u.user_id, u.name, u.avatar_url, u.deleted_at
      FROM room_task_assignees rta
      JOIN users u ON u.user_id = rta.user_id
      WHERE rta.task_id = ANY(${pgTaskIds}::uuid[])
      ORDER BY u.name ASC
    `;

    for (const row of rows) {
      const assignees = assigneesByTaskId.get(row.task_id) ?? [];
      assignees.push(mapUserRow(row));
      assigneesByTaskId.set(row.task_id, assignees);
    }
    return assigneesByTaskId;
  }

  async findById(taskId: string): Promise<RoomTaskWithDetails | null> {
    const rows = await this.sql<RoomTaskRow[]>`
      SELECT
        t.*,
        u.user_id AS creator_user_id,
        u.name AS creator_name,
        u.avatar_url AS creator_avatar_url,
        u.deleted_at AS creator_deleted_at
      FROM room_tasks t
      LEFT JOIN users u ON u.user_id = t.created_by
      WHERE t.task_id = ${taskId}
    `;
    if (rows.length === 0) return null;

    const assigneesByTaskId = await this.fetchAssigneesByTaskIds([taskId]);
    return mapRowToTask(rows[0], assigneesByTaskId.get(taskId) ?? []);
  }

  async findByRoom(roomId: string): Promise<RoomTaskWithDetails[]> {
    const rows = await this.sql<RoomTaskRow[]>`
      SELECT
        t.*,
        u.user_id AS creator_user_id,
        u.name AS creator_name,
        u.avatar_url AS creator_avatar_url,
        u.deleted_at AS creator_deleted_at
      FROM room_tasks t
      LEFT JOIN users u ON u.user_id = t.created_by
      WHERE t.room_id = ${roomId}
      ORDER BY t.created_at DESC
    `;
    const taskIds = rows.map((row) => row.task_id);
    const assigneesByTaskId = await this.fetchAssigneesByTaskIds(taskIds);
    return rows.map((row) => mapRowToTask(row, assigneesByTaskId.get(row.task_id) ?? []));
  }

  async create(data: CreateRoomTaskData): Promise<RoomTaskWithDetails> {
    let taskId = '';

    await this.sql.begin(async (tx) => {
      const rows = await tx<{ task_id: string }[]>`
        INSERT INTO room_tasks (room_id, title, description, created_by, due_at, external_link)
        VALUES (
          ${data.roomId},
          ${data.title},
          ${data.description ?? null},
          ${data.createdBy},
          ${data.dueAt ?? null},
          ${data.externalLink ?? null}
        )
        RETURNING task_id
      `;
      taskId = rows[0].task_id;

      for (const userId of new Set(data.assigneeUserIds)) {
        await tx`
          INSERT INTO room_task_assignees (task_id, user_id) VALUES (${taskId}, ${userId})
        `;
      }
    });

    const created = await this.findById(taskId);
    return created!;
  }

  async update(taskId: string, data: UpdateRoomTaskData): Promise<RoomTaskWithDetails> {
    // Unspecified fields re-select their current value, matching the partial
    // UPDATE the pg builder produced.
    const titleVal = data.title !== undefined ? data.title : this.sql`title`;
    const descVal = data.description !== undefined ? data.description : this.sql`description`;
    const dueVal = data.dueAt !== undefined ? data.dueAt : this.sql`due_at`;
    const linkVal = data.externalLink !== undefined ? data.externalLink : this.sql`external_link`;

    const rows = await this.sql<{ task_id: string }[]>`
      UPDATE room_tasks SET
        title = ${titleVal},
        description = ${descVal},
        due_at = ${dueVal},
        external_link = ${linkVal},
        updated_at = NOW()
      WHERE task_id = ${taskId}
      RETURNING task_id
    `;
    if (rows.length === 0) throw new Error('Task not found');

    const task = await this.findById(taskId);
    return task!;
  }

  async setStatus(taskId: string, status: RoomTaskStatus): Promise<RoomTaskWithDetails> {
    const rows = await this.sql<{ task_id: string }[]>`
      UPDATE room_tasks SET status = ${status}, updated_at = NOW()
      WHERE task_id = ${taskId}
      RETURNING task_id
    `;
    if (rows.length === 0) throw new Error('Task not found');

    const task = await this.findById(taskId);
    return task!;
  }

  async delete(taskId: string): Promise<void> {
    await this.sql`DELETE FROM room_tasks WHERE task_id = ${taskId}`;
  }
}
