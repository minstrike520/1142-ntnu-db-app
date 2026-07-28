import { describe, it, expect, beforeEach } from "bun:test";
import { UserRepository } from "../../../src/models/userRepository";
import { testPool } from "../../helpers/testPool";
import { resetDb } from "../../helpers/resetDb";

describe("UserRepository (pg)", () => {
  const repo = new UserRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  it("should create and get a user", async () => {
    const user = await repo.create({
      name: "Test User",
      email: "test@example.com",
      passwordHash: "hash123"
    });

    expect(user.userId).toBeDefined();
    expect(user.name).toBe("Test User");
    expect(user.email).toBe("test@example.com");
    expect(user.passwordHash).toBe("hash123");
    expect(user.language).toBe("en");
    expect(user.createdAt).toBeInstanceOf(Date);

    const fetched = await repo.findById(user.userId);
    expect(fetched).toEqual(user);
    
    const byEmail = await repo.findByEmail("test@example.com");
    expect(byEmail).toEqual(user);
  });

  it("should return null for non-existent user", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";
    const fetched = await repo.findById(nonExistentId);
    expect(fetched).toBeNull();
    
    const byEmail = await repo.findByEmail("notfound@example.com");
    expect(byEmail).toBeNull();
  });

  it("should update a user", async () => {
    const user = await repo.create({
      name: "Old Name",
      email: "update@example.com",
      passwordHash: "hash"
    });

    const updated = await repo.update(user.userId, {
      name: "New Name",
      bio: "Hello world",
      warningEnabled: true,
      language: "zh-TW",
    });

    expect(updated.name).toBe("New Name");
    expect(updated.bio).toBe("Hello world");
    expect(updated.warningEnabled).toBe(true);
    expect(updated.language).toBe("zh-TW");
    expect(updated.email).toBe("update@example.com");

    const fetched = await repo.findById(user.userId);
    expect(fetched).toEqual(updated);
  });

  it("should delete a user", async () => {
    const user = await repo.create({
      name: "Delete Me",
      email: "delete@example.com",
      passwordHash: "hash"
    });

    await repo.delete(user.userId);

    const fetched = await repo.findById(user.userId);
    expect(fetched).toBeNull();
  });
});
