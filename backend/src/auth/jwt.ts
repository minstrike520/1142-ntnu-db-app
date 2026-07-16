import { sign, verify } from 'hono/jwt';
import { createHash, randomBytes } from 'crypto';
import type { JwtPayload } from '@shared/types';

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is not defined in production environment.');
    }
    return 'default-dev-secret';
  }
  return secret;
};

export const signToken = async (payload: JwtPayload): Promise<string> => {
  const secret = getJwtSecret();
  // ponytail: Hono JWT requires 'exp' inside the payload as a UNIX timestamp in seconds
  const minutes = 15;
  const exp = Math.floor(Date.now() / 1000) + (minutes * 60);
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
