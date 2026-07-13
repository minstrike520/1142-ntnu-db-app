import rateLimit, { type Options } from 'express-rate-limit';
import helmet from 'helmet';
import type { RequestHandler } from 'express';
import { parsePositiveInt } from '../utils/parsePositiveInt';
import { AppError } from '../errors/AppError';

const rateLimitDisabled = (): boolean =>
  process.env.NODE_ENV === 'test' || process.env.RATE_LIMIT_DISABLED === 'true';

const defaultSecurityHeaders = helmet();
const avatarSecurityHeaders = helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

export const testOnlyMiddleware: RequestHandler = (_req, _res, next) => {
  if (process.env.NODE_ENV !== 'test') {
    return next(new AppError(404, 'Not Found', 'NOT_FOUND'));
  }
  next();
};

export const securityHeaders: RequestHandler = (req, res, next) => {
  if (req.path === '/uploads/avatars' || req.path.startsWith('/uploads/avatars/')) {
    avatarSecurityHeaders(req, res, next);
    return;
  }
  defaultSecurityHeaders(req, res, next);
};

export const makeGlobalRateLimiter = (overrides: Partial<Options> = {}) =>
  rateLimit({
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.RATE_LIMIT_MAX, 1000),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: () => rateLimitDisabled(),
    message: { message: 'Too many requests, please try again later' },
    ...overrides,
  });

export const makeAuthRateLimiter = (overrides: Partial<Options> = {}) =>
  rateLimit({
    windowMs: parsePositiveInt(process.env.AUTH_RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    limit: parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, 10),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    skip: () => rateLimitDisabled(),
    message: { message: 'Too many authentication attempts, please try again later' },
    ...overrides,
  });
