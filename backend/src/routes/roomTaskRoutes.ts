import { Hono } from 'hono';
import type { RoomTaskService } from '../services/roomTaskService';

// The service validates every payload with the task schemas (roomId/taskId are
// merged in from the path), so these handlers stay thin and let AppError
// subclasses reach the shared error handler. Bodies are read with
// `.catch(() => ({}))` (as in the other route modules) so a missing or
// malformed body falls through to the schema and yields a 400, rather than
// letting c.req.json()'s SyntaxError escape as a 500.
export const makeRoomTaskRoutes = (service: RoomTaskService) => {
  const app = new Hono();

  app.get('/:roomId/tasks', async (c) => {
    const userId = c.get('user').userId;
    const tasks = await service.listTasks(userId, c.req.param('roomId'));
    return c.json(tasks, 200);
  });

  app.post('/:roomId/tasks', async (c) => {
    // Shape comes from the service contract; the schema there coerces/validates
    // the raw JSON (e.g. dueAt arrives as an ISO string).
    const body = (await c.req.json().catch(() => ({}))) as Partial<
      Parameters<RoomTaskService['createTask']>[2]
    >;
    const userId = c.get('user').userId;
    const { title, description, dueAt, externalLink, assigneeUserIds } = body;
    // Forwarded as-is (title may be absent) — createTask's schema is the gate
    // that turns a missing/invalid field into a 400.
    const task = await service.createTask(userId, c.req.param('roomId'), {
      title,
      description,
      dueAt,
      externalLink,
      assigneeUserIds,
    } as Parameters<RoomTaskService['createTask']>[2]);
    return c.json(task, 201);
  });

  app.patch('/:roomId/tasks/:taskId', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<
      Parameters<RoomTaskService['updateTask']>[3]
    >;
    const userId = c.get('user').userId;
    const { title, description, dueAt, externalLink } = body;
    const task = await service.updateTask(
      userId,
      c.req.param('roomId'),
      c.req.param('taskId'),
      { title, description, dueAt, externalLink },
    );
    return c.json(task, 200);
  });

  app.patch('/:roomId/tasks/:taskId/status', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { status?: 'open' | 'done' };
    const userId = c.get('user').userId;
    const task = await service.setStatus(
      userId,
      c.req.param('roomId'),
      c.req.param('taskId'),
      body.status as 'open' | 'done',
    );
    return c.json(task, 200);
  });

  app.delete('/:roomId/tasks/:taskId', async (c) => {
    const userId = c.get('user').userId;
    await service.deleteTask(userId, c.req.param('roomId'), c.req.param('taskId'));
    return c.body(null, 204);
  });

  return app;
};
