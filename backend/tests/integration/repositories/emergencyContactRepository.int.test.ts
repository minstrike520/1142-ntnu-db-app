import { beforeEach, describe, expect, test } from 'bun:test';
import { EmergencyContactRepository } from '../../../src/models/emergencyContactRepository';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

describe('EmergencyContactRepository alert claim recovery', () => {
  const repository = new EmergencyContactRepository(testPool);
  let userId: string;

  beforeEach(async () => {
    await resetDb();
    const users = await testPool`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Alice', 'alert-claim-alice@test.com', 'hash')
      RETURNING user_id
    `;
    userId = users[0].user_id as string;
  });

  test('a pending claim resumes after process interruption and completed work stays suppressed', async () => {
    const lastActivity = new Date('2026-08-01T00:00:00.000Z');

    expect(await repository.recordAlertIfNew(userId, lastActivity)).toBe(true);
    expect(await repository.recordAlertIfNew(userId, lastActivity)).toBe(true);

    await repository.completeAlert(userId, lastActivity);

    expect(await repository.recordAlertIfNew(userId, lastActivity)).toBe(false);
  });
});
