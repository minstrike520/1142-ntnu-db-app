import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { parsePositiveInt } from '../utils/parsePositiveInt';
import { getRefreshTokenTtlMs } from './refreshTokenTtl';

export const AUTH_COOKIE_NAME = 'auth_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

const getRefreshCookieMaxAgeMs = (): number =>
  parsePositiveInt(process.env.REFRESH_COOKIE_MAX_AGE_MS, getRefreshTokenTtlMs());

export const setRefreshCookie = (c: Context, token: string): void => {
  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test',
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(getRefreshCookieMaxAgeMs() / 1000),
  });
};

export const clearRefreshCookie = (c: Context): void => {
  deleteCookie(c, REFRESH_COOKIE_NAME, {
    path: '/',
    secure: process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test',
  });
};

export const readCookie = (cookieHeader: string | undefined, name: string): string | undefined => {
  if (!cookieHeader) return undefined;

  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const [rawKey, ...rawValue] = pair.trim().split('=');
    if (rawKey === name && rawValue.length > 0) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return undefined;
};
