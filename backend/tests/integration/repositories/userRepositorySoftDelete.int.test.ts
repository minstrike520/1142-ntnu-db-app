import { describe, it, expect, afterAll } from 'bun:test';
import { testPool } from '../../helpers/testPool';
import { UserRepository } from '../../../src/repositories/userRepository';

const repo = new UserRepository(testPool);

describe('UserRepository soft-delete', () => {
  it('findById returns null for a soft-deleted user', async () => {
    const user = await repo.create({
      name: 'Soft Delete Test',
      email: `soft-delete-findbyid-${Date.now()}@test.example`,
      passwordHash: 'testhash',
    });

    await repo.update(user.userId, { deletedAt: new Date() });

    try {
      const result = await repo.findById(user.userId);
      expect(result).toBeNull();
    } finally {
      await repo.delete(user.userId);
    }
  });

  it('findByEmail returns null for a soft-deleted user', async () => {
    const email = `soft-delete-findbyemail-${Date.now()}@test.example`;
    const user = await repo.create({
      name: 'Soft Delete Test',
      email,
      passwordHash: 'testhash',
    });

    await repo.update(user.userId, { deletedAt: new Date() });

    try {
      const result = await repo.findByEmail(email);
      expect(result).toBeNull();
    } finally {
      await repo.delete(user.userId);
    }
  });

  it('findById returns the user when not soft-deleted', async () => {
    const user = await repo.create({
      name: 'Active User Test',
      email: `active-findbyid-${Date.now()}@test.example`,
      passwordHash: 'testhash',
    });

    try {
      const result = await repo.findById(user.userId);
      expect(result).not.toBeNull();
      expect(result?.userId).toBe(user.userId);
    } finally {
      await repo.delete(user.userId);
    }
  });
});

describe('UserRepository search', () => {
  it('finds users by partial name or email case-insensitively', async () => {
    const uniqueHash = Date.now();
    const user1 = await repo.create({
      name: `Search Name ${uniqueHash}`,
      email: `search-test-${uniqueHash}@test.example`,
      passwordHash: 'testhash',
    });

    try {
      const byEmail = await repo.search(`SEARCH-TEST-${uniqueHash}`);
      expect(byEmail.length).toBeGreaterThan(0);
      expect(byEmail.some(u => u.userId === user1.userId)).toBe(true);

      const byName = await repo.search(`search name ${uniqueHash}`);
      expect(byName.length).toBeGreaterThan(0);
      expect(byName.some(u => u.userId === user1.userId)).toBe(true);
      
      const byUserId = await repo.search(user1.userId);
      expect(byUserId.length).toBeGreaterThan(0);
      expect(byUserId.some(u => u.userId === user1.userId)).toBe(true);
    } finally {
      await repo.delete(user1.userId);
    }
  });
});
