import type { Hono } from 'hono';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { request } from '../../helpers/http';
import { resetDb } from '../../helpers/resetDb';
import type { AuthResponse, RoomResponse, RoomMemberResponse } from '../../helpers/responseTypes';
import { testPool } from '../../helpers/testPool';

let app: Hono;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.honoApp;
});

describe('Room Members E2E', () => {
  let ownerToken: string;
  let adminToken: string;
  let memberToken: string;
  let pendingToken: string;
  
  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let pendingId: string;
  
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    
    // Register owner
    let res = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Owner', email: 'owner@example.com', password: 'Password123!',
    });
    ownerToken = res.body.token;
    ownerId = res.body.user.userId;

    // Register admin
    res = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Admin', email: 'admin@example.com', password: 'Password123!',
    });
    adminToken = res.body.token;
    adminId = res.body.user.userId;

    // Register member
    res = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Member', email: 'member@example.com', password: 'Password123!',
    });
    memberToken = res.body.token;
    memberId = res.body.user.userId;
    
    // Register pending
    res = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Pending', email: 'pending@example.com', password: 'Password123!',
    });
    pendingToken = res.body.token;
    pendingId = res.body.user.userId;

    // Create room
    const roomRes = await request(app)
      .post<RoomResponse>('/api/v1/rooms')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ type: 'group', name: 'Test Room', requireApproval: true });
    roomId = roomRes.body.roomId;

    const adminRole = 'admin';
    const memberRole = 'member';
    const pendingRole = 'pending';
    await testPool`INSERT INTO room_members (room_id, user_id, role) VALUES (${roomId}, ${adminId}, ${adminRole})`;
    await testPool`INSERT INTO room_members (room_id, user_id, role) VALUES (${roomId}, ${memberId}, ${memberRole})`;
    await testPool`INSERT INTO room_members (room_id, user_id, role) VALUES (${roomId}, ${pendingId}, ${pendingRole})`;
  });

  describe('POST /rooms/:id/members/:userId/approve', () => {
    it('should allow owner to approve pending member', async () => {
      const res = await request(app)
        .post(`/api/v1/rooms/${roomId}/members/${pendingId}/approve`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('should allow admin to approve pending member', async () => {
      const res = await request(app)
        .post(`/api/v1/rooms/${roomId}/members/${pendingId}/approve`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    it('should not allow regular member to approve pending member', async () => {
      const res = await request(app)
        .post(`/api/v1/rooms/${roomId}/members/${pendingId}/approve`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /rooms/:id/members', () => {
    it('should list room members for an existing member', async () => {
      const res = await request(app)
        .get<RoomMemberResponse[]>(`/api/v1/rooms/${roomId}/members`)
        .set('Authorization', `Bearer ${memberToken}`);

      expect(res.status).toBe(200);
      expect(res.body.map((member: { userId: string; role: string }) => [member.userId, member.role]))
        .toEqual(expect.arrayContaining([
          [ownerId, 'owner'],
          [adminId, 'admin'],
          [memberId, 'member'],
          [pendingId, 'pending'],
        ]));
    });

    it('should reject non-members', async () => {
      const outsider = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
        name: 'Outsider', email: 'outsider@example.com', password: 'Password123!',
      });

      const res = await request(app)
        .get<RoomMemberResponse[]>(`/api/v1/rooms/${roomId}/members`)
        .set('Authorization', `Bearer ${outsider.body.token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /rooms/:id/members/:userId', () => {
    it('should allow owner to change role of member', async () => {
      const res = await request(app)
        .patch(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: 'admin' });
      expect(res.status).toBe(200);
    });

    it('should not allow admin to change role', async () => {
      const res = await request(app)
        .patch(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ role: 'admin' });
      expect(res.status).toBe(403);
    });
    
    it('should allow admin to mute member', async () => {
      const res = await request(app)
        .patch(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ isMuted: true });
      expect(res.status).toBe(200);
    });
  });

  describe('DELETE /rooms/:id/members/:userId', () => {
    it('should allow owner to kick admin', async () => {
      const res = await request(app)
        .delete(`/api/v1/rooms/${roomId}/members/${adminId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(204);
    });

    it('should allow admin to kick member', async () => {
      const res = await request(app)
        .delete(`/api/v1/rooms/${roomId}/members/${memberId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(204);
    });

    it('should not allow admin to kick owner', async () => {
      const res = await request(app)
        .delete(`/api/v1/rooms/${roomId}/members/${ownerId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('PATCH /rooms/:id (ownership transfer)', () => {
    const rolesOf = async () => {
      const rows = await testPool`
        SELECT user_id, role FROM room_members WHERE room_id = ${roomId}
      `;
      return Object.fromEntries(rows.map((row: { user_id: string; role: string }) => [row.user_id, row.role]));
    };

    it('should transfer ownership from owner to admin', async () => {
      const res = await request(app)
        .patch<{ message: string; name?: string }>(`/api/v1/rooms/${roomId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ ownerId: adminId });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Ownership transferred');

      const roles = await rolesOf();
      expect(roles[adminId]).toBe('owner');
      expect(roles[ownerId]).toBe('admin');
    });

    it('should not allow a non-owner to transfer ownership', async () => {
      const res = await request(app)
        .patch<{ message: string; name?: string }>(`/api/v1/rooms/${roomId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ ownerId: memberId });

      expect(res.status).toBe(403);
      expect((await rolesOf())[ownerId]).toBe('owner');
    });

    it('should reject transferring ownership to a pending member', async () => {
      const res = await request(app)
        .patch<{ message: string; name?: string }>(`/api/v1/rooms/${roomId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ ownerId: pendingId });

      expect(res.status).toBe(400);
      expect((await rolesOf())[ownerId]).toBe('owner');
    });

    it('should still update room settings when no ownerId is sent', async () => {
      const res = await request(app)
        .patch<{ message: string; name?: string }>(`/api/v1/rooms/${roomId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Renamed Room' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Renamed Room');
      expect((await rolesOf())[ownerId]).toBe('owner');
    });
  });
});
