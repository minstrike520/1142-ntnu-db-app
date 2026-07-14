import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import request from 'supertest';
let app: any;
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

describe('Message E2E', () => {
  let token: string;
  let userId: string;
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    const authRes = await request(app).post('/api/v1/auth/register').send({
      name: 'User',
      email: 'user@example.com',
      password: 'Password123!',
    });
    token = authRes.body.token;
    userId = authRes.body.user.userId;

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
    // Insert a dummy message directly into DB for testing the GET endpoint
    // (since send_message is handled via Socket.IO, not HTTP)
    await testPool.query(
      "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'Hello E2E!')",
      [roomId, userId]
    );

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

    await testPool.query(
      "INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'pending')",
      [roomId, pendingRes.body.user.userId],
    );

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

    await testPool.query(
      "INSERT INTO messages (room_id, sender_id, content, sent_at) VALUES ($1, $2, 'before join', '2026-01-01T00:00:00.000Z')",
      [hiddenRoomId, userId],
    );

    const newUserRes = await request(app).post('/api/v1/auth/register').send({
      name: 'New Member',
      email: 'new-member@example.com',
      password: 'Password123!',
    });

    await testPool.query(
      "INSERT INTO room_members (room_id, user_id, role, join_time) VALUES ($1, $2, 'member', '2026-01-02T00:00:00.000Z')",
      [hiddenRoomId, newUserRes.body.user.userId],
    );
    await testPool.query(
      "INSERT INTO messages (room_id, sender_id, content, sent_at) VALUES ($1, $2, 'after join', '2026-01-03T00:00:00.000Z')",
      [hiddenRoomId, userId],
    );

    const res = await request(app)
      .get(`/api/v1/rooms/${hiddenRoomId}/messages`)
      .set('Authorization', `Bearer ${newUserRes.body.token}`);

    expect(res.status).toBe(200);
    expect(res.body.map((message: { content: string }) => message.content)).toEqual(['after join']);
  });
});
