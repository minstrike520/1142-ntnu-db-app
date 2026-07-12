import { describe, it, expect } from 'bun:test';
import { createRoomSchema, updateRoomSchema } from '../../../src/validators/roomSchemas';

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
});
