import { describe, it, expect, beforeAll, beforeEach } from 'bun:test';
import request from 'supertest';
import sharp from 'sharp';
import { resetDb } from '../../helpers/resetDb';

let app: any;

// Avatar uploads are decoded and re-encoded to WebP server-side, so the
// fixture has to be a genuinely decodable image — a bare PNG magic-byte
// prefix passes the signature check but cannot be decoded.
const makeRealPngBuffer = () =>
  sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 120, g: 80, b: 40 } },
  })
    .png()
    .toBuffer();

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

  it('should preview a room by invite code without joining, then reflect membership after joining', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Preview Room',
        avatarUrl: 'https://example.com/group.png',
      });
    const inviteCode = createRes.body.inviteCode;

    const previewRes = await request(app)
      .get(`/api/v1/rooms/invite/${inviteCode}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(previewRes.status).toBe(200);
    expect(previewRes.body).toEqual({
      roomId: createRes.body.roomId,
      name: 'Preview Room',
      avatarUrl: 'https://example.com/group.png',
      requireApproval: false,
      isMember: false,
      isPending: false,
    });

    await request(app)
      .post(`/api/v1/rooms/${createRes.body.roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode });

    const previewAfterJoinRes = await request(app)
      .get(`/api/v1/rooms/invite/${inviteCode}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(previewAfterJoinRes.status).toBe(200);
    expect(previewAfterJoinRes.body.isMember).toBe(true);
  });

  it('should report isPending when previewing an approval-required group already requested', async () => {
    const createRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Approval Room',
        requireApproval: true,
      });
    const inviteCode = createRes.body.inviteCode;

    await request(app)
      .post(`/api/v1/rooms/${createRes.body.roomId}/members`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ inviteCode });

    const previewRes = await request(app)
      .get(`/api/v1/rooms/invite/${inviteCode}`)
      .set('Authorization', `Bearer ${otherToken}`);

    expect(previewRes.status).toBe(200);
    expect(previewRes.body.requireApproval).toBe(true);
    expect(previewRes.body.isMember).toBe(true);
    expect(previewRes.body.isPending).toBe(true);
    // This group was created without an avatar, so the optional field is omitted
    // from the payload rather than serialized as null (see api-documentation.md).
    expect(previewRes.body).not.toHaveProperty('avatarUrl');
  });

  it('should 404 when previewing an unknown invite code', async () => {
    const res = await request(app)
      .get('/api/v1/rooms/invite/DOESNOTEXIST')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
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

    const buffer = await makeRealPngBuffer();
    const uploadRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/avatar`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', buffer, 'avatar.png');

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.avatarUrl).toContain('/uploads/avatars/');
    // Stored avatars are always re-encoded to WebP regardless of upload format.
    expect(uploadRes.body.avatarUrl.endsWith('.webp')).toBe(true);

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

    // Use a genuinely valid image so the 403 can only come from the
    // permission check, never from image decoding failing first.
    const buffer = await makeRealPngBuffer();
    const uploadRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/avatar`)
      .set('Authorization', `Bearer ${otherToken}`)
      .attach('file', buffer, 'avatar.png');

    expect(uploadRes.status).toBe(403);
  });
});
