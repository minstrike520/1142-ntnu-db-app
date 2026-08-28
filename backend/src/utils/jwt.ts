import { sign, verify } from 'hono/jwt';
import { createHash, randomBytes } from 'crypto';
import type { JwtPayload } from '@shared/types';
import { DEV_JWT_SECRET, env } from '../config/env';

/**
 * The signing key.
 *
 * `assertStartupEnv()` already refuses to boot a production process without
 * `JWT_SECRET`, so this throw is the backstop for anything that reaches signing
 * without having gone through the entrypoint.
 */
const getJwtSecret = (): string => {
  const { jwtSecret, isProduction } = env();
  if (!jwtSecret) {
    if (isProduction) {
      throw new Error('JWT_SECRET is not defined in production environment.');
    }
    return DEV_JWT_SECRET;
  }
  return jwtSecret;
};

export const signToken = async (payload: JwtPayload): Promise<string> => {
  const secret = getJwtSecret();
  // ponytail: Hono JWT requires 'exp' inside the payload as a UNIX timestamp in seconds
  const exp = Math.floor(Date.now() / 1000) + env().accessTokenTtlSeconds;
  return await sign({ ...payload, exp }, secret, 'HS256');
};

export const verifyToken = async (token: string): Promise<JwtPayload> => {
  const secret = getJwtSecret();
  return await verify(token, secret, 'HS256') as unknown as JwtPayload;
};

export const generateRefreshToken = (): string => {
  return randomBytes(40).toString('hex');
};

export const hashToken = (token: string): string => {
  return createHash('sha256').update(token).digest('hex');
};
