import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeRoomTaskController } from '../../../src/controllers/roomTaskController';
import type { Request, Response, NextFunction } from 'express';

const mockRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), send: vi.fn() } as any;
  res.status.mockReturnValue(res);
  return res;
};

const authedReq = (overrides: Partial<Request> = {}): any => ({
  body: {},
  params: { roomId: 'room-1' },
  query: {},
  user: { userId: 'user-1' },
  ...overrides,
});

describe('roomTaskController', () => {
  const task = { taskId: 'task-1', roomId: 'room-1', title: 'Write report', status: 'open' };
  const service = {
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    setStatus: vi.fn(),
    deleteTask: vi.fn(),
  };
  const ctrl = makeRoomTaskController(service as any);

  beforeEach(() => vi.clearAllMocks());

  describe('list', () => {
    it('returns 200 with tasks from the service', async () => {
      service.listTasks.mockResolvedValue([task]);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.list(authedReq(), res, next);

      expect(service.listTasks).toHaveBeenCalledWith('user-1', 'room-1');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([task]);
    });

    it('calls next with error when the service throws', async () => {
      const err = new Error('forbidden');
      service.listTasks.mockRejectedValue(err);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.list(authedReq(), res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('create', () => {
    it('returns 201 with the created task', async () => {
      service.createTask.mockResolvedValue(task);
      const res = mockRes();
      const next = vi.fn();
      const body = { title: 'Write report', assigneeUserIds: ['user-2'] };

      await ctrl.create(authedReq({ body }), res, next);

      expect(service.createTask).toHaveBeenCalledWith('user-1', 'room-1', {
        title: 'Write report',
        description: undefined,
        dueAt: undefined,
        externalLink: undefined,
        assigneeUserIds: ['user-2'],
      });
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(task);
    });
  });

  describe('update', () => {
    it('returns 200 with the updated task', async () => {
      const updated = { ...task, title: 'Updated' };
      service.updateTask.mockResolvedValue(updated);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.update(authedReq({ params: { roomId: 'room-1', taskId: 'task-1' }, body: { title: 'Updated' } }), res, next);

      expect(service.updateTask).toHaveBeenCalledWith('user-1', 'room-1', 'task-1', {
        title: 'Updated',
        description: undefined,
        dueAt: undefined,
        externalLink: undefined,
      });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(updated);
    });
  });

  describe('setStatus', () => {
    it('returns 200 with the updated task', async () => {
      const done = { ...task, status: 'done' };
      service.setStatus.mockResolvedValue(done);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.setStatus(
        authedReq({ params: { roomId: 'room-1', taskId: 'task-1' }, body: { status: 'done' } }),
        res,
        next,
      );

      expect(service.setStatus).toHaveBeenCalledWith('user-1', 'room-1', 'task-1', 'done');
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(done);
    });
  });

  describe('remove', () => {
    it('returns 204 on success', async () => {
      service.deleteTask.mockResolvedValue(undefined);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.remove(authedReq({ params: { roomId: 'room-1', taskId: 'task-1' } }), res, next);

      expect(service.deleteTask).toHaveBeenCalledWith('user-1', 'room-1', 'task-1');
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('calls next with error when the service throws', async () => {
      const err = new Error('forbidden');
      service.deleteTask.mockRejectedValue(err);
      const res = mockRes();
      const next = vi.fn();

      await ctrl.remove(authedReq({ params: { roomId: 'room-1', taskId: 'task-1' } }), res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
