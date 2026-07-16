import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { signToken, verifyToken, generateRefreshToken, hashToken } from '../../../src/auth/jwt';
import type { JwtPayload } from '../../../../shared/types';

const payload: JwtPayload = { userId: 'u1', name: 'Alice' };

describe('jwt', () => {
  let originalJwtSecret: string | undefined;
  let originalNodeEnv: string | undefined;

  beforeEach(() => {
    originalJwtSecret = process.env.JWT_SECRET;
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.JWT_SECRET = originalJwtSecret;
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('signs and verifies a token with an explicit JWT_SECRET', async () => {
    process.env.JWT_SECRET = 'unit-test-secret';
    const token = await signToken(payload);
    const decoded = await verifyToken(token);
    expect(decoded.userId).toBe('u1');
  });

  it('falls back to the dev secret when JWT_SECRET is unset outside production', async () => {
    process.env.JWT_SECRET = '';
    process.env.NODE_ENV = 'test';
    const token = await signToken(payload);
    expect((await verifyToken(token)).userId).toBe('u1');
  });

  it('throws when JWT_SECRET is unset in production', async () => {
    process.env.JWT_SECRET = '';
    process.env.NODE_ENV = 'production';
    await expect(signToken(payload)).rejects.toThrow('JWT_SECRET is not defined');
  });

  it('rejects a token signed with a different secret', async () => {
    process.env.JWT_SECRET = 'secret-a';
    const token = await signToken(payload);
    process.env.JWT_SECRET = 'secret-b';
    await expect(verifyToken(token)).rejects.toThrow();
  });

  it('generateRefreshToken returns an 80-char hex string', () => {
    const token = generateRefreshToken();
    expect(token).toMatch(/^[0-9a-f]{80}$/);
  });

  it('hashToken returns a repeatable SHA-256 hex digest', () => {
    const hash = hashToken('some-token');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('same')).toBe(hashToken('same'));
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});
