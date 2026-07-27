import { describe, it, expect } from 'bun:test';
import type { Context } from 'hono';
import {
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  clearRefreshCookie,
  readCookie,
} from '../../../src/utils/cookies';

const makeHonoContext = () => {
  const resHeaders = new Headers();
  const reqHeaders = new Headers();
  return {
    header: (name: string, value: string, options?: any) => {
      resHeaders.append(name, value);
    },
    req: {
      raw: {
        headers: reqHeaders,
      },
    },
    res: { headers: resHeaders },
  } as unknown as Context;
};

describe('cookies', () => {
  describe('setRefreshCookie', () => {
    it('sets the refresh cookie with httpOnly and strict sameSite', () => {
      const c = makeHonoContext();
      setRefreshCookie(c, 'token-123');
      const setCookieHeader = c.res.headers.get('set-cookie') || '';
      expect(setCookieHeader).toContain('refresh_token=token-123');
      expect(setCookieHeader).toContain('HttpOnly');
      expect(setCookieHeader).toContain('SameSite=Strict');
    });

    it('defaults the cookie maxAge to the refresh token TTL', () => {
      const originalMaxAge = process.env.REFRESH_COOKIE_MAX_AGE_MS;
      const originalDays = process.env.JWT_REFRESH_EXPIRES_IN_DAYS;
      delete process.env.REFRESH_COOKIE_MAX_AGE_MS;
      process.env.JWT_REFRESH_EXPIRES_IN_DAYS = '14';
      try {
        const c = makeHonoContext();
        setRefreshCookie(c, 'token-123');
        const setCookieHeader = c.res.headers.get('set-cookie') || '';
        const expectedMaxAgeSec = 14 * 24 * 60 * 60;
        expect(setCookieHeader).toContain(`Max-Age=${expectedMaxAgeSec}`);
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
      const c = makeHonoContext();
      clearRefreshCookie(c);
      const setCookieHeader = c.res.headers.get('set-cookie') || '';
      expect(setCookieHeader).toContain('refresh_token=;');
      expect(setCookieHeader).toContain('Max-Age=0');
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
