import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { request } from '../../helpers/http';
import { honoApp as app } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import type { AuthResponse, EmergencyContactResponse } from '../../helpers/responseTypes';
import { testPool } from '../../helpers/testPool';

describe('Emergency Contacts E2E', () => {
  let token1: string;
  let user1Id: string;
  let token2: string;
  let user2Id: string;

  beforeEach(async () => {
    await resetDb();

    const u1 = await request(app)
      .post<AuthResponse>('/api/v1/auth/register')
      .send({ name: 'User One', email: 'user1@test.com', password: 'password123' });
    token1 = u1.body.token;
    user1Id = u1.body.user.userId;

    const u2 = await request(app)
      .post<AuthResponse>('/api/v1/auth/register')
      .send({ name: 'User Two', email: 'user2@test.com', password: 'password123' });
    token2 = u2.body.token;
    user2Id = u2.body.user.userId;
  });

  it('should manage emergency contacts lifecycle', async () => {
    // 1. Initially empty
    const listInitial = await request(app)
      .get<EmergencyContactResponse[]>('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`);
    expect(listInitial.status).toBe(200);
    expect(listInitial.body).toEqual([]);

    // 2. Add contact
    const addRes = await request(app)
      .post<EmergencyContactResponse>('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Please check on me if I go inactive!',
      });
    expect([200, 201]).toContain(addRes.status);
    expect(addRes.body.contactId).toBe(user2Id);
    expect(addRes.body.message).toBe('Please check on me if I go inactive!');
    expect(addRes.body.contact.name).toBe('User Two');

    // 3. List contains added contact
    const listAfterAdd = await request(app)
      .get<EmergencyContactResponse[]>('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`);
    expect(listAfterAdd.status).toBe(200);
    expect(listAfterAdd.body).toHaveLength(1);
    expect(listAfterAdd.body[0].contactId).toBe(user2Id);

    // 4. Update message (upsert)
    const updateRes = await request(app)
      .post<EmergencyContactResponse>('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Updated emergency message',
      });
    expect([200, 201]).toContain(updateRes.status);
    expect(updateRes.body.message).toBe('Updated emergency message');

    // 5. Delete contact
    const delRes = await request(app)
      .delete(`/api/v1/users/me/emergency-contacts/${user2Id}`)
      .set('Authorization', `Bearer ${token1}`);
    expect(delRes.status).toBe(200);

    // 6. List empty again
    const listAfterDel = await request(app)
      .get<EmergencyContactResponse[]>('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`);
    expect(listAfterDel.status).toBe(200);
    expect(listAfterDel.body).toEqual([]);
  });

  it('should reject self-contact creation', async () => {
    const res = await request(app)
      .post<EmergencyContactResponse>('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user1Id,
        message: 'Self contact',
      });
    expect(res.status).toBe(400);
  });

  it('should check inactivity threshold and suppress duplicate alerts', async () => {
    await request(app)
      .post<EmergencyContactResponse>('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Legacy check message',
      });

    await testPool`
      UPDATE users
      SET warning_enabled = true,
          warning_days = 2,
          last_activity = '2026-01-01T00:00:00.000Z'
      WHERE user_id = ${user1Id}
    `;

    const runCheck = async () => {
      const { UserRepository } = await import('../../../src/models/userRepository');
      const { EmergencyContactRepository } = await import('../../../src/models/emergencyContactRepository');
      const { makeUserService } = await import('../../../src/services/userService');
      const { RefreshTokenRepository } = await import('../../../src/models/refreshTokenRepository');
      const { makeFriendRepository } = await import('../../../src/models/friendRepository');

      const userRepo = new UserRepository(testPool);
      const contactRepo = new EmergencyContactRepository(testPool);
      const tokenRepo = new RefreshTokenRepository(testPool);
      const friendRepo = makeFriendRepository(testPool);
      let notifiedCount = 0;

      const userService = makeUserService(
        userRepo,
        contactRepo,
        tokenRepo,
        { signToken: async () => 't', generateRefreshToken: () => 'r', hashToken: () => 'h' },
        async () => { notifiedCount++; },
        friendRepo
      );

      const status = await userService.checkInactivity(user1Id);
      return { status, notifiedCount };
    };

    const firstRun = await runCheck();
    expect(firstRun.status.alerted).toBe(true);
    expect(firstRun.notifiedCount).toBe(1);

    const secondRun = await runCheck();
    expect(secondRun.status.alerted).toBe(false);
    expect(secondRun.notifiedCount).toBe(0);
  });
});
