import { describe, it, expect, mock, type Mock } from 'bun:test';
import type { Response } from 'express';
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  clearRefreshCookie,
  readCookie,
} from '../../../src/utils/cookies';

const makeRes = () =>
  ({ cookie: mock(), clearCookie: mock() }) as unknown as Response;

describe('cookies', () => {
  describe('setRefreshCookie', () => {
    it('sets the refresh cookie with httpOnly and strict sameSite', () => {
      const res = makeRes();
      setRefreshCookie(res, 'token-123');
      expect(res.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        'token-123',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: expect.any(Number),
        })
      );
    });

    it('defaults the cookie maxAge to the refresh token TTL', () => {
      const originalMaxAge = process.env.REFRESH_COOKIE_MAX_AGE_MS;
      const originalDays = process.env.JWT_REFRESH_EXPIRES_IN_DAYS;
      delete process.env.REFRESH_COOKIE_MAX_AGE_MS;
      process.env.JWT_REFRESH_EXPIRES_IN_DAYS = '14';
      try {
        const res = makeRes();
        setRefreshCookie(res, 'token-123');
        const options = (res.cookie as Mock<any>).mock.calls[0][2] as any;
        expect(options.maxAge).toBe(14 * 24 * 60 * 60 * 1000);
      } finally {
        if (originalMaxAge !== undefined) process.env.REFRESH_COOKIE_MAX_AGE_MS = originalMaxAge;
        if (originalDays !== undefined) {
          process.env.JWT_REFRESH_EXPIRES_IN_DAYS = originalDays;
        } else {
          delete process.env.JWT_REFRESH_EXPIRES_IN_DAYS;
        }
      }
    });
  });

  describe('clearRefreshCookie', () => {
    it('clears the refresh cookie with matching options', () => {
      const res = makeRes();
      clearRefreshCookie(res);
      expect(res.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.objectContaining({ httpOnly: true, sameSite: 'strict', path: '/' })
      );
    });
  });

  describe('readCookie', () => {
    it('returns undefined when the header is missing', () => {
      expect(readCookie(undefined, 'auth_token')).toBeUndefined();
    });

    it('reads a cookie value from the header', () => {
      expect(readCookie('auth_token=abc; other=1', 'auth_token')).toBe('abc');
    });

    it('preserves "=" characters inside the value', () => {
      expect(readCookie('auth_token=a=b=c', 'auth_token')).toBe('a=b=c');
    });

    it('decodes URI-encoded values', () => {
      expect(readCookie('auth_token=a%20b', 'auth_token')).toBe('a b');
    });

    it('returns undefined when the cookie is not present', () => {
      expect(readCookie('other=1; another=2', 'auth_token')).toBeUndefined();
    });

    it('returns undefined for a cookie with no value', () => {
      expect(readCookie('auth_token', 'auth_token')).toBeUndefined();
    });
  });
});
