import type { MiddlewareHandler } from 'hono';
import { verifyToken } from '../utils/jwt';
import { AUTH_COOKIE_NAME, readCookie } from '../utils/cookies';
import { AppError } from '../utils/AppError';
import pool from '../models/db';
import { UserRepository } from '../models/userRepository';
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

export const authMiddleware: MiddlewareHandler = async (c, next) => {
  const userRepo = new UserRepository(pool);
  const cookieHeader = c.req.header('cookie');
  const authHeader = c.req.header('authorization');

  const token = readCookie(cookieHeader, AUTH_COOKIE_NAME) ?? getBearerToken(authHeader);
  if (!token) {
    throw new AppError(401, 'Unauthorized: Missing authentication token');
  }

  try {
    const payload = await verifyToken(token);
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
};
