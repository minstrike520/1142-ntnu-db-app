import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { env } from '../config/env';

export const AUTH_COOKIE_NAME = 'auth_token';
export const REFRESH_COOKIE_NAME = 'refresh_token';

export const setRefreshCookie = (c: Context, token: string): void => {
  const { refreshCookieMaxAgeMs, secureCookies } = env();

  setCookie(c, REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: secureCookies,
    sameSite: 'Strict',
    path: '/',
    maxAge: Math.floor(refreshCookieMaxAgeMs / 1000),
  });
};

export const clearRefreshCookie = (c: Context): void => {
  deleteCookie(c, REFRESH_COOKIE_NAME, {
    path: '/',
    secure: env().secureCookies,
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
