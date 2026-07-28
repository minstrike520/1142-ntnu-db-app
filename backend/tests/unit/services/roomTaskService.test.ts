import { describe, it, expect, beforeEach, mock, type Mock } from 'bun:test';
import { makeRoomTaskService } from '../../../src/services/roomTaskService';
import { ForbiddenError, NotFoundError, ValidationError } from '../../../src/utils/AppError';
import type { IRoomTaskRepository } from '../../../src/models/IRoomTaskRepository';
import type { IRoomMemberRepository } from '../../../src/models/IRoomMemberRepository';
import type { IRoomRepository } from '../../../src/models/IRoomRepository';
import type { Room, RoomMember, RoomTaskWithDetails } from '../../../../shared/types';

type Mocked<T> = {
  [P in keyof T]: T[P] extends Function ? Mock<any> : T[P];
};

describe('roomTaskService', () => {
  let roomTaskRepo: Mocked<IRoomTaskRepository>;
  let roomRepo: Mocked<IRoomRepository>;
  let roomMemberRepo: Mocked<IRoomMemberRepository>;
  let roomTaskService: ReturnType<typeof makeRoomTaskService>;

  const room: Room = {
    roomId: 'room-1',
    type: 'group',
    name: 'Study Room',
    requireApproval: false,
    viewHistory: true,
    isArchived: false,
    isReadonly: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const ownerMember: RoomMember = {
    roomId: 'room-1',
    userId: 'owner-1',
    role: 'owner',
    isMuted: false,
    joinTime: new Date('2026-01-01T00:00:00.000Z'),
  };

  const adminMember: RoomMember = { ...ownerMember, userId: 'admin-1', role: 'admin' };
  const plainMember: RoomMember = { ...ownerMember, userId: 'member-1', role: 'member' };
  const otherMember: RoomMember = { ...ownerMember, userId: 'member-2', role: 'member' };

  const membersById: Record<string, RoomMember> = {
    'owner-1': ownerMember,
    'admin-1': adminMember,
    'member-1': plainMember,
    'member-2': otherMember,
  };

  const task: RoomTaskWithDetails = {
    taskId: 'task-1',
    roomId: 'room-1',
    title: 'Write report',
    createdBy: 'member-1',
    status: 'open',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    creator: { userId: 'member-1', name: 'Member One' },
    assignees: [{ userId: 'member-2', name: 'Member Two' }],
  };

  beforeEach(() => {
    roomTaskRepo = {
      findById: mock(),
      findByRoom: mock(),
      create: mock(),
      update: mock(),
      setStatus: mock(),
      delete: mock(),
    };
    roomRepo = {
      findById: mock(),
      findByInviteCode: mock(),
      findByMember: mock(),
      findPrivateRoomByMembers: mock(),
      create: mock(),
      update: mock(),
      delete: mock(),
    };
    roomMemberRepo = {
      findMember: mock(),
      findByRoom: mock(),
      add: mock(),
      update: mock(),
      remove: mock(),
      resolveMentions: mock(),
    };
    roomTaskService = makeRoomTaskService(roomTaskRepo, roomRepo, roomMemberRepo);

    roomRepo.findById.mockResolvedValue(room);
    roomMemberRepo.findMember.mockImplementation(async (_roomId: string, userId: string) => membersById[userId] ?? null);
  });

  describe('listTasks', () => {
    it('checks membership and returns tasks from the repository', async () => {
      roomTaskRepo.findByRoom.mockResolvedValue([task]);

      const result = await roomTaskService.listTasks('member-1', 'room-1');

      expect(roomMemberRepo.findMember).toHaveBeenCalledWith('room-1', 'member-1');
      expect(roomTaskRepo.findByRoom).toHaveBeenCalledWith('room-1');
      expect(result).toEqual([task]);
    });

    it('throws NotFoundError when the room is missing', async () => {
      roomRepo.findById.mockResolvedValue(null);

      await expect(roomTaskService.listTasks('member-1', 'missing-room')).rejects.toThrow(NotFoundError);
      expect(roomTaskRepo.findByRoom).not.toHaveBeenCalled();
    });

    it('throws ForbiddenError when caller is not a room member', async () => {
      await expect(roomTaskService.listTasks('stranger', 'room-1')).rejects.toThrow(ForbiddenError);
      expect(roomTaskRepo.findByRoom).not.toHaveBeenCalled();
    });

    it('rejects pending members', async () => {
      roomMemberRepo.findMember.mockResolvedValue({ ...plainMember, role: 'pending' });

      await expect(roomTaskService.listTasks('member-1', 'room-1')).rejects.toThrow(ForbiddenError);
      expect(roomTaskRepo.findByRoom).not.toHaveBeenCalled();
    });
  });

  describe('createTask', () => {
    it('allows the owner to create a task and deduplicates assignee ids', async () => {
      roomTaskRepo.create.mockResolvedValue(task);

      await roomTaskService.createTask('owner-1', 'room-1', {
        title: 'Write report',
        assigneeUserIds: ['member-2', 'member-2'],
      });

      expect(roomTaskRepo.create).toHaveBeenCalledWith({
        roomId: 'room-1',
        title: 'Write report',
        description: undefined,
        createdBy: 'owner-1',
        dueAt: undefined,
        externalLink: undefined,
        assigneeUserIds: ['member-2'],
      });
    });

    it('allows an admin to create a task', async () => {
      roomTaskRepo.create.mockResolvedValue(task);

      await roomTaskService.createTask('admin-1', 'room-1', { title: 'Write report' });

      expect(roomTaskRepo.create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'admin-1' }));
    });

    it('rejects plain members', async () => {
      await expect(
        roomTaskService.createTask('member-1', 'room-1', { title: 'Write report' }),
      ).rejects.toThrow(ForbiddenError);
      expect(roomTaskRepo.create).not.toHaveBeenCalled();
    });

    it('rejects assignees who are not current room members', async () => {
      await expect(
        roomTaskService.createTask('owner-1', 'room-1', {
          title: 'Write report',
          assigneeUserIds: ['stranger'],
        }),
      ).rejects.toThrow(ValidationError);
      expect(roomTaskRepo.create).not.toHaveBeenCalled();
    });

    it('rejects pending members as assignees', async () => {
      roomMemberRepo.findMember.mockImplementation(async (_roomId: string, userId: string) => {
        if (userId === 'owner-1') return ownerMember;
        if (userId === 'pending-1') return { ...plainMember, userId: 'pending-1', role: 'pending' };
        return null;
      });

      await expect(
        roomTaskService.createTask('owner-1', 'room-1', {
          title: 'Write report',
          assigneeUserIds: ['pending-1'],
        }),
      ).rejects.toThrow(ValidationError);
      expect(roomTaskRepo.create).not.toHaveBeenCalled();
    });

    it('rejects empty titles', async () => {
      await expect(roomTaskService.createTask('owner-1', 'room-1', { title: '   ' })).rejects.toThrow(
        ValidationError,
      );
      expect(roomTaskRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('setStatus', () => {
    beforeEach(() => {
      roomTaskRepo.findById.mockResolvedValue(task);
    });

    it('allows an assignee to toggle status', async () => {
      const done = { ...task, status: 'done' as const };
      roomTaskRepo.setStatus.mockResolvedValue(done);

      const result = await roomTaskService.setStatus('member-2', 'room-1', 'task-1', 'done');

      expect(roomTaskRepo.setStatus).toHaveBeenCalledWith('task-1', 'done');
      expect(result).toBe(done);
    });

    it('allows the creator to toggle status', async () => {
      roomTaskRepo.setStatus.mockResolvedValue({ ...task, status: 'done' });

      await roomTaskService.setStatus('member-1', 'room-1', 'task-1', 'done');

      expect(roomTaskRepo.setStatus).toHaveBeenCalledWith('task-1', 'done');
    });

    it('allows owner/admin to toggle status even if not an assignee', async () => {
      roomTaskRepo.setStatus.mockResolvedValue({ ...task, status: 'done' });

      await roomTaskService.setStatus('owner-1', 'room-1', 'task-1', 'done');

      expect(roomTaskRepo.setStatus).toHaveBeenCalledWith('task-1', 'done');
    });

    it('rejects a member who is neither an assignee, the creator, nor an admin', async () => {
      roomMemberRepo.findMember.mockImplementation(async (_roomId: string, userId: string) => {
        if (userId === 'bystander') return { ...plainMember, userId: 'bystander', role: 'member' };
        return membersById[userId] ?? null;
      });

      await expect(roomTaskService.setStatus('bystander', 'room-1', 'task-1', 'done')).rejects.toThrow(
        ForbiddenError,
      );
      expect(roomTaskRepo.setStatus).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the task does not belong to the room', async () => {
      roomTaskRepo.findById.mockResolvedValue({ ...task, roomId: 'other-room' });

      await expect(roomTaskService.setStatus('member-1', 'room-1', 'task-1', 'done')).rejects.toThrow(
        NotFoundError,
      );
      expect(roomTaskRepo.setStatus).not.toHaveBeenCalled();
    });
  });

  describe('updateTask', () => {
    beforeEach(() => {
      roomTaskRepo.findById.mockResolvedValue(task);
    });

    it('allows the creator to edit their own task', async () => {
      roomTaskRepo.update.mockResolvedValue({ ...task, title: 'Updated' });

      await roomTaskService.updateTask('member-1', 'room-1', 'task-1', { title: 'Updated' });

      expect(roomTaskRepo.update).toHaveBeenCalledWith('task-1', {
        title: 'Updated',
        description: undefined,
        dueAt: undefined,
        externalLink: undefined,
      });
    });

    it('allows the owner to edit a task created by a plain member', async () => {
      roomTaskRepo.update.mockResolvedValue({ ...task, title: 'Updated' });

      await roomTaskService.updateTask('owner-1', 'room-1', 'task-1', { title: 'Updated' });

      expect(roomTaskRepo.update).toHaveBeenCalled();
    });

    it('rejects a plain member editing someone else\'s task', async () => {
      await expect(
        roomTaskService.updateTask('member-2', 'room-1', 'task-1', { title: 'Updated' }),
      ).rejects.toThrow(ForbiddenError);
      expect(roomTaskRepo.update).not.toHaveBeenCalled();
    });

    it('rejects an admin editing a task created by the owner', async () => {
      const ownerTask = { ...task, createdBy: 'owner-1' };
      roomTaskRepo.findById.mockResolvedValue(ownerTask);

      await expect(
        roomTaskService.updateTask('admin-1', 'room-1', 'task-1', { title: 'Updated' }),
      ).rejects.toThrow(ForbiddenError);
      expect(roomTaskRepo.update).not.toHaveBeenCalled();
    });

    it('rejects an admin editing a task created by another admin', async () => {
      const otherAdmin: RoomMember = { ...adminMember, userId: 'admin-2' };
      roomMemberRepo.findMember.mockImplementation(async (_roomId: string, userId: string) => {
        if (userId === 'admin-2') return otherAdmin;
        return membersById[userId] ?? null;
      });
      const adminTask = { ...task, createdBy: 'admin-2' };
      roomTaskRepo.findById.mockResolvedValue(adminTask);

      await expect(
        roomTaskService.updateTask('admin-1', 'room-1', 'task-1', { title: 'Updated' }),
      ).rejects.toThrow(ForbiddenError);
      expect(roomTaskRepo.update).not.toHaveBeenCalled();
    });

    it('allows an admin to edit a task created by a plain member', async () => {
      roomTaskRepo.update.mockResolvedValue({ ...task, title: 'Updated' });

      await roomTaskService.updateTask('admin-1', 'room-1', 'task-1', { title: 'Updated' });

      expect(roomTaskRepo.update).toHaveBeenCalled();
    });

    it('allows an admin to edit an orphaned task (creator account deleted)', async () => {
      roomTaskRepo.findById.mockResolvedValue({ ...task, createdBy: null });
      roomTaskRepo.update.mockResolvedValue({ ...task, createdBy: null, title: 'Updated' });

      await roomTaskService.updateTask('admin-1', 'room-1', 'task-1', { title: 'Updated' });

      expect(roomTaskRepo.update).toHaveBeenCalled();
    });

    it('rejects empty update payloads', async () => {
      await expect(roomTaskService.updateTask('member-1', 'room-1', 'task-1', {})).rejects.toThrow(
        ValidationError,
      );
      expect(roomTaskRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteTask', () => {
    beforeEach(() => {
      roomTaskRepo.findById.mockResolvedValue(task);
    });

    it('allows the creator to delete their own task', async () => {
      await roomTaskService.deleteTask('member-1', 'room-1', 'task-1');
      expect(roomTaskRepo.delete).toHaveBeenCalledWith('task-1');
    });

    it('allows the owner to delete any task', async () => {
      await roomTaskService.deleteTask('owner-1', 'room-1', 'task-1');
      expect(roomTaskRepo.delete).toHaveBeenCalledWith('task-1');
    });

    it('rejects an admin deleting a task created by the owner', async () => {
      roomTaskRepo.findById.mockResolvedValue({ ...task, createdBy: 'owner-1' });

      await expect(roomTaskService.deleteTask('admin-1', 'room-1', 'task-1')).rejects.toThrow(
        ForbiddenError,
      );
      expect(roomTaskRepo.delete).not.toHaveBeenCalled();
    });

    it('rejects a plain member deleting someone else\'s task', async () => {
      await expect(roomTaskService.deleteTask('member-2', 'room-1', 'task-1')).rejects.toThrow(
        ForbiddenError,
      );
      expect(roomTaskRepo.delete).not.toHaveBeenCalled();
    });

    it('throws NotFoundError when the task does not exist', async () => {
      roomTaskRepo.findById.mockResolvedValue(null);

      await expect(roomTaskService.deleteTask('owner-1', 'room-1', 'missing')).rejects.toThrow(
        NotFoundError,
      );
      expect(roomTaskRepo.delete).not.toHaveBeenCalled();
    });
  });
});
