import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { AddressInfo } from 'net';
import { request } from '../../helpers/http';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { honoApp as app, server } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import type { ClientToServerEvents, ServerToClientEvents, Message } from '../../../../shared/types';
import type { AuthResponse, RoomResponse } from '../../helpers/responseTypes';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const waitForMessage = (socket: TestClient): Promise<Message> =>
  new Promise((resolve) => {
    socket.once('new_message', resolve);
  });

describe('Emergency alert Socket.IO E2E', () => {
  let url: string;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      if (server.listening) return resolve();
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(async () => {
    clients.forEach((socket) => socket.disconnect());
    clients = [];
    await resetDb();
  });

  afterAll(async () => {
    clients.forEach((socket) => {
      try { socket.disconnect(); } catch (e) {}
    });
    if (server.listening) {
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 300))
      ]);
    }
  });

  const connectClient = (token: string): Promise<TestClient> =>
    new Promise((resolve, reject) => {
      const socket: TestClient = createClient(url, {
        auth: { token },
        forceNew: true,
        transports: ['websocket'],
      });
      clients.push(socket);
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });

  it('sends real chat message to configured emergency contacts (private room)', async () => {
    const userRes = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Alert User',
      email: 'alert-user@example.com',
      password: 'Password123!',
    });
    const contactRes = await request(app).post<AuthResponse>('/api/v1/auth/register').send({
      name: 'Contact User',
      email: 'contact-user@example.com',
      password: 'Password123!',
    });

    // Become friends
    await request(app).post('/api/v1/friend-requests').set('Authorization', `Bearer ${userRes.body.token}`).send({
      target_user_id: contactRes.body.user.userId,
    });
    await request(app).patch(`/api/v1/friend-requests/${userRes.body.user.userId}`).set('Authorization', `Bearer ${contactRes.body.token}`).send({
      status: 'accepted',
    });

    // explicitly create private room
    const roomRes = await request(app)
      .post<RoomResponse>('/api/v1/rooms')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({ type: 'private', targetUserId: contactRes.body.user.userId });
    expect([200, 201]).toContain(roomRes.status);
    const privateRoomId = roomRes.body.roomId;

    // Set up emergency contact and enable warning settings
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({
        contactId: contactRes.body.user.userId,
        message: 'Please check on me',
      });

    await request(app)
      .patch('/api/v1/users/me/settings')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({
        warningEnabled: true,
        warningDays: 1,
      });

    const contactSocket = await connectClient(contactRes.body.token);
    
    // Room subscriptions are derived from the contact's durable membership.

    const messagePayload = waitForMessage(contactSocket);

    const triggerRes = await request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({ now: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() });

    expect(triggerRes.status).toBe(200);
    
    const received = await messagePayload;
    expect(received.content).toBe('Please check on me');
    expect(received.senderId).toBe(userRes.body.user.userId);
    expect(received.roomId).toBe(privateRoomId);
  });

});
