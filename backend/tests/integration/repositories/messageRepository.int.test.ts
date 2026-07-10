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


import { MessageRepository } from '../../../src/repositories/messageRepository';
import { testPool } from '../../helpers/testPool';
import { resetDb } from '../../helpers/resetDb';

describe('MessageRepository (pg)', () => {
  const repo = new MessageRepository(testPool);

  beforeEach(async () => {
    await resetDb();
  });

  async function createUser(email: string) {
    const res = await testPool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING user_id',
      ['Message Tester', email, 'hash'],
    );
    return res.rows[0].user_id as string;
  }

  async function createRoom() {
    const res = await testPool.query(
      'INSERT INTO chat_rooms (type, name) VALUES ($1, $2) RETURNING room_id',
      ['group', 'Message Repo Room'],
    );
    return res.rows[0].room_id as string;
  }

  it('create -> findById -> findByRoom returns camelCase messages in reverse-chronological order', async () => {
    const userId = await createUser('message-user@test.com');
    const roomId = await createRoom();

    const first = await repo.create({
      roomId,
      senderId: userId,
      content: 'first message',
    });
    const second = await repo.create({
      roomId,
      senderId: userId,
      content: 'second message',
      replyToId: first.messageId,
    });

    expect(first.messageId).toBeDefined();
    expect(first.roomId).toBe(roomId);
    expect(first.senderId).toBe(userId);
    expect(first.sender).toEqual({
      userId,
      name: 'Message Tester',
      avatarUrl: undefined,
    });
    expect(first.replyToId).toBeUndefined();
    expect(first.isRecalled).toBe(false);
    expect(first.sentAt).toBeInstanceOf(Date);

    const fetched = await repo.findById(second.messageId);
    expect(fetched).toMatchObject({
      messageId: second.messageId,
      roomId,
      senderId: userId,
      content: 'second message',
    });
    expect(fetched?.replyToId).toBe(first.messageId);

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages.map((message) => message.messageId)).toEqual([
      second.messageId,
      first.messageId,
    ]);
    expect(messages[0].sender).toEqual({
      userId,
      name: 'Message Tester',
      avatarUrl: undefined,
    });
  });

  it('findByRoom respects beforeId and limit', async () => {
    const userId = await createUser('pagination-user@test.com');
    const roomId = await createRoom();

    const first = await repo.create({ roomId, senderId: userId, content: 'one' });
    const second = await repo.create({ roomId, senderId: userId, content: 'two' });
    await repo.create({ roomId, senderId: userId, content: 'three' });

    const beforeSecond = await repo.findByRoom(roomId, {
      beforeId: second.messageId,
      limit: 5,
    });
    expect(beforeSecond.map((message) => message.messageId)).toEqual([first.messageId]);

    const limited = await repo.findByRoom(roomId, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].content).toBe('three');
    expect(limited[1].content).toBe('two');
  });

  it('create stores mentions and reads them back with messages', async () => {
    const senderId = await createUser('mention-sender@test.com');
    const mentionedId = await createUser('mentioned-user@test.com');
    const roomId = await createRoom();

    const created = await repo.create({
      roomId,
      senderId,
      content: 'hello @Message Tester',
      mentions: [mentionedId],
    });

    expect(created.mentions).toEqual([mentionedId]);

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages[0].mentions).toEqual([mentionedId]);
  });

  it('create binds unassigned attachments once and returns attachment objects', async () => {
    const senderId = await createUser('attachment-sender@test.com');
    const roomId = await createRoom();
    const attachmentRes = await testPool.query(
      `INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
       VALUES ($1, $2, $3, $4)
       RETURNING attachment_id`,
      [senderId, 'uploads/test.txt', 'text/plain', 'test.txt'],
    );
    const attachmentId = attachmentRes.rows[0].attachment_id as string;

    const created = await repo.create({
      roomId,
      senderId,
      content: 'message with attachment',
      attachmentIds: [attachmentId],
    });

    expect(created.attachments).toEqual([
      expect.objectContaining({
        attachmentId,
        messageId: created.messageId,
        uploadedBy: senderId,
        fileUrl: `/api/v1/attachments/${attachmentId}`,
        fileType: 'text/plain',
        originalName: 'test.txt',
      }),
    ]);

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages[0].attachments).toEqual([
      expect.objectContaining({
        attachmentId,
        messageId: created.messageId,
        originalName: 'test.txt',
      }),
    ]);

    await expect(repo.create({
      roomId,
      senderId,
      content: 'try reusing attachment',
      attachmentIds: [attachmentId],
    })).rejects.toThrow('Attachments must exist and must not already belong to a message');
  });

  it('markRecalled sets isRecalled and findById returns null for missing messages', async () => {
    const userId = await createUser('recall-user@test.com');
    const roomId = await createRoom();

    const message = await repo.create({ roomId, senderId: userId, content: 'recall me' });
    const recalled = await repo.markRecalled(message.messageId);

    expect(recalled.messageId).toBe(message.messageId);
    expect(recalled.isRecalled).toBe(true);
    expect(recalled.sender).toEqual({
      userId,
      name: 'Message Tester',
      avatarUrl: undefined,
    });
    await expect(repo.markRecalled('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      'Message not found',
    );

    const missing = await repo.findById('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeNull();
  });

  it('markRecalled hides attachments from the recalled message and future fetches', async () => {
    const senderId = await createUser('recall-attachment-sender@test.com');
    const roomId = await createRoom();
    const attachmentRes = await testPool.query(
      `INSERT INTO attachments (uploaded_by, file_path, file_type, original_name)
       VALUES ($1, $2, $3, $4)
       RETURNING attachment_id`,
      [senderId, 'uploads/recall-test.txt', 'text/plain', 'recall-test.txt'],
    );
    const attachmentId = attachmentRes.rows[0].attachment_id as string;

    const created = await repo.create({
      roomId,
      senderId,
      content: 'recall me with an attachment',
      attachmentIds: [attachmentId],
    });
    expect(created.attachments).toHaveLength(1);

    const recalled = await repo.markRecalled(created.messageId);
    expect(recalled.isRecalled).toBe(true);
    expect(recalled.attachments).toBeUndefined();

    const messages = await repo.findByRoom(roomId, { limit: 10 });
    expect(messages[0].isRecalled).toBe(true);
    expect(messages[0].attachments).toBeUndefined();
  });
});
