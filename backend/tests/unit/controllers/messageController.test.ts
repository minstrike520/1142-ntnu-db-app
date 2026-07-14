import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { makeMessageController } from '../../../src/controllers/messageController';
import { ValidationError } from '../../../src/errors/AppError';
import type { Request, Response, NextFunction } from 'express';

const mockRes = () => {
  const res = { status: mock(), json: mock(), send: mock() } as any;
  res.status.mockReturnValue(res);
  return res;
};

const authedReq = (overrides: Partial<Request> = {}): any => ({
  body: {},
  params: { roomId: 'room-1' },
  query: {},
  user: { userId: 'user-1' },
  ...overrides,
});

describe('messageController', () => {
  const messages = [{ messageId: 'msg-1', content: 'Hello', sender: { userId: 'user-1', name: 'Alice' } }];
  const service = { listForRoom: mock() };
  const ctrl = makeMessageController(service);

  beforeEach(() => mock.clearAllMocks());

  describe('listForRoom', () => {
    it('returns 200 with messages using default limit', async () => {
      service.listForRoom.mockResolvedValue(messages);
      const res = mockRes();
      const next = mock();

      await ctrl.listForRoom(authedReq(), res, next);

      expect(service.listForRoom).toHaveBeenCalledWith('user-1', 'room-1', { beforeId: undefined, limit: 50 });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(messages);
      expect(next).not.toHaveBeenCalled();
    });

    it('passes before_id and limit to service', async () => {
      service.listForRoom.mockResolvedValue(messages);
      const res = mockRes();
      const next = mock();

      await ctrl.listForRoom(authedReq({ query: { before_id: 'msg-5', limit: '20' } }), res, next);

      expect(service.listForRoom).toHaveBeenCalledWith('user-1', 'room-1', { beforeId: 'msg-5', limit: 20 });
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('calls next with ValidationError when limit is not a number', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.listForRoom(authedReq({ query: { limit: 'abc' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError when limit is out of range', async () => {
      const res = mockRes();
      const next = mock();

      await ctrl.listForRoom(authedReq({ query: { limit: '200' } }), res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('calls next with error when service throws', async () => {
      const err = new Error('forbidden');
      service.listForRoom.mockRejectedValue(err);
      const res = mockRes();
      const next = mock();

      await ctrl.listForRoom(authedReq(), res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
