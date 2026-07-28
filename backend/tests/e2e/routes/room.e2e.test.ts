import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import request from 'supertest';
import { resetDb } from '../../helpers/resetDb';

let app: any;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

describe('Room E2E', () => {
  let token: string;
  let userId: string;
  let otherToken: string;
  let otherUserId: string;
  let thirdToken: string;

  beforeEach(async () => {
    await resetDb();
    const res = await request(app).post('/api/v1/auth/register').send({
      name: 'User',
      email: 'user@example.com',
      password: 'Password123!',
    });
    token = res.body.token;
    userId = res.body.user.userId;

    const otherRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Other User',
      email: 'other@example.com',
      password: 'Password123!',
    });
    otherToken = otherRes.body.token;
    otherUserId = otherRes.body.user.userId;

    const thirdRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Third User',
      email: 'third@example.com',
      password: 'Password123!',
    });
    thirdToken = thirdRes.body.token;
  });

  const makeFriends = async () => {
    await request(app)
      .post('/api/v1/friend-requests')
      .set('Authorization', `Bearer ${token}`)
      .send({ target_user_id: otherUserId });

    await request(app)
      .patch(`/api/v1/friend-requests/${userId}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ status: 'accepted' });
  };

  it('should create a room', async () => {
    const res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Test Room',
      });
    expect(res.status).toBe(201);
    expect(res.body.roomId).toBeDefined();
    expect(res.body.type).toBe('group');
    expect(res.body.name).toBe('Test Room');
  });

  it('should reject creating a group without a name', async () => {
    // `type` defaults to 'group', so both of these would otherwise persist a
    // room with name = NULL.
    for (const payload of [{}, { type: 'group' }]) {
      const res = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${token}`)
        .send(payload);

      expect(res.status).toBe(400);
    }

    const list = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.length).toBe(0);
  });

  it('should list rooms', async () => {
    await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Test Room 1',
      });

    const res = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('Test Room 1');
    expect(res.body[0].unreadCount).toBeDefined();
  });

  it('should create a group with avatar and generated invite code, then join by code', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Invite Room',
        avatarUrl: 'https://example.com/group.png',
      });

    expect(createRes.status).toBe(201);
    expect(createRes.body.avatarUrl).toBe('https://example.com/group.png');
    expect(createRes.body.inviteCode).toEqual(expect.any(String));

    const joinRes = await request(app)
      .post(`/api/v1/rooms/${createRes.body.roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode: createRes.body.inviteCode });

    expect(joinRes.status).toBe(200);
    expect(joinRes.body.roomId).toBe(createRes.body.roomId);
  });

  it('should create an idempotent private room for accepted friends', async () => {
    await makeFriends();

    const first = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'private', target_user_id: otherUserId });
    const second = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'private', target_user_id: otherUserId });

    expect(first.status).toBe(201); // created on first POST
    expect(first.body.type).toBe('private');
    expect(first.body.roomHash).toBeUndefined();
    expect(second.status).toBe(200);
    expect(second.body.roomId).toBe(first.body.roomId);
    expect(second.body.roomHash).toBeUndefined();

    const ownerRooms = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${token}`);
    const otherRooms = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${otherToken}`);
    expect(ownerRooms.body.some((room: { roomId: string }) => room.roomId === first.body.roomId)).toBe(true);
    expect(otherRooms.body.some((room: { roomId: string }) => room.roomId === first.body.roomId)).toBe(true);

    const outsider = await request(app)
      .get(`/api/v1/rooms/${first.body.roomId}`)
      .set('Authorization', `Bearer ${thirdToken}`);
    expect(outsider.status).toBe(403);
  });

  it('should reject private room creation when users are blocked', async () => {
    await makeFriends();

    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({ target_user_id: otherUserId });

    const res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'private', target_user_id: otherUserId });

    expect(res.status).toBe(403);
  });

  it('should permanently delete a group room for the owner', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Delete Me',
      });

    await request(app)
      .post(`/api/v1/rooms/${createRes.body.roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode: createRes.body.inviteCode });

    const deleteRes = await request(app)
      .delete(`/api/v1/rooms/${createRes.body.roomId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(deleteRes.status).toBe(204);

    const ownerRooms = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`);
    const memberRooms = await request(app)
      .get('/api/v1/rooms')
      .set('Authorization', `Bearer ${otherToken}`);

    expect(ownerRooms.body.some((room: { roomId: string }) => room.roomId === createRes.body.roomId)).toBe(false);
    expect(memberRooms.body.some((room: { roomId: string }) => room.roomId === createRes.body.roomId)).toBe(false);

    const fetchDeleted = await request(app)
      .get(`/api/v1/rooms/${createRes.body.roomId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(fetchDeleted.status).toBe(404);
  });

  it('should upload group avatar successfully by owner', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Avatar E2E Room',
      });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.roomId;

    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploadRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/avatar`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, 'avatar.png');

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.avatarUrl).toContain('/uploads/avatars/');

    // Clean up uploaded file
    const fs = await import('fs/promises');
    const path = await import('path');
    const filename = path.basename(uploadRes.body.avatarUrl);
    const filepath = path.resolve(process.cwd(), 'uploads/avatars', filename);
    await fs.unlink(filepath).catch(() => {});
  });

  it('should reject avatar upload by non-admin member', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Avatar Reject Room',
      });
    const roomId = createRes.body.roomId;

    await request(app)
      .post(`/api/v1/rooms/${roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode: createRes.body.inviteCode });

    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const uploadRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/avatar`)
      .set('Authorization', `Bearer ${otherToken}`)
      .attach('file', buffer, 'avatar.png');

    expect(uploadRes.status).toBe(403);
  });
});
