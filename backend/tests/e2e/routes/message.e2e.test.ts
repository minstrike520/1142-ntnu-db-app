import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import request from 'supertest';
import { app } from '../../../src/index';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('Message E2E', () => {
  let token: string;
  let userId: string;
  let roomId: string;

  beforeEach(async () => {
    await resetDb();

    // Register User
    const regRes = await request(app)
      .post('/api/v1/auth/register')
      .send({
        name: 'Message User',
        email: 'msguser@test.com',
        password: 'password123',
      });
    token = regRes.body.token;
    userId = regRes.body.user.userId;

    // Create Room
    const roomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Message Test Room',
      });
    roomId = roomRes.body.roomId;
  });

  it('should list messages for a room', async () => {
    const msgContent = 'Hello E2E!';
    await testPool`
      INSERT INTO messages (room_id, sender_id, content) VALUES (${roomId}, ${userId}, ${msgContent})
    `;

    const res = await request(app)
      .get(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`);
    
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].content).toBe('Hello E2E!');
  });

  it('should reject pending members when listing messages', async () => {
    const pendingRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Pending User',
      email: 'pending@example.com',
      password: 'Password123!',
    });

    const pendingUserId = pendingRes.body.user.userId;
    const pendingRole = 'pending';
    await testPool`
      INSERT INTO room_members (room_id, user_id, role) VALUES (${roomId}, ${pendingUserId}, ${pendingRole})
    `;

    const res = await request(app)
      .get(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${pendingRes.body.token}`);

    expect(res.status).toBe(403);
  });

  it('should hide pre-join messages when room viewHistory is false', async () => {
    const hiddenRoomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'No History Room',
        viewHistory: false,
      });
    const hiddenRoomId = hiddenRoomRes.body.roomId;

    const beforeContent = 'before join';
    const beforeTime = '2026-01-01T00:00:00.000Z';
    await testPool`
      INSERT INTO messages (room_id, sender_id, content, sent_at) VALUES (${hiddenRoomId}, ${userId}, ${beforeContent}, ${beforeTime})
    `;

    const newUserRes = await request(app).post('/api/v1/auth/register').send({
      name: 'New Member',
      email: 'new-member@example.com',
      password: 'Password123!',
    });

    const newUserId = newUserRes.body.user.userId;
    const memberRole = 'member';
    const joinTime = '2026-01-02T00:00:00.000Z';
    await testPool`
      INSERT INTO room_members (room_id, user_id, role, join_time) VALUES (${hiddenRoomId}, ${newUserId}, ${memberRole}, ${joinTime})
    `;

    const afterContent = 'after join';
    const afterTime = '2026-01-03T00:00:00.000Z';
    await testPool`
      INSERT INTO messages (room_id, sender_id, content, sent_at) VALUES (${hiddenRoomId}, ${userId}, ${afterContent}, ${afterTime})
    `;

    const res = await request(app)
      .get(`/api/v1/rooms/${hiddenRoomId}/messages`)
      .set('Authorization', `Bearer ${newUserRes.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].content).toBe('after join');
  });
});
