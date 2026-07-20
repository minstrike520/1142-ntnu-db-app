import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import { resetDb } from '../../helpers/resetDb';

let app: any;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

describe('Room Task E2E', () => {
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;

  let ownerId: string;
  let adminId: string;
  let memberId: string;

  let roomId: string;

  beforeEach(async () => {
    await resetDb();

    let res = await request(app).post('/api/v1/auth/register').send({
      name: 'Owner', email: 'owner@example.com', password: 'Password123!',
    });
    ownerToken = res.body.token;
    ownerId = res.body.user.userId;

    res = await request(app).post('/api/v1/auth/register').send({
      name: 'Admin', email: 'admin@example.com', password: 'Password123!',
    });
    adminToken = res.body.token;
    adminId = res.body.user.userId;

    res = await request(app).post('/api/v1/auth/register').send({
      name: 'Member', email: 'member@example.com', password: 'Password123!',
    });
    memberToken = res.body.token;
    memberId = res.body.user.userId;

    res = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'group', name: 'Test Room' });
    roomId = res.body.roomId;

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });

    await pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [roomId, adminId, 'admin']);
    await pool.query('INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)', [roomId, memberId, 'member']);
  });

  it('should allow the owner to create a task with assignees', async () => {
    const res = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report', description: 'Q3 summary', assigneeUserIds: [memberId] });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Write report');
    expect(res.body.status).toBe('open');
    expect(res.body.creator.userId).toBe(ownerId);
    expect(res.body.assignees.map((a: { userId: string }) => a.userId)).toEqual([memberId]);
  });

  it('should reject a plain member creating a task', async () => {
    const res = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ title: 'Write report' });

    expect(res.status).toBe(403);
  });

  it('should reject assigning a non-member', async () => {
    const res = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report', assigneeUserIds: ['00000000-0000-0000-0000-000000000000'] });

    expect(res.status).toBe(400);
  });

  it('should list tasks for any room member', async () => {
    await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report' });

    const res = await request(app)
      .get(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${memberToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Write report');
  });

  it('should allow an assignee to mark a task done', async () => {
    const createRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report', assigneeUserIds: [memberId] });
    const taskId = createRes.body.taskId;

    const res = await request(app)
      .patch(`/api/v1/rooms/${roomId}/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('done');
  });

  it('should reject a bystander marking a task done', async () => {
    const createRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report' });
    const taskId = createRes.body.taskId;

    const res = await request(app)
      .patch(`/api/v1/rooms/${roomId}/tasks/${taskId}/status`)
      .set('Authorization', `Bearer ${memberToken}`)
      .send({ status: 'done' });

    expect(res.status).toBe(403);
  });

  it('should reject an admin deleting a task created by the owner', async () => {
    const createRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report' });
    const taskId = createRes.body.taskId;

    const res = await request(app)
      .delete(`/api/v1/rooms/${roomId}/tasks/${taskId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(403);
  });

  it('should allow the owner to delete a task', async () => {
    const createRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report' });
    const taskId = createRes.body.taskId;

    const deleteRes = await request(app)
      .delete(`/api/v1/rooms/${roomId}/tasks/${taskId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(deleteRes.status).toBe(204);

    const listRes = await request(app)
      .get(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(listRes.body).toHaveLength(0);
  });

  it('should allow the creator to edit their own task', async () => {
    const createRes = await request(app)
      .post(`/api/v1/rooms/${roomId}/tasks`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write report' });
    const taskId = createRes.body.taskId;

    const res = await request(app)
      .patch(`/api/v1/rooms/${roomId}/tasks/${taskId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ title: 'Write final report' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Write final report');
  });
});
