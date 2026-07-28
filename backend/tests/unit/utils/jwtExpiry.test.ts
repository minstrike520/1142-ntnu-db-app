import { describe, it, expect, afterEach } from 'bun:test';
import { decode } from 'hono/jwt';
import { signToken } from '../../../src/utils/jwt';

const originalExpiresIn = process.env.JWT_EXPIRES_IN;

const expiryOf = async (): Promise<number> => {
  const token = await signToken({ userId: 'user-1', email: 'user@test.com' } as never);
  const { payload } = decode(token);
  return (payload as { exp: number }).exp;
};

describe('access token lifetime', () => {
  afterEach(() => {
    if (originalExpiresIn !== undefined) {
      process.env.JWT_EXPIRES_IN = originalExpiresIn;
    } else {
      delete process.env.JWT_EXPIRES_IN;
    }
  });

  it('defaults to 15 minutes', async () => {
    delete process.env.JWT_EXPIRES_IN;
    const ttl = (await expiryOf()) - Math.floor(Date.now() / 1000);

    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('applies JWT_EXPIRES_IN instead of the hard-coded 15 minutes', async () => {
    process.env.JWT_EXPIRES_IN = '2h';
    const ttl = (await expiryOf()) - Math.floor(Date.now() / 1000);

    expect(ttl).toBeGreaterThan(7190);
    expect(ttl).toBeLessThanOrEqual(7200);
  });

  it('falls back to the default when JWT_EXPIRES_IN is unusable', async () => {
    process.env.JWT_EXPIRES_IN = 'not-a-duration';
    const ttl = (await expiryOf()) - Math.floor(Date.now() / 1000);

    expect(ttl).toBeGreaterThan(890);
    expect(ttl).toBeLessThanOrEqual(900);
  });
});
