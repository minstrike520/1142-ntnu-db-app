import type { LevelWithSilent } from 'pino';
import { DEFAULT_ACCESS_TOKEN_TTL_SECONDS, parseDurationSeconds } from '../utils/accessTokenTtl';
import { parsePositiveInt } from '../utils/parsePositiveInt';

/**
 * Centralized environment configuration and validation.
 *
 * Re-reads process.env dynamically on each `env()` call. Unusable values
 * fall back to defaults, while `assertStartupEnv()` validates configuration
 * at boot and throws if fatal variables are missing.
 */

/** Re-exported so every default is reachable from one place. */
export { DEFAULT_ACCESS_TOKEN_TTL_SECONDS };

export const DEFAULT_PORT = 4000;

export const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:3005',
  'http://localhost:5173',
] as const;

/** Stand-in secret for non-production runs so local development boots easily. */
export const DEV_JWT_SECRET = 'default-dev-secret';

export const DEFAULT_REFRESH_TTL_DAYS = 14;

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_RATE_LIMIT_MAX = 1000;
export const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;

export const DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/pdf',
  'application/zip',
  'text/plain',
] as const;

export const DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.pdf',
  '.zip',
  '.txt',
] as const;

export const DEFAULT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

export const DEFAULT_MAX_SESSIONS_PER_USER = 5;
export const DEFAULT_TYPING_TTL_MS = 3_000;
export const DEFAULT_SESSION_RESERVATION_TTL_MS = 10_000;
export const DEFAULT_PRESENCE_GRACE_MS = 3_000;

/** Presence lease TTL in Redis before an unrefreshed session is considered offline. */
export const DEFAULT_PRESENCE_TTL_MS = 30_000;

/** Number of refresh heartbeats within one lease TTL window. */
export const DEFAULT_PRESENCE_REFRESH_DIVISOR = 3;

/** Log level names accepted by Pino, including 'silent'. */
export type LogLevel = LevelWithSilent;

export const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export interface Env {
  /** Raw `NODE_ENV`; undefined when unset. */
  nodeEnv: string | undefined;
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;

  /** Listen port or socket/pipe path passed to server.listen. */
  port: string | number;
  corsOrigins: string[];

  /** PostgreSQL connection string. Prefers DATABASE_URL_TEST under test environment. */
  databaseUrl: string | undefined;

  /** Redis connection URL, or undefined if running in single-node mode without Redis. */
  redisUrl: string | undefined;

  /** Unique identifier for this process instance in presence leases. */
  instanceId: string | undefined;

  /** Raw `JWT_SECRET`, empty treated as unset. Required in production. */
  jwtSecret: string | undefined;
  accessTokenTtlSeconds: number;
  refreshTokenTtlMs: number;
  refreshCookieMaxAgeMs: number;
  /** Secure flag for auth cookies; enabled everywhere except local dev and test. */
  secureCookies: boolean;

  /** Number of trusted reverse proxy hops for client IP extraction. */
  trustedProxyHops: number;

  rateLimit: {
    disabled: boolean;
    global: { windowMs: number; limit: number };
    auth: { windowMs: number; limit: number };
  };

  /** Severity level for logging. Defaults to 'info', or 'silent' in tests. */
  logLevel: LogLevel;

  realtime: {
    /** Max concurrent Socket.IO sessions allowed per user. */
    maxSessionsPerUser: number;
    /** Lifetime of typing indicators without a refresh. */
    typingTtlMs: number;
    /** Handshake reservation timeout before slot is considered abandoned. */
    sessionReservationTtlMs: number;
    /** Reconnect grace period before broadcasting user offline. */
    presenceGraceMs: number;
    /** Redis presence lease duration. */
    presenceTtlMs: number;
  };

  attachments: {
    restrictionEnabled: boolean;
    allowedMimeTypes: string[];
    allowedExtensions: string[];
    maxBytes: number;
  };
}

/** Represents a missing or invalid environment variable. */
export interface EnvProblem {
  name: string;
  message: string;
  /** Offending value (omitted for secrets). */
  value?: string;
  /** If true, prevents server startup. */
  fatal: boolean;
}

export class EnvConfigError extends Error {
  constructor(readonly problems: EnvProblem[]) {
    super(`Invalid environment configuration:\n${problems.map(formatProblem).join('\n')}`);
    this.name = 'EnvConfigError';
  }
}

// --- value parsers -----------------------------------------------------------

