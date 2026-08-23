import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Context } from 'hono';
import { type AdminChecker, makeAdminMiddleware } from '../../../src/middlewares/adminMiddleware';
import type { JwtPayload } from '@shared/types';

// No `mock.module` here on purpose — it is process-global within a tier and
// cannot be undone (see backend/tests/CLAUDE.md and issue #467). The middleware
// takes its collaborator as a parameter, so a plain object is enough.
const makeHonoContext = (authUser?: JwtPayload, path = '/api/v1/admin/health') => {
  const vars = new Map<string, unknown>();
  if (authUser) vars.set('user', authUser);
  return {
    req: { path },
    set: (key: string, val: unknown) => {
      vars.set(key, val);
    },
    get: (key: string) => vars.get(key),
  } as unknown as Context;
};

const adminUser: JwtPayload = { userId: 'admin-1', name: 'Admin' };
const plainUser: JwtPayload = { userId: 'user-1', name: 'Plain' };

describe('adminMiddleware', () => {
  let checker: AdminChecker & { isAdmin: ReturnType<typeof mock> };
  let nextFunction: ReturnType<typeof mock>;

  beforeEach(() => {
    checker = { isAdmin: mock().mockResolvedValue(false) };
    nextFunction = mock();
  });

  it('calls next() when the user row has is_admin = true', async () => {
    checker.isAdmin.mockResolvedValue(true);
    const c = makeHonoContext(adminUser);

    await makeAdminMiddleware(checker)(c, nextFunction);

    expect(checker.isAdmin).toHaveBeenCalledWith('admin-1');
    expect(nextFunction).toHaveBeenCalledTimes(1);
  });

  it('throws 403 when the user row has is_admin = false', async () => {
    checker.isAdmin.mockResolvedValue(false);
    const c = makeHonoContext(plainUser);

    const promise = makeAdminMiddleware(checker)(c, nextFunction);

    await expect(promise).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('throws 401 when authMiddleware did not run, rather than dereferencing undefined', async () => {
    const c = makeHonoContext(undefined);

    const promise = makeAdminMiddleware(checker)(c, nextFunction);

    await expect(promise).rejects.toMatchObject({ statusCode: 401 });
    expect(checker.isAdmin).not.toHaveBeenCalled();
    expect(nextFunction).not.toHaveBeenCalled();
  });

  it('fails closed when the account was deleted between auth and the admin check', async () => {
    // The repository reports a missing or soft-deleted row as false, never a throw.
    checker.isAdmin.mockResolvedValue(false);
    const c = makeHonoContext(adminUser);

    await expect(makeAdminMiddleware(checker)(c, nextFunction)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('does not leak whether the caller exists in the 403 message', async () => {
    const c = makeHonoContext(plainUser);

    await expect(makeAdminMiddleware(checker)(c, nextFunction)).rejects.toThrow('Forbidden');
  });

  it('re-reads the flag on every request so a revoked admin loses access immediately', async () => {
    const middleware = makeAdminMiddleware(checker);
    checker.isAdmin.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await middleware(makeHonoContext(adminUser), nextFunction);
    await expect(middleware(makeHonoContext(adminUser), nextFunction)).rejects.toMatchObject({
      statusCode: 403,
    });

    expect(checker.isAdmin).toHaveBeenCalledTimes(2);
    expect(nextFunction).toHaveBeenCalledTimes(1);
  });
});
