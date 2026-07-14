import { describe, it, expect, mock } from 'bun:test';
import { makeFriendController } from '../../../src/controllers/friendController';
import { ValidationError } from '../../../src/errors/AppError';
import type { Request } from 'express';

describe('friendController', () => {
  it('blockUser handles zod errors', async () => {
    const service = { blockUser: mock() };
    const ctrl = makeFriendController(service);
    const req = { user: { userId: 'u1' }, body: { target_user_id: 'invalid-uuid' } } as unknown as Request;
    const res = { status: mock().mockReturnThis(), json: mock() } as any;
    const next = mock();

    await ctrl.blockUser(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it('unblockUser works successfully', async () => {
    const service = { unblockUser: mock().mockResolvedValue(true) };
    const ctrl = makeFriendController(service);
    const req = { user: { userId: 'u1' }, params: { id: 'u2' } } as unknown as Request;
    const res = { status: mock().mockReturnThis(), send: mock() } as any;
    const next = mock();

    await ctrl.unblockUser(req, res, next);
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.send).toHaveBeenCalled();
  });
  
  it('unblockUser passes error to next', async () => {
    const err = new Error('fail');
    const service = { unblockUser: mock().mockRejectedValue(err) };
    const ctrl = makeFriendController(service);
    const req = { user: { userId: 'u1' }, params: { id: 'u2' } } as unknown as Request;
    const res = {} as any;
    const next = mock();

    await ctrl.unblockUser(req, res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