/** Parses positive integers; returns undefined if invalid or non-positive. */
const asPositiveInt = (raw: string): number | undefined => {
  const parsed = parsePositiveInt(raw, Number.NaN);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const asNonNegativeInt = (raw: string): number | undefined => {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Parses positive floating point millisecond delays. */
const asPositiveNumber = (raw: string): number | undefined => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const asNonNegativeNumber = (raw: string): number | undefined => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

const asDurationSeconds = (raw: string): number | undefined => {
  const parsed = parseDurationSeconds(raw, -1);
  return parsed === -1 ? undefined : parsed;
};

const asLogLevel = (raw: string): LogLevel | undefined => {
  const normalized = raw.trim().toLowerCase() as LogLevel;
  return LOG_LEVELS.includes(normalized) ? normalized : undefined;
};

const asBoolean = (raw: string): boolean | undefined => {
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
};

const asList = (raw: string): string[] =>
  raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

/** Parses comma-separated list, requiring at least one item. */
const asNonEmptyList = (raw: string): string[] | undefined => {
  const items = asList(raw);
  return items.length > 0 ? items : undefined;
};

// --- readers -----------------------------------------------------------------

type Parser<T> = (raw: string) => T | undefined;

/** Reads one variable, falling back to default when unset or invalid. */
const read = <T>(
  source: NodeJS.ProcessEnv,
  name: string,
  parse: Parser<T>,
  fallback: T,
  problems?: EnvProblem[],
): T => {
  const raw = source[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const parsed = parse(raw);
  if (parsed !== undefined) return parsed;

  problems?.push({
    name,
    message: `is not usable, falling back to the default (${String(fallback)})`,
    value: raw,
    fatal: false,
  });
  return fallback;
};

/** Resolves trusted proxy hop count (prefers TRUST_PROXY_HOPS over legacy TRUST_PROXY). */
const readTrustedProxyHops = (source: NodeJS.ProcessEnv, problems?: EnvProblem[]): number => {
  const configured = (source.TRUST_PROXY_HOPS ?? '').trim();

  if (configured) {
    const hops = asNonNegativeInt(configured);
    if (hops !== undefined) return hops;

    problems?.push({
      name: 'TRUST_PROXY_HOPS',
      message: 'is not a non-negative integer, so no proxy is trusted',
      value: configured,
      fatal: false,
    });
    return 0;
  }

  return (source.TRUST_PROXY ?? '').trim().toLowerCase() === 'true' ? 1 : 0;
};

/** Redis connection URL protocols accepted by Bun's RedisClient. */
export const REDIS_URL_PROTOCOLS = [
  'redis:',
  'valkey:',
  'rediss:',
  'valkeys:',
  'redis+tls:',
  'redis+unix:',
  'redis+tls+unix:',
] as const;

/** Resolves REDIS_URL without echoing credentials in error messages. */
const readRedisUrl = (source: NodeJS.ProcessEnv, problems?: EnvProblem[]): string | undefined => {
  const configured = (source.REDIS_URL ?? '').trim();
  if (!configured) return undefined;

  let protocol: string | undefined;
  try {
    protocol = new URL(configured).protocol;
  } catch {
    protocol = undefined;
  }

  if (protocol && (REDIS_URL_PROTOCOLS as readonly string[]).includes(protocol)) return configured;

  problems?.push({
    name: 'REDIS_URL',
    message: `is not a Redis connection URL (expected ${REDIS_URL_PROTOCOLS.join(', ')}), so Redis stays disabled and realtime runs single-node`,
    fatal: false,
  });
  return undefined;
};

const readAll = (source: NodeJS.ProcessEnv, problems?: EnvProblem[]): Env => {
  const nodeEnv = source.NODE_ENV;
  const isTest = nodeEnv === 'test';

  const refreshTokenTtlMs =
    read(source, 'JWT_REFRESH_EXPIRES_IN_DAYS', asPositiveInt, DEFAULT_REFRESH_TTL_DAYS, problems) *
    24 * 60 * 60 * 1000;

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isDevelopment: nodeEnv === 'development',
    isTest,

    port: source.PORT || DEFAULT_PORT,
    // Blank means allow no origin (differs from unset which uses localhost defaults).
    corsOrigins:
      source.CORS_ORIGINS === undefined ? [...DEFAULT_CORS_ORIGINS] : asList(source.CORS_ORIGINS),

    databaseUrl: (isTest ? source.DATABASE_URL_TEST : undefined) || source.DATABASE_URL || undefined,

    redisUrl: readRedisUrl(source, problems),

    instanceId: source.INSTANCE_ID?.trim() || undefined,

    jwtSecret: source.JWT_SECRET || undefined,
    accessTokenTtlSeconds: read(
      source,
      'JWT_EXPIRES_IN',
      asDurationSeconds,
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
      problems,
    ),
    refreshTokenTtlMs,
    refreshCookieMaxAgeMs: read(
      source,
      'REFRESH_COOKIE_MAX_AGE_MS',
      asPositiveInt,
      refreshTokenTtlMs,
      problems,
    ),
    secureCookies: nodeEnv !== 'development' && nodeEnv !== 'test',

    trustedProxyHops: readTrustedProxyHops(source, problems),

    // Silent by default in tests to keep test output clean.
    logLevel: read(source, 'LOG_LEVEL', asLogLevel, isTest ? 'silent' : DEFAULT_LOG_LEVEL, problems),

    rateLimit: {
      disabled: isTest || source.RATE_LIMIT_DISABLED === 'true',
      global: {
        windowMs: read(
          source,
          'RATE_LIMIT_WINDOW_MS',
          asPositiveInt,
          DEFAULT_RATE_LIMIT_WINDOW_MS,
          problems,
        ),
        limit: read(source, 'RATE_LIMIT_MAX', asPositiveInt, DEFAULT_RATE_LIMIT_MAX, problems),
      },
      auth: {
        windowMs: read(
          source,
          'AUTH_RATE_LIMIT_WINDOW_MS',
          asPositiveInt,
          DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
          problems,
        ),
        limit: read(
          source,
          'AUTH_RATE_LIMIT_MAX',
          asPositiveInt,
          DEFAULT_AUTH_RATE_LIMIT_MAX,
          problems,
        ),
      },
    },

    realtime: {
      maxSessionsPerUser: read(
        source,
        'MAX_SESSIONS_PER_USER',
        asPositiveInt,
        DEFAULT_MAX_SESSIONS_PER_USER,
        problems,
      ),
      typingTtlMs: read(source, 'TYPING_TTL_MS', asPositiveNumber, DEFAULT_TYPING_TTL_MS, problems),
      sessionReservationTtlMs: read(
        source,
        'SESSION_RESERVATION_TTL_MS',
        asPositiveNumber,
        DEFAULT_SESSION_RESERVATION_TTL_MS,
        problems,
      ),
      // Set to 0 in tests so tests do not leave lingering timers.
      presenceGraceMs: read(
        source,
        'PRESENCE_GRACE_MS',
        asNonNegativeNumber,
        isTest ? 0 : DEFAULT_PRESENCE_GRACE_MS,
        problems,
      ),
      presenceTtlMs: read(
        source,
        'PRESENCE_TTL_MS',
        asPositiveNumber,
        DEFAULT_PRESENCE_TTL_MS,
        problems,
      ),
    },

    attachments: {
      restrictionEnabled: read(
        source,
        'ATTACHMENT_TYPE_RESTRICTION_ENABLED',
        asBoolean,
        false,
        problems,
      ),
      allowedMimeTypes: read(
        source,
        'ATTACHMENT_ALLOWED_MIME_TYPES',
        asNonEmptyList,
        [...DEFAULT_ATTACHMENT_ALLOWED_MIME_TYPES],
        problems,
      ).map((mimeType) => mimeType.toLowerCase()),
      allowedExtensions: read(
        source,
        'ATTACHMENT_ALLOWED_EXTENSIONS',
        asNonEmptyList,
        [...DEFAULT_ATTACHMENT_ALLOWED_EXTENSIONS],
        problems,
      ).map((extension) => extension.toLowerCase()),
      maxBytes: read(
        source,
        'ATTACHMENT_MAX_BYTES',
        asPositiveInt,
        DEFAULT_ATTACHMENT_MAX_BYTES,
        problems,
      ),
    },
  };
};

/** Returns current environment configuration, parsed dynamically from process.env. */
export const env = (source: NodeJS.ProcessEnv = process.env): Env => readAll(source);

/** Collects missing or unusable environment settings. */
export const envProblems = (source: NodeJS.ProcessEnv = process.env): EnvProblem[] => {
  const problems: EnvProblem[] = [];
  const config = readAll(source, problems);

  if (source.PORT?.trim() && asPositiveInt(source.PORT) === undefined) {
    problems.push({
      name: 'PORT',
      message: 'is not a positive integer, so it will be treated as a pipe or socket path',
      value: source.PORT,
      fatal: false,
    });
  }

  // Database URL is required outside unit tests.
  if (!config.databaseUrl && !config.isTest) {
    problems.push({
      name: 'DATABASE_URL',
      message: 'is required (or DATABASE_URL_TEST when NODE_ENV=test)',
      fatal: true,
    });
  }

  if (!config.jwtSecret && config.isProduction) {
    problems.push({
      name: 'JWT_SECRET',
      message: 'is required in production; tokens would otherwise be signed with a public dev key',
      fatal: true,
    });
  }

  return problems;
};

const formatProblem = (problem: EnvProblem): string =>
  problem.value === undefined
    ? `  - ${problem.name} ${problem.message}`
    : `  - ${problem.name}=${JSON.stringify(problem.value)} ${problem.message}`;

/** Validates startup configuration; logs warnings for fallbacks and throws on fatal errors. */
export const assertStartupEnv = (source: NodeJS.ProcessEnv = process.env): void => {
  const problems = envProblems(source);
  if (problems.length === 0) return;

  const fatal = problems.filter((problem) => problem.fatal);
  const ignored = problems.filter((problem) => !problem.fatal);

  if (ignored.length > 0) {
    console.warn(`Ignoring unusable environment values:\n${ignored.map(formatProblem).join('\n')}`);
  }

  if (fatal.length > 0) {
    throw new EnvConfigError(fatal);
  }
};
