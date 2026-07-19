import bcrypt from 'bcryptjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/errors/AppError';
import type { IEmergencyContactRepository } from '../../../src/repositories/IEmergencyContactRepository';
import type { IUserRepository } from '../../../src/repositories/IUserRepository';
import { makeUserService } from '../../../src/services/userService';
import { loginSchema, registerSchema } from '../../../src/validators/userSchemas';
import type { User } from '../../../../shared/types';
import { saveAvatarUpload, removeManagedAvatar } from '../../../src/lib/avatarUpload';

vi.mock('../../../src/lib/avatarUpload', () => ({
  saveAvatarUpload: vi.fn(),
  removeManagedAvatar: vi.fn().mockResolvedValue(undefined),
}));

describe('userService', () => {
  let mockRepo: import('vitest').Mocked<IUserRepository>;
  let emergencyContactRepo: import('vitest').Mocked<IEmergencyContactRepository>;
  let mockRefreshTokenRepo: import('vitest').Mocked<any>;
  let mockJwt: { signToken: import('vitest').Mock; generateRefreshToken: import('vitest').Mock; hashToken: import('vitest').Mock };
  let notifyEmergencyContact: import('vitest').Mock;
  let userService: ReturnType<typeof makeUserService>;

  const baseUser = (): User => ({
    userId: 'u1',
    name: 'Test User',
    email: 'test@example.com',
    passwordHash: 'hashedpassword',
    bio: 'Hello there',
    avatarUrl: 'https://example.com/avatar.png',
    language: 'en',
    theme: 'light',
    notifyDesktop: true,
    notifySound: true,
    warningEnabled: false,
    warningDays: 0,
    lastActivity: new Date('2026-01-01T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    deletedAt: null,
  });

  beforeEach(() => {
    mockRepo = {
      findById: vi.fn(),
      findByEmail: vi.fn(),
      search: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findAllWarningEnabled: vi.fn(),
    };
    emergencyContactRepo = {
      findByUserId: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      recordAlertIfNew: vi.fn(),
    };
    mockRefreshTokenRepo = {
      create: vi.fn(),
      findByHash: vi.fn(),
      revoke: vi.fn(),
      revokeAllForUser: vi.fn(),
      rotate: vi.fn(),
    };
    mockRefreshTokenRepo.create.mockResolvedValue({
      tokenId: 'new-rt-id',
      userId: 'u1',
      tokenHash: 'hashed-fake-refresh-token',
      expiresAt: new Date(Date.now() + 100000),
      createdAt: new Date(),
      revokedAt: null,
      replacedBy: null,
    });
    mockRefreshTokenRepo.rotate.mockResolvedValue({
      tokenId: 'new-rt-id',
      userId: 'u1',
      tokenHash: 'hashed-new-fake-refresh-token',
      expiresAt: new Date(Date.now() + 100000),
      createdAt: new Date(),
      revokedAt: null,
      replacedBy: null,
    });
    mockJwt = {
      signToken: vi.fn(),
      generateRefreshToken: vi.fn(),
      hashToken: vi.fn(),
    };
    mockJwt.generateRefreshToken.mockReturnValue('fake-refresh-token');
    mockJwt.hashToken.mockImplementation((t: string) => `hashed-${t}`);
    notifyEmergencyContact = vi.fn();
    userService = makeUserService(
      mockRepo,
      emergencyContactRepo,
      mockRefreshTokenRepo,
      mockJwt,
      notifyEmergencyContact
    );
  });

  describe('register', () => {
    it('registers a new user and returns a public profile', async () => {
      mockRepo.findByEmail.mockResolvedValue(null);
      mockRepo.create.mockResolvedValue(baseUser());
      mockJwt.signToken.mockReturnValue('fake-jwt-token');

      const result = await userService.register({
        email: 'test@example.com',
        name: 'Test User',
        password: 'password123',
      });

      expect(mockRepo.findByEmail).toHaveBeenCalledWith('test@example.com');
      expect(mockRepo.create).toHaveBeenCalled();
      const createCall = mockRepo.create.mock.calls[0][0];
      expect(createCall.name).toBe('Test User');
      expect(createCall.email).toBe('test@example.com');
      expect(createCall.passwordHash).not.toBe('password123');
      expect(await bcrypt.compare('password123', createCall.passwordHash)).toBe(true);
      expect(result).toEqual({
        token: 'fake-jwt-token',
        refreshToken: 'fake-refresh-token',
        user: {
          userId: 'u1',
          name: 'Test User',
          avatarUrl: 'https://example.com/avatar.png',
        },
      });
    });

    it('rejects duplicate emails', async () => {
      mockRepo.findByEmail.mockResolvedValue(baseUser());
      await expect(
        userService.register({
          email: 'test@example.com',
          name: 'Test User',
          password: 'password123',
        }),
      ).rejects.toThrow(ConflictError);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('logs in a valid user', async () => {
      const user = baseUser();
      user.passwordHash = await bcrypt.hash('password123', 10);
      mockRepo.findByEmail.mockResolvedValue(user);
      mockJwt.signToken.mockReturnValue('fake-jwt-token');

      const result = await userService.login({
        email: 'test@example.com',
        password: 'password123',
      });

      expect(mockRepo.update).toHaveBeenCalledWith('u1', { lastActivity: expect.any(Date) });
      expect(result.token).toBe('fake-jwt-token');
      expect(result.refreshToken).toBe('fake-refresh-token');
      expect(result.user).toEqual({
        userId: 'u1',
        name: 'Test User',
        avatarUrl: 'https://example.com/avatar.png',
      });
    });

    it('rejects unknown emails', async () => {
      mockRepo.findByEmail.mockResolvedValue(null);
      await expect(
        userService.login({
          email: 'missing@example.com',
          password: 'password123',
        }),
      ).rejects.toThrow(ValidationError);
    });

    it('rejects wrong passwords', async () => {
      const user = baseUser();
      user.passwordHash = await bcrypt.hash('correctpassword', 10);
      mockRepo.findByEmail.mockResolvedValue(user);
      await expect(
        userService.login({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe('profile methods', () => {
    it('returns my profile', async () => {
      mockRepo.findById.mockResolvedValue(baseUser());

      await expect(userService.getMe('u1')).resolves.toEqual({
        userId: 'u1',
        name: 'Test User',
        email: 'test@example.com',
        bio: 'Hello there',
        avatarUrl: 'https://example.com/avatar.png',
        lastActivity: new Date('2026-01-01T00:00:00.000Z'),
      });
    });

    it('returns a public user profile', async () => {
      mockRepo.findById.mockResolvedValue(baseUser());

      await expect(userService.getUserProfile('u1')).resolves.toEqual({
        userId: 'u1',
        name: 'Test User',
        bio: 'Hello there',
        avatarUrl: 'https://example.com/avatar.png',
      });
    });

    it('updates my editable profile fields', async () => {
      const updatedUser = { ...baseUser(), name: 'New Name', avatarUrl: 'https://example.com/new.png' };
      mockRepo.update.mockResolvedValue(updatedUser);

      const result = await userService.updateMe('u1', { name: 'New Name' });

      expect(mockRepo.update).toHaveBeenCalledWith('u1', { name: 'New Name' });
      expect(result).toEqual({
        userId: 'u1',
        name: 'New Name',
        email: 'test@example.com',
        bio: 'Hello there',
        avatarUrl: 'https://example.com/new.png',
        lastActivity: new Date('2026-01-01T00:00:00.000Z'),
      });
    });

    it('updates email and password through my profile', async () => {
      const passwordHash = await bcrypt.hash('oldpassword123', 10);
      mockRepo.findById.mockResolvedValue({ ...baseUser(), passwordHash });
      const updatedUser = { ...baseUser(), email: 'new@example.com' };
      mockRepo.findByEmail.mockResolvedValue(null);
      mockRepo.update.mockResolvedValue(updatedUser);

      const result = await userService.updateMe('u1', {
        email: 'new@example.com',
        password: 'newpassword123',
        currentPassword: 'oldpassword123',
      });

      expect(mockRepo.findById).toHaveBeenCalledWith('u1');
      expect(mockRepo.findByEmail).toHaveBeenCalledWith('new@example.com');
      const updateCall = mockRepo.update.mock.calls[0][1];
      expect(updateCall.email).toBe('new@example.com');
      expect(updateCall.passwordHash).not.toBe('newpassword123');
      expect(await bcrypt.compare('newpassword123', updateCall.passwordHash!)).toBe(true);
      expect(result.email).toBe('new@example.com');
    });

    it('rejects updating email to another user email', async () => {
      mockRepo.findByEmail.mockResolvedValue({ ...baseUser(), userId: 'u2' });

      await expect(userService.updateMe('u1', { email: 'taken@example.com' })).rejects.toThrow(ConflictError);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });

    it('rejects invalid profile payloads', async () => {
      await expect(userService.updateMe('u1', { name: '' })).rejects.toThrow(ValidationError);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('settings methods', () => {
    it('returns user settings', async () => {
      mockRepo.findById.mockResolvedValue(baseUser());

      await expect(userService.getMySettings('u1')).resolves.toEqual({
        warningEnabled: false,
        warningDays: 0,
        language: 'en',
        theme: 'light',
        notifyDesktop: true,
        notifySound: true,
      });
    });

    it('updates settings when the next state is valid', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: false, warningDays: 0 });
      mockRepo.update.mockResolvedValue({
        ...baseUser(),
        warningEnabled: true,
        warningDays: 3,
        language: 'zh-TW',
        theme: 'dark',
        notifyDesktop: false,
        notifySound: false,
      });

      const result = await userService.updateMySettings('u1', {
        warningEnabled: true,
        warningDays: 3,
        language: 'zh-TW',
        theme: 'dark',
        notifyDesktop: false,
        notifySound: false,
      });

      expect(mockRepo.update).toHaveBeenCalledWith('u1', {
        warningEnabled: true,
        warningDays: 3,
        language: 'zh-TW',
        theme: 'dark',
        notifyDesktop: false,
        notifySound: false,
      });
      expect(result).toEqual({
        warningEnabled: true,
        warningDays: 3,
        language: 'zh-TW',
        theme: 'dark',
        notifyDesktop: false,
        notifySound: false,
      });
    });

    it('rejects enabling alerts with a zero-day threshold', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: false, warningDays: 0 });

      await expect(
        userService.updateMySettings('u1', {
          warningEnabled: true,
        }),
      ).rejects.toThrow(ValidationError);
      expect(mockRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteMe', () => {
    it('soft deletes the account', async () => {
      await userService.deleteMe('u1');
      expect(mockRepo.update).toHaveBeenCalledWith('u1', { deletedAt: expect.any(Date) });
    });
  });

  describe('search', () => {
    it('maps search results to public users', async () => {
      mockRepo.search.mockResolvedValue([baseUser()]);

      await expect(userService.search('Test')).resolves.toEqual([
        {
          userId: 'u1',
          name: 'Test User',
          email: 'test@example.com',
          avatarUrl: 'https://example.com/avatar.png',
        },
      ]);
    });

    it('rejects empty search queries', async () => {
      await expect(userService.search('')).rejects.toThrow(ValidationError);
    });

    it('passes mode=email to repo for exact email lookup', async () => {
      mockRepo.search.mockResolvedValue([baseUser()]);

      await userService.search('test@example.com', 'email');

      expect(mockRepo.search).toHaveBeenCalledWith('test@example.com', 'email');
    });

    it('passes mode=userId to repo for exact userId lookup', async () => {
      mockRepo.search.mockResolvedValue([baseUser()]);

      await userService.search('u1', 'userId');

      expect(mockRepo.search).toHaveBeenCalledWith('u1', 'userId');
    });

    it('passes mode=name to repo for fuzzy name search', async () => {
      mockRepo.search.mockResolvedValue([baseUser()]);

      await userService.search('Test', 'name');

      expect(mockRepo.search).toHaveBeenCalledWith('Test', 'name');
    });

    it('omits email from results when mode=name to prevent email enumeration', async () => {
      mockRepo.search.mockResolvedValue([baseUser()]);

      const results = await userService.search('Test', 'name');

      expect(results).toEqual([
        {
          userId: 'u1',
          name: 'Test User',
          avatarUrl: 'https://example.com/avatar.png',
        },
      ]);
      expect(results[0]).not.toHaveProperty('email');
    });

    it('includes email in results when mode=email', async () => {
      mockRepo.search.mockResolvedValue([baseUser()]);

      const results = await userService.search('test@example.com', 'email');

      expect(results[0]).toMatchObject({ email: 'test@example.com' });
    });

    it('includes email in results when mode=userId', async () => {
      mockRepo.search.mockResolvedValue([baseUser()]);

      const results = await userService.search('u1', 'userId');

      expect(results[0]).toMatchObject({ email: 'test@example.com' });
    });

    it('searches user friends when currentUserId is provided', async () => {
      const mockFriendRepo = {
        getFriends: vi.fn().mockResolvedValue([
          {
            friend: {
              userId: 'friend-1',
              name: 'Alice Friend',
              email: 'alice.friend@example.com',
              avatarUrl: 'https://example.com/alice.png',
            },
            friendshipCreatedAt: new Date(),
          },
          {
            friend: {
              userId: 'friend-2',
              name: 'Bob Friend',
              email: 'bob.friend@example.com',
              avatarUrl: 'https://example.com/bob.png',
            },
            friendshipCreatedAt: new Date(),
          },
        ]),
      };

      const userServiceWithFriends = makeUserService(
        mockRepo,
        emergencyContactRepo,
        mockRefreshTokenRepo,
        mockJwt,
        notifyEmergencyContact,
        mockFriendRepo,
      );

      const results = await userServiceWithFriends.search('Alice', 'name', 'user-id');
      expect(results).toHaveLength(1);
      expect(results[0].userId).toBe('friend-1');
      expect(results[0].name).toBe('Alice Friend');
      expect(mockFriendRepo.getFriends).toHaveBeenCalledWith('user-id');
      expect(mockRepo.search).not.toHaveBeenCalled();
    });
  });

  describe('schema sanity checks', () => {
    it('keeps register schema validation intact', () => {
      expect(registerSchema.safeParse({ email: 'valid@example.com', name: 'N', password: 'password123' }).success).toBe(true);
      expect(registerSchema.safeParse({ email: 'invalid', name: 'N', password: 'password123' }).success).toBe(false);
    });

    it('keeps login schema validation intact', () => {
      expect(loginSchema.safeParse({ email: 'valid@example.com', password: 'password123' }).success).toBe(true);
      expect(loginSchema.safeParse({ email: 'invalid', password: 'password123' }).success).toBe(false);
    });
  });

  describe('emergency alerts', () => {
    const inactiveUser: User = {
      ...baseUser(),
      warningEnabled: true,
      warningDays: 2,
    };

    it('checks inactivity threshold and suppresses duplicate alerts', async () => {
      mockRepo.findById.mockResolvedValue(inactiveUser);
      emergencyContactRepo.recordAlertIfNew.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      emergencyContactRepo.findByUserId.mockResolvedValue([
        {
          userId: 'u1',
          contactId: 'u2',
          message: 'inactive',
          createdAt: new Date(),
        },
      ]);

      const first = await userService.checkInactivity('u1', new Date('2026-01-04T00:00:00.000Z'));
      const second = await userService.checkInactivity('u1', new Date('2026-01-04T00:00:00.000Z'));

      expect(first.alerted).toBe(true);
      expect(second).toEqual({ alerted: false, recipients: [], reason: 'ALREADY_ALERTED' });
      expect(notifyEmergencyContact).toHaveBeenCalledTimes(1);
      expect(notifyEmergencyContact).toHaveBeenCalledWith('u2', {
        userId: 'u1',
        message: 'inactive',
      });
    });

    it('does not alert below the inactivity threshold', async () => {
      mockRepo.findById.mockResolvedValue(inactiveUser);

      const result = await userService.checkInactivity('u1', new Date('2026-01-02T00:00:00.000Z'));

      expect(result).toEqual({ alerted: false, recipients: [], reason: 'BELOW_THRESHOLD' });
      expect(emergencyContactRepo.recordAlertIfNew).not.toHaveBeenCalled();
    });
  });

  describe('refresh and revokeToken', () => {
    it('successfully refreshes token', async () => {
      const mockRecord = {
        tokenId: 'rt1',
        userId: 'u1',
        tokenHash: 'hashed-old-token',
        expiresAt: new Date(Date.now() + 100000),
        createdAt: new Date(),
        revokedAt: null,
        replacedBy: null,
      };
      mockRefreshTokenRepo.findByHash.mockResolvedValue(mockRecord);
      mockRepo.findById.mockResolvedValue(baseUser());
      mockJwt.signToken.mockReturnValue('new-fake-jwt-token');
      mockJwt.generateRefreshToken.mockReturnValue('new-fake-refresh-token');

      const result = await userService.refresh('old-token');

      expect(mockRefreshTokenRepo.findByHash).toHaveBeenCalledWith('hashed-old-token');
      expect(mockRefreshTokenRepo.rotate).toHaveBeenCalledWith('rt1', expect.objectContaining({
        userId: 'u1',
        tokenHash: 'hashed-new-fake-refresh-token',
      }));
      expect(result.token).toBe('new-fake-jwt-token');
      expect(result.refreshToken).toBe('new-fake-refresh-token');
    });

    it('rejects invalid or non-existent refresh token', async () => {
      mockRefreshTokenRepo.findByHash.mockResolvedValue(null);
      await expect(userService.refresh('invalid-token')).rejects.toThrow(ValidationError);
    });

    it('detects token reuse and revokes all user tokens', async () => {
      const mockRecord = {
        tokenId: 'rt1',
        userId: 'u1',
        tokenHash: 'hashed-old-token',
        expiresAt: new Date(Date.now() + 100000),
        createdAt: new Date(),
        revokedAt: new Date(),
        replacedBy: 'rt2',
      };
      mockRefreshTokenRepo.findByHash.mockResolvedValue(mockRecord);

      await expect(userService.refresh('old-token')).rejects.toThrow(ValidationError);
      expect(mockRefreshTokenRepo.revokeAllForUser).toHaveBeenCalledWith('u1');
    });

    it('rejects a revoked token without revoking other tokens if it was not replaced (manual logout)', async () => {
      const mockRecord = {
        tokenId: 'rt1',
        userId: 'u1',
        tokenHash: 'hashed-old-token',
        expiresAt: new Date(Date.now() + 100000),
        createdAt: new Date(),
        revokedAt: new Date(),
        replacedBy: null,
      };
      mockRefreshTokenRepo.findByHash.mockResolvedValue(mockRecord);

      await expect(userService.refresh('old-token')).rejects.toThrow(ValidationError);
      expect(mockRefreshTokenRepo.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('rejects expired refresh token', async () => {
      const mockRecord = {
        tokenId: 'rt1',
        userId: 'u1',
        tokenHash: 'hashed-old-token',
        expiresAt: new Date(Date.now() - 100000),
        createdAt: new Date(),
        revokedAt: null,
        replacedBy: null,
      };
      mockRefreshTokenRepo.findByHash.mockResolvedValue(mockRecord);

      await expect(userService.refresh('old-token')).rejects.toThrow(ValidationError);
    });

    it('successfully revokes token on logout', async () => {
      const mockRecord = {
        tokenId: 'rt1',
        userId: 'u1',
        tokenHash: 'hashed-token',
        expiresAt: new Date(),
        createdAt: new Date(),
        revokedAt: null,
        replacedBy: null,
      };
      mockRefreshTokenRepo.findByHash.mockResolvedValue(mockRecord);

      await userService.revokeToken('some-token');

      expect(mockRefreshTokenRepo.revoke).toHaveBeenCalledWith('rt1');
    });

    it('sets new refresh token expiration according to JWT_REFRESH_EXPIRES_IN_DAYS (sliding window)', async () => {
      const originalEnv = process.env.JWT_REFRESH_EXPIRES_IN_DAYS;
      process.env.JWT_REFRESH_EXPIRES_IN_DAYS = '14';
      try {
        const mockRecord = {
          tokenId: 'rt1',
          userId: 'u1',
          tokenHash: 'hashed-old-token',
          expiresAt: new Date(Date.now() + 100000),
          createdAt: new Date(),
          revokedAt: null,
          replacedBy: null,
        };
        mockRefreshTokenRepo.findByHash.mockResolvedValue(mockRecord);
        mockRepo.findById.mockResolvedValue(baseUser());
        mockJwt.signToken.mockReturnValue('new-fake-jwt-token');
        mockJwt.generateRefreshToken.mockReturnValue('new-fake-refresh-token');

        const now = Date.now();
        await userService.refresh('old-token');

        expect(mockRefreshTokenRepo.rotate).toHaveBeenCalledWith(
          'rt1',
          expect.objectContaining({
            userId: 'u1',
            expiresAt: expect.any(Date),
          })
        );
        const rotateCall = mockRefreshTokenRepo.rotate.mock.calls[mockRefreshTokenRepo.rotate.mock.calls.length - 1][1];
        const expectedTime = now + 14 * 24 * 60 * 60 * 1000;
        expect(Math.abs(rotateCall.expiresAt.getTime() - expectedTime)).toBeLessThan(5000);
      } finally {
        process.env.JWT_REFRESH_EXPIRES_IN_DAYS = originalEnv;
      }
    });
  });

  describe('login with soft-deleted user', () => {
    it('throws ValidationError when user has deletedAt set', async () => {
      mockRepo.findByEmail.mockResolvedValue({ ...baseUser(), deletedAt: new Date() });
      await expect(userService.login({ email: 'test@example.com', password: 'password123' }))
        .rejects.toThrow(ValidationError);
    });
  });

  describe('notifyContacts additional branches', () => {
    it('returns NO_CONTACTS when user has no emergency contacts', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: true, warningDays: 1, lastActivity: new Date('2026-01-01T00:00:00.000Z') });
      emergencyContactRepo.findByUserId.mockResolvedValue([]);
      emergencyContactRepo.recordAlertIfNew.mockResolvedValue(true);
      const result = await userService.checkInactivity('u1', new Date('2026-01-03T00:00:00.000Z'));
      expect(result).toEqual({ alerted: false, recipients: [], reason: 'NO_CONTACTS' });
    });

    it('still resolves and tracks recipients when notifyEmergencyContact callback is absent', async () => {
      const serviceNoCallback = makeUserService(mockRepo, emergencyContactRepo, mockRefreshTokenRepo, mockJwt);
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: true, warningDays: 1, lastActivity: new Date('2026-01-01T00:00:00.000Z') });
      emergencyContactRepo.findByUserId.mockResolvedValue([
        { contactId: 'c1', userId: 'u1', contactUserId: 'c1', message: 'Call me' },
      ] as any);
      emergencyContactRepo.recordAlertIfNew.mockResolvedValue(true);
      const result = await serviceNoCallback.checkInactivity('u1', new Date('2026-01-03T00:00:00.000Z'));
      expect(result.alerted).toBe(true);
      expect(result.recipients).toContain('c1');
    });

    it('uses the fallback message when contact.message is an empty string', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: true, warningDays: 1, lastActivity: new Date('2026-01-01T00:00:00.000Z') });
      emergencyContactRepo.findByUserId.mockResolvedValue([
        { contactId: 'c1', userId: 'u1', contactUserId: 'c1', message: '' },
      ] as any);
      emergencyContactRepo.recordAlertIfNew.mockResolvedValue(true);
      await userService.checkInactivity('u1', new Date('2026-01-03T00:00:00.000Z'));
      expect(notifyEmergencyContact).toHaveBeenCalledWith(
        'c1',
        expect.objectContaining({ message: expect.stringContaining('User has exceeded their inactivity warning threshold') }),
      );
    });
  });

  describe('checkInactivity additional branches', () => {
    it('returns WARNING_DISABLED when warningEnabled is false', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: false });
      const result = await userService.checkInactivity('u1');
      expect(result).toEqual({ alerted: false, recipients: [], reason: 'WARNING_DISABLED' });
    });

    it('returns INVALID_THRESHOLD when warningEnabled is true but warningDays is 0', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: true, warningDays: 0 });
      const result = await userService.checkInactivity('u1');
      expect(result).toEqual({ alerted: false, recipients: [], reason: 'INVALID_THRESHOLD' });
    });
  });

  describe('updateMe additional branches', () => {
    it('throws ValidationError when changing password without providing currentPassword', async () => {
      await expect(userService.updateMe('u1', { password: 'NewPass123' }))
        .rejects.toThrow(ValidationError);
    });

    it('throws ValidationError when currentPassword does not match stored hash', async () => {
      mockRepo.findById.mockResolvedValue(baseUser());
      await expect(userService.updateMe('u1', { password: 'NewPass123', currentPassword: 'wrongpassword' }))
        .rejects.toThrow(ValidationError);
    });

    it('does not throw ConflictError when the email already belongs to the same user', async () => {
      mockRepo.findByEmail.mockResolvedValue({ ...baseUser(), userId: 'u1' });
      mockRepo.update.mockResolvedValue(baseUser());
      await expect(userService.updateMe('u1', { email: 'test@example.com' })).resolves.toBeDefined();
    });
  });

  describe('uploadAvatar', () => {
    const fakeFile = { originalname: 'avatar.png', buffer: Buffer.from('data') } as Express.Multer.File;

    beforeEach(() => {
      vi.mocked(saveAvatarUpload).mockReset();
      vi.mocked(removeManagedAvatar).mockReset();
      vi.mocked(removeManagedAvatar).mockResolvedValue(undefined);
    });

    it('throws NotFoundError when user does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.uploadAvatar('u1', fakeFile)).rejects.toThrow(NotFoundError);
      expect(saveAvatarUpload).not.toHaveBeenCalled();
    });

    it('does not remove previous avatar when user had no avatarUrl', async () => {
      const user = { ...baseUser(), avatarUrl: undefined };
      const newUrl = '/uploads/avatars/u1-new.png';
      mockRepo.findById.mockResolvedValue(user);
      vi.mocked(saveAvatarUpload).mockResolvedValue(newUrl);
      mockRepo.update.mockResolvedValue({ ...user, avatarUrl: newUrl });
      await userService.uploadAvatar('u1', fakeFile);
      expect(removeManagedAvatar).not.toHaveBeenCalledWith(undefined, 'u1');
    });

    it('removes newly uploaded avatar and rethrows when repo.update fails', async () => {
      const user = { ...baseUser(), avatarUrl: '/old-avatar.png' };
      const newUrl = '/uploads/avatars/u1-new.png';
      mockRepo.findById.mockResolvedValue(user);
      vi.mocked(saveAvatarUpload).mockResolvedValue(newUrl);
      mockRepo.update.mockRejectedValue(new Error('DB failure'));
      await expect(userService.uploadAvatar('u1', fakeFile)).rejects.toThrow('DB failure');
      expect(removeManagedAvatar).toHaveBeenCalledWith(newUrl, 'u1');
    });
  });

  describe('search with friendRepo', () => {
    let friendRepo: any;

    beforeEach(() => {
      friendRepo = { getFriends: vi.fn() };
      userService = makeUserService(mockRepo, emergencyContactRepo, mockRefreshTokenRepo, mockJwt, notifyEmergencyContact, friendRepo);
      friendRepo.getFriends.mockResolvedValue([
        { friend: { userId: 'friend-1', name: 'Alice', email: 'alice@example.com', avatarUrl: null } },
        { friend: { userId: 'friend-2', name: 'Bob', email: null, avatarUrl: null } },
      ]);
    });

    it('filters by exact userId when mode is userId', async () => {
      const result = await userService.search('friend-1', 'userId', 'current-user');
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('friend-1');
      expect(result[0].email).toBe('alice@example.com');
    });

    it('filters by email when mode is email', async () => {
      const result = await userService.search('alice@example.com', 'email', 'current-user');
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('friend-1');
    });

    it('filters by name substring when no mode specified', async () => {
      const result = await userService.search('alice', undefined, 'current-user');
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('friend-1');
    });

    it('returns empty results for email search when friend has null email', async () => {
      const result = await userService.search('bob@example.com', 'email', 'current-user');
      expect(result).toHaveLength(0);
    });
  });

  describe('revokeToken no-op', () => {
    it('does nothing when the token hash is not found in the store', async () => {
      mockRefreshTokenRepo.findByHash.mockResolvedValue(null);
      await expect(userService.revokeToken('nonexistent-token')).resolves.toBeUndefined();
      expect(mockRefreshTokenRepo.revoke).not.toHaveBeenCalled();
    });
  });

  describe('refresh with soft-deleted user', () => {
    it('throws ValidationError when the associated user is soft-deleted', async () => {
      mockRefreshTokenRepo.findByHash.mockResolvedValue({
        tokenId: 'rt1',
        userId: 'u1',
        revokedAt: null,
        replacedBy: null,
        expiresAt: new Date(Date.now() + 86_400_000),
      });
      mockRepo.findById.mockResolvedValue({ ...baseUser(), deletedAt: new Date() });
      await expect(userService.refresh('some-token')).rejects.toThrow(ValidationError);
    });
  });

  describe('updateMe with onUserUpdated callback', () => {
    it('calls onUserUpdated after successful update', async () => {
      const onUserUpdated = vi.fn();
      const serviceWithCb = makeUserService(
        mockRepo, emergencyContactRepo, mockRefreshTokenRepo, mockJwt,
        undefined, undefined, onUserUpdated,
      );
      const updated = baseUser();
      mockRepo.update.mockResolvedValue(updated);
      await serviceWithCb.updateMe('u1', { name: 'New Name' });
      expect(onUserUpdated).toHaveBeenCalledWith('u1', { name: updated.name, avatarUrl: updated.avatarUrl });
    });
  });

  describe('uploadAvatar with onUserUpdated and old avatar removal', () => {
    const fakeFile = { originalname: 'avatar.png', buffer: Buffer.from('data') } as Express.Multer.File;

    beforeEach(() => {
      vi.mocked(saveAvatarUpload).mockReset();
      vi.mocked(removeManagedAvatar).mockReset();
      vi.mocked(removeManagedAvatar).mockResolvedValue(undefined);
    });

    it('calls onUserUpdated callback on successful upload', async () => {
      const onUserUpdated = vi.fn();
      const serviceWithCb = makeUserService(
        mockRepo, emergencyContactRepo, mockRefreshTokenRepo, mockJwt,
        undefined, undefined, onUserUpdated,
      );
      const user = { ...baseUser(), avatarUrl: undefined };
      const newUrl = '/uploads/avatars/u1-new.png';
      mockRepo.findById.mockResolvedValue(user);
      vi.mocked(saveAvatarUpload).mockResolvedValue(newUrl);
      mockRepo.update.mockResolvedValue({ ...user, avatarUrl: newUrl });
      await serviceWithCb.uploadAvatar('u1', fakeFile);
      expect(onUserUpdated).toHaveBeenCalledWith('u1', expect.objectContaining({ avatarUrl: newUrl }));
    });

    it('removes old avatar when user had a different previous avatarUrl', async () => {
      const oldUrl = '/uploads/avatars/old.png';
      const newUrl = '/uploads/avatars/new.png';
      const user = { ...baseUser(), avatarUrl: oldUrl };
      mockRepo.findById.mockResolvedValue(user);
      vi.mocked(saveAvatarUpload).mockResolvedValue(newUrl);
      mockRepo.update.mockResolvedValue({ ...user, avatarUrl: newUrl });
      await userService.uploadAvatar('u1', fakeFile);
      expect(removeManagedAvatar).toHaveBeenCalledWith(oldUrl, 'u1');
    });
  });

  describe('updateMySettings', () => {
    it('throws ValidationError when data fails schema validation', async () => {
      await expect(userService.updateMySettings('u1', { warningDays: -1 } as any))
        .rejects.toThrow(ValidationError);
    });
  });

  describe('getEmergencyContacts', () => {
    it('returns the list of emergency contacts for the user', async () => {
      const contacts = [{ contactId: 'c1', userId: 'u1', contactUserId: 'c1', message: 'help' }] as any;
      emergencyContactRepo.findByUserId.mockResolvedValue(contacts);
      const result = await userService.getEmergencyContacts('u1');
      expect(emergencyContactRepo.findByUserId).toHaveBeenCalledWith('u1');
      expect(result).toBe(contacts);
    });
  });

  describe('upsertEmergencyContact', () => {
    it('throws ValidationError when userId equals contactId (self-add)', async () => {
      await expect(userService.upsertEmergencyContact('u1', 'u1', 'help'))
        .rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError when the contact user does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.upsertEmergencyContact('u1', 'c1', 'help'))
        .rejects.toThrow(NotFoundError);
    });

    it('returns the upserted contact and isUpdate flag on success', async () => {
      const contact = { contactId: 'c1', userId: 'u1', contactUserId: 'c1', message: 'help' };
      mockRepo.findById.mockResolvedValue(baseUser());
      emergencyContactRepo.upsert.mockResolvedValue({ contact, isUpdate: false });
      const result = await userService.upsertEmergencyContact('u1', 'c1', 'help');
      expect(emergencyContactRepo.upsert).toHaveBeenCalledWith('u1', 'c1', 'help');
      expect(result).toEqual({ contact, isUpdate: false });
    });
  });

  describe('deleteEmergencyContact', () => {
    it('delegates to emergencyContactRepo.delete', async () => {
      emergencyContactRepo.delete.mockResolvedValue(undefined);
      await userService.deleteEmergencyContact('u1', 'c1');
      expect(emergencyContactRepo.delete).toHaveBeenCalledWith('u1', 'c1');
    });
  });

  describe('getMe user not found', () => {
    it('throws NotFoundError when user does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.getMe('u1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('getUserProfile user not found', () => {
    it('throws NotFoundError when user does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.getUserProfile('u1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('getMySettings user not found', () => {
    it('throws NotFoundError when user does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.getMySettings('u1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateMe user not found during password change', () => {
    it('throws NotFoundError when user is not found while changing password', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.updateMe('u1', { password: 'NewPass123', currentPassword: 'old' }))
        .rejects.toThrow(NotFoundError);
    });
  });

  describe('updateMySettings additional branches', () => {
    it('throws NotFoundError when user does not exist after schema passes', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.updateMySettings('u1', { warningDays: 5 }))
        .rejects.toThrow(NotFoundError);
    });

    it('falls back to current.warningEnabled when warningEnabled is not provided', async () => {
      mockRepo.findById.mockResolvedValue({ ...baseUser(), warningEnabled: false, warningDays: 3 });
      mockRepo.update.mockResolvedValue(baseUser());
      await expect(userService.updateMySettings('u1', { warningDays: 5 })).resolves.toBeDefined();
    });
  });



  describe('checkInactivity user not found', () => {
    it('throws NotFoundError when user does not exist', async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(userService.checkInactivity('u1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('search default mode null email friend', () => {
    it('handles null email in default-mode search without error', async () => {
      const fr = { getFriends: vi.fn() };
      const svc = makeUserService(mockRepo, emergencyContactRepo, mockRefreshTokenRepo, mockJwt, undefined, fr);
      fr.getFriends.mockResolvedValue([
        { friend: { userId: 'f1', name: 'Nullemail', email: null, avatarUrl: null } },
      ]);
      const result = await svc.search('nomatch', undefined, 'me');
      expect(result).toHaveLength(0);
    });
  });
});
