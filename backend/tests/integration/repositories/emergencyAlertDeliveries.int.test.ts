import { describe, it, expect, beforeEach } from "bun:test";
import { EmergencyContactRepository } from "../../../src/models/emergencyContactRepository";
import { UserRepository } from "../../../src/models/userRepository";
import { testPool } from "../../helpers/testPool";
import { resetDb } from "../../helpers/resetDb";

/**
 * Per-contact receipts are what let an incident be retried for the contact that
 * failed without re-alerting the ones that already heard. The incident lease in
 * `emergency_alert_logs` is too coarse for that: it is released as a whole.
 */
describe("EmergencyContactRepository alert deliveries", () => {
  const repo = new EmergencyContactRepository(testPool);
  const users = new UserRepository(testPool);
  let userId: string;
  let contactA: string;
  let contactB: string;

  beforeEach(async () => {
    await resetDb();
    const owner = await users.create({ name: "Owner", email: "owner@example.com", passwordHash: "h" });
    const a = await users.create({ name: "A", email: "a@example.com", passwordHash: "h" });
    const b = await users.create({ name: "B", email: "b@example.com", passwordHash: "h" });
    userId = owner.userId;
    contactA = a.userId;
    contactB = b.userId;
  });

  it("records delivery per contact and per incident", async () => {
    const incident = "2026-08-11T00:00:00.000Z";

    expect(await repo.hasAlertDelivery(userId, contactA, incident)).toBe(false);

    await repo.recordAlertDelivery(userId, contactA, incident);

    expect(await repo.hasAlertDelivery(userId, contactA, incident)).toBe(true);
    // The other contact still needs telling — this is the retry case that used
    // to re-alert everyone.
    expect(await repo.hasAlertDelivery(userId, contactB, incident)).toBe(false);
    // And a later incident is a fresh alert for the same contact.
    expect(await repo.hasAlertDelivery(userId, contactA, "2026-08-12T00:00:00.000Z")).toBe(false);
  });

  it("is idempotent, so a retried write does not fail", async () => {
    const incident = "2026-08-11T00:00:00.000Z";
    await repo.recordAlertDelivery(userId, contactA, incident);
    await repo.recordAlertDelivery(userId, contactA, incident);

    expect(await repo.hasAlertDelivery(userId, contactA, incident)).toBe(true);
  });
});
