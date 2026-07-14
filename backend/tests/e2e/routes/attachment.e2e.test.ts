import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import request from 'supertest';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

let app: any;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

describe('Attachment E2E', () => {
  let token: string;
  let userId: string;
  let roomId: string;
  let messageId: string;

  beforeEach(async () => {
    await resetDb();
    const authRes = await request(app).post('/api/v1/auth/register').send({
      name: 'AttachmentUser',
      email: 'attach@example.com',
      password: 'Password123!',
    });
    token = authRes.body.token;
    userId = authRes.body.user.userId;

    const roomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Attachment Test Room',
      });
    roomId = roomRes.body.roomId;

    const msgRes = await testPool.query(
      "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'Hello attachment!') RETURNING message_id",
      [roomId, userId]
    );
    messageId = msgRes.rows[0].message_id;
  });

  afterAll(async () => {
    await testPool.end();
  });

  it('should upload an attachment successfully', async () => {
    const res = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('dummy file content'), 'test.txt');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('attachmentId');
    expect(res.body.fileUrl).toContain('/api/v1/attachments/');
    expect(res.body).toMatchObject({
      uploadedBy: userId,
      fileType: 'text/plain',
      originalName: 'test.txt',
    });
    expect(res.body.messageId).toBeUndefined();
    expect(res.body.uploadedAt).toBeDefined();
  });

  it('should download an uploaded attachment', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('dummy file content'), 'test.txt');

    const attachmentId = uploadRes.body.attachmentId;

    const getRes = await request(app)
      .get(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(200);
    expect(getRes.text || getRes.body.toString()).toBe('dummy file content');
    // Ensure content disposition or content type
    expect(getRes.headers['content-type']).toContain('application/octet-stream');
  });

  it('should return 404 for non-existent attachment', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const getRes = await request(app)
      .get(`/api/v1/attachments/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(404);
  });

  it('should return 404 for an attachment whose message has been recalled', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('dummy file content'), 'test.txt');

    const attachmentId = uploadRes.body.attachmentId;

    await testPool.query(
      'UPDATE attachments SET message_id = $1 WHERE attachment_id = $2',
      [messageId, attachmentId],
    );
    await testPool.query(
      'UPDATE messages SET is_recalled = true WHERE message_id = $1',
      [messageId],
    );

    const getRes = await request(app)
      .get(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(404);
  });
});
