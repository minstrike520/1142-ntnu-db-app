import { describe, it, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import type { Context } from 'hono';
import { authMiddleware } from '../../../src/middlewares/authMiddleware';
import * as jwtHelper from '../../../src/utils/jwt';
import { AppError } from '../../../src/utils/AppError';
import pool from '../../../src/models/db';

mock.module('../../../src/models/db', () => ({
  default: { query: mock() },
}));

const makeHonoContext = (headersRecord: Record<string, string> = {}) => {
  const vars = new Map<string, any>();
  return {
    req: {
      header: (name: string) => headersRecord[name.toLowerCase()],
    },
    set: (key: string, val: any) => {
      vars.set(key, val);
    },
    get: (key: string) => vars.get(key),
  } as unknown as Context;
};

describe('authMiddleware', () => {
  let nextFunction: any;

  beforeEach(() => {
    nextFunction = mock();
    ((pool.query as any) as Mock<any>).mockResolvedValue({ rows: [{}] } as any);
  });

  afterEach(() => {
    mock.restore();
    mock.clearAllMocks();
  });

  it('throws 401 when auth token is missing', async () => {
    const c = makeHonoContext();
    expect(authMiddleware(c, nextFunction)).rejects.toThrow('Missing authentication token');
  });

  it('throws 401 when Authorization header is malformed and no cookie exists', async () => {
    const c = makeHonoContext({ authorization: 'Basic sometoken' });
    expect(authMiddleware(c, nextFunction)).rejects.toThrow('Missing authentication token');
  });

  it('throws 401 when token is invalid', async () => {
    const c = makeHonoContext({ authorization: 'Bearer invalid-token' });
    spyOn(jwtHelper, 'verifyToken').mockImplementation(() => {
      throw new Error('Invalid token');
    });

    expect(authMiddleware(c, nextFunction)).rejects.toThrow('Invalid token');
  });

  it('calls next() and populates c.get("user") when token is valid and user is active', async () => {
    const c = makeHonoContext({ authorization: 'Bearer valid-token' });
    const mockPayload = { userId: '1', name: 'Test User' };
    
    spyOn(jwtHelper, 'verifyToken').mockReturnValue(mockPayload as any);

    await authMiddleware(c, nextFunction);

    expect(c.get('user')).toEqual(mockPayload);
    expect(nextFunction).toHaveBeenCalledTimes(1);
  });

  it('prefers the HttpOnly auth cookie token when present', async () => {
    const c = makeHonoContext({
      authorization: 'Bearer header-token',
      cookie: 'theme=dark; auth_token=cookie-token',
    });
    const mockPayload = { userId: '1', name: 'Test User' };

    spyOn(jwtHelper, 'verifyToken').mockReturnValue(mockPayload as any);

    await authMiddleware(c, nextFunction);

    expect(jwtHelper.verifyToken).toHaveBeenCalledWith('cookie-token');
    expect(c.get('user')).toEqual(mockPayload);
    expect(nextFunction).toHaveBeenCalledTimes(1);
  });

  it('throws 401 when user is not found in the database', async () => {
    const c = makeHonoContext({ authorization: 'Bearer valid-token' });
    spyOn(jwtHelper, 'verifyToken').mockReturnValue({ userId: '1', name: 'Test User' } as any);
    ((pool.query as any) as Mock<any>).mockResolvedValueOnce({ rows: [] } as any);

    expect(authMiddleware(c, nextFunction)).rejects.toThrow(/not found or deleted/);
  });

  it('re-throws original AppError when verifyToken throws an AppError', async () => {
    const c = makeHonoContext({ authorization: 'Bearer valid-token' });
    const customErr = new AppError(403, 'Custom forbidden');
    spyOn(jwtHelper, 'verifyToken').mockImplementation(() => { throw customErr; });

    expect(authMiddleware(c, nextFunction)).rejects.toThrow(customErr);
  });
});
