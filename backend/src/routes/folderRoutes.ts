import { Hono } from 'hono';
import { createFolderSchema, updateFolderRoomsSchema } from '../validators/folderSchemas';
import { validate } from '../middlewares/validator';
import { authMiddleware } from '../middlewares/authMiddleware';

export interface FolderService {
  createFolder(userId: string, name: string): Promise<any>;
  getFolders(userId: string): Promise<any>;
  deleteFolder(folderId: string, userId: string): Promise<void>;
  updateFolderRooms(folderId: string, userId: string, roomIds: string[]): Promise<void>;
  renameFolder(folderId: string, userId: string, name: string): Promise<any>;
}

export const makeFolderRoutes = (service: FolderService) => {
  const app = new Hono();
  app.use('*', authMiddleware);

  app.get('/', async (c) => {
    const userId = c.get('user').userId;
    const folders = await service.getFolders(userId);
    return c.json(folders, 200);
  });

  app.post('/', validate('json', createFolderSchema), async (c) => {
    const userId = c.get('user').userId;
    const body = c.req.valid('json') as any;
    const folder = await service.createFolder(userId, body.name);
    return c.json(folder, 201);
  });

  app.delete('/:id', async (c) => {
    const userId = c.get('user').userId;
    const folderId = c.req.param('id');
    await service.deleteFolder(folderId, userId);
    return c.body(null, 204);
  });

  const handleUpdateRooms = async (c: any) => {
    const userId = c.get('user').userId;
    const folderId = c.req.param('id');
    const body = c.req.valid('json') as any;
    await service.updateFolderRooms(folderId, userId, body.roomIds);
    return c.json({ success: true }, 200);
  };

  app.put('/:id/rooms', validate('json', updateFolderRoomsSchema), handleUpdateRooms);
  app.post('/:id/rooms', validate('json', updateFolderRoomsSchema), handleUpdateRooms);

  app.patch('/:id', validate('json', createFolderSchema), async (c) => {
    const userId = c.get('user').userId;
    const folderId = c.req.param('id');
    const body = c.req.valid('json') as any;
    const folder = await service.renameFolder(folderId, userId, body.name);
    return c.json(folder, 200);
  });

  return app;
};
