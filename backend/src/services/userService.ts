import type { UploadedFile } from '../utils/fileUpload';
import type { IUserRepository } from '../models/IUserRepository';
import type { IEmergencyContactRepository, EmergencyContact } from '../models/IEmergencyContactRepository';
import type {
  RegisterRequest,
  LoginRequest,
  AuthResponse,
  JwtPayload,
  MyProfile,
  PublicUser,
  SearchUserResult,
  User,
  UserProfile,
  UserSettings,
  FriendResponse,
} from '../../../shared/types';

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../utils/AppError';
import { defaultAvatarStore, type AvatarStore } from '../utils/avatarUpload';
import {
  updateMeSchema,
  updateSettingsSchema,
  searchQuerySchema,
  type UpdateMeInput,
  type UpdateSettingsInput,
} from '../routes/userSchemas';
import { getRefreshTokenTtlMs } from '../utils/refreshTokenTtl';

import type { IRefreshTokenRepository } from '../models/IRefreshTokenRepository';

interface JwtHelper {
  signToken(payload: JwtPayload): Promise<string>;
  generateRefreshToken(): string;
  hashToken(token: string): string;
}

interface EmergencyAlertResult {
  alerted: boolean;
  recipients: string[];
  /** Contacts whose durable delivery threw. Non-empty means a retry is owed. */
  failed?: string[];
  reason?: string;
}

const toPublicUser = (user: Pick<User, 'userId' | 'name' | 'avatarUrl'>): PublicUser => ({
  userId: user.userId,
  name: user.name,
  avatarUrl: user.avatarUrl,
});

const toUserProfile = (user: Pick<User, 'userId' | 'name' | 'bio' | 'avatarUrl'>): UserProfile => ({
  userId: user.userId,
  name: user.name,
  bio: user.bio,
  avatarUrl: user.avatarUrl,
});

const toMyProfile = (
  user: Pick<User, 'userId' | 'name' | 'email' | 'bio' | 'avatarUrl' | 'lastActivity'>,
): MyProfile => ({
  ...toUserProfile(user),
  email: user.email,
  lastActivity: user.lastActivity,
});

const toUserSettings = (
  user: Pick<User, 'warningEnabled' | 'warningDays' | 'language' | 'theme' | 'notifyDesktop' | 'notifySound' | 'roomOrder'>,
): UserSettings => ({
  warningEnabled: user.warningEnabled,
  warningDays: user.warningDays,
  language: user.language,
  theme: user.theme,
  notifyDesktop: user.notifyDesktop,
  notifySound: user.notifySound,
  roomOrder: user.roomOrder,
});

