import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { makeAuthController } from '../../../src/controllers/authController';
import { ValidationError } from '../../../src/errors/AppError';
import type { Request, Response, NextFunction } from 'express';

const mockRes = () => {
  const res = { status: mock(), json: mock(), send: mock(), cookie: mock(), clearCookie: mock() } as any;
  res.status.mockReturnValue(res);
  return res;
};

describe('authController', () => {
  const authResult = { token: 'tok', refreshToken: 'fake-refresh-token', user: { userId: 'u1', email: 'alice@example.com', name: 'Alice' } };
  const service = { register: mock(), login: mock(), refresh: mock(), revokeToken: mock() };
  const ctrl = makeAuthController(service);

  beforeEach(() => {
    mock.restore();
    mock.clearAllMocks();
  });

  describe('register', () => {
    it('returns 201 on valid input', async () => {
      service.register.mockResolvedValue(authResult);
      const req = { body: { email: 'alice@example.com', name: 'Alice', password: 'password123' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.register(req, res, next);

      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'fake-refresh-token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.json).toHaveBeenCalledWith({
        token: 'tok',
        user: authResult.user
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError on invalid body', async () => {
      const req = { body: { email: 'not-an-email', name: 'Alice', password: 'short' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.register(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('calls next with error when service throws', async () => {
      const err = new Error('conflict');
      service.register.mockRejectedValue(err);
      const req = { body: { email: 'alice@example.com', name: 'Alice', password: 'password123' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.register(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('login', () => {
    it('returns 200 on valid input', async () => {
      service.login.mockResolvedValue(authResult);
      const req = { body: { email: 'alice@example.com', password: 'password123' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.login(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'fake-refresh-token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.json).toHaveBeenCalledWith({
        token: 'tok',
        user: authResult.user
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next with ValidationError on missing fields', async () => {
      const req = { body: {} } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.login(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
    });

    it('calls next with error when service throws', async () => {
      const err = new Error('unauthorized');
      service.login.mockRejectedValue(err);
      const req = { body: { email: 'alice@example.com', password: 'password123' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.login(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('logout', () => {
    it('returns 204', async () => {
      const req = { headers: { cookie: 'refresh_token=fake-refresh-token' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.logout(req, res, next);

      expect(service.revokeToken).toHaveBeenCalledWith('fake-refresh-token');
      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('skips revokeToken but still clears cookie and sends 204 when no cookie is present', async () => {
      const req = { headers: {} } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.logout(req, res, next);

      expect(service.revokeToken).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.status).toHaveBeenCalledWith(204);
      expect(res.send).toHaveBeenCalled();
    });

    it('calls next with error when revokeToken throws', async () => {
      const err = new Error('revoke failed');
      service.revokeToken.mockRejectedValue(err);
      const req = { headers: { cookie: 'refresh_token=some-token' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.logout(req, res, next);

      expect(next).toHaveBeenCalledWith(err);
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('returns 200 and a new access token on valid refresh token', async () => {
      service.refresh.mockResolvedValue({
        token: 'new-tok',
        refreshToken: 'new-fake-refresh-token',
        user: authResult.user
      });
      const req = { headers: { cookie: 'refresh_token=old-refresh-token' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.refresh(req, res, next);

      expect(service.refresh).toHaveBeenCalledWith('old-refresh-token');
      expect(res.cookie).toHaveBeenCalledWith(
        'refresh_token',
        'new-fake-refresh-token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        token: 'new-tok',
        user: authResult.user
      });
    });

    it('calls next with ValidationError when cookie is missing', async () => {
      const req = { headers: {} } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.refresh(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
      expect(res.status).not.toHaveBeenCalled();
    });

    it('clears cookie and calls next when the token is rejected', async () => {
      const err = new ValidationError('invalid token');
      service.refresh.mockRejectedValue(err);
      const req = { headers: { cookie: 'refresh_token=bad-token' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.refresh(req, res, next);

      expect(res.clearCookie).toHaveBeenCalledWith(
        'refresh_token',
        expect.objectContaining({ httpOnly: true, secure: false, sameSite: 'strict' }),
      );
      expect(next).toHaveBeenCalledWith(err);
    });

    it('keeps the cookie when the service throws an unexpected error', async () => {
      const err = new Error('database unavailable');
      service.refresh.mockRejectedValue(err);
      const req = { headers: { cookie: 'refresh_token=valid-token' } } as Request;
      const res = mockRes();
      const next = mock();

      await ctrl.refresh(req, res, next);

      expect(res.clearCookie).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledWith(err);
    });
  });
});
