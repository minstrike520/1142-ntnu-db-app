import type { MiddlewareHandler } from 'hono';
import { secureHeaders as honoSecureHeaders } from 'hono/secure-headers';
import { rateLimiter as honoRateLimiter } from 'hono-rate-limiter';
import { parsePositiveInt } from '../utils/parsePositiveInt';
import { AppError } from '../utils/AppError';

const rateLimitDisabled = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === 'true';

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  const isAvatar = c.req.path === '/uploads/avatars' || c.req.path.startsWith('/uploads/avatars/');
  const headersMiddleware = honoSecureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"] },
    crossOriginResourcePolicy: isAvatar ? 'cross-origin' : 'same-origin',
  });
  return headersMiddleware(c, next);
};

export const makeGlobalRateLimiter = (overrides: any = {}): MiddlewareHandler => {
  return honoRateLimiter({
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.RATE_LIMIT_MAX, 1000),
    standardHeaders: 'draft-6',
    keyGenerator: (c) => c.req.header('x-forwarded-for') || 'unknown-ip',
    skip: () => rateLimitDisabled(),
    handler: () => {
      throw new AppError(429, 'Too many requests, please try again later', 'TOO_MANY_REQUESTS');
    },
    ...overrides,
  });
};

export const makeAuthRateLimiter = (overrides: any = {}): MiddlewareHandler => {
  return honoRateLimiter({
    windowMs: parsePositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 10),
    standardHeaders: 'draft-6',
    keyGenerator: (c) => c.req.header('x-forwarded-for') || 'unknown-ip',
    skip: () => rateLimitDisabled(),
    handler: () => {
      throw new AppError(429, 'Too many authentication attempts, please try again later', 'TOO_MANY_REQUESTS');
    },
    ...overrides,
  });
};
