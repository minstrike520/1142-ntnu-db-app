import { Hono } from 'hono';
import type { RoomTaskService } from '../services/roomTaskService';

// The service validates every payload with the task schemas (roomId/taskId are
// merged in from the path), so these handlers stay thin and let AppError
// subclasses reach the shared error handler.
export const makeRoomTaskRoutes = (service: RoomTaskService) => {
  const app = new Hono();

  app.get('/:roomId/tasks', async (c) => {
    const userId = c.get('user').userId;
    const tasks = await service.listTasks(userId, c.req.param('roomId'));
    return c.json(tasks, 200);
  });

  app.post('/:roomId/tasks', async (c) => {
    const body = await c.req.json();
    const userId = c.get('user').userId;
    const { title, description, dueAt, externalLink, assigneeUserIds } = body;
    const task = await service.createTask(userId, c.req.param('roomId'), {
      title,
      description,
      dueAt,
      externalLink,
      assigneeUserIds,
    });
    return c.json(task, 201);
  });

  app.patch('/:roomId/tasks/:taskId', async (c) => {
    const body = await c.req.json();
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
    const body = await c.req.json();
    const userId = c.get('user').userId;
    const task = await service.setStatus(
      userId,
      c.req.param('roomId'),
      c.req.param('taskId'),
      body.status,
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
