import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import type { Context } from 'hono';
import {
  getClientIp,
  normalizeIp,
  resetUntrustedForwardWarning,
  trustProxyEnabled,
  trustedProxyIps,
} from '../../../src/utils/clientIp';

const originalTrustProxy = process.env.TRUST_PROXY;
const originalTrustedProxyIps = process.env.TRUSTED_PROXY_IPS;
const originalNodeEnv = process.env.NODE_ENV;

const makeContext = (
  headers: Record<string, string> = {},
  socket?: { remoteAddress?: string; remotePort?: number; remoteFamily?: string },
): Context =>
  ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: socket ? { incoming: { socket } } : {},
  }) as unknown as Context;

const restore = (name: string, value: string | undefined): void => {
  if (value !== undefined) {
    process.env[name] = value;
  } else {
    delete process.env[name];
  }
};

describe('clientIp', () => {
  afterEach(() => {
    restore('TRUST_PROXY', originalTrustProxy);
    restore('TRUSTED_PROXY_IPS', originalTrustedProxyIps);
    restore('NODE_ENV', originalNodeEnv);
    resetUntrustedForwardWarning();
  });

  describe('trustProxyEnabled', () => {
    it('defaults to false', () => {
      delete process.env.TRUST_PROXY;
      expect(trustProxyEnabled()).toBe(false);
    });

    it('is case- and whitespace-insensitive', () => {
      process.env.TRUST_PROXY = ' TRUE ';
      expect(trustProxyEnabled()).toBe(true);
    });

    it('treats any other value as false', () => {
      for (const value of ['false', '1', 'yes', '']) {
        process.env.TRUST_PROXY = value;
        expect(trustProxyEnabled()).toBe(false);
      }
    });
  });

  describe('normalizeIp', () => {
    it('trims surrounding whitespace', () => {
      expect(normalizeIp('  203.0.113.1  ')).toBe('203.0.113.1');
    });

    it('strips a port from an IPv4 address', () => {
      expect(normalizeIp('203.0.113.1:443')).toBe('203.0.113.1');
    });

    it('strips brackets and a port from an IPv6 address', () => {
      expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
      expect(normalizeIp('[2001:db8::1]')).toBe('2001:db8::1');
    });

    it('keeps a bare IPv6 address intact', () => {
      // Naive `split(':')[0]` port stripping would collapse this to "2606",
      // funnelling every IPv6 visitor into a single rate-limit bucket.
      expect(normalizeIp('2606:4700::1')).toBe('2606:4700::1');
      expect(normalizeIp('::1')).toBe('::1');
    });

    it('unwraps IPv4-mapped IPv6 addresses so both forms share a bucket', () => {
      expect(normalizeIp('::ffff:203.0.113.1')).toBe('203.0.113.1');
      expect(normalizeIp('::FFFF:203.0.113.1')).toBe('203.0.113.1');
    });

    it('rejects anything that is not an IP address', () => {
      for (const value of ['', '   ', 'not-an-ip', '999.999.999.999', 'unknown']) {
        expect(normalizeIp(value)).toBeUndefined();
      }
    });
  });

  describe('trustedProxyIps', () => {
    it('is empty when unset', () => {
      delete process.env.TRUSTED_PROXY_IPS;
      expect(trustedProxyIps()).toEqual([]);
    });

    it('parses a comma-separated list and drops unusable entries', () => {
      process.env.TRUSTED_PROXY_IPS = ' 10.83.71.250 , , not-an-ip, ::ffff:172.20.0.4 ';
      expect(trustedProxyIps()).toEqual(['10.83.71.250', '172.20.0.4']);
    });
  });

  describe('getClientIp', () => {
    it('prefers the socket peer address by default', () => {
      delete process.env.TRUST_PROXY;
      const c = makeContext({ 'x-forwarded-for': '10.0.0.1' }, { remoteAddress: '192.168.1.5' });

      expect(getClientIp(c)).toBe('192.168.1.5');
    });

    it('normalises the socket peer address', () => {
      delete process.env.TRUST_PROXY;
      const c = makeContext({}, { remoteAddress: '::ffff:192.168.1.5' });

      expect(getClientIp(c)).toBe('192.168.1.5');
    });

    it('keeps an IPv6 socket peer address intact', () => {
      delete process.env.TRUST_PROXY;
      const c = makeContext({}, { remoteAddress: '2606:4700::1' });

      expect(getClientIp(c)).toBe('2606:4700::1');
    });

    it('uses the last forwarded hop, not the caller-supplied prefix', () => {
      // Cloudflare appends the address that actually opened the connection to
      // its edge, so anything to the left of it is whatever the caller sent.
      process.env.TRUST_PROXY = 'true';
      const c = makeContext(
        { 'x-forwarded-for': ' 10.0.0.1 , 203.0.113.7 ' },
        { remoteAddress: '192.168.1.5' },
      );

      expect(getClientIp(c)).toBe('203.0.113.7');
    });

    it('skips trusted proxies while walking the forwarded chain', () => {
      process.env.TRUSTED_PROXY_IPS = '192.168.1.5,172.20.0.9';
      const c = makeContext(
        { 'x-forwarded-for': '10.0.0.1, 203.0.113.7, 172.20.0.9' },
        { remoteAddress: '192.168.1.5' },
      );

      expect(getClientIp(c)).toBe('203.0.113.7');
    });

    it('falls back to the peer when every forwarded hop is a trusted proxy', () => {
      process.env.TRUSTED_PROXY_IPS = '192.168.1.5,172.20.0.9';
      const c = makeContext({ 'x-forwarded-for': '172.20.0.9' }, { remoteAddress: '192.168.1.5' });

      expect(getClientIp(c)).toBe('192.168.1.5');
    });

    it('trusts the forwarded header when the peer is a listed proxy', () => {
      delete process.env.TRUST_PROXY;
      process.env.TRUSTED_PROXY_IPS = '10.83.71.250';
      const c = makeContext(
        { 'x-forwarded-for': '203.0.113.7' },
        { remoteAddress: '10.83.71.250' },
      );

      expect(getClientIp(c)).toBe('203.0.113.7');
    });

    it('ignores the forwarded header when the peer is not a listed proxy', () => {
      delete process.env.TRUST_PROXY;
      process.env.TRUSTED_PROXY_IPS = '10.83.71.250';
      // Anything reaching the published port arrives with a different peer
      // address, so it cannot pick its own bucket.
      const c = makeContext({ 'x-forwarded-for': '203.0.113.7' }, { remoteAddress: '10.83.71.1' });

      expect(getClientIp(c)).toBe('10.83.71.1');
    });

    it('prefers CF-Connecting-IP over X-Forwarded-For when the peer is trusted', () => {
      process.env.TRUSTED_PROXY_IPS = '10.83.71.250';
      const c = makeContext(
        { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '10.0.0.1, 198.51.100.4' },
        { remoteAddress: '10.83.71.250' },
      );

      expect(getClientIp(c)).toBe('203.0.113.7');
    });

    it('ignores CF-Connecting-IP from an untrusted peer', () => {
      process.env.TRUSTED_PROXY_IPS = '10.83.71.250';
      const c = makeContext({ 'cf-connecting-ip': '203.0.113.7' }, { remoteAddress: '10.83.71.1' });

      expect(getClientIp(c)).toBe('10.83.71.1');
    });

    it('falls back to X-Forwarded-For when CF-Connecting-IP is unusable', () => {
      process.env.TRUSTED_PROXY_IPS = '10.83.71.250';
      const c = makeContext(
        { 'cf-connecting-ip': '  ', 'x-forwarded-for': '203.0.113.7' },
        { remoteAddress: '10.83.71.250' },
      );

      expect(getClientIp(c)).toBe('203.0.113.7');
    });

    it('falls back to the socket when a trusted proxy sends no header', () => {
      process.env.TRUST_PROXY = 'true';
      const c = makeContext({}, { remoteAddress: '192.168.1.5' });

      expect(getClientIp(c)).toBe('192.168.1.5');
    });

    it('falls back to the socket when the forwarded header is blank', () => {
      process.env.TRUST_PROXY = 'true';
      const c = makeContext({ 'x-forwarded-for': '  ' }, { remoteAddress: '192.168.1.5' });

      expect(getClientIp(c)).toBe('192.168.1.5');
    });

    it('falls back to the socket when every forwarded hop is malformed', () => {
      process.env.TRUST_PROXY = 'true';
      const c = makeContext(
        { 'x-forwarded-for': 'unknown, not-an-ip' },
        { remoteAddress: '192.168.1.5' },
      );

      expect(getClientIp(c)).toBe('192.168.1.5');
    });

    it('returns undefined when no connection info is attached', () => {
      delete process.env.TRUST_PROXY;

      expect(getClientIp(makeContext())).toBeUndefined();
      expect(getClientIp(makeContext({ 'x-forwarded-for': '10.0.0.1' }))).toBeUndefined();
    });

    it('returns undefined when the socket has no remote address', () => {
      delete process.env.TRUST_PROXY;

      expect(getClientIp(makeContext({}, {}))).toBeUndefined();
    });
  });

  describe('untrusted forwarded header warning', () => {
    it('warns once per window when a forwarded header arrives from an untrusted peer', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TRUST_PROXY;
      delete process.env.TRUSTED_PROXY_IPS;
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const c = makeContext({ 'x-forwarded-for': '203.0.113.7' }, { remoteAddress: '10.83.71.1' });
        getClientIp(c);
        getClientIp(c);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('TRUSTED_PROXY_IPS');
      } finally {
        warn.mockRestore();
      }
    });

    it('stays quiet when no forwarded header is present', () => {
      process.env.NODE_ENV = 'production';
      delete process.env.TRUST_PROXY;
      delete process.env.TRUSTED_PROXY_IPS;
      const warn = spyOn(console, 'warn').mockImplementation(() => {});

      try {
        getClientIp(makeContext({}, { remoteAddress: '10.83.71.1' }));

        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
