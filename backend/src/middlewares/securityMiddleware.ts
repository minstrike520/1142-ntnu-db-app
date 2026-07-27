import type { Context, MiddlewareHandler } from 'hono';
import { secureHeaders as honoSecureHeaders } from 'hono/secure-headers';
import { rateLimiter as honoRateLimiter } from 'hono-rate-limiter';
import { parsePositiveInt } from '../utils/parsePositiveInt';
import { getClientIp } from '../utils/clientIp';
import { AppError } from '../utils/AppError';

const rateLimitDisabled = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === 'true';

export const testOnlyMiddleware: MiddlewareHandler = async (c, next) => {
  if (process.env.NODE_ENV !== 'test') {
    throw new AppError(404, 'Not Found', 'NOT_FOUND');
  }
  await next();
};

/**
 * Bucket requests by the caller's real IP.
 *
 * A fixed fallback key (the previous `'unknown-ip'`) is not safe here: whenever
 * the peer address is unavailable, every such caller shares one bucket, so ten
 * auth attempts from anyone would lock out login for the entire service. An
 * unattributable request instead gets its own key — it goes unlimited rather
 * than taking everyone else down with it.
 */
export const rateLimitKeyGenerator = (c: Context): string =>
  getClientIp(c) ?? `unattributed:${crypto.randomUUID()}`;

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  const isAvatar = c.req.path === '/uploads/avatars' || c.req.path.startsWith('/uploads/avatars/');
  const headersMiddleware = honoSecureHeaders({
    contentSecurityPolicy: { defaultSrc: ["'self'"] },
    crossOriginResourcePolicy: isAvatar ? 'cross-origin' : 'same-origin',
  });
  return headersMiddleware(c, next);
};

export const makeGlobalRateLimiter = (overrides: Record<string, unknown> = {}): MiddlewareHandler => {
  return honoRateLimiter({
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.RATE_LIMIT_MAX, 1000),
    standardHeaders: 'draft-6',
    keyGenerator: rateLimitKeyGenerator,
    skip: () => rateLimitDisabled(),
    handler: () => {
      throw new AppError(429, 'Too many requests, please try again later', 'TOO_MANY_REQUESTS');
    },
    ...overrides,
  });
};

export const makeAuthRateLimiter = (overrides: Record<string, unknown> = {}): MiddlewareHandler => {
  return honoRateLimiter({
    windowMs: parsePositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 10),
    standardHeaders: 'draft-6',
    keyGenerator: rateLimitKeyGenerator,
    skipSuccessfulRequests: true,
    skip: () => rateLimitDisabled(),
    handler: () => {
      throw new AppError(429, 'Too many authentication attempts, please try again later', 'TOO_MANY_REQUESTS');
    },
    ...overrides,
  });
};
