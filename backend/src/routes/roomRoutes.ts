import { Hono } from 'hono';
import {
  createRoomSchema,
  updateRoomSchema,
  joinByCodeSchema,
  updateMemberSchema,
} from '../routes/roomSchemas';
import { validate } from '../middlewares/validator';
import { authMiddleware } from '../middlewares/authMiddleware';
import { parseSingleFile } from '../utils/fileUpload';
import { ALLOWED_AVATAR_MIME_TYPES, AVATAR_UPLOAD_MAX_BYTES } from '../utils/avatarUpload';
import { ValidationError } from '../utils/AppError';

export interface RoomService {
  list(userId: string): Promise<any>;
  getById(roomId: string, callerId: string): Promise<any>;
  create(creatorId: string, data: any): Promise<any>;
  createPrivate(userId: string, targetUserId: string, bypassFriendCheck?: boolean): Promise<{ room: any; isExisting?: boolean; created?: boolean }>;
  update(roomId: string, callerId: string, data: unknown): Promise<any>;
  joinByCode(userId: string, inviteCode: string): Promise<any>;
  leave(userId: string, roomId: string): Promise<void>;
  deleteGroup(roomId: string, callerId: string): Promise<void>;
  uploadAvatar(roomId: string, callerId: string, file: Express.Multer.File): Promise<any>;
  listMembers(roomId: string, callerId: string): Promise<any>;
  approveMember(roomId: string, callerId: string, targetUserId: string): Promise<any>;
  updateMember(roomId: string, callerId: string, targetUserId: string, data: unknown): Promise<any>;
  transferOwnership(roomId: string, callerId: string, targetUserId: string): Promise<any>;
  kickMember(roomId: string, callerId: string, targetUserId: string): Promise<void>;
}

export const makeRoomRoutes = (service: RoomService) => {
  const app = new Hono();

  app.use('*', authMiddleware);

  app.get('/', async (c) => {
    const userId = c.get('user').userId;
    const rooms = await service.list(userId);
    return c.json(rooms, 200);
  });

  app.post('/', validate('json', createRoomSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as any;

    if (body.type === 'private') {
      if (!body.targetUserId) {
        throw new ValidationError('targetUserId is required for private rooms');
      }
      const result = await service.createPrivate(userId, body.targetUserId);
      const isExisting = (result as any).isExisting ?? !(result as any).created;
      return c.json(result.room, isExisting ? 200 : 201);
    } else {
      const room = await service.create(userId, body);
      return c.json(room, 201);
    }
  });

  app.post('/join', validate('json', joinByCodeSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as any;
    const room = await service.joinByCode(userId, body.inviteCode);
    return c.json(room, 200);
  });

  app.get('/:id/members', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const members = await service.listMembers(roomId, userId);
    return c.json(members, 200);
  });

  app.post('/:id/members', validate('json', joinByCodeSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as any;
    const room = await service.joinByCode(userId, body.inviteCode);
    return c.json(room, 200);
  });

  app.delete('/:id/members/me', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    await service.leave(userId, roomId);
    return c.body(null, 204);
  });

  app.post('/:id/leave', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    await service.leave(userId, roomId);
    return c.body(null, 204);
  });

  app.delete('/:id/members/:targetUserId', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const targetUserId = c.req.param('targetUserId');
    await service.kickMember(roomId, userId, targetUserId);
    return c.body(null, 204);
  });

  app.patch('/:id/members/:targetUserId', validate('json', updateMemberSchema), async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const targetUserId = c.req.param('targetUserId');
    const body = c.req.valid('json') as any;

    if (body.status === 'approved') {
      await service.approveMember(roomId, userId, targetUserId);
      return c.json({ success: true }, 200);
    }

    if (body.ownerId && (body.ownerId === targetUserId || body.ownerId === userId)) {
      const targetOwnerId = body.ownerId === userId ? targetUserId : body.ownerId;
      if (!targetOwnerId) {
        throw new ValidationError('targetUserId is required for ownership transfer');
      }
      await service.transferOwnership(roomId, userId, targetOwnerId);
      return c.json({ success: true }, 200);
    }

    await service.updateMember(roomId, userId, targetUserId, body);
    return c.json({ success: true }, 200);
  });

  app.post('/:id/members/:targetUserId/approve', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const targetUserId = c.req.param('targetUserId');
    await service.approveMember(roomId, userId, targetUserId);
    return c.json({ success: true }, 200);
  });

  app.get('/:id', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const room = await service.getById(roomId, userId);
    return c.json(room, 200);
  });

  app.patch('/:id', validate('json', updateRoomSchema), async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const body = c.req.valid('json');
    const updated = await service.update(roomId, userId, body);
    return c.json(updated, 200);
  });

  app.post('/:id/avatar', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const file = await parseSingleFile(c, {
      fieldName: 'file',
      maxBytes: AVATAR_UPLOAD_MAX_BYTES,
      allowedMimeTypes: ALLOWED_AVATAR_MIME_TYPES as unknown as string[],
    });
    const updated = await service.uploadAvatar(roomId, userId, file);
    return c.json(updated, 200);
  });

  app.delete('/:id', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    await service.deleteGroup(roomId, userId);
    return c.body(null, 204);
  });

  return app;
};
