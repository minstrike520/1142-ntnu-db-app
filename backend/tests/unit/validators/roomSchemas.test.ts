import { describe, it, expect } from 'bun:test';
import { createRoomSchema, updateRoomSchema, patchRoomSchema } from '../../../src/routes/roomSchemas';

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
});
