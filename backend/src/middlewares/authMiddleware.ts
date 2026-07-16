import type { MiddlewareHandler } from 'hono';
import type { Request, Response as ExpressResponse, NextFunction } from 'express';
import { verifyToken } from '../auth/jwt';
import { AUTH_COOKIE_NAME, readCookie } from '../auth/cookies';
import { AppError } from '../errors/AppError';
import pool from '../db';
import { UserRepository } from '../repositories/userRepository';
import type { JwtPayload } from '@shared/types';

// ponytail: Type-safety extension for Hono Context variables
declare module 'hono' {
  interface ContextVariableMap {
    user: JwtPayload;
  }
}

const getBearerToken = (authHeader: string | undefined): string | undefined => {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  return authHeader.split(' ')[1];
};

// ponytail: Clean separation of concerns using UserRepository instead of raw pool.query (Layer 4 decoupling)
export const authMiddleware = (async (cOrReq: any, nextOrRes: any, maybeNext?: any) => {
  const isExpress = typeof maybeNext === 'function';
  const userRepo = new UserRepository(pool);

  if (isExpress) {
    const req = cOrReq as Request;
    const res = nextOrRes as ExpressResponse;
    const next = maybeNext as NextFunction;

    const token = readCookie(req.headers.cookie, AUTH_COOKIE_NAME) ?? getBearerToken(req.headers.authorization);
    if (!token) {
      return next(new AppError(401, 'Unauthorized: Missing authentication token'));
    }

    try {
      const payload = await verifyToken(token);
      // ponytail: Replacing pool.query with Repository pattern call
      const user = await userRepo.findById(payload.userId);
      if (!user) {
        return next(new AppError(401, 'Unauthorized: Account not found or deleted'));
      }
      req.user = payload;
      next();
    } catch (error) {
      if (error instanceof AppError) {
        return next(error);
      }
      next(new AppError(401, 'Unauthorized: Invalid token'));
    }
  } else {
    // Hono Mode
    const c = cOrReq;
    const next = nextOrRes;
    
    const cookieHeader = c.req.header('cookie');
    const authHeader = c.req.header('authorization');
    
    const token = readCookie(cookieHeader, AUTH_COOKIE_NAME) ?? getBearerToken(authHeader);
    if (!token) {
      throw new AppError(401, 'Unauthorized: Missing authentication token');
    }

    try {
      const payload = await verifyToken(token);
      // ponytail: Replacing pool.query with Repository pattern call
      const user = await userRepo.findById(payload.userId);
      if (!user) {
        throw new AppError(401, 'Unauthorized: Account not found or deleted');
      }
      c.set('user', payload);
      await next();
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(401, 'Unauthorized: Invalid token');
    }
  }
}) as any;