export const makeUserService = (
  repo: IUserRepository,
  emergencyContactRepo: IEmergencyContactRepository,
  refreshTokenRepo: IRefreshTokenRepository,
  jwt: JwtHelper,
  notifyEmergencyContact?: (contactId: string, payload: { userId: string; message: string; incidentId: string }) => void | Promise<void>,
  friendRepo?: { getFriends(userId: string): Promise<FriendResponse[]>; isBlocked?(userA: string, userB: string): Promise<boolean> },
  onUserUpdated?: (userId: string, data: { name?: string; avatarUrl?: string }) => void | Promise<void>,
  avatarStore: AvatarStore = defaultAvatarStore,
  disconnectUser?: (userId: string, reason: string) => void,
) => {
  const notifyContacts = async (userId: string, fallbackMessage: string, incidentId: string): Promise<EmergencyAlertResult> => {
    const user = await repo.findById(userId);
    if (!user) throw new NotFoundError('user', userId);

    const contacts = await emergencyContactRepo.findByUserId(userId);
    if (contacts.length === 0) {
      return { alerted: false, recipients: [], reason: 'NO_CONTACTS' };
    }

    const recipients: string[] = [];
    const failed: string[] = [];
    for (const contact of contacts) {
      const msg = contact.message || fallbackMessage;
      const deliver = async (): Promise<boolean> => {
        const currentContacts = await emergencyContactRepo.findByUserId(userId);
        if (!currentContacts.some((current) => current.contactId === contact.contactId)) return false;
        if (notifyEmergencyContact) {
          await notifyEmergencyContact(contact.contactId, {
            userId,
            message: msg,
            incidentId,
          });
        }
        return true;
      };
      // One unreachable contact must not silence the alert for everyone else,
      // so each delivery is isolated. Retrying the whole incident later is
      // safe because delivery is keyed by `incidentId` and is idempotent.
      try {
        const delivered = emergencyContactRepo.withContactLock
          ? await emergencyContactRepo.withContactLock(userId, contact.contactId, deliver)
          : await deliver();
        if (delivered) recipients.push(contact.contactId);
      } catch (error) {
        failed.push(contact.contactId);
        console.error(
          `Failed to deliver emergency alert to contact ${contact.contactId} for user ${userId}:`,
          error,
        );
      }
    }

    if (failed.length > 0) {
      return {
        alerted: recipients.length > 0,
        recipients,
        failed,
        reason: 'PARTIAL_DELIVERY',
      };
    }
    return { alerted: true, recipients };
  };

  const issueRefreshToken = async (userId: string): Promise<string> => {
    const refreshToken = jwt.generateRefreshToken();
    await refreshTokenRepo.create({
      userId,
      tokenHash: jwt.hashToken(refreshToken),
      expiresAt: new Date(Date.now() + getRefreshTokenTtlMs()),
    });
    return refreshToken;
  };

  return {
    async register(data: RegisterRequest): Promise<AuthResponse & { refreshToken: string }> {
      const existingUser = await repo.findByEmail(data.email);
      if (existingUser) {
        throw new ConflictError('Email already in use');
      }

      // ponytail: Using Bun's native high-performance password hashing
      const passwordHash = await Bun.password.hash(data.password);

      const user = await repo.create({
        email: data.email,
        name: data.name,
        passwordHash
      });

      const token = await jwt.signToken({
        userId: user.userId,
        name: user.name
      });

      const refreshToken = await issueRefreshToken(user.userId);

      return {
        token,
        refreshToken,
        user: toPublicUser(user)
      };
    },

    async login(data: LoginRequest): Promise<AuthResponse & { refreshToken: string }> {
      const user = await repo.findByEmail(data.email);
      if (!user || user.deletedAt) {
        throw new ValidationError('Invalid email or password');
      }

      // ponytail: Using Bun's native password verification with robust safety catch
      let isMatch = false;
      try {
        isMatch = await Bun.password.verify(data.password, user.passwordHash);
      } catch {
        isMatch = false;
      }
      if (!isMatch) {
        throw new ValidationError('Invalid email or password');
      }

      await repo.update(user.userId, { lastActivity: new Date() });

      const token = await jwt.signToken({
        userId: user.userId,
        name: user.name
      });

      const refreshToken = await issueRefreshToken(user.userId);

      return {
        token,
        refreshToken,
        user: toPublicUser(user)
      };
    },

    async getMe(userId: string): Promise<MyProfile> {
      const user = await repo.findById(userId);
      if (!user) throw new NotFoundError('user', userId);
      return toMyProfile(user);
    },

    async getUserProfile(userId: string): Promise<UserProfile> {
      const user = await repo.findById(userId);
      if (!user) throw new NotFoundError('user', userId);
      return toUserProfile(user);
    },

    async updateMe(userId: string, data: UpdateMeInput): Promise<MyProfile> {
      const parsed = updateMeSchema.safeParse(data);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload');
      }

      const updateData: Partial<Pick<User, 'name' | 'email' | 'passwordHash' | 'bio' | 'avatarUrl'>> = {
        name: parsed.data.name,
        email: parsed.data.email,
        bio: parsed.data.bio,
        avatarUrl: parsed.data.avatarUrl,
      };

      if (parsed.data.email !== undefined) {
        const existing = await repo.findByEmail(parsed.data.email);
        if (existing && existing.userId !== userId) {
          throw new ConflictError('Email already in use');
        }
      }

      if (parsed.data.password !== undefined) {
        if (!parsed.data.currentPassword) {
          throw new ValidationError('Current password is required to change password');
        }
        const currentUser = await repo.findById(userId);
        if (!currentUser) throw new NotFoundError('user', userId);

        // ponytail: Using Bun's native password verification with robust safety catch
        let isMatch = false;
        try {
          isMatch = await Bun.password.verify(parsed.data.currentPassword, currentUser.passwordHash);
        } catch {
          isMatch = false;
        }
        if (!isMatch) {
          throw new ValidationError('Incorrect current password');
        }

        // ponytail: Using Bun's native high-performance password hashing
        updateData.passwordHash = await Bun.password.hash(parsed.data.password);
      }

      const updated = await repo.update(userId, updateData);
      const profile = toMyProfile(updated);
      if (onUserUpdated) {
        onUserUpdated(userId, { name: profile.name, avatarUrl: profile.avatarUrl });
      }
      return profile;
    },

    async uploadAvatar(userId: string, file: UploadedFile): Promise<MyProfile> {
      const currentUser = await repo.findById(userId);
      if (!currentUser) {
        throw new NotFoundError('user', userId);
      }

      const avatarUrl = await avatarStore.saveAvatarUpload(userId, file);

      try {
        const updated = await repo.update(userId, { avatarUrl });
        const profile = toMyProfile(updated);
        if (onUserUpdated) {
          onUserUpdated(userId, { name: profile.name, avatarUrl: profile.avatarUrl });
        }
        if (currentUser.avatarUrl && currentUser.avatarUrl !== avatarUrl) {
          await avatarStore.removeManagedAvatar(currentUser.avatarUrl, userId);
        }
        return profile;
      } catch (error) {
        await avatarStore.removeManagedAvatar(avatarUrl, userId);
        throw error;
      }
    },

    async getMySettings(userId: string): Promise<UserSettings> {
      const user = await repo.findById(userId);
      if (!user) throw new NotFoundError('user', userId);
      return toUserSettings(user);
    },

    async updateMySettings(userId: string, data: UpdateSettingsInput): Promise<UserSettings> {
      const parsed = updateSettingsSchema.safeParse(data);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid payload');
      }

      const current = await repo.findById(userId);
      if (!current) throw new NotFoundError('user', userId);

      const nextWarningEnabled = parsed.data.warningEnabled ?? current.warningEnabled;
      const nextWarningDays = parsed.data.warningDays ?? current.warningDays;
      if (nextWarningEnabled && nextWarningDays < 1) {
        throw new ValidationError('warningDays must be at least 1 when warnings are enabled');
      }

      const updated = await repo.update(userId, parsed.data);
      return toUserSettings(updated);
    },

    async deleteMe(userId: string): Promise<void> {
      await repo.update(userId, { deletedAt: new Date() });
      await refreshTokenRepo.revokeAllForUser(userId);
      disconnectUser?.(userId, 'account_deleted');
    },

    
    async getEmergencyContacts(userId: string): Promise<EmergencyContact[]> {
      return await emergencyContactRepo.findByUserId(userId);
    },

    async upsertEmergencyContact(userId: string, contactId: string, message: string): Promise<{ contact: EmergencyContact, isUpdate: boolean }> {
      if (userId === contactId) {
        throw new ValidationError('Cannot add yourself as an emergency contact');
      }
      if (await friendRepo?.isBlocked?.(userId, contactId)) {
        throw new ForbiddenError('Cannot add a blocked user as an emergency contact');
      }
      const contact = await repo.findById(contactId);
      if (!contact) throw new NotFoundError('user', contactId);
      const result = await emergencyContactRepo.upsert(userId, contactId, message);
      // The block operation removes both directions under the same pair lock.
      // Recheck after the write so a block that committed during the initial
      // authorization check cannot leave a newly-created contact behind.
      if (await friendRepo?.isBlocked?.(userId, contactId)) {
        await emergencyContactRepo.delete(userId, contactId);
        throw new ForbiddenError('Cannot add a blocked user as an emergency contact');
      }
      return result;
    },

    async deleteEmergencyContact(userId: string, contactId: string): Promise<void> {
      await emergencyContactRepo.delete(userId, contactId);
    },


    async checkInactivity(userId: string, now = new Date()): Promise<EmergencyAlertResult> {
      const user = await repo.findById(userId);
      if (!user) throw new NotFoundError('user', userId);

      if (!user.warningEnabled) {
        return { alerted: false, recipients: [], reason: 'WARNING_DISABLED' };
      }
      if (user.warningDays < 1) {
        return { alerted: false, recipients: [], reason: 'INVALID_THRESHOLD' };
      }

      const inactiveMs = now.getTime() - user.lastActivity.getTime();
      const thresholdMs = user.warningDays * 24 * 60 * 60 * 1000;
      if (inactiveMs < thresholdMs) {
        return { alerted: false, recipients: [], reason: 'BELOW_THRESHOLD' };
      }

      const shouldAlert = await emergencyContactRepo.recordAlertIfNew(userId, user.lastActivity);
      if (!shouldAlert) {
        return { alerted: false, recipients: [], reason: 'ALREADY_ALERTED' };
      }

      try {
        const alert = await notifyContacts(
          userId,
          'User has exceeded their inactivity warning threshold',
          user.lastActivity.toISOString(),
        );
        if (!alert.alerted || (alert.failed?.length ?? 0) > 0) {
          // A partially delivered incident still owes the remaining contacts a
          // notification, so the reservation is released and the next run
          // retries. Contacts that already received the message are protected
          // by the per-incident idempotency key.
          await emergencyContactRepo.releaseAlertIfNew?.(userId, user.lastActivity);
        } else {
          await emergencyContactRepo.completeAlert?.(userId, user.lastActivity);
        }
        return alert;
      } catch (error) {
        // The row is a reservation, not the delivery itself. Release it when
        // the durable notification cannot be completed so a later check can
        // retry instead of permanently suppressing the incident.
        await emergencyContactRepo.releaseAlertIfNew?.(userId, user.lastActivity);
        throw error;
      }
    },


    async search(query: string, mode?: 'name' | 'userId' | 'email', currentUserId?: string): Promise<SearchUserResult[]> {
      const parsed = searchQuerySchema.safeParse({ q: query, mode, friendsOnly: !!currentUserId });
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Invalid query');
      }

      let users: SearchUserResult[] = [];
      if (currentUserId && friendRepo) {
        const friendships = await friendRepo.getFriends(currentUserId);
        const searchVal = parsed.data.q.toLowerCase();

        const matchingFriends = friendships.filter((f: FriendResponse) => {
          const u = f.friend as PublicUser & { email?: string };
          if (parsed.data.mode === 'userId') {
            return u.userId.toLowerCase() === searchVal;
          } else if (parsed.data.mode === 'email') {
            return u.email && u.email.toLowerCase() === searchVal;
          } else if (parsed.data.mode === 'name') {
            return u.name.toLowerCase().includes(searchVal);
          } else {
            return (
              u.name.toLowerCase().includes(searchVal) ||
              u.userId.toLowerCase() === searchVal ||
              (u.email && u.email.toLowerCase().includes(searchVal))
            );
          }
        });

        users = matchingFriends.map((f: FriendResponse) => {
          const u = f.friend as PublicUser & { email?: string };
          return {
            userId: u.userId,
            name: u.name,
            email: u.email,
            avatarUrl: u.avatarUrl,
          };
        });
      } else {
        const dbUsers = await repo.search(parsed.data.q, parsed.data.mode);
        users = dbUsers.map((u) => ({
          userId: u.userId,
          name: u.name,
          email: u.email,
          avatarUrl: u.avatarUrl,
        }));
      }

      return users.map((user) => {
        const result: SearchUserResult = {
          userId: user.userId,
          name: user.name,
          avatarUrl: user.avatarUrl,
        };
        if (parsed.data.mode !== 'name') {
          result.email = user.email;
        }
        return result;
      });
    },

    async refresh(refreshToken: string): Promise<AuthResponse & { refreshToken: string }> {
      const tokenHash = jwt.hashToken(refreshToken);
      const tokenRecord = await refreshTokenRepo.findByHash(tokenHash);
      if (!tokenRecord) {
        throw new ValidationError('Invalid refresh token');
      }

      if (tokenRecord.revokedAt) {
        if (tokenRecord.replacedBy) {
          await refreshTokenRepo.revokeAllForUser(tokenRecord.userId);
          throw new ValidationError('Refresh token has been reused and revoked');
        }
        throw new ValidationError('Refresh token has been revoked');
      }

      if (new Date() > new Date(tokenRecord.expiresAt)) {
        throw new ValidationError('Refresh token expired');
      }

      const user = await repo.findById(tokenRecord.userId);
      if (!user || user.deletedAt) {
        throw new ValidationError('User not found or deleted');
      }

      const newAccessToken = await jwt.signToken({
        userId: user.userId,
        name: user.name,
      });
      const newRefreshToken = jwt.generateRefreshToken();

      await refreshTokenRepo.rotate(tokenRecord.tokenId, {
        userId: user.userId,
        tokenHash: jwt.hashToken(newRefreshToken),
        expiresAt: new Date(Date.now() + getRefreshTokenTtlMs()),
      });

      return {
        token: newAccessToken,
        refreshToken: newRefreshToken,
        user: toPublicUser(user),
      };
    },

    async revokeToken(refreshToken: string): Promise<void> {
      const tokenHash = jwt.hashToken(refreshToken);
      const tokenRecord = await refreshTokenRepo.findByHash(tokenHash);
      if (tokenRecord) {
        await refreshTokenRepo.revoke(tokenRecord.tokenId);
      }
    },
  };
};
