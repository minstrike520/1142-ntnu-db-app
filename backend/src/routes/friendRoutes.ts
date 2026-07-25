import { Hono } from 'hono';
import {
  sendFriendRequestSchema,
  respondFriendRequestSchema,
  blockUserSchema,
} from '../routes/userSchemas';
import { validate } from '../middlewares/validator';
import { authMiddleware } from '../middlewares/authMiddleware';

export interface FriendService {
  getFriends(userId: string): Promise<any>;
  removeFriend(userId: string, friendId: string): Promise<void>;
  getPendingRequests(userId: string): Promise<any>;
  sendFriendRequest(userId: string, targetUserId: string): Promise<any>;
  respondFriendRequest(userId: string, requestId: string, status: 'accepted' | 'rejected'): Promise<any>;
  getBlockedUsers(userId: string): Promise<any>;
  blockUser(userId: string, targetUserId: string): Promise<any>;
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
    const blocks = await service.getBlockedUsers(userId);
    const mapped = (blocks || []).map((b: any) => ({
      blocked: b.blocked ?? b,
    }));
    return c.json(mapped, 200);
  });

  app.post('/', validate('json', blockUserSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as any;
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

  const getPending = async (c: any) => {
    const userId = c.get('user').userId;
    const requests = await service.getPendingRequests(userId);
    return c.json(requests, 200);
  };

  app.get('/', getPending);
  app.get('/pending', getPending);

  app.post('/', validate('json', sendFriendRequestSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as any;
    const result = await service.sendFriendRequest(userId, body.targetUserId);
    const payload = (result as any).request ?? result;
    return c.json(payload, (result as any).autoAccepted ? 200 : 201);
  });

  const handleRespond = async (c: any) => {
    const userId = c.get('user').userId;
    const requestId = c.req.param('id');
    const body = c.req.valid('json') as any;
    const rawAction = body.action ?? (body.status === 'accepted' ? 'accept' : body.status === 'rejected' ? 'reject' : body.status);
    const status = rawAction === 'accept' ? 'accepted' : rawAction === 'reject' ? 'rejected' : rawAction;
    const result = await service.respondFriendRequest(userId, requestId, status);
    const payload = (result as any).request ?? result;
    return c.json(payload, 200);
  };

  app.patch('/:id', validate('json', respondFriendRequestSchema), handleRespond);
  app.post('/:id/respond', validate('json', respondFriendRequestSchema), handleRespond);

  return app;
};
