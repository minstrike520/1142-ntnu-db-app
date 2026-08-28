import { describe, it, expect, afterEach } from 'bun:test';
import type { Context } from 'hono';
import { getClientIp, trustedProxyHops } from '../../../src/utils/clientIp';

const originalTrustProxy = process.env.TRUST_PROXY;
const originalTrustProxyHops = process.env.TRUST_PROXY_HOPS;

const makeContext = (headers: Record<string, string> = {}): Context =>
  ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: {},
  }) as unknown as Context;

const restore = (name: string, value: string | undefined) => {
  if (value !== undefined) {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
};

describe('clientIp', () => {
  afterEach(() => {
    restore('TRUST_PROXY', originalTrustProxy);
    restore('TRUST_PROXY_HOPS', originalTrustProxyHops);
  });

  describe('trustedProxyHops', () => {
    it('defaults to trusting nothing', () => {
      delete process.env.TRUST_PROXY;
      delete process.env.TRUST_PROXY_HOPS;
      expect(trustedProxyHops()).toBe(0);
    });

    it('reads an explicit hop count', () => {
      delete process.env.TRUST_PROXY;
      process.env.TRUST_PROXY_HOPS = ' 2 ';
      expect(trustedProxyHops()).toBe(2);
    });

    it('treats the legacy TRUST_PROXY=true as a single hop', () => {
      delete process.env.TRUST_PROXY_HOPS;
      process.env.TRUST_PROXY = ' TRUE ';
      expect(trustedProxyHops()).toBe(1);
    });

    it('treats any other legacy value as no trust', () => {
      delete process.env.TRUST_PROXY_HOPS;
      for (const value of ['false', '1', 'yes', '']) {
        process.env.TRUST_PROXY = value;
        expect(trustedProxyHops()).toBe(0);
      }
    });

    it('lets an explicit hop count win over the legacy flag', () => {
      process.env.TRUST_PROXY = 'true';
      process.env.TRUST_PROXY_HOPS = '0';
      expect(trustedProxyHops()).toBe(0);
    });

    it('falls back to no trust for a malformed hop count', () => {
      delete process.env.TRUST_PROXY;
      for (const value of ['-1', 'two', '1.5', 'NaN']) {
        process.env.TRUST_PROXY_HOPS = value;
        expect(trustedProxyHops()).toBe(0);
      }
    });
  });

  describe('getClientIp', () => {
    it('does not trust forwarded headers without a trusted proxy', () => {
      delete process.env.TRUST_PROXY;
      delete process.env.TRUST_PROXY_HOPS;
      const c = makeContext({ 'x-forwarded-for': '10.0.0.1' });

      expect(getClientIp(c)).toBeUndefined();
    });

    it('reads one hop back from the right when one proxy is trusted', () => {
      process.env.TRUST_PROXY_HOPS = '1';
      const c = makeContext({ 'x-forwarded-for': ' 10.0.0.1 , 172.16.0.1 ' });

      // Our single proxy appended 172.16.0.1 as the address it heard the request
      // from, so that is the caller. 10.0.0.1 arrived with the request itself.
      expect(getClientIp(c)).toBe('172.16.0.1');
    });

    it('ignores entries a client prepends to the chain', () => {
      process.env.TRUST_PROXY_HOPS = '1';
      const spoofed = makeContext(
        { 'x-forwarded-for': '203.0.113.7, 203.0.113.8, 198.51.100.4' },
      );
      const honest = makeContext({ 'x-forwarded-for': '198.51.100.4' });

      // Padding the chain must not let a caller pick a different bucket.
      expect(getClientIp(spoofed)).toBe('198.51.100.4');
      expect(getClientIp(spoofed)).toBe(getClientIp(honest));
    });

    it('skips the declared number of hops', () => {
      process.env.TRUST_PROXY_HOPS = '2';
      const c = makeContext({ 'x-forwarded-for': '10.0.0.1, 198.51.100.4, 172.16.0.1' });

      expect(getClientIp(c)).toBe('198.51.100.4');
    });

    it('returns undefined when a synthetic chain is shorter than trusted hops', () => {
      // A synthetic request has no peer address to use as a safe fallback.
      process.env.TRUST_PROXY_HOPS = '2';
      const c = makeContext({ 'x-forwarded-for': '10.0.0.1' });

      expect(getClientIp(c)).toBeUndefined();
    });

    it('returns undefined when a synthetic request has no forwarded header', () => {
      process.env.TRUST_PROXY_HOPS = '1';
      const c = makeContext();

      expect(getClientIp(c)).toBeUndefined();
    });

    it('returns undefined when a synthetic forwarded header is blank', () => {
      process.env.TRUST_PROXY_HOPS = '1';
      const c = makeContext({ 'x-forwarded-for': '  ' });

      expect(getClientIp(c)).toBeUndefined();
    });

    it('returns undefined when no connection info is attached', () => {
      delete process.env.TRUST_PROXY;
      delete process.env.TRUST_PROXY_HOPS;

      expect(getClientIp(makeContext())).toBeUndefined();
      expect(getClientIp(makeContext({ 'x-forwarded-for': '10.0.0.1' }))).toBeUndefined();
    });

    it('returns undefined when a synthetic request has no remote address', () => {
      delete process.env.TRUST_PROXY;
      delete process.env.TRUST_PROXY_HOPS;

      expect(getClientIp(makeContext())).toBeUndefined();
    });
  });
});
