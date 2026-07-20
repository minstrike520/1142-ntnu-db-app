import { Pool } from 'pg';
import type { PublicUser, RoomTaskStatus, RoomTaskWithDetails } from '@shared/types';
import type { CreateRoomTaskData, IRoomTaskRepository, UpdateRoomTaskData } from './IRoomTaskRepository';

interface RoomTaskRow {
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

interface AssigneeRow {
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

const SELECT_TASK_WITH_CREATOR = `
  SELECT
    t.*,
    u.user_id AS creator_user_id,
    u.name AS creator_name,
    u.avatar_url AS creator_avatar_url,
    u.deleted_at AS creator_deleted_at
  FROM room_tasks t
  LEFT JOIN users u ON u.user_id = t.created_by
`;

export class RoomTaskRepository implements IRoomTaskRepository {
  constructor(private db: Pool) {}

  private async fetchAssigneesByTaskIds(taskIds: string[]): Promise<Map<string, PublicUser[]>> {
    const assigneesByTaskId = new Map<string, PublicUser[]>();
    if (taskIds.length === 0) {
      return assigneesByTaskId;
    }

    const res = await this.db.query<AssigneeRow>(
      `SELECT rta.task_id, u.user_id, u.name, u.avatar_url, u.deleted_at
       FROM room_task_assignees rta
       JOIN users u ON u.user_id = rta.user_id
       WHERE rta.task_id = ANY($1::uuid[])
       ORDER BY u.name ASC`,
      [taskIds],
    );

    for (const row of res.rows) {
      const assignees = assigneesByTaskId.get(row.task_id) ?? [];
      assignees.push(mapUserRow(row));
      assigneesByTaskId.set(row.task_id, assignees);
    }
    return assigneesByTaskId;
  }

  async findById(taskId: string): Promise<RoomTaskWithDetails | null> {
    const res = await this.db.query<RoomTaskRow>(
      `${SELECT_TASK_WITH_CREATOR} WHERE t.task_id = $1`,
      [taskId],
    );
    if (res.rows.length === 0) return null;

    const assigneesByTaskId = await this.fetchAssigneesByTaskIds([taskId]);
    return mapRowToTask(res.rows[0], assigneesByTaskId.get(taskId) ?? []);
  }

  async findByRoom(roomId: string): Promise<RoomTaskWithDetails[]> {
    const res = await this.db.query<RoomTaskRow>(
      `${SELECT_TASK_WITH_CREATOR} WHERE t.room_id = $1 ORDER BY t.created_at DESC`,
      [roomId],
    );
    const taskIds = res.rows.map((row) => row.task_id);
    const assigneesByTaskId = await this.fetchAssigneesByTaskIds(taskIds);
    return res.rows.map((row) => mapRowToTask(row, assigneesByTaskId.get(row.task_id) ?? []));
  }

  async create(data: CreateRoomTaskData): Promise<RoomTaskWithDetails> {
    const client = await this.db.connect();
    let taskId: string;
    try {
      await client.query('BEGIN');
      const res = await client.query<{ task_id: string }>(
        `INSERT INTO room_tasks (room_id, title, description, created_by, due_at, external_link)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING task_id`,
        [
          data.roomId,
          data.title,
          data.description ?? null,
          data.createdBy,
          data.dueAt ?? null,
          data.externalLink ?? null,
        ],
      );
      taskId = res.rows[0].task_id;

      const uniqueAssigneeIds = [...new Set(data.assigneeUserIds)];
      if (uniqueAssigneeIds.length > 0) {
        const values = uniqueAssigneeIds.map((_, i) => `($1, $${i + 2})`).join(', ');
        await client.query(
          `INSERT INTO room_task_assignees (task_id, user_id) VALUES ${values}`,
          [taskId, ...uniqueAssigneeIds],
        );
      }

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const created = await this.findById(taskId);
    return created!;
  }

  async update(taskId: string, data: UpdateRoomTaskData): Promise<RoomTaskWithDetails> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (data.title !== undefined) { fields.push(`title = $${idx++}`); values.push(data.title); }
    if (data.description !== undefined) { fields.push(`description = $${idx++}`); values.push(data.description); }
    if (data.dueAt !== undefined) { fields.push(`due_at = $${idx++}`); values.push(data.dueAt); }
    if (data.externalLink !== undefined) { fields.push(`external_link = $${idx++}`); values.push(data.externalLink); }
    fields.push(`updated_at = NOW()`);

    values.push(taskId);
    const res = await this.db.query(
      `UPDATE room_tasks SET ${fields.join(', ')} WHERE task_id = $${idx} RETURNING task_id`,
      values,
    );
    if (res.rows.length === 0) throw new Error('Task not found');

    const task = await this.findById(taskId);
    return task!;
  }

  async setStatus(taskId: string, status: RoomTaskStatus): Promise<RoomTaskWithDetails> {
    const res = await this.db.query(
      `UPDATE room_tasks SET status = $1, updated_at = NOW() WHERE task_id = $2 RETURNING task_id`,
      [status, taskId],
    );
    if (res.rows.length === 0) throw new Error('Task not found');

    const task = await this.findById(taskId);
    return task!;
  }

  async delete(taskId: string): Promise<void> {
    await this.db.query('DELETE FROM room_tasks WHERE task_id = $1', [taskId]);
  }
}
