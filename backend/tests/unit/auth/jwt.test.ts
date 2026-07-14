import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { signToken, verifyToken, generateRefreshToken, hashToken } from '../../../src/auth/jwt';
import type { JwtPayload } from '@shared/types';

const payload: JwtPayload = { userId: 'u1', email: 'u1@test.example' } as JwtPayload;

describe('jwt', () => {
  let envBackup: NodeJS.ProcessEnv;

  beforeEach(() => {
    envBackup = { ...process.env };
  });

  afterEach(() => {
    process.env = envBackup;
  });

  it('signs and verifies a token with an explicit JWT_SECRET', () => {
    process.env.JWT_SECRET = 'unit-test-secret';
    const token = signToken(payload);
    const decoded = verifyToken(token);
    expect(decoded.userId).toBe('u1');
  });

  it('falls back to the dev secret when JWT_SECRET is unset outside production', () => {
    process.env.JWT_SECRET = '';
    process.env.NODE_ENV = 'test';
    const token = signToken(payload);
    expect(verifyToken(token).userId).toBe('u1');
  });

  it('throws when JWT_SECRET is unset in production', () => {
    process.env.JWT_SECRET = '';
    process.env.NODE_ENV = 'production';
    expect(() => signToken(payload)).toThrow('JWT_SECRET is not defined');
  });

  it('rejects a token signed with a different secret', () => {
    process.env.JWT_SECRET = 'secret-a';
    const token = signToken(payload);
    process.env.JWT_SECRET = 'secret-b';
    expect(() => verifyToken(token)).toThrow();
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
