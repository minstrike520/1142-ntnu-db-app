import { afterEach, describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  REALTIME_SUBPROTOCOL,
  parseServerFrame,
  type RealtimeCommand,
  type RealtimeServerFrame,
} from '@shared/realtime';
import { Hono } from 'hono';
import { RealtimeCommandHandler } from '../../../src/realtime/commandHandler';
import { RealtimeManager } from '../../../src/realtime/manager';
import { RealtimeRepository } from '../../../src/models/realtimeRepository';
import { createRealtimeServer, type RealtimeServer } from '../../../src/realtime/server';
import { makeRealtimeService } from '../../../src/services/realtimeService';
import { WsTicketService } from '../../../src/realtime/wsTicket';
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

const servers: RealtimeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
});

const waitForFrame = (socket: WebSocket) => new Promise<string>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for WebSocket frame')), 1_000);
  socket.addEventListener('message', (event) => {
    clearTimeout(timeout);
    resolve(String(event.data));
  }, { once: true });
});

const waitForMatchingFrame = (
  socket: WebSocket,
  predicate: (frame: RealtimeServerFrame) => boolean,
) => new Promise<RealtimeServerFrame>((resolve, reject) => {
  const timeout = setTimeout(() => {
    socket.removeEventListener('message', listener);
    reject(new Error('Timed out waiting for matching WebSocket frame'));
  }, 2_000);
  const listener = (event: MessageEvent) => {
    const parsed = parseServerFrame(String(event.data));
    if (!parsed.success || !predicate(parsed.data)) return;
    clearTimeout(timeout);
    socket.removeEventListener('message', listener);
    resolve(parsed.data);
  };
  socket.addEventListener('message', listener);
});

const connect = (url: string, protocol = REALTIME_SUBPROTOCOL): WebSocket => {
  const BunWebSocket = WebSocket as unknown as new (
    target: string,
    options: Bun.WebSocketOptions,
  ) => WebSocket;
  return new BunWebSocket(url, {
    protocols: [protocol],
    headers: { Origin: 'http://localhost:3000' },
  });
};

describe('native WebSocket handshake', () => {
  test('accepts a valid ticket and rejects ticket replay', async () => {
    const tickets = new WsTicketService({ secret: 'test-secret' });
    const manager = new RealtimeManager();
    const app = new Hono();
    const server = createRealtimeServer({
      app,
      tickets,
      manager,
      allowedOrigins: ['http://localhost:3000'],
      handleCommand: async () => undefined,
      port: 0,
    });
    servers.push(server);
    const issued = await tickets.issue({
      userId: 'user-1',
      name: 'Alice',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const url = `ws://127.0.0.1:${server.port}/ws?ticket=${encodeURIComponent(issued.ticket)}`;

    const socket = connect(url);
    const framePromise = waitForFrame(socket);
    const frame = parseServerFrame(await framePromise);
    expect(frame.success).toBe(true);
    if (frame.success) {
      expect(frame.data).toMatchObject({
        version: PROTOCOL_VERSION,
        kind: 'event',
        type: 'session.ready',
      });
    }
    socket.close();

    const replay = connect(url);
    const close = await new Promise<CloseEvent>((resolve) => {
      replay.addEventListener('close', resolve, { once: true });
    });
    expect(close.code).not.toBe(1000);

    const mismatchTicket = await tickets.issue({
      userId: 'user-1',
      name: 'Alice',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const mismatch = connect(
      `ws://127.0.0.1:${server.port}/ws?ticket=${encodeURIComponent(mismatchTicket.ticket)}`,
      'near-chat.v0',
    );
    const mismatchClose = await new Promise<CloseEvent>((resolve) => {
      mismatch.addEventListener('close', resolve, { once: true });
    });
    expect(mismatchClose.code).not.toBe(1000);
  });

  test('commits, ACKs, and idempotently replays a message command through the real server', async () => {
    await resetDb();
    const users = await testPool`
      INSERT INTO users (name, email, password_hash)
      VALUES ('Alice', 'native-e2e-alice@test.com', 'hash')
      RETURNING user_id
    `;
    const userId = users[0].user_id as string;
    const rooms = await testPool`
      INSERT INTO chat_rooms (type, name)
      VALUES ('group', 'Native E2E Room')
      RETURNING room_id
    `;
    const roomId = rooms[0].room_id as string;
    await testPool`
      INSERT INTO room_members (room_id, user_id, role)
      VALUES (${roomId}, ${userId}, 'owner')
    `;

    const tickets = new WsTicketService({ secret: 'test-secret' });
    const manager = new RealtimeManager();
    const repository = new RealtimeRepository(testPool, { cursorSecret: 'cursor-test-secret' });
    const service = makeRealtimeService({ repository, publisher: manager });
    const commands = new RealtimeCommandHandler({
      manager,
      tickets,
      listAuthorizedRoomIds: (id) => repository.listAuthorizedRoomIds(id),
      service,
      log: () => undefined,
    });
    const server = createRealtimeServer({
      app: new Hono(),
      tickets,
      manager,
      allowedOrigins: ['http://localhost:3000'],
      handleCommand: (connectionId, frame) => commands.handle(connectionId, frame),
      port: 0,
    });
    servers.push(server);
    const issued = await tickets.issue({
      userId,
      name: 'Alice',
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const socket = connect(
      `ws://127.0.0.1:${server.port}/ws?ticket=${encodeURIComponent(issued.ticket)}`,
    );
    await waitForFrame(socket);

    const sync: RealtimeCommand = {
      version: PROTOCOL_VERSION,
      kind: 'command',
      id: 'sync-1',
      type: 'rooms.sync',
      streamId: 'control',
      reliable: true,
      payload: {},
    };
    const syncAck = waitForMatchingFrame(
      socket,
      (frame) => frame.kind === 'ack' && frame.correlationId === sync.id,
    );
    socket.send(JSON.stringify(sync));
    await syncAck;

    const send: RealtimeCommand = {
      version: PROTOCOL_VERSION,
      kind: 'command',
      id: 'message-command-1',
      type: 'message.send',
      streamId: `room:${roomId}`,
      reliable: true,
      payload: { roomId, content: 'native delivery' },
    };
    const firstAckPromise = waitForMatchingFrame(
      socket,
      (frame) => frame.kind === 'ack' && frame.correlationId === send.id,
    );
    socket.send(JSON.stringify(send));
    const firstAck = await firstAckPromise;
    expect(firstAck).toMatchObject({ kind: 'ack', payload: { replayed: false } });

    const replayAckPromise = waitForMatchingFrame(
      socket,
      (frame) => frame.kind === 'ack' && frame.correlationId === send.id,
    );
    socket.send(JSON.stringify(send));
    const replayAck = await replayAckPromise;
    expect(replayAck).toMatchObject({ kind: 'ack', payload: { replayed: true } });

    const rows = await testPool`
      SELECT content, revision::text AS revision FROM messages WHERE room_id = ${roomId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: 'native delivery', revision: expect.any(String) });
    socket.close();
  });
});
