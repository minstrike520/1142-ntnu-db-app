import { describe, it, expect, beforeEach } from 'bun:test';
import { request } from '../../helpers/http';
import { honoApp as app } from '../../../src/index';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';
import type { AttachmentResponse, AuthResponse, RoomResponse } from '../../helpers/responseTypes';
import path from 'path';
import fs from 'fs/promises';

describe('Attachment E2E', () => {
  let userToken: string;
  let userId: string;
  let roomId: string;
  let messageId: string;

  beforeEach(async () => {
    await resetDb();

    const regRes = await request(app)
      .post<AuthResponse>('/api/v1/auth/register')
      .send({
        name: 'Attachment User',
        email: 'attachment@test.com',
        password: 'password123',
      });
    userToken = regRes.body.token;
    userId = regRes.body.user.userId;

    const roomRes = await request(app)
      .post<RoomResponse>('/api/v1/rooms')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        type: 'group',
        name: 'Attachment Test Room',
      });
    roomId = roomRes.body.roomId;

    const msgContent = 'Hello attachment!';
    const msgRes = await testPool`
      INSERT INTO messages (room_id, sender_id, content) VALUES (${roomId}, ${userId}, ${msgContent}) RETURNING message_id
    `;
    messageId = msgRes[0].message_id;
  });

  it('should upload an attachment successfully', async () => {
    const res = await request(app)
      .post<AttachmentResponse>('/api/v1/attachments')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('test file content'), 'test.txt');

    expect(res.status).toBe(201);
    expect(res.body.attachmentId).toBeDefined();
    expect(res.body.originalName).toBe('test.txt');
    expect(res.body.fileType).toBe('text/plain');
    expect(res.body.fileUrl).toBe(`/api/v1/attachments/${res.body.attachmentId}`);
  });

  it('should return 400 if no file is provided', async () => {
    const res = await request(app)
      .post<AttachmentResponse>('/api/v1/attachments')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(400);
  });

  it('should fetch metadata for an unassigned attachment uploaded by the user', async () => {
    const uploadRes = await request(app)
      .post<AttachmentResponse>('/api/v1/attachments')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('test metadata file'), 'meta.txt');

    const attachmentId = uploadRes.body.attachmentId;

    const getRes = await request(app)
      .get<AttachmentResponse>(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('Accept', 'application/json');

    expect(getRes.status).toBe(200);
    expect(getRes.body.attachmentId).toBe(attachmentId);
    expect(getRes.body.originalName).toBe('meta.txt');
  });

  it('should fetch metadata for an attachment linked to a room message if user is in that room', async () => {
    const uploadRes = await request(app)
      .post<AttachmentResponse>('/api/v1/attachments')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('room attachment content'), 'room_file.txt');

    const attachmentId = uploadRes.body.attachmentId;

    await testPool`
      UPDATE attachments SET message_id = ${messageId} WHERE attachment_id = ${attachmentId}
    `;

    const getRes = await request(app)
      .get<AttachmentResponse>(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${userToken}`)
      .set('Accept', 'application/json');

    expect(getRes.status).toBe(200);
    expect(getRes.body.attachmentId).toBe(attachmentId);
  });
});
