import { Request, Response, NextFunction } from 'express';
import type { RoomTaskService } from '../services/roomTaskService';

export const makeRoomTaskController = (service: RoomTaskService) => ({
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const roomId = req.params.roomId as string;
      const tasks = await service.listTasks(req.user!.userId, roomId);
      res.status(200).json(tasks);
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const roomId = req.params.roomId as string;
      const { title, description, dueAt, externalLink, assigneeUserIds } = req.body;
      const task = await service.createTask(req.user!.userId, roomId, {
        title,
        description,
        dueAt,
        externalLink,
        assigneeUserIds,
      });
      res.status(201).json(task);
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const roomId = req.params.roomId as string;
      const taskId = req.params.taskId as string;
      const { title, description, dueAt, externalLink } = req.body;
      const task = await service.updateTask(req.user!.userId, roomId, taskId, {
        title,
        description,
        dueAt,
        externalLink,
      });
      res.status(200).json(task);
    } catch (err) {
      next(err);
    }
  },

  async setStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const roomId = req.params.roomId as string;
      const taskId = req.params.taskId as string;
      const { status } = req.body;
      const task = await service.setStatus(req.user!.userId, roomId, taskId, status);
      res.status(200).json(task);
    } catch (err) {
      next(err);
    }
  },

  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const roomId = req.params.roomId as string;
      const taskId = req.params.taskId as string;
      await service.deleteTask(req.user!.userId, roomId, taskId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
});
