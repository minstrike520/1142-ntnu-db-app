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


import request from 'supertest';
let app: any;
import { resetDb } from '../../helpers/resetDb';
import { testPool } from '../../helpers/testPool';

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
  const indexModule = await import('../../../src/index');
  app = indexModule.app;
});

describe('Attachment E2E', () => {
  let token: string;
  let userId: string;
  let roomId: string;
  let messageId: string;

  beforeEach(async () => {
    await resetDb();
    const authRes = await request(app).post('/api/v1/auth/register').send({
      name: 'AttachmentUser',
      email: 'attach@example.com',
      password: 'Password123!',
    });
    token = authRes.body.token;
    userId = authRes.body.user.userId;

    const roomRes = await request(app)
      .post('/api/v1/rooms')
      .set('Authorization', `Bearer ${token}`)
      .send({
        type: 'group',
        name: 'Attachment Test Room',
      });
    roomId = roomRes.body.roomId;

    const msgRes = await testPool.query(
      "INSERT INTO messages (room_id, sender_id, content) VALUES ($1, $2, 'Hello attachment!') RETURNING message_id",
      [roomId, userId]
    );
    messageId = msgRes.rows[0].message_id;
  });

  afterAll(async () => {
    await testPool.end();
  });

  it('should upload an attachment successfully', async () => {
    const res = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('dummy file content'), 'test.txt');

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('attachmentId');
    expect(res.body.fileUrl).toContain('/api/v1/attachments/');
    expect(res.body).toMatchObject({
      uploadedBy: userId,
      fileType: 'text/plain',
      originalName: 'test.txt',
    });
    expect(res.body.messageId).toBeUndefined();
    expect(res.body.uploadedAt).toBeDefined();
  });

  it('should download an uploaded attachment', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('dummy file content'), 'test.txt');

    const attachmentId = uploadRes.body.attachmentId;

    const getRes = await request(app)
      .get(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(200);
    expect(getRes.text || getRes.body.toString()).toBe('dummy file content');
    // Ensure content disposition or content type
    expect(getRes.headers['content-type']).toContain('application/octet-stream');
  });

  it('should return 404 for non-existent attachment', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const getRes = await request(app)
      .get(`/api/v1/attachments/${fakeId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(404);
  });

  it('should return 404 for an attachment whose message has been recalled', async () => {
    const uploadRes = await request(app)
      .post('/api/v1/attachments')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('dummy file content'), 'test.txt');

    const attachmentId = uploadRes.body.attachmentId;

    await testPool.query(
      'UPDATE attachments SET message_id = $1 WHERE attachment_id = $2',
      [messageId, attachmentId],
    );
    await testPool.query(
      'UPDATE messages SET is_recalled = true WHERE message_id = $1',
      [messageId],
    );

    const getRes = await request(app)
      .get(`/api/v1/attachments/${attachmentId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(getRes.status).toBe(404);
  });
});
