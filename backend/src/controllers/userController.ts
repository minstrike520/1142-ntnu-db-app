import { Request, Response, NextFunction } from 'express';
import {
  updateMeSchema,
  updateSettingsSchema,
  searchQuerySchema,
  addEmergencyContactSchema,
} from '../validators/userSchemas';
import { ValidationError } from '../errors/AppError';
import type { MyProfile, PublicUser, SearchUserResult, UserProfile, UserSettings } from '../../../shared/types';


interface UserService {
  getMe(userId: string): Promise<MyProfile>;
  getUserProfile(userId: string): Promise<UserProfile>;
  updateMe(userId: string, data: unknown): Promise<MyProfile>;
  uploadAvatar(userId: string, file: Express.Multer.File): Promise<MyProfile>;
  getMySettings(userId: string): Promise<UserSettings>;
  updateMySettings(userId: string, data: unknown): Promise<UserSettings>;
  deleteMe(userId: string): Promise<void>;
  search(query: string, mode?: 'name' | 'userId' | 'email', currentUserId?: string): Promise<SearchUserResult[]>;

  getEmergencyContacts(userId: string): Promise<any>;
  upsertEmergencyContact(userId: string, contactId: string, message: string): Promise<{ contact: any, isUpdate: boolean }>;
  deleteEmergencyContact(userId: string, contactId: string): Promise<void>;
  checkInactivity(userId: string, now?: Date): Promise<any>;
}

export const makeUserController = (service: UserService) => ({
  async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const user = await service.getMe(userId);
      res.status(200).json(user);
    } catch (err) {
      next(err);
    }
  },

  async updateMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = updateMeSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload'));
      }
      const userId = req.user!.userId;
      const updated = await service.updateMe(userId, parsed.data);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  },

  async uploadAvatar(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.file) {
        return next(new ValidationError('file is required'));
      }
      const userId = req.user!.userId;
      const updated = await service.uploadAvatar(userId, req.file);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  },

  async getUserProfile(req: Request<{ id: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const user = await service.getUserProfile(req.params.id);
      res.status(200).json(user);
    } catch (err) {
      next(err);
    }
  },

  async getMySettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const settings = await service.getMySettings(userId);
      res.status(200).json(settings);
    } catch (err) {
      next(err);
    }
  },

  async updateMySettings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = updateSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload'));
      }
      const userId = req.user!.userId;
      const updated = await service.updateMySettings(userId, parsed.data);
      res.status(200).json(updated);
    } catch (err) {
      next(err);
    }
  },

  async deleteMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      await service.deleteMe(userId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
  
  async getEmergencyContacts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const contacts = await service.getEmergencyContacts(userId);
      res.status(200).json(contacts);
    } catch (err) {
      next(err);
    }
  },

  async addEmergencyContact(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = addEmergencyContactSchema.safeParse(req.body);
      if (!parsed.success) {
        return next(new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload'));
      }
      const userId = req.user!.userId;
      const { contact, isUpdate } = await service.upsertEmergencyContact(userId, parsed.data.contactId, parsed.data.message);
      res.status(isUpdate ? 200 : 201).json(contact);
    } catch (err) {
      next(err);
    }
  },

  async deleteEmergencyContact(req: Request<{ contactId: string }>, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const contactId = req.params.contactId;
      await service.deleteEmergencyContact(userId, contactId);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  },


  async checkEmergencyInactivity(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!.userId;
      const now = typeof req.body?.now === 'string' ? new Date(req.body.now) : undefined;
      if (now && Number.isNaN(now.getTime())) {
        return next(new ValidationError('now must be a valid ISO datetime'));
      }
      const result = await service.checkInactivity(userId, now);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },

  async search(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const parsed = searchQuerySchema.safeParse({
        q: req.query.q,
        mode: req.query.mode,
        friendsOnly: req.query.friendsOnly,
      });
      if (!parsed.success) {
        console.error('SEARCH PARSE ERROR:', parsed.error.issues, 'QUERY:', req.query);
        return next(new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query'));
      }
      const currentUserId = req.user!.userId;
      const users = parsed.data.friendsOnly
        ? await service.search(parsed.data.q, parsed.data.mode, currentUserId)
        : await service.search(parsed.data.q, parsed.data.mode);
      res.status(200).json(users);
    } catch (err) {
      next(err);
    }
  },
});
