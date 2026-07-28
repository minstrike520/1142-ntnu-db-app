import { describe, it, expect, afterEach } from 'bun:test';
import type { Context } from 'hono';
import { getClientIp, trustProxyEnabled } from '../../../src/utils/clientIp';

const originalTrustProxy = process.env.TRUST_PROXY;

const makeContext = (
  headers: Record<string, string> = {},
  socket?: { remoteAddress?: string; remotePort?: number; remoteFamily?: string },
): Context =>
  ({
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: socket ? { incoming: { socket } } : {},
  }) as unknown as Context;

describe('clientIp', () => {
  afterEach(() => {
    if (originalTrustProxy !== undefined) {
      process.env.TRUST_PROXY = originalTrustProxy;
    } else {
      delete process.env.TRUST_PROXY;
    }
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

  describe('getClientIp', () => {
    it('prefers the socket peer address by default', () => {
      delete process.env.TRUST_PROXY;
      const c = makeContext({ 'x-forwarded-for': '10.0.0.1' }, { remoteAddress: '192.168.1.5' });

      expect(getClientIp(c)).toBe('192.168.1.5');
    });

    it('uses the first forwarded hop when the proxy is trusted', () => {
      process.env.TRUST_PROXY = 'true';
      const c = makeContext(
        { 'x-forwarded-for': ' 10.0.0.1 , 172.16.0.1 ' },
        { remoteAddress: '192.168.1.5' },
      );

      expect(getClientIp(c)).toBe('10.0.0.1');
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
});
