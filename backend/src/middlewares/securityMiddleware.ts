import type { MiddlewareHandler } from 'hono';
import { cors as honoCors } from 'hono/cors';
import { secureHeaders as honoSecureHeaders } from 'hono/secure-headers';
import { rateLimiter as honoRateLimiter } from 'hono-rate-limiter';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { parsePositiveInt } from '../utils/parsePositiveInt';
import { AppError } from '../utils/AppError';

const rateLimitDisabled = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === 'true';

const expressDefaultSecurityHeaders = helmet();
const expressAvatarSecurityHeaders = helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

// ponytail: Dual-mode security headers supporting both Express (3-args) and Hono (2-args)
export const securityHeaders = (async (cOrReq: any, nextOrRes: any, maybeNext?: any) => {
  const isExpress = typeof maybeNext === 'function';

  if (isExpress) {
    const req = cOrReq;
    const res = nextOrRes;
    const next = maybeNext;
    if (req.path === '/uploads/avatars' || req.path.startsWith('/uploads/avatars/')) {
      expressAvatarSecurityHeaders(req, res, next);
      return;
    }
    expressDefaultSecurityHeaders(req, res, next);
  } else {
    // Hono Mode
    const c = cOrReq;
    const next = nextOrRes;
    const isAvatar = c.req.path === '/uploads/avatars' || c.req.path.startsWith('/uploads/avatars/');
    const headersMiddleware = honoSecureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'self'"] },
      crossOriginResourcePolicy: isAvatar ? 'cross-origin' : 'same-origin',
    });
    return headersMiddleware(c, next);
  }
}) as any;

// ponytail: Dual-mode Rate Limiters wrapping express-rate-limit and hono-rate-limiter
export const makeGlobalRateLimiter = (overrides: any = {}) => {
  const expressLimiter = rateLimit({
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.RATE_LIMIT_MAX, 1000),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => rateLimitDisabled(),
    message: { message: 'Too many requests, please try again later' },
    ...overrides,
  });

  const honoLimiter = honoRateLimiter({
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

  return ((cOrReq: any, nextOrRes: any, maybeNext?: any) => {
    const isExpress = typeof maybeNext === 'function';
    if (isExpress) {
      return expressLimiter(cOrReq, nextOrRes, maybeNext);
    } else {
      return honoLimiter(cOrReq, nextOrRes);
    }
  }) as any;
};

export const makeAuthRateLimiter = (overrides: any = {}) => {
  const expressLimiter = rateLimit({
    windowMs: parsePositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 10),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: () => rateLimitDisabled(),
    message: { message: 'Too many authentication attempts, please try again later' },
    ...overrides,
  });

  const honoLimiter = honoRateLimiter({
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

  return ((cOrReq: any, nextOrRes: any, maybeNext?: any) => {
    const isExpress = typeof maybeNext === 'function';
    if (isExpress) {
      return expressLimiter(cOrReq, nextOrRes, maybeNext);
    } else {
      return honoLimiter(cOrReq, nextOrRes);
    }
  }) as any;
};
