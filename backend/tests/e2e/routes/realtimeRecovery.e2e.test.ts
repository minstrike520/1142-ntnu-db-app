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

    await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${first.body.messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '1')
      .set('Idempotency-Key', 'create-followup-edit')
      .send({ content: 'changed later' });
    const createRetryAfterLaterEdit = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'create-command-1')
      .send({ content: 'still the original command' });
    expect(createRetryAfterLaterEdit.body.content).toBe('durable');
    expect(createRetryAfterLaterEdit.body.revision).toBe(1);
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

  it('keeps edit, recall, and read-position commands idempotent', async () => {
    const created = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'create-command-3')
      .send({ content: 'command target' });
    const messageId = created.body.messageId;

    const edited = await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '1')
      .set('Idempotency-Key', 'edit-command-3')
      .send({ content: 'edited once' });
    const editRetry = await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '1')
      .set('Idempotency-Key', 'edit-command-3')
      .send({ content: 'different retry body' });
    expect(edited.status).toBe(200);
    expect(editRetry.status).toBe(200);
    expect(editRetry.body.messageId).toBe(messageId);
    expect(editRetry.body.content).toBe('edited once');
    expect(editRetry.body.revision).toBe(2);

    const laterEdit = await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '2')
      .set('Idempotency-Key', 'edit-command-3-later')
      .send({ content: 'edited later' });
    const editRetryAfterLaterEdit = await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '1')
      .set('Idempotency-Key', 'edit-command-3')
      .send({ content: 'different retry body again' });
    expect(laterEdit.body.content).toBe('edited later');
    expect(editRetryAfterLaterEdit.body.content).toBe('edited once');
    expect(editRetryAfterLaterEdit.body.revision).toBe(2);

    const recalled = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages/${messageId}/recall`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '3')
      .set('Idempotency-Key', 'recall-command-3');
    const recallRetry = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages/${messageId}/recall`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', '3')
      .set('Idempotency-Key', 'recall-command-3');
    expect(recalled.status).toBe(200);
    expect(recallRetry.status).toBe(200);
    expect(recallRetry.body.isRecalled).toBe(true);
    expect(recallRetry.body.revision).toBe(4);

    const read = await request(app)
      .put(`/api/v1/rooms/${roomId}/read-position`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'read-command-3')
      .send({ messageId });
    const readRetry = await request(app)
      .put(`/api/v1/rooms/${roomId}/read-position`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'read-command-3')
      .send({ messageId });
    expect(read.status).toBe(200);
    expect(readRetry.status).toBe(200);
    expect(readRetry.body.readPosition).toBe(read.body.readPosition);
  });

  it('keeps a no-op recall key out of the create and edit namespaces', async () => {
    const created = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'noop-target-create')
      .send({ content: 'recall me' });
    const messageId = created.body.messageId;

    const firstRecall = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages/${messageId}/recall`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', String(created.body.revision))
      .set('Idempotency-Key', 'noop-recall-first');
    expect(firstRecall.status).toBe(200);

    // A second recall under a *different* key. The message is already recalled,
    // so nothing is committed and no Message Change is published — but the key
    // is spent all the same.
    const secondRecall = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages/${messageId}/recall`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', String(firstRecall.body.revision))
      .set('Idempotency-Key', 'noop-recall-second');
    expect(secondRecall.status).toBe(200);
    expect(secondRecall.body.isRecalled).toBe(true);
    expect(secondRecall.body.revision).toBe(firstRecall.body.revision);

    // Replaying it stays a success and still reports the same message.
    const secondRecallRetry = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages/${messageId}/recall`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', String(firstRecall.body.revision))
      .set('Idempotency-Key', 'noop-recall-second');
    expect(secondRecallRetry.status).toBe(200);
    expect(secondRecallRetry.body.messageId).toBe(messageId);
    expect(secondRecallRetry.body.isRecalled).toBe(true);

    // Create, edit and recall share one idempotency namespace, so the spent key
    // must not be usable for another operation.
    const reusedForCreate = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'noop-recall-second')
      .send({ content: 'should not be created' });
    expect(reusedForCreate.status).toBe(409);

    const other = await request(app)
      .post(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', 'noop-other-create')
      .send({ content: 'edit me' });
    const reusedForEdit = await request(app)
      .patch(`/api/v1/rooms/${roomId}/messages/${other.body.messageId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('If-Match', String(other.body.revision))
      .set('Idempotency-Key', 'noop-recall-second')
      .send({ content: 'should not be edited' });
    expect(reusedForEdit.status).toBe(409);

    const listed = await request(app)
      .get(`/api/v1/rooms/${roomId}/messages`)
      .set('Authorization', `Bearer ${token}`);
    expect(listed.body.map((message: { messageId: string }) => message.messageId).sort())
      .toEqual([messageId, other.body.messageId].sort());
  });
});
