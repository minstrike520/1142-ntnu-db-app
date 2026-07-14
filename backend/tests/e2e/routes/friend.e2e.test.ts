import { describe, it, expect, beforeEach } from 'bun:test';
import request from 'supertest';
import { app } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

describe('Friendships & Blocks E2E', () => {
  let tokenA: string;
  let userA: { userId: string; name: string };
  let tokenB: string;
  let userB: { userId: string; name: string };
  let tokenC: string;
  let userC: { userId: string; name: string };

  beforeEach(async () => {
    await resetDb();

    // Create User A
    const resA = await request(app).post('/api/v1/auth/register').send({
      name: 'User A',
      email: 'a@example.com',
      password: 'Password123!',
    });
    tokenA = resA.body.token;
    userA = resA.body.user;

    // Create User B
    const resB = await request(app).post('/api/v1/auth/register').send({
      name: 'User B',
      email: 'b@example.com',
      password: 'Password123!',
    });
    tokenB = resB.body.token;
    userB = resB.body.user;

    // Create User C
    const resC = await request(app).post('/api/v1/auth/register').send({
      name: 'User C',
      email: 'c@example.com',
      password: 'Password123!',
    });
    tokenC = resC.body.token;
    userC = resC.body.user;
  });

  describe('Friendships', () => {
    it('should send a friend request successfully', async () => {
      const res = await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      expect(res.status).toBe(201);
      expect(res.body.status).toBe('pending');
    });

    it('should fail if sending a request to oneself', async () => {
      const res = await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userA.userId });

      expect(res.status).toBe(400);
    });

    it('should list pending friend requests', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      const res = await request(app)
        .get('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].requesterId).toBe(userA.userId);
    });

    it('should accept a friend request', async () => {
      // A sends request to B
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      // B accepts
      const res = await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('accepted');

      // Check friends list for B
      const listRes = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenB}`);
      
      expect(listRes.status).toBe(200);
      expect(listRes.body.length).toBe(1);
      expect(listRes.body[0].friend.userId).toBe(userA.userId);

      // accepting the request does NOT auto-create the private room anymore
      const roomsBeforeOpen = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${tokenA}`);
      expect(roomsBeforeOpen.body.some((room: { type: string }) => room.type === 'private')).toBe(false);

      const openRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(openRoom.status).toBe(201); // created for the first time

      const roomsB = await request(app).get('/api/v1/rooms').set('Authorization', `Bearer ${tokenB}`);
      const privateRoomB = roomsB.body.find((room: { type: string }) => room.type === 'private');
      expect(privateRoomB?.roomId).toBe(openRoom.body.roomId);
    });

    it('should mark the private room read-only when friendship is removed', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      const privateRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(privateRoom.status).toBe(201); // created for the first time

      const deleteRes = await request(app)
        .delete(`/api/v1/friends/${userB.userId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(deleteRes.status).toBe(204);

      const row = await testPool.query('SELECT is_readonly FROM chat_rooms WHERE room_id = $1', [privateRoom.body.roomId]);
      expect(row.rows[0].is_readonly).toBe(true);
    });
    it('should reject a friend request and not affect accepted friendships', async () => {
      // C sends request to B
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenC}`)
        .send({ target_user_id: userB.userId });

      // B accepts C
      await request(app)
        .patch(`/api/v1/friend-requests/${userC.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      // A sends request to B
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      // B rejects A
      const res = await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'rejected' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');

      // Check friends list for B, C should still be there
      const listRes = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenB}`);
      
      expect(listRes.status).toBe(200);
      expect(listRes.body.length).toBe(1);
      expect(listRes.body[0].friend.userId).toBe(userC.userId);
    });
  });

  describe('Blocks', () => {
    it('should block a user', async () => {
      const res = await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      expect(res.status).toBe(201);
    });

    it('should not allow sending a friend request to a blocked user', async () => {
      // A blocks C
      await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      // C tries to friend A
      const res = await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenC}`)
        .send({ target_user_id: userA.userId });

      expect(res.status).toBe(403);
    });

    it('should mark existing private room read-only when blocking a friend', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      const privateRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(privateRoom.status).toBe(201); // created for the first time

      const blockRes = await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      expect(blockRes.status).toBe(201);
      const row = await testPool.query('SELECT is_readonly FROM chat_rooms WHERE room_id = $1', [privateRoom.body.roomId]);
      expect(row.rows[0].is_readonly).toBe(true);
    });

    it('should restore the friendship after unblocking a blocked friend', async () => {
      await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      const privateRoom = await request(app)
        .post('/api/v1/rooms')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ type: 'private', targetUserId: userB.userId });
      expect(privateRoom.status).toBe(201);

      const blockRes = await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });
      expect(blockRes.status).toBe(201);

      const blockedFriends = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(blockedFriends.status).toBe(200);
      expect(blockedFriends.body).toEqual([]);

      const unblockRes = await request(app)
        .delete(`/api/v1/blocks/${userB.userId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(unblockRes.status).toBe(204);

      const restoredFriends = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenA}`);
      expect(restoredFriends.status).toBe(200);
      expect(restoredFriends.body).toHaveLength(1);
      expect(restoredFriends.body[0].friend.userId).toBe(userB.userId);

      const row = await testPool.query('SELECT is_readonly FROM chat_rooms WHERE room_id = $1', [privateRoom.body.roomId]);
      expect(row.rows[0].is_readonly).toBe(false);
    });

    it('should list blocked users', async () => {
      // A blocks C (done in earlier test, but tests might not be perfectly isolated, let's block C if not blocked or use B)
      await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      const listRes = await request(app)
        .get('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(listRes.status).toBe(200);
      expect(Array.isArray(listRes.body)).toBe(true);
      expect(listRes.body.length).toBeGreaterThan(0);
      expect(listRes.body[0]).toHaveProperty('userId');
      expect(listRes.body[0]).toHaveProperty('name');
      expect(listRes.body[0]).toHaveProperty('email');
    });
  });
});
