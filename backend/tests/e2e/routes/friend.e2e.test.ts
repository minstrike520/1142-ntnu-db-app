import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import request from 'supertest';
import { app } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

describe('Friend & Block E2E Integration Tests', () => {
  let tokenA: string;
  let userA: any;
  let tokenB: string;
  let userB: any;
  let tokenC: string;
  let userC: any;

  beforeEach(async () => {
    await resetDb();

    // Register User A
    const resA = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'User A', email: 'usera@test.com', password: 'password123' });
    tokenA = resA.body.token;
    userA = resA.body.user;

    // Register User B
    const resB = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'User B', email: 'userb@test.com', password: 'password123' });
    tokenB = resB.body.token;
    userB = resB.body.user;

    // Register User C
    const resC = await request(app)
      .post('/api/v1/auth/register')
      .send({ name: 'User C', email: 'userc@test.com', password: 'password123' });
    tokenC = resC.body.token;
    userC = resC.body.user;
  });

  describe('Friendships', () => {
    it('should send, list, accept, and get friends', async () => {
      // 1. A sends friend request to B
      const sendRes = await request(app)
        .post('/api/v1/friend-requests')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userB.userId });

      expect(sendRes.status).toBe(201);
      expect(sendRes.body.status).toBe('pending');
      expect(sendRes.body.requester?.userId ?? sendRes.body.requesterId).toBe(userA.userId);
      expect(sendRes.body.addressee?.userId ?? sendRes.body.addresseeId).toBe(userB.userId);

      // 2. B views pending requests
      const pendingRes = await request(app)
        .get('/api/v1/friend-requests/pending')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(pendingRes.status).toBe(200);
      expect(pendingRes.body.length).toBe(1);
      expect(pendingRes.body[0].requester.userId).toBe(userA.userId);

      // 3. B accepts friend request from A
      const acceptRes = await request(app)
        .patch(`/api/v1/friend-requests/${userA.userId}`)
        .set('Authorization', `Bearer ${tokenB}`)
        .send({ status: 'accepted' });

      expect(acceptRes.status).toBe(200);
      expect(acceptRes.body.status).toBe('accepted');

      // 4. A gets friends list (should include B)
      const friendsARes = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(friendsARes.status).toBe(200);
      expect(friendsARes.body.length).toBe(1);
      expect(friendsARes.body[0].friend.userId).toBe(userB.userId);

      // 5. B gets friends list (should include A)
      const friendsBRes = await request(app)
        .get('/api/v1/friends')
        .set('Authorization', `Bearer ${tokenB}`);

      expect(friendsBRes.status).toBe(200);
      expect(friendsBRes.body.length).toBe(1);
      expect(friendsBRes.body[0].friend.userId).toBe(userA.userId);
    });

    it('should delete a friend and mark existing private room read-only', async () => {
      // Setup accepted friendship
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

      // A deletes friend B
      const deleteRes = await request(app)
        .delete(`/api/v1/friends/${userB.userId}`)
        .set('Authorization', `Bearer ${tokenA}`);
      expect(deleteRes.status).toBe(204);

      const roomId = privateRoom.body.roomId;
      const row = await testPool`SELECT is_readonly FROM chat_rooms WHERE room_id = ${roomId}`;
      expect(row[0].is_readonly).toBe(true);
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
      const roomId = privateRoom.body.roomId;
      const row = await testPool`SELECT is_readonly FROM chat_rooms WHERE room_id = ${roomId}`;
      expect(row[0].is_readonly).toBe(true);
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

      const roomId = privateRoom.body.roomId;
      const row = await testPool`SELECT is_readonly FROM chat_rooms WHERE room_id = ${roomId}`;
      expect(row[0].is_readonly).toBe(false);
    });

    it('should list blocked users', async () => {
      await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      const res = await request(app)
        .get('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].blocked?.userId ?? res.body[0].blockedId).toBe(userC.userId);
    });

    it('should unblock a user', async () => {
      await request(app)
        .post('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`)
        .send({ target_user_id: userC.userId });

      const unblockRes = await request(app)
        .delete(`/api/v1/blocks/${userC.userId}`)
        .set('Authorization', `Bearer ${tokenA}`);

      expect(unblockRes.status).toBe(204);

      const listRes = await request(app)
        .get('/api/v1/blocks')
        .set('Authorization', `Bearer ${tokenA}`);

      expect(listRes.body.length).toBe(0);
    });
  });
});
