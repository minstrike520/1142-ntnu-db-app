import type { RoomTaskWithDetails } from '@shared/types';
import type { IRoomTaskRepository } from '../models/IRoomTaskRepository';
import type { IRoomMemberRepository } from '../models/IRoomMemberRepository';
import type { IRoomRepository } from '../models/IRoomRepository';
import { ForbiddenError, NotFoundError, ValidationError } from '../utils/AppError';
import {
  createTaskSchema,
  deleteTaskSchema,
  listTasksSchema,
  setTaskStatusSchema,
  updateTaskSchema,
} from '../routes/taskSchemas';

const validationMessage = (issues: { message: string }[]) =>
  issues[0]?.message ?? 'Invalid task payload';

export const makeRoomTaskService = (
  roomTaskRepo: IRoomTaskRepository,
  roomRepo: IRoomRepository,
  roomMemberRepo: IRoomMemberRepository,
) => {
  const assertRoomMembership = async (userId: string, roomId: string) => {
    const room = await roomRepo.findById(roomId);
    if (!room) {
      throw new NotFoundError('room', roomId);
    }

    const member = await roomMemberRepo.findMember(roomId, userId);
    if (!member) {
      throw new ForbiddenError('User is not a member of this room');
    }
    if (member.role === 'pending') {
      throw new ForbiddenError('Pending members cannot access room tasks');
    }

    return { room, member };
  };

  const findTaskInRoom = async (roomId: string, taskId: string): Promise<RoomTaskWithDetails> => {
    const task = await roomTaskRepo.findById(taskId);
    if (!task || task.roomId !== roomId) {
      throw new NotFoundError('task', taskId);
    }
    return task;
  };

  /** Mirrors messageService.recallMessage's hierarchy: creator can always act on
   * their own task; otherwise the caller must be owner/admin, and an admin may
   * not act on a task created by the owner or another admin. Orphaned tasks
   * (creator account deleted) are treated as manageable by any owner/admin. */
  const assertCanManageTask = async (
    roomId: string,
    userId: string,
    role: string,
    task: RoomTaskWithDetails,
  ) => {
    if (task.createdBy === userId) return;

    if (role !== 'owner' && role !== 'admin') {
      throw new ForbiddenError('Only the task creator or an admin can manage this task');
    }

    if (role === 'admin' && task.createdBy) {
      const creatorMember = await roomMemberRepo.findMember(roomId, task.createdBy);
      if (creatorMember && (creatorMember.role === 'owner' || creatorMember.role === 'admin')) {
        throw new ForbiddenError('Admins cannot manage tasks created by the room owner or other admins');
      }
    }
  };

  return {
    async listTasks(userId: string, roomId: string): Promise<RoomTaskWithDetails[]> {
      const parsed = listTasksSchema.safeParse({ roomId });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      await assertRoomMembership(userId, parsed.data.roomId);
      return roomTaskRepo.findByRoom(parsed.data.roomId);
    },

    async createTask(
      userId: string,
      roomId: string,
      input: {
        title: string;
        description?: string;
        dueAt?: Date;
        externalLink?: string;
        assigneeUserIds?: string[];
      },
    ): Promise<RoomTaskWithDetails> {
      const parsed = createTaskSchema.safeParse({ roomId, ...input });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { member } = await assertRoomMembership(userId, parsed.data.roomId);
      if (member.role !== 'owner' && member.role !== 'admin') {
        throw new ForbiddenError('Only the room owner or an admin can create tasks');
      }

      const uniqueAssigneeIds = [...new Set(parsed.data.assigneeUserIds)];
      for (const assigneeId of uniqueAssigneeIds) {
        const assigneeMember = await roomMemberRepo.findMember(parsed.data.roomId, assigneeId);
        if (!assigneeMember || assigneeMember.role === 'pending') {
          throw new ValidationError('Assignees must be current members of this room');
        }
      }

      return roomTaskRepo.create({
        roomId: parsed.data.roomId,
        title: parsed.data.title,
        description: parsed.data.description,
        createdBy: userId,
        dueAt: parsed.data.dueAt,
        externalLink: parsed.data.externalLink,
        assigneeUserIds: uniqueAssigneeIds,
      });
    },

    async setStatus(
      userId: string,
      roomId: string,
      taskId: string,
      status: 'open' | 'done',
    ): Promise<RoomTaskWithDetails> {
      const parsed = setTaskStatusSchema.safeParse({ roomId, taskId, status });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { member } = await assertRoomMembership(userId, parsed.data.roomId);
      const task = await findTaskInRoom(parsed.data.roomId, parsed.data.taskId);

      const isAssignee = task.assignees.some((assignee) => assignee.userId === userId);
      const canManage = member.role === 'owner' || member.role === 'admin' || task.createdBy === userId;
      if (!isAssignee && !canManage) {
        throw new ForbiddenError('Only an assignee, the creator, or an admin can update this task\'s status');
      }

      return roomTaskRepo.setStatus(parsed.data.taskId, parsed.data.status);
    },

    async updateTask(
      userId: string,
      roomId: string,
      taskId: string,
      input: {
        title?: string;
        description?: string | null;
        dueAt?: Date | null;
        externalLink?: string | null;
      },
    ): Promise<RoomTaskWithDetails> {
      const parsed = updateTaskSchema.safeParse({ roomId, taskId, ...input });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { member } = await assertRoomMembership(userId, parsed.data.roomId);
      const task = await findTaskInRoom(parsed.data.roomId, parsed.data.taskId);
      await assertCanManageTask(parsed.data.roomId, userId, member.role, task);

      return roomTaskRepo.update(parsed.data.taskId, {
        title: parsed.data.title,
        description: parsed.data.description,
        dueAt: parsed.data.dueAt,
        externalLink: parsed.data.externalLink,
      });
    },

    async deleteTask(userId: string, roomId: string, taskId: string): Promise<void> {
      const parsed = deleteTaskSchema.safeParse({ roomId, taskId });
      if (!parsed.success) {
        throw new ValidationError(validationMessage(parsed.error.issues));
      }

      const { member } = await assertRoomMembership(userId, parsed.data.roomId);
      const task = await findTaskInRoom(parsed.data.roomId, parsed.data.taskId);
      await assertCanManageTask(parsed.data.roomId, userId, member.role, task);

      await roomTaskRepo.delete(parsed.data.taskId);
    },
  };
};

export type RoomTaskService = ReturnType<typeof makeRoomTaskService>;
