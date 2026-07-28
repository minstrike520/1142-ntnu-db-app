import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { makeRoomTaskRoutes } from '../../../src/routes/roomTaskRoutes';
import { authMiddleware } from '../../../src/middlewares/authMiddleware';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import { ForbiddenError } from '../../../src/utils/AppError';
import { signToken } from '../../../src/utils/jwt';

// authMiddleware looks the caller up through the shared SQL client; a non-empty
// row is all it needs to accept the signed token.
const mockSqlFn: any = mock().mockResolvedValue([{ user_id: 'caller-id' }]);
mockSqlFn.unsafe = mock().mockResolvedValue([{}]);
mock.module('../../../src/models/db', () => ({ default: mockSqlFn }));

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = 'room-1';
const TASK_ID = 'task-1';

// Ported from the Express-era roomTaskController test: the controller layer was
// folded into the route layer, so these now drive real Hono requests.
describe('roomTaskRoutes', () => {
  const task = { taskId: TASK_ID, roomId: ROOM_ID, title: 'Write report', status: 'open' };
  let service: any;
  let token: string;

  const makeApp = () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.use('/rooms/*', authMiddleware);
    app.route('/rooms', makeRoomTaskRoutes(service));
    return app;
  };

  const call = (path: string, method: string, body?: unknown) =>
    makeApp().request(`/rooms${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(async () => {
    token = await signToken({ userId: CALLER_ID, email: 'caller@test.com' } as any);
    service = {
      listTasks: mock(),
      createTask: mock(),
      updateTask: mock(),
      setStatus: mock(),
      deleteTask: mock(),
    };
  });

  afterAll(() => {
    mock.restore();
  });

  describe('GET /:roomId/tasks', () => {
    it('returns 200 with tasks from the service', async () => {
      service.listTasks.mockResolvedValue([task]);

      const res = await call(`/${ROOM_ID}/tasks`, 'GET');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([task]);
      expect(service.listTasks).toHaveBeenCalledWith(CALLER_ID, ROOM_ID);
    });

    it('surfaces a service error through the shared error handler', async () => {
      service.listTasks.mockRejectedValue(new ForbiddenError('nope'));

      const res = await call(`/${ROOM_ID}/tasks`, 'GET');

      expect(res.status).toBe(403);
    });
  });

  describe('POST /:roomId/tasks', () => {
    it('returns 201 with the created task', async () => {
      service.createTask.mockResolvedValue(task);

      const res = await call(`/${ROOM_ID}/tasks`, 'POST', {
        title: 'Write report',
        assigneeUserIds: ['user-2'],
      });

      expect(res.status).toBe(201);
      expect(await res.json()).toEqual(task);
      expect(service.createTask).toHaveBeenCalledWith(CALLER_ID, ROOM_ID, {
        title: 'Write report',
        description: undefined,
        dueAt: undefined,
        externalLink: undefined,
        assigneeUserIds: ['user-2'],
      });
    });
  });

  // Regression: the handlers originally read the body with a bare
  // `await c.req.json()`, so a missing/malformed body threw a SyntaxError that
  // escaped the route as a 500 INTERNAL_ERROR. The body must instead reach the
  // service's zod schema, which reports it as a 400. (The 400 itself is pinned
  // by the roomTaskService tests; here we only assert the SyntaxError no longer
  // escapes and the call still reaches the service.)
  describe('malformed or missing request bodies', () => {
    it.each([
      ['POST', `/${ROOM_ID}/tasks`, undefined],
      ['POST', `/${ROOM_ID}/tasks`, '{not json'],
      ['PATCH', `/${ROOM_ID}/tasks/${TASK_ID}`, undefined],
      ['PATCH', `/${ROOM_ID}/tasks/${TASK_ID}/status`, undefined],
    ] as const)('%s %s does not surface a 500', async (method, path, rawBody) => {
      const res = await makeApp().request(`/rooms${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(rawBody === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(rawBody === undefined ? {} : { body: rawBody }),
      });

      expect(res.status).not.toBe(500);
    });

    it('forwards an absent body to the service as undefined fields', async () => {
      service.createTask.mockResolvedValue(task);

      await makeApp().request(`/rooms/${ROOM_ID}/tasks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(service.createTask).toHaveBeenCalledWith(CALLER_ID, ROOM_ID, {
        title: undefined,
        description: undefined,
        dueAt: undefined,
        externalLink: undefined,
        assigneeUserIds: undefined,
      });
    });
  });

  describe('PATCH /:roomId/tasks/:taskId', () => {
    it('returns 200 with the updated task', async () => {
      const updated = { ...task, title: 'Updated' };
      service.updateTask.mockResolvedValue(updated);

      const res = await call(`/${ROOM_ID}/tasks/${TASK_ID}`, 'PATCH', { title: 'Updated' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(updated);
      expect(service.updateTask).toHaveBeenCalledWith(CALLER_ID, ROOM_ID, TASK_ID, {
        title: 'Updated',
        description: undefined,
        dueAt: undefined,
        externalLink: undefined,
      });
    });
  });

  describe('PATCH /:roomId/tasks/:taskId/status', () => {
    it('returns 200 with the updated task', async () => {
      const done = { ...task, status: 'done' };
      service.setStatus.mockResolvedValue(done);

      const res = await call(`/${ROOM_ID}/tasks/${TASK_ID}/status`, 'PATCH', { status: 'done' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(done);
      expect(service.setStatus).toHaveBeenCalledWith(CALLER_ID, ROOM_ID, TASK_ID, 'done');
    });

    it('does not collide with the plain task PATCH route', async () => {
      service.setStatus.mockResolvedValue(task);

      await call(`/${ROOM_ID}/tasks/${TASK_ID}/status`, 'PATCH', { status: 'done' });

      expect(service.updateTask).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:roomId/tasks/:taskId', () => {
    it('returns 204 on success', async () => {
      service.deleteTask.mockResolvedValue(undefined);

      const res = await call(`/${ROOM_ID}/tasks/${TASK_ID}`, 'DELETE');

      expect(res.status).toBe(204);
      expect(service.deleteTask).toHaveBeenCalledWith(CALLER_ID, ROOM_ID, TASK_ID);
    });

    it('surfaces a service error through the shared error handler', async () => {
      service.deleteTask.mockRejectedValue(new ForbiddenError('nope'));

      const res = await call(`/${ROOM_ID}/tasks/${TASK_ID}`, 'DELETE');

      expect(res.status).toBe(403);
    });
  });
});
