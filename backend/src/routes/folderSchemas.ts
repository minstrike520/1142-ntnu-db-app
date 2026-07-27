import { z } from 'zod';

export const createFolderSchema = z.object({
  name: z.string().min(1).max(50),
});

export const updateFolderRoomsSchema = z.object({
  roomIds: z.array(z.string().uuid()),
});
