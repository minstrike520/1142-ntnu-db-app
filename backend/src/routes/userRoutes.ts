import { Hono } from 'hono';
import {
  updateMeSchema,
  updateSettingsSchema,
  searchQuerySchema,
  addEmergencyContactSchema,
  checkInactivitySchema,
} from '../validators/userSchemas';
import { validate } from '../middlewares/validator';
import { authMiddleware } from '../middlewares/authMiddleware';
import { clearRefreshCookie } from '../auth/cookies';
import { parseSingleFile } from '../utils/fileUpload';
import { ALLOWED_AVATAR_MIME_TYPES, AVATAR_UPLOAD_MAX_BYTES } from '../lib/avatarUpload';

export interface UserService {
  getMe(userId: string): Promise<any>;
  getUserProfile(userId: string): Promise<any>;
  updateMe(userId: string, data: unknown): Promise<any>;
  uploadAvatar(userId: string, file: Express.Multer.File): Promise<any>;
  getMySettings(userId: string): Promise<any>;
  updateMySettings(userId: string, data: unknown): Promise<any>;
  deleteMe(userId: string): Promise<void>;
  search(query: string, mode?: 'name' | 'userId' | 'email', currentUserId?: string): Promise<any>;
  getEmergencyContacts(userId: string): Promise<any>;
  upsertEmergencyContact(userId: string, contactId: string, message: string): Promise<{ contact: any; isUpdate: boolean }>;
  deleteEmergencyContact(userId: string, contactId: string): Promise<void>;
  checkInactivity(userId: string, now?: Date): Promise<any>;
}

export const makeUserRoutes = (service: UserService) => {
  const app = new Hono();

  app.use('*', authMiddleware);

  app.get('/me', async (c) => {
    const userId = c.get('user').userId;
    const user = await service.getMe(userId);
    return c.json(user, 200);
  });

  app.patch('/me', validate('json', updateMeSchema), async (c) => {
    const userId = c.get('user').userId;
    const data = c.req.valid('json');
    const updated = await service.updateMe(userId, data);
    return c.json(updated, 200);
  });

  app.post('/me/avatar', async (c) => {
    const userId = c.get('user').userId;
    const file = await parseSingleFile(c, {
      fieldName: 'file',
      maxBytes: AVATAR_UPLOAD_MAX_BYTES,
      allowedMimeTypes: ALLOWED_AVATAR_MIME_TYPES as unknown as string[],
    });
    const updated = await service.uploadAvatar(userId, file);
    return c.json(updated, 200);
  });

  app.delete('/me', async (c) => {
    const userId = c.get('user').userId;
    await service.deleteMe(userId);
    clearRefreshCookie(c);
    return c.body(null, 204);
  });

  app.get('/me/settings', async (c) => {
    const userId = c.get('user').userId;
    const settings = await service.getMySettings(userId);
    return c.json(settings, 200);
  });

  app.patch('/me/settings', validate('json', updateSettingsSchema), async (c) => {
    const userId = c.get('user').userId;
    const data = c.req.valid('json');
    const updated = await service.updateMySettings(userId, data);
    return c.json(updated, 200);
  });

  app.get('/search', validate('query', searchQuerySchema), async (c) => {
    const queryData = c.req.valid('query') as any;
    const currentUserId = queryData.friendsOnly === 'true' || queryData.friendsOnly === true
      ? c.get('user').userId
      : undefined;
    const users = await service.search(queryData.q, queryData.mode, currentUserId);
    return c.json(users, 200);
  });

  app.get('/me/emergency-contacts', async (c) => {
    const userId = c.get('user').userId;
    const contacts = await service.getEmergencyContacts(userId);
    return c.json(contacts, 200);
  });

  app.post('/me/emergency-contacts', validate('json', addEmergencyContactSchema), async (c) => {
    const userId = c.get('user').userId;
    const data = c.req.valid('json') as any;
    const result = await service.upsertEmergencyContact(userId, data.contactId, data.message);
    return c.json(result.contact, result.isUpdate ? 200 : 201);
  });

  app.delete('/me/emergency-contacts/:contactId', async (c) => {
    const userId = c.get('user').userId;
    const contactId = c.req.param('contactId');
    await service.deleteEmergencyContact(userId, contactId);
    return c.json({ message: 'Emergency contact removed' }, 200);
  });

  const handleCheckInactivity = async (c: any) => {
    const userId = c.get('user').userId;
    const data = c.req.valid('json') as any;
    const now = data.now ? new Date(data.now) : undefined;
    const result = await service.checkInactivity(userId, now);
    return c.json(result, 200);
  };

  app.post('/me/emergency-alert/check-inactivity', validate('json', checkInactivitySchema), handleCheckInactivity);
  app.post('/me/emergency-contacts/check-inactivity', validate('json', checkInactivitySchema), handleCheckInactivity);

  // Search without /search subpath (e.g. GET /api/v1/users?q=...)
  app.get('/', validate('query', searchQuerySchema), async (c) => {
    const queryData = c.req.valid('query') as any;
    const currentUserId = queryData.friendsOnly === 'true' || queryData.friendsOnly === true
      ? c.get('user').userId
      : undefined;
    const users = await service.search(queryData.q, queryData.mode, currentUserId);
    return c.json(users, 200);
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const user = await service.getUserProfile(id);
    return c.json(user, 200);
  });

  return app;
};
