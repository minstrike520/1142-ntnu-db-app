import { describe, it, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { app } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

describe('Emergency Contacts E2E', () => {
  let token1: string;
  let user1Id: string;
  let user2Id: string;

  beforeEach(async () => {
    await resetDb();
    
    // Register User 1
    const res1 = await request(app).post('/api/v1/auth/register').send({
      name: 'User One',
      email: 'user1@example.com',
      password: 'Password123!',
    });
    token1 = res1.body.token;
    user1Id = res1.body.user.userId;

    // Register User 2
    const res2 = await request(app).post('/api/v1/auth/register').send({
      name: 'User Two',
      email: 'user2@example.com',
      password: 'Password123!',
    });
    user2Id = res2.body.user.userId;
  });

  it('should create an emergency contact', async () => {
    const res = await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Help me!',
      });
    
    expect(res.status).toBe(201);
    expect(res.body.contactId).toBe(user2Id);
    expect(res.body.message).toBe('Help me!');
  });

  it('should get emergency contacts', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Help me!',
      });

    const res = await request(app)
      .get('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`);
    
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].contactId).toBe(user2Id);
    expect(res.body[0].message).toBe('Help me!');
    expect(res.body[0].contact).toBeDefined();
    expect(res.body[0].contact.name).toBe('User Two');
  });

  it('should update an emergency contact if already exists', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Initial message',
      });

    const res = await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Updated message',
      });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Updated message');
  });

  it('should delete an emergency contact', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Help me!',
      });

    const delRes = await request(app)
      .delete(`/api/v1/users/me/emergency-contacts/${user2Id}`)
      .set('Authorization', `Bearer ${token1}`);
    
    expect(delRes.status).toBe(200);

    const getRes = await request(app)
      .get('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`);
    
    expect(getRes.body).toHaveLength(0);
  });


  it('should check inactivity threshold and suppress duplicate alerts', async () => {
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${token1}`)
      .send({
        contactId: user2Id,
        message: 'Legacy check message',
      });

    await testPool.query(
      `UPDATE users
       SET warning_enabled = true,
           warning_days = 2,
           last_activity = '2026-01-01T00:00:00.000Z'
       WHERE user_id = $1`,
      [user1Id],
    );

    const belowThreshold = await request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${token1}`)
      .send({ now: '2026-01-02T00:00:00.000Z' });
    expect(belowThreshold.status).toBe(200);
    expect(belowThreshold.body).toMatchObject({ alerted: false, reason: 'BELOW_THRESHOLD' });

    const firstAlert = await request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${token1}`)
      .send({ now: '2026-01-04T00:00:00.000Z' });
    expect(firstAlert.status).toBe(200);
    expect(firstAlert.body).toEqual({ alerted: true, recipients: [user2Id] });

    const duplicate = await request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${token1}`)
      .send({ now: '2026-01-04T00:00:00.000Z' });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ alerted: false, reason: 'ALREADY_ALERTED' });
  });
});
