import type { FriendRequestResponse, PublicUser } from '@shared/types';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  sendFriendRequestSchema,
  respondFriendRequestSchema,
  blockUserSchema,
} from '../routes/userSchemas';
import { validate } from '../middlewares/validator';
import { authMiddleware } from '../middlewares/authMiddleware';

export interface SendFriendRequestResult {
  request?: FriendRequestResponse;
  autoAccepted?: boolean;
  room?: unknown;
  requesterId?: string;
  addresseeId?: string;
  status?: string;
}

export interface FriendService {
  getFriends(userId: string): Promise<unknown>;
  removeFriend(userId: string, friendId: string): Promise<void>;
  getPendingRequests(userId: string): Promise<unknown>;
  sendFriendRequest(userId: string, targetUserId: string): Promise<unknown>;
  respondFriendRequest(userId: string, requestId: string, status: 'accepted' | 'rejected'): Promise<unknown>;
  getBlockedUsers(userId: string): Promise<unknown>;
  blockUser(userId: string, targetUserId: string): Promise<unknown>;
  unblockUser(userId: string, targetUserId: string): Promise<void>;
}

export const makeFriendRoutes = (service: FriendService) => {
  const app = new Hono();
  app.use('*', authMiddleware);

  app.get('/', async (c) => {
    const userId = c.get('user').userId;
    const friends = await service.getFriends(userId);
    return c.json(friends, 200);
  });

  app.delete('/:id', async (c) => {
    const userId = c.get('user').userId;
    const friendId = c.req.param('id');
    await service.removeFriend(userId, friendId);
    return c.body(null, 204);
  });

  return app;
};

export const makeBlockRoutes = (service: FriendService) => {
  const app = new Hono();
  app.use('*', authMiddleware);

  app.get('/', async (c) => {
    const userId = c.get('user').userId;
    // The service already returns a flat PublicUser[]; clients read `userId`/`name`
    // directly off each entry, so it must not be wrapped.
    const blocks = (await service.getBlockedUsers(userId)) as PublicUser[];
    return c.json(blocks ?? [], 200);
  });

  app.post('/', validate('json', blockUserSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as { targetUserId: string };
    const block = await service.blockUser(userId, body.targetUserId);
    return c.json(block, 201);
  });

  app.delete('/:id', async (c) => {
    const userId = c.get('user').userId;
    const targetUserId = c.req.param('id');
    await service.unblockUser(userId, targetUserId);
    return c.body(null, 204);
  });

  return app;
};

export const makeFriendRequestRoutes = (service: FriendService) => {
  const app = new Hono();
  app.use('*', authMiddleware);

  const getPending = async (c: Context) => {
    const userId = c.get('user').userId;
    const requests = await service.getPendingRequests(userId);
    return c.json(requests, 200);
  };

  app.get('/', getPending);
  app.get('/pending', getPending);

  app.post('/', validate('json', sendFriendRequestSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as { targetUserId: string };
    const result = await service.sendFriendRequest(userId, body.targetUserId);
    const resObj = result as SendFriendRequestResult;
    const payload = resObj.request ?? result;
    return c.json(payload, resObj.autoAccepted ? 200 : 201);
  });

  const handleRespond = async (c: Context) => {
    const userId = c.get('user').userId;
    const requestId = c.req.param('id') || '';
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; status?: string };
    const rawAction = body.action ?? (body.status === 'accepted' ? 'accept' : body.status === 'rejected' ? 'reject' : body.status);
    const status = rawAction === 'accept' ? 'accepted' : rawAction === 'reject' ? 'rejected' : ((rawAction || 'accepted') as 'accepted' | 'rejected');
    const result = await service.respondFriendRequest(userId, requestId, status);
    const resObj = result as { request?: FriendRequestResponse };
    const payload = resObj.request ?? result;
    return c.json(payload, 200);
  };

  app.patch('/:id', validate('json', respondFriendRequestSchema), handleRespond);
  app.post('/:id/respond', validate('json', respondFriendRequestSchema), handleRespond);

  return app;
};
