import { describe, it, expect, afterEach } from 'bun:test';
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  getAccessTokenTtlSeconds,
  parseDurationSeconds,
} from '../../../src/utils/accessTokenTtl';

const originalExpiresIn = process.env.JWT_EXPIRES_IN;

describe('parseDurationSeconds', () => {
  it('parses each supported unit', () => {
    expect(parseDurationSeconds('30s', 1)).toBe(30);
    expect(parseDurationSeconds('15m', 1)).toBe(900);
    expect(parseDurationSeconds('2h', 1)).toBe(7200);
    expect(parseDurationSeconds('7d', 1)).toBe(604800);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDurationSeconds('3600', 1)).toBe(3600);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseDurationSeconds(' 15M ', 1)).toBe(900);
  });

  it('falls back when the value is missing', () => {
    expect(parseDurationSeconds(undefined, 900)).toBe(900);
    expect(parseDurationSeconds('', 900)).toBe(900);
  });

  it('falls back for unparsable or non-positive values', () => {
    for (const value of ['abc', '15 minutes', '-5m', '0', '0m', '15y']) {
      expect(parseDurationSeconds(value, 900)).toBe(900);
    }
  });
});

describe('getAccessTokenTtlSeconds', () => {
  afterEach(() => {
    if (originalExpiresIn !== undefined) {
      process.env.JWT_EXPIRES_IN = originalExpiresIn;
    } else {
      delete process.env.JWT_EXPIRES_IN;
    }
  });

  it('defaults to 15 minutes when JWT_EXPIRES_IN is unset', () => {
    delete process.env.JWT_EXPIRES_IN;
    expect(getAccessTokenTtlSeconds()).toBe(DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
    expect(DEFAULT_ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });

  it('honours a configured non-default lifetime', () => {
    process.env.JWT_EXPIRES_IN = '1h';
    expect(getAccessTokenTtlSeconds()).toBe(3600);
  });
});
