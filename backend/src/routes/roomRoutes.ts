import type { Room, RoomSummary } from '@shared/types';
import type { UploadedFile } from '../utils/fileUpload';
import { Hono } from 'hono';
import {
  createRoomSchema,
  patchRoomSchema,
  joinByCodeSchema,
  updateMemberSchema,
  type PatchRoomInput,
} from '../routes/roomSchemas';
import { validate } from '../middlewares/validator';
import { authMiddleware } from '../middlewares/authMiddleware';
import { parseSingleFile } from '../utils/fileUpload';
import { ALLOWED_AVATAR_MIME_TYPES, AVATAR_UPLOAD_MAX_BYTES } from '../utils/avatarUpload';
import { ValidationError } from '../utils/AppError';

export interface RoomService {
  list(userId: string): Promise<unknown>;
  getById(roomId: string, callerId: string): Promise<unknown>;
  create(creatorId: string, data: unknown): Promise<unknown>;
  createPrivate(userId: string, targetUserId: string, bypassFriendCheck?: boolean): Promise<{ room: Room | RoomSummary | unknown; isExisting?: boolean; created?: boolean }>;
  update(roomId: string, callerId: string, data: unknown): Promise<unknown>;
  joinByCode(userId: string, inviteCode: string): Promise<unknown>;
  leave(userId: string, roomId: string): Promise<void>;
  deleteGroup(roomId: string, callerId: string): Promise<void>;
  uploadAvatar(roomId: string, callerId: string, file: UploadedFile): Promise<unknown>;
  listMembers(roomId: string, callerId: string): Promise<unknown>;
  approveMember(roomId: string, callerId: string, targetUserId: string): Promise<void>;
  updateMember(roomId: string, callerId: string, targetUserId: string, data: unknown): Promise<void>;
  transferOwnership(roomId: string, callerId: string, targetUserId: string): Promise<void>;
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
    const body = c.req.valid('json') as { type?: string; targetUserId?: string };

    if (body.type === 'private') {
      if (!body.targetUserId) {
        throw new ValidationError('targetUserId is required for private rooms');
      }
      const result = await service.createPrivate(userId, body.targetUserId);
      const isExisting = result.isExisting ?? !result.created;
      return c.json(result.room, isExisting ? 200 : 201);
    } else {
      const room = await service.create(userId, body);
      return c.json(room, 201);
    }
  });

  app.post('/join', validate('json', joinByCodeSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as { inviteCode: string };
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
    const body = c.req.valid('json') as { inviteCode: string };
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
    const body = c.req.valid('json') as { status?: string };

    if (body.status === 'approved') {
      await service.approveMember(roomId, userId, targetUserId);
      return c.json({ message: 'Member approved' }, 200);
    }

    // Ownership transfer lives on PATCH /rooms/:id, not here.
    await service.updateMember(roomId, userId, targetUserId, body);
    return c.json({ message: 'Member updated' }, 200);
  });

  app.post('/:id/members/:targetUserId/approve', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const targetUserId = c.req.param('targetUserId');
    await service.approveMember(roomId, userId, targetUserId);
    return c.json({ message: 'Member approved' }, 200);
  });

  app.get('/:id', async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const room = await service.getById(roomId, userId);
    return c.json(room, 200);
  });

  app.patch('/:id', validate('json', patchRoomSchema), async (c) => {
    const userId = c.get('user').userId;
    const roomId = c.req.param('id');
    const { ownerId, ...settings } = c.req.valid('json') as PatchRoomInput;

    if (ownerId) {
      await service.transferOwnership(roomId, userId, ownerId);
      return c.json({ message: 'Ownership transferred' }, 200);
    }

    const updated = await service.update(roomId, userId, settings);
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
