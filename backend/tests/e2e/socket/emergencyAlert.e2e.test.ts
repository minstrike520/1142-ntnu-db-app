import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { AddressInfo } from 'net';
import request from 'supertest';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { app, server } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import type { ClientToServerEvents, ServerToClientEvents, Message } from '../../../../shared/types';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const waitFor = <T>(socket: TestClient, event: keyof ServerToClientEvents): Promise<T> =>
  new Promise((resolve) => {
    socket.once(event, (payload: any) => resolve(payload as T));
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
    const userRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Alert User',
      email: 'alert-user@example.com',
      password: 'Password123!',
    });
    const contactRes = await request(app).post('/api/v1/auth/register').send({
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
      .post('/api/v1/rooms')
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
    
    // Have the contact socket join the room to receive new_message event
    contactSocket.emit('join_room', { roomId: privateRoomId });
    await new Promise((res) => setTimeout(res, 100));
    
    const messagePayload = waitFor<Message>(
      contactSocket,
      'new_message',
    );

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

  /**
   * Registers two users, makes them friends, opens their private room and
   * configures the first as an inactive user alerting the second.
   */
  const setUpAlertPair = async (suffix: string, message = 'Please check on me') => {
    const userRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Alert User',
      email: `alert-user-${suffix}@example.com`,
      password: 'Password123!',
    });
    const contactRes = await request(app).post('/api/v1/auth/register').send({
      name: 'Contact User',
      email: `contact-user-${suffix}@example.com`,
      password: 'Password123!',
    });

    await request(app)
      .post('/api/v1/friend-requests')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({ target_user_id: contactRes.body.user.userId });
    await request(app)
      .patch(`/api/v1/friend-requests/${userRes.body.user.userId}`)
      .set('Authorization', `Bearer ${contactRes.body.token}`)
      .send({ status: 'accepted' });

    const roomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({ type: 'private', targetUserId: contactRes.body.user.userId });
    expect([200, 201]).toContain(roomRes.status);

    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({ contactId: contactRes.body.user.userId, message });

    await request(app)
      .patch('/api/v1/users/me/settings')
      .set('Authorization', `Bearer ${userRes.body.token}`)
      .send({ warningEnabled: true, warningDays: 1 });

    return {
      user: userRes.body.user,
      userToken: userRes.body.token as string,
      contact: contactRes.body.user,
      contactToken: contactRes.body.token as string,
      roomId: roomRes.body.roomId as string,
    };
  };

  const triggerAlert = (token: string) =>
    request(app)
      .post('/api/v1/users/me/emergency-alert/check-inactivity')
      .set('Authorization', `Bearer ${token}`)
      .send({ now: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString() });

  const listMessages = (token: string, roomId: string) =>
    request(app).get(`/api/v1/rooms/${roomId}/messages`).set('Authorization', `Bearer ${token}`);

  it('leaves the alert readable through normal history for a contact that was offline', async () => {
    const ctx = await setUpAlertPair('offline', 'Offline contact alert');

    // No socket is connected for the contact at any point during the trigger.
    const triggerRes = await triggerAlert(ctx.userToken);
    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.alerted).toBe(true);
    expect(triggerRes.body.recipients).toEqual([ctx.contact.userId]);
    expect(triggerRes.body.failedRecipients).toBeUndefined();

    // The contact "reconnects" and reads the room through the ordinary path.
    const history = await listMessages(ctx.contactToken, ctx.roomId);
    expect(history.status).toBe(200);
    const contents = (history.body as any[]).map((m) => m.content);
    expect(contents).toContain('Offline contact alert');
  });

  it('reports an undeliverable alert instead of emitting a transient event', async () => {
    const ctx = await setUpAlertPair('blocked', 'Blocked contact alert');

    // Blocking marks the shared private room read-only, so the durable write
    // cannot succeed. This used to fall back to a fire-and-forget
    // `emergency_alert` event that nothing recorded.
    await request(app)
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${ctx.contactToken}`)
      .send({ targetUserId: ctx.user.userId });

    const contactSocket = await connectClient(ctx.contactToken);
    contactSocket.emit('join_room', { roomId: ctx.roomId });
    await new Promise((res) => setTimeout(res, 100));

    const events: string[] = [];
    contactSocket.onAny((event: string) => events.push(event));

    const triggerRes = await triggerAlert(ctx.userToken);
    expect(triggerRes.status).toBe(200);
    expect(triggerRes.body.alerted).toBe(false);
    expect(triggerRes.body.reason).toBe('DELIVERY_FAILED');
    expect(triggerRes.body.failedRecipients).toEqual([ctx.contact.userId]);

    await new Promise((res) => setTimeout(res, 300));
    expect(events).not.toContain('emergency_alert');
    expect(events).not.toContain('new_message');

    const history = await listMessages(ctx.contactToken, ctx.roomId);
    const contents = (history.body as any[]).map((m) => m.content);
    expect(contents).not.toContain('Blocked contact alert');
  });

  it('stores exactly one alert when the same window is checked twice', async () => {
    const ctx = await setUpAlertPair('duplicate', 'Duplicate guard alert');

    const first = await triggerAlert(ctx.userToken);
    expect(first.body.alerted).toBe(true);

    const second = await triggerAlert(ctx.userToken);
    expect(second.body).toEqual({ alerted: false, recipients: [], reason: 'ALREADY_ALERTED' });

    const history = await listMessages(ctx.contactToken, ctx.roomId);
    const matching = (history.body as any[]).filter((m) => m.content === 'Duplicate guard alert');
    expect(matching).toHaveLength(1);
  });

  it('retries a window in which nothing was ever attempted', async () => {
    const ctx = await setUpAlertPair('retry', 'Retry alert');

    await request(app)
      .delete(`/api/v1/users/me/emergency-contacts/${ctx.contact.userId}`)
      .set('Authorization', `Bearer ${ctx.userToken}`);

    const noContacts = await triggerAlert(ctx.userToken);
    expect(noContacts.body).toEqual({ alerted: false, recipients: [], reason: 'NO_CONTACTS' });

    // The dedupe marker must have been given back: the user has now configured
    // a contact and the same inactivity window has to be alertable.
    await request(app)
      .post('/api/v1/users/me/emergency-contacts')
      .set('Authorization', `Bearer ${ctx.userToken}`)
      .send({ contactId: ctx.contact.userId, message: 'Retry alert' });

    const retried = await triggerAlert(ctx.userToken);
    expect(retried.body.alerted).toBe(true);
    expect(retried.body.recipients).toEqual([ctx.contact.userId]);

    const history = await listMessages(ctx.contactToken, ctx.roomId);
    const matching = (history.body as any[]).filter((m) => m.content === 'Retry alert');
    expect(matching).toHaveLength(1);
  });
});
