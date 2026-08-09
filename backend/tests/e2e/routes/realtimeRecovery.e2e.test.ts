import { describe, it, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { app } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';

describe('Realtime recovery REST contract', () => {
  let token: string;
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    const user = await request(app).post('/api/v1/auth/register').send({
      name: 'Recovery User',
      email: 'recovery@example.com',
      password: 'Password123!',
    });
    token = user.body.token;
    const room = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({ type: 'group', name: 'Recovery Room' });
    roomId = room.body.roomId;
  });

  it('applies one create command once and recovers its durable change', async () => {
    const first = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'create-command-1')
      .send({ content: 'durable' });
    const second = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'create-command-1')
      .send({ content: 'different retry body' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.messageId).toBe(first.body.messageId);
    expect(second.body.content).toBe('durable');
    expect(first.body.messageSequence).toBe(1);
    expect(first.body.changeSequence).toBe(1);
    expect(first.body.revision).toBe(1);

    const sync = await request(app)
      .get('/api/v1/sync?cursor=0&limit=100')
      .set('Authorization', `Bearer ${token}`);
    expect(sync.status).toBe(200);
    expect(sync.body.changes).toHaveLength(1);
    expect(sync.body.changes[0]).toMatchObject({
      changeSequence: 1,
      messageSequence: 1,
      revision: 1,
      changeType: 'created',
    });
  });

  it('rejects stale revisions and exposes the conflict as 409', async () => {
    const created = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'create-command-2')
      .send({ content: 'before edit' });

    const edited = await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${created.body.messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '1')
      .set('Idempotency-Key', 'edit-command-1')
      .send({ content: 'after edit' });
    expect(edited.status).toBe(200);
    expect(edited.body.revision).toBe(2);

    const stale = await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${created.body.messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '1')
      .set('Idempotency-Key', 'edit-command-2')
      .send({ content: 'stale edit' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('CONFLICT');
  });
});
