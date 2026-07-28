import { describe, it, expect, beforeEach, afterAll, mock } from 'bun:test';
import { Hono } from 'hono';
import { makeBlockRoutes } from '../../../src/routes/friendRoutes';
import { errorHandler } from '../../../src/middlewares/errorHandler';
import { signToken } from '../../../src/utils/jwt';

const mockSqlFn: any = mock().mockResolvedValue([{ user_id: 'caller-id' }]);
mockSqlFn.unsafe = mock().mockResolvedValue([{}]);
mock.module('../../../src/models/db', () => ({ default: mockSqlFn }));

const CALLER_ID = '11111111-1111-4111-8111-111111111111';
const BLOCKED_USER = {
  userId: 'e4c08495-e224-4a67-b6dd-5958952d3d42',
  name: 'Blocked User',
  email: 'blocked@test.com',
  avatarUrl: '/uploads/avatars/blocked.png',
};

describe('GET /blocks', () => {
  let service: any;
  let token: string;

  const listBlocks = () => {
    const app = new Hono();
    app.onError(errorHandler);
    app.route('/blocks', makeBlockRoutes(service));
    return app.request('/blocks', { headers: { authorization: `Bearer ${token}` } });
  };

  beforeEach(async () => {
    token = await signToken({ userId: CALLER_ID, email: 'caller@test.com' } as any);
    service = { getBlockedUsers: mock().mockResolvedValue([BLOCKED_USER]) };
  });

  afterAll(() => {
    mock.restore();
  });

  it('returns the flat user array the service produced', async () => {
    const res = await listBlocks();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([BLOCKED_USER]);
    expect(service.getBlockedUsers).toHaveBeenCalledWith(CALLER_ID);
  });

  it('exposes userId on each entry rather than nesting it under `blocked`', async () => {
    const body = await (await listBlocks()).json() as any[];

    expect(body[0].userId).toBe(BLOCKED_USER.userId);
    expect(body[0].name).toBe(BLOCKED_USER.name);
    expect(body[0]).not.toHaveProperty('blocked');
  });

  it('returns an empty array when nothing is blocked', async () => {
    service.getBlockedUsers = mock().mockResolvedValue([]);

    const res = await listBlocks();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('tolerates a nullish service result', async () => {
    service.getBlockedUsers = mock().mockResolvedValue(null);

    const res = await listBlocks();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
