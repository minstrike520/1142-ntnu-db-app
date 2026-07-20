import { Router } from 'express';
import { authMiddleware } from '../middlewares/authMiddleware';
import type { makeRoomTaskController } from '../controllers/roomTaskController';

export const makeRoomTaskRoutes = (ctrl: ReturnType<typeof makeRoomTaskController>): Router => {
  const router = Router();

  router.use(authMiddleware);

  router.get('/:roomId/tasks', ctrl.list.bind(ctrl));
  router.post('/:roomId/tasks', ctrl.create.bind(ctrl));
  router.patch('/:roomId/tasks/:taskId', ctrl.update.bind(ctrl));
  router.patch('/:roomId/tasks/:taskId/status', ctrl.setStatus.bind(ctrl));
  router.delete('/:roomId/tasks/:taskId', ctrl.remove.bind(ctrl));

  return router;
};
