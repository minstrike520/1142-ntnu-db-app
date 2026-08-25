import { describe, it, expect, spyOn } from 'bun:test';
import {
  assertStartupEnv,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS,
  DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_AUTH_RATE_LIMIT_MAX,
  DEFAULT_CORS_ORIGINS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_SESSIONS_PER_USER,
  DEFAULT_PORT,
  DEFAULT_PRESENCE_GRACE_MS,
  DEFAULT_RATE_LIMIT_MAX,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_REFRESH_TTL_DAYS,
  DEFAULT_SESSION_RESERVATION_TTL_MS,
  DEFAULT_TYPING_TTL_MS,
  env,
  EnvConfigError,
  envProblems,
} from '../../../src/config/env';

const DAY_MS = 24 * 60 * 60 * 1000;

const problemNames = (source: NodeJS.ProcessEnv): string[] =>
  envProblems(source).map((problem) => problem.name);

describe('env', () => {
  it('falls back to the documented defaults for an empty environment', () => {
    const config = env({});

    expect(config.nodeEnv).toBeUndefined();
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.corsOrigins).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(config.databaseUrl).toBeUndefined();
    expect(config.jwtSecret).toBeUndefined();
    expect(config.accessTokenTtlSeconds).toBe(DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
    expect(config.refreshTokenTtlMs).toBe(DEFAULT_REFRESH_TTL_DAYS * DAY_MS);
    expect(config.refreshCookieMaxAgeMs).toBe(DEFAULT_REFRESH_TTL_DAYS * DAY_MS);
    expect(config.secureCookies).toBe(true);
    expect(config.trustedProxyHops).toBe(0);
    expect(config.logLevel).toBe(DEFAULT_LOG_LEVEL);
    expect(config.rateLimit).toEqual({
      disabled: false,
      global: { windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS, limit: DEFAULT_RATE_LIMIT_MAX },
      auth: { windowMs: DEFAULT_RATE_LIMIT_WINDOW_MS, limit: DEFAULT_AUTH_RATE_LIMIT_MAX },
    });
    expect(config.realtime).toEqual({
      maxSessionsPerUser: DEFAULT_MAX_SESSIONS_PER_USER,
      typingTtlMs: DEFAULT_TYPING_TTL_MS,
      sessionReservationTtlMs: DEFAULT_SESSION_RESERVATION_TTL_MS,
      presenceGraceMs: DEFAULT_PRESENCE_GRACE_MS,
    });
    expect(config.attachments).toEqual({
      restrictionEnabled: false,
      allowedMimeTypes: [...DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES],
      allowedExtensions: [...DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS],
      maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES,
    });
  });

  it('coerces the values it is given', () => {
    const config = env({
      NODE_ENV: 'production',
      PORT: '8080',
      CORS_ORIGINS: 'https://a.example, https://b.example ',
      DATABASE_URL: 'postgresql://app@primary/appdb',
      JWT_SECRET: 'a-real-secret',
      JWT_EXPIRES_IN: '2h',
      JWT_REFRESH_EXPIRES_IN_DAYS: '30',
      RATE_LIMIT_MAX: '25',
      ATTACHMENT_MAX_BYTES: '2048',
    });

    expect(config.isProduction).toBe(true);
    expect(config.port).toBe('8080');
    expect(config.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(config.databaseUrl).toBe('postgresql://app@primary/appdb');
    expect(config.jwtSecret).toBe('a-real-secret');
    expect(config.accessTokenTtlSeconds).toBe(7200);
    expect(config.refreshTokenTtlMs).toBe(30 * DAY_MS);
    expect(config.rateLimit.global.limit).toBe(25);
    expect(config.attachments.maxBytes).toBe(2048);
  });

  it('never throws, whatever it is handed', () => {
    expect(() =>
      env({
        NODE_ENV: 'production',
        PORT: 'not-a-port',
        JWT_EXPIRES_IN: 'whenever',
        JWT_REFRESH_EXPIRES_IN_DAYS: '-1',
        RATE_LIMIT_MAX: 'lots',
        TRUST_PROXY_HOPS: 'two',
        ATTACHMENT_TYPE_RESTRICTION_ENABLED: 'maybe',
      }),
    ).not.toThrow();
  });

  it('treats a blank value as unset, the way Compose passes an absent variable', () => {
    const config = env({ PORT: '', JWT_EXPIRES_IN: '  ', RATE_LIMIT_MAX: '' });

    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.accessTokenTtlSeconds).toBe(DEFAULT_ACCESS_TOKEN_TTL_SECONDS);
    expect(config.rateLimit.global.limit).toBe(DEFAULT_RATE_LIMIT_MAX);
    expect(problemNames({ PORT: '', JWT_EXPIRES_IN: '  ', RATE_LIMIT_MAX: '' })).not.toContain(
      'RATE_LIMIT_MAX',
    );
  });

  it('reads a blank CORS_ORIGINS as allowing no origin rather than as unset', () => {
    // An operator who leaves CORS_ORIGINS out of `.env` gets an empty string
    // through Compose; falling back to the localhost defaults would widen it.
    expect(env({ CORS_ORIGINS: '' }).corsOrigins).toEqual([]);
    expect(env({}).corsOrigins).toEqual([...DEFAULT_CORS_ORIGINS]);
  });

  describe('logLevel', () => {
    it('accepts a real level, case- and space-insensitively', () => {
      expect(env({ LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
      expect(env({ LOG_LEVEL: '  WARN ' }).logLevel).toBe('warn');
      expect(env({ LOG_LEVEL: 'silent' }).logLevel).toBe('silent');
    });

    it('falls back rather than handing pino a level it would throw on', () => {
      for (const value of ['verbose', 'INFOO', '30', '']) {
        expect(env({ LOG_LEVEL: value }).logLevel).toBe(DEFAULT_LOG_LEVEL);
      }
    });

    it('defaults to silent under the test runner, but an explicit level wins', () => {
      expect(env({ NODE_ENV: 'test' }).logLevel).toBe('silent');
      expect(env({ NODE_ENV: 'production' }).logLevel).toBe(DEFAULT_LOG_LEVEL);
      expect(env({ NODE_ENV: 'test', LOG_LEVEL: 'error' }).logLevel).toBe('error');
    });

    it('reports a misspelt level at startup instead of ignoring it silently', () => {
      expect(problemNames({ NODE_ENV: 'test', LOG_LEVEL: 'verbose' })).toEqual(['LOG_LEVEL']);
    });
  });

  describe('realtime', () => {
    it('reads the configured session, typing and reservation limits', () => {
      const config = env({
        MAX_SESSIONS_PER_USER: '2',
        TYPING_TTL_MS: '250',
        SESSION_RESERVATION_TTL_MS: '500',
        PRESENCE_GRACE_MS: '0',
      });

      expect(config.realtime).toEqual({
        maxSessionsPerUser: 2,
        typingTtlMs: 250,
        sessionReservationTtlMs: 500,
        presenceGraceMs: 0,
      });
    });

    it('keeps the millisecond delays fractional but the session count whole', () => {
      // The pre-existing parsers differed on purpose: a session count is a
      // cardinality, a delay is a duration.
      const config = env({ MAX_SESSIONS_PER_USER: '2.5', TYPING_TTL_MS: '2.5' });

      expect(config.realtime.maxSessionsPerUser).toBe(DEFAULT_MAX_SESSIONS_PER_USER);
      expect(config.realtime.typingTtlMs).toBe(2.5);
    });

    it('rejects a non-positive delay but allows a zero presence grace', () => {
      const config = env({ TYPING_TTL_MS: '0', PRESENCE_GRACE_MS: '0' });

      expect(config.realtime.typingTtlMs).toBe(DEFAULT_TYPING_TTL_MS);
      expect(config.realtime.presenceGraceMs).toBe(0);
    });

    it('drops the presence grace period under the test runner', () => {
      expect(env({ NODE_ENV: 'test' }).realtime.presenceGraceMs).toBe(0);
      expect(env({ NODE_ENV: 'production' }).realtime.presenceGraceMs).toBe(
        DEFAULT_PRESENCE_GRACE_MS,
      );
    });

    it('reports unusable values instead of applying them', () => {
      // NODE_ENV=test so the missing DATABASE_URL is not also reported.
      expect(
        problemNames({ NODE_ENV: 'test', MAX_SESSIONS_PER_USER: 'many', TYPING_TTL_MS: '-1' }),
      ).toEqual(['MAX_SESSIONS_PER_USER', 'TYPING_TTL_MS']);
    });
  });

  describe('trustedProxyHops', () => {
    it('reads an explicit hop count, trimmed', () => {
      expect(env({ TRUST_PROXY_HOPS: ' 2 ' }).trustedProxyHops).toBe(2);
    });

    it('treats the legacy TRUST_PROXY=true as a single hop', () => {
      expect(env({ TRUST_PROXY: ' TRUE ' }).trustedProxyHops).toBe(1);
      expect(env({ TRUST_PROXY: 'false' }).trustedProxyHops).toBe(0);
    });

    it('lets an explicit hop count win over the legacy flag', () => {
      expect(env({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '0' }).trustedProxyHops).toBe(0);
    });

    it('grants no trust for a malformed hop count, ignoring the legacy flag', () => {
      for (const value of ['-1', 'two', '1.5', 'NaN']) {
        expect(env({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: value }).trustedProxyHops).toBe(0);
      }
    });
  });

  describe('databaseUrl', () => {
    const urls = { DATABASE_URL: 'postgresql://app@primary/appdb', DATABASE_URL_TEST: 'postgresql://t@test/testdb' };

    it('prefers DATABASE_URL_TEST only under NODE_ENV=test', () => {
      expect(env({ ...urls, NODE_ENV: 'test' }).databaseUrl).toBe(urls.DATABASE_URL_TEST);
      expect(env({ ...urls, NODE_ENV: 'development' }).databaseUrl).toBe(urls.DATABASE_URL);
    });

    it('falls back to DATABASE_URL when the test one is unset', () => {
      expect(env({ DATABASE_URL: urls.DATABASE_URL, NODE_ENV: 'test' }).databaseUrl).toBe(
        urls.DATABASE_URL,
      );
    });
  });
});

describe('envProblems', () => {
  it('reports each value that will be ignored, without claiming it is fatal', () => {
    const problems = envProblems({
      NODE_ENV: 'test',
      PORT: 'not-a-port',
      JWT_EXPIRES_IN: 'whenever',
      RATE_LIMIT_MAX: 'lots',
      TRUST_PROXY_HOPS: 'two',
      ATTACHMENT_TYPE_RESTRICTION_ENABLED: 'maybe',
    });

    expect(problems.map((problem) => problem.name).sort()).toEqual([
      'ATTACHMENT_TYPE_RESTRICTION_ENABLED',
      'JWT_EXPIRES_IN',
      'PORT',
      'RATE_LIMIT_MAX',
      'TRUST_PROXY_HOPS',
    ]);
    expect(problems.every((problem) => !problem.fatal)).toBe(true);
    expect(problems.every((problem) => problem.value !== undefined)).toBe(true);
  });

  it('finds nothing wrong with a well-formed environment', () => {
    expect(
      envProblems({
        NODE_ENV: 'production',
        PORT: '4000',
        DATABASE_URL: 'postgresql://app@primary/appdb',
        JWT_SECRET: 'a-real-secret',
      }),
    ).toEqual([]);
  });

  it('requires a database outside the test runner', () => {
    expect(problemNames({ NODE_ENV: 'production', JWT_SECRET: 's' })).toContain('DATABASE_URL');
    expect(problemNames({ NODE_ENV: 'test' })).not.toContain('DATABASE_URL');
    expect(problemNames({ NODE_ENV: 'test', DATABASE_URL_TEST: 'postgresql://t@test/db' })).toEqual(
      [],
    );
  });

  it('requires JWT_SECRET only in production', () => {
    expect(problemNames({ NODE_ENV: 'development' })).not.toContain('JWT_SECRET');
    expect(
      problemNames({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://app@primary/appdb' }),
    ).toContain('JWT_SECRET');
  });

  it('never carries the value of a variable that could hold a secret', () => {
    const problems = envProblems({ NODE_ENV: 'production', JWT_SECRET: '', DATABASE_URL: '' });

    for (const problem of problems) {
      expect(problem.value).toBeUndefined();
      expect(problem.fatal).toBe(true);
    }
  });
});

describe('assertStartupEnv', () => {
  it('accepts a well-formed environment silently', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        assertStartupEnv({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://app@primary/appdb',
          JWT_SECRET: 'a-real-secret',
        }),
      ).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('warns about ignored values but still starts', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      assertStartupEnv({ NODE_ENV: 'test', RATE_LIMIT_MAX: 'lots' });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toInclude('RATE_LIMIT_MAX');
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses to start a production process with no signing secret', () => {
    expect(() =>
      assertStartupEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://app@primary/appdb' }),
    ).toThrow(EnvConfigError);
  });

  it('names every fatal problem at once rather than one per restart', () => {
    let caught: unknown;
    try {
      assertStartupEnv({ NODE_ENV: 'production' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(EnvConfigError);
    expect((caught as EnvConfigError).problems.map((problem) => problem.name).sort()).toEqual([
      'DATABASE_URL',
      'JWT_SECRET',
    ]);
  });
});
