import { Request, Response, NextFunction } from 'express';
import { ValidationError } from '../errors/AppError';
import type { Room, RoomInvitePreview, RoomMember, RoomSummary } from '../../../shared/types';
import type { UpdateRoomInput } from '../validators/roomSchemas';

interface RoomService {
  list(userId: string): Promise<RoomSummary[]>;
  create(creatorId: string, data: { type: 'group'; name: string; avatarUrl?: string; requireApproval?: boolean; viewHistory?: boolean }): Promise<Room>;
  createPrivate(creatorId: string, targetUserId: string, bypassFriendCheck?: boolean): Promise<{ room: Room; created: boolean }>;
  getById(roomId: string, callerId: string): Promise<Room>;
  listMembers(roomId: string, callerId: string): Promise<RoomMember[]>;
  update(roomId: string, callerId: string, data: UpdateRoomInput): Promise<Room>;
  transferOwnership(roomId: string, callerId: string, targetUserId: string): Promise<void>;
  deleteGroup(roomId: string, callerId: string): Promise<void>;
  joinByCode(userId: string, inviteCode: string): Promise<Room>;
  previewByCode(userId: string, inviteCode: string): Promise<RoomInvitePreview>;
  leave(userId: string, roomId: string): Promise<void>;
  approveMember(roomId: string, callerId: string, targetUserId: string): Promise<void>;
  updateMember(roomId: string, callerId: string, targetUserId: string, data: { role?: string; nickname?: string; isMuted?: boolean }): Promise<void>;
  kickMember(roomId: string, callerId: string, targetUserId: string): Promise<void>;
  uploadAvatar(roomId: string, callerId: string, file: Express.Multer.File): Promise<Room>;
}

export const makeRoomController = (service: RoomService) => ({
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rooms = await service.list(req.user!.userId);
      res.status(200).json(rooms);
    } catch (err) {
      next(err);
    }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { type } = req.body;
      if (type === 'group') {
        const { name, avatarUrl, requireApproval, viewHistory } = req.body;
        if (!name || !name.trim()) {
          return next(new ValidationError('Room name cannot be empty'));
        }
        const room = await service.create(req.user!.userId, { type: 'group', name, avatarUrl, requireApproval, viewHistory });
        res.status(201).json(room);
      } else if (type === 'private') {
        const targetUserId = req.body.targetUserId ?? req.body.target_user_id;
        if (!targetUserId) {
          return next(new ValidationError('targetUserId is required'));
        }
        const result = await service.createPrivate(req.user!.userId, targetUserId);
        res.status(result.created ? 201 : 200).json(result.room);
      } else {
        return next(new ValidationError('Invalid room type'));
      }
    } catch (err) {
      next(err);
    }
  },

  async getById(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const room = await service.getById(req.params.id, req.user!.userId);
      res.status(200).json(room);
    } catch (err) {
      next(err);
    }
  },

  async listMembers(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const members = await service.listMembers(req.params.id, req.user!.userId);
      res.status(200).json(members);
    } catch (err) {
      next(err);
    }
  },

  async update(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const targetUserId = req.body.ownerId ?? req.body.owner_id;
      if (targetUserId) {
        await service.transferOwnership(req.params.id, req.user!.userId, targetUserId);
        res.status(200).json({ message: 'Ownership transferred' });
        return;
      }
      const room = await service.update(req.params.id, req.user!.userId, req.body);
      res.status(200).json(room);
    } catch (err) {
      next(err);
    }
  },

  async previewByCode(req: Request<{ code: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const preview = await service.previewByCode(req.user!.userId, req.params.code);
      res.status(200).json(preview);
    } catch (err) {
      next(err);
    }
  },

  async join(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const inviteCode = req.body.inviteCode ?? req.body.invite_code;
      const room = await service.joinByCode(req.user!.userId, inviteCode);
      res.status(200).json(room);
    } catch (err) {
      next(err);
    }
  },

  async transferOwnership(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const targetUserId = req.body.targetUserId ?? req.body.target_user_id;
      if (!targetUserId) {
        return next(new ValidationError('targetUserId is required'));
      }
      await service.transferOwnership(req.params.id, req.user!.userId, targetUserId);
      res.status(200).json({ message: 'Ownership transferred' });
    } catch (err) {
      next(err);
    }
  },

  async deleteGroup(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      await service.deleteGroup(req.params.id, req.user!.userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  async leave(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      await service.leave(req.user!.userId, req.params.id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  async approveMember(req: Request<{ id: string; userId: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      await service.approveMember(req.params.id, req.user!.userId, req.params.userId);
      res.status(200).json({ message: 'Member approved' });
    } catch (err) {
      next(err);
    }
  },

  async updateMember(req: Request<{ id: string; userId: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      if (req.body.status === 'approved') {
        await service.approveMember(req.params.id, req.user!.userId, req.params.userId);
        res.status(200).json({ message: 'Member approved' });
        return;
      }
      await service.updateMember(req.params.id, req.user!.userId, req.params.userId, req.body);
      res.status(200).json({ message: 'Member updated' });
    } catch (err) {
      next(err);
    }
  },

  async kickMember(req: Request<{ id: string; userId: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      await service.kickMember(req.params.id, req.user!.userId, req.params.userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },

  async uploadAvatar(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        return next(new ValidationError('Avatar file is required'));
      }
      const room = await service.uploadAvatar(req.params.id, req.user!.userId, req.file);
      res.status(200).json(room);
    } catch (err) {
      next(err);
    }
  }
});
