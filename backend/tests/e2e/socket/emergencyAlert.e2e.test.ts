import { describe, it, test, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';

// Bun-compatibility helper for Vitest/Jest APIs
import { mock, spyOn, afterAll, expect as originalExpect, jest } from 'bun:test';
let mockedModules: any[] = [];
afterAll(() => {
  for (const m of mockedModules) {
    if (m && m.path) {
      mock.module(m.path, () => m.original);
    }
  }
  mockedModules = [];
});
function createVitestMockProxy(f: any) {
  const extensions = {
    mockResolvedValue(val: any) {
      f.mockImplementation(() => Promise.resolve(val));
      return proxy;
    },
    mockRejectedValue(val: any) {
      f.mockImplementation(() => Promise.reject(val));
      return proxy;
    },
    mockResolvedValueOnce(val: any) {
      if (typeof f.mockImplementationOnce === "function") {
        f.mockImplementationOnce(() => Promise.resolve(val));
      } else {
        f.mockImplementation(() => Promise.resolve(val));
      }
      return proxy;
    },
    mockRejectedValueOnce(val: any) {
      if (typeof f.mockImplementationOnce === "function") {
        f.mockImplementationOnce(() => Promise.reject(val));
      } else {
        f.mockImplementation(() => Promise.reject(val));
      }
      return proxy;
    },
    mockReset() {
      f.mockClear();
      f.mockImplementation(() => {});
      return proxy;
    }
  };
  const proxy = new Proxy(f, {
    get(target, prop, receiver) {
      if (prop === "__is_vitest_mock_proxy__") return true;
      if (prop === "__original_target__") return target;
      if (prop in extensions) return (extensions as any)[prop];
      const val = Reflect.get(target, prop);
      if (typeof val === "function") return val.bind(target);
      return val;
    },
    set(target, prop, value, receiver) {
      return Reflect.set(target, prop, value);
    }
  });
  return proxy;
}
const vi = {
  fn: (impl?: any) => createVitestMockProxy(mock(impl)),
  spyOn: (obj: any, method: string) => createVitestMockProxy(spyOn(obj, method as any)),
  mock: (path: string, factory?: any) => {
    let original: any = null;
    try {
      original = require(path);
    } catch (e) {}
    mockedModules.push({ path, original });
    return mock.module(path, factory || (() => ({})));
  },
  mocked: <T>(obj: T) => obj as any,
  restoreAllMocks: () => {
    jest.restoreAllMocks();
    for (const m of mockedModules) {
      if (m && m.path) {
        mock.module(m.path, () => m.original);
      }
    }
    mockedModules = [];
  },
  resetAllMocks: () => {
    jest.resetAllMocks();
  },
  clearAllMocks: () => {
    jest.clearAllMocks();
  },
  stubEnv: (name: string, value: string) => {
    if (!globalThis.__envStubs) globalThis.__envStubs = {};
    if (!(name in globalThis.__envStubs)) globalThis.__envStubs[name] = process.env[name];
    process.env[name] = value;
  },
  unstubAllEnvs: () => {
    if (globalThis.__envStubs) {
      for (const name in globalThis.__envStubs) {
        const val = globalThis.__envStubs[name];
        if (val === undefined) delete process.env[name];
        else process.env[name] = val;
      }
      globalThis.__envStubs = null;
    }
  },
  useFakeTimers: () => {
    globalThis.__activeIntervals = [];
    globalThis.__originalSetInterval = globalThis.setInterval;
    globalThis.__originalClearInterval = globalThis.clearInterval;
    globalThis.setInterval = (callback: any, delay?: number, ...args: any[]) => {
      const id = Math.random();
      globalThis.__activeIntervals.push({ callback: () => callback(...args), delay: delay || 0, id });
      return id as any;
    };
    globalThis.clearInterval = (id: any) => {
      globalThis.__activeIntervals = globalThis.__activeIntervals.filter((item: any) => item.id !== id);
    };
  },
  useRealTimers: () => {
    if (globalThis.__originalSetInterval) {
      globalThis.setInterval = globalThis.__originalSetInterval;
      globalThis.clearInterval = globalThis.__originalClearInterval;
    }
    globalThis.__activeIntervals = [];
  },
  advanceTimersByTime: (ms: number) => {
    if (globalThis.__activeIntervals) {
      for (const item of globalThis.__activeIntervals) {
        item.callback();
      }
    }
  },
  advanceTimersByTimeAsync: async (ms: number) => {
    if (globalThis.__activeIntervals) {
      const promises = globalThis.__activeIntervals.map((item: any) => item.callback());
      await Promise.all(promises);
    }
  },
  waitFor: async (callback: () => any, options?: { timeout?: number; interval?: number }) => {
    const timeout = options?.timeout || 5000;
    const interval = options?.interval || 50;
    const startTime = Date.now();
    while (true) {
      try {
        await callback();
        return;
      } catch (err) {
        if (Date.now() - startTime > timeout) {
          throw err;
        }
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }
  }
};
const expect = (actual: any) => {
  if (actual && typeof actual === 'function' && actual.__is_vitest_mock_proxy__) {
    actual = actual.__original_target__;
  }
  return originalExpect(actual);
};
Object.setPrototypeOf(expect, originalExpect);
Object.defineProperties(expect, Object.getOwnPropertyDescriptors(originalExpect));

import { AddressInfo } from 'net';
import request from 'supertest';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';

import { app, server } from '../../../src/index';
import { resetDb } from '../../helpers/resetDb';
import type { ClientToServerEvents, ServerToClientEvents, Room, Message } from '../../../../shared/types';

type TestClient = ClientSocket<ServerToClientEvents, ClientToServerEvents>;

const waitFor = <T>(socket: TestClient, event: keyof ServerToClientEvents): Promise<T> =>
  new Promise((resolve) => {
    socket.once(event, (payload) => resolve(payload as T));
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
});
