import { describe, it, expect } from 'bun:test';
import {
  createRoomSchema,
  updateRoomSchema,
  patchRoomSchema,
  updateMemberSchema,
} from '../../../src/routes/roomSchemas';

const OWNER_ID = 'e4c08495-e224-4a67-b6dd-5958952d3d42';

describe('room validation schemas', () => {
  it('validates create room payloads and applies defaults', () => {
    expect(createRoomSchema.parse({ name: ' Study Group ' })).toEqual({
      type: 'group',
      name: 'Study Group',
      requireApproval: false,
      viewHistory: true,
    });
    expect(createRoomSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createRoomSchema.safeParse({ type: 'channel', name: 'Bad' }).success).toBe(false);
  });

  it('requires at least one valid update field', () => {
    expect(updateRoomSchema.parse({ name: ' New Name ' })).toEqual({ name: 'New Name' });
    expect(updateRoomSchema.safeParse({}).success).toBe(false);
    expect(updateRoomSchema.safeParse({ name: '' }).success).toBe(false);
    expect(updateRoomSchema.safeParse({ avatarUrl: 'bad-url' }).success).toBe(false);
    expect(updateRoomSchema.safeParse({ isArchived: true }).success).toBe(true);
  });

  describe('patchRoomSchema', () => {
    it('keeps ownerId so PATCH /rooms/:id can transfer ownership', () => {
      expect(patchRoomSchema.parse({ ownerId: OWNER_ID })).toEqual({ ownerId: OWNER_ID });
    });

    it('accepts the snake_case owner_id alias', () => {
      expect(patchRoomSchema.parse({ owner_id: OWNER_ID })).toEqual({ ownerId: OWNER_ID });
    });

    it('rejects a malformed ownerId', () => {
      expect(patchRoomSchema.safeParse({ ownerId: 'not-a-uuid' }).success).toBe(false);
    });

    it('still accepts and trims plain settings updates', () => {
      expect(patchRoomSchema.parse({ name: ' New Name ' })).toEqual({ name: 'New Name' });
      expect(patchRoomSchema.safeParse({ isArchived: true }).success).toBe(true);
      expect(patchRoomSchema.safeParse({ avatarUrl: 'bad-url' }).success).toBe(false);
    });

    it('still requires at least one field', () => {
      expect(patchRoomSchema.safeParse({}).success).toBe(false);
      expect(patchRoomSchema.safeParse({ unrelated: true }).success).toBe(false);
    });
  });

  describe('group name requirement', () => {
    it('rejects a group room without a name', () => {
      // `type` defaults to 'group', so an empty body must not slip through.
      expect(createRoomSchema.safeParse({}).success).toBe(false);
      expect(createRoomSchema.safeParse({ type: 'group' }).success).toBe(false);
    });

    it('reports the missing name with the documented message', () => {
      const result = createRoomSchema.safeParse({ type: 'group' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe('Room name cannot be empty');
      }
    });

    it('still lets a private room omit the name', () => {
      const result = createRoomSchema.safeParse({
        type: 'private',
        targetUserId: OWNER_ID,
      });
      expect(result.success).toBe(true);
    });
  });

  describe('updateMemberSchema', () => {
    it('keeps isMuted so mute changes reach the service', () => {
      expect(updateMemberSchema.parse({ isMuted: true })).toEqual({ isMuted: true });
    });

    it('no longer strips the frontend field name', () => {
      const parsed = updateMemberSchema.parse({ role: 'admin', isMuted: false });
      expect(parsed).toEqual({ role: 'admin', isMuted: false });
    });

    it('drops the legacy muted alias rather than silently accepting it', () => {
      expect(updateMemberSchema.parse({ muted: true })).toEqual({});
    });

    it('does not accept ownerId (transfer lives on PATCH /rooms/:id)', () => {
      expect(updateMemberSchema.parse({ ownerId: OWNER_ID })).toEqual({});
    });
  });
});
